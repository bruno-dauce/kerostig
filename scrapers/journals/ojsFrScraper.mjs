import * as cheerio from 'cheerio';
import { matchIssn } from '../issnMatcher.mjs';
import { parse as parsePdf } from '../fileParser.mjs';

// Revues francophones de gestion publiant leurs appels hors des grands
// hubs editeurs. M@n@gement, SIM et la RIPME tournent sur OJS/PKP, Finance
// Controle Strategie sur OpenEdition Journals -- mais leurs appels vivent a
// des endroits differents de chaque plateforme (verifie manuellement, cf
// commentaires plus bas), d'ou une extraction propre a chacune.
//
// Seules SIM et la RIPME partagent reellement le meme gabarit (le module
// Announcements standard d'OJS) : elles passent par la meme fonction.
//
// curl (meme curl-impersonate) passe en local mais se fait bloquer sur le
// runner GitHub Actions -- meme symptome que SAGE/Wiley (fingerprint reseau
// du runner CI, distinct d'un poste local) alors que ces pages sont du HTML
// statique sans anti-bot apparent en local. D'ou l'usage du navigateur
// (patchright, cf miScraper.mjs), qui contourne ce blocage specifique au CI.
const REQUEST_DELAY_MS = 1000;

// M@n@gement publie tous ses appels actifs sur une page statique unique,
// maintenue a la main par la redaction (PAS le module Announcements
// standard d'OJS). Chaque appel est un bloc <h1>Titre</h1>...contenu...
// jusqu'au <h1> suivant ; les appels sont separes par un <h1> de simples
// underscores (repere visuel, pas un appel).
const MGMT_CALL_URL = 'https://management-aims.com/index.php/mgmt/call';
const MGMT_JOURNAL = 'M@n@gement';
const MGMT_CONTAINER_SELECTOR = '#pkp_content_main';
const MGMT_SEPARATOR_PATTERN = /^_+$/;
const MGMT_PDF_LINK_SELECTOR = 'a[href*="/libraryFiles/downloadPublic/"]';

// La page /special_issues suggeree au depart ne contient en realite QUE la
// procedure interne de selection par le comite editorial -- confirme en
// lisant tout le HTML, aucun appel n'y est jamais liste (verifie aussi en
// changeant de locale). Les vrais appels vivent parmi les announcements
// generiques d'OJS (melanges a des appels a candidature de comite
// editorial, prix, etc.), d'ou le filtre sur le titre.
const SIM_ANNOUNCEMENT_LIST_URL = 'https://revuesim.org/index.php/sim/announcement';
const SIM_JOURNAL = "Systèmes d'information & management";

// La RIPME expose le meme module Announcements d'OJS que SIM, avec un
// balisage identique (memes classes obj_announcement_summary / _full,
// verifie sur le HTML reel des deux sites) et le meme melange d'appels et
// d'annonces sans rapport (voeux, deces de collegues, classement FNEGE,
// indexation Scopus) -- d'ou le meme filtre sur le titre.
//
// Le nom doit rester celui du CSV enrichi : "Revue internationale PME" seul
// ne matche pas (la colonne titre est "REVUE INTERNATIONALE PME (RIPME)",
// le "(RIPME)" fait partie de la cle normalisee), on passe donc par le
// nom_openalex, qui est aussi le titre affiche dans journals.json.
const RIPME_ANNOUNCEMENT_LIST_URL = 'https://revueinternationalepme.com/index.php/1/announcement';
const RIPME_JOURNAL = 'Revue internationale P M E Économie et gestion de la petite et moyenne entreprise';

// Deux pieges specifiques a la RIPME, absents chez SIM.
//
// 1. Sa page d'annonces est un archive permanent : les appels de 2017, 2018
//    ou 2020 y sont toujours listes, contrairement aux hubs editeurs qui
//    retirent les appels clos. Or diffChecker ne repasse un appel a
//    active:false que quand il DISPARAIT de sa source, et isActiveCall
//    (eleventy.config.mjs) ne regarde que ce drapeau, jamais l'echeance :
//    sans filtre, 14 appels morts s'afficheraient comme courants a vie.
//    On se limite donc aux annonces publiees recemment -- la date de
//    publication est dans le listing OJS (.date). Les fenetres de
//    soumission de la revue vont de 6 a 12 mois, 24 mois laisse donc une
//    marge confortable sans ratisser l'archive.
//    Filtre volontairement NON applique a SIM, dont le scraper fonctionne
//    et dont le plus vieil appel retenu (2023-11-21) est encore en base.
// 2. Le corps HTML d'une annonce ne contient jamais d'echeance : seulement
//    le titre, les redacteurs invites et un lien vers le PDF de l'appel
//    (verifie sur les annonces 68, 62 et 26). Sans le PDF, le LLM n'a
//    aucune date a extraire. On concatene donc son texte au contenu brut,
//    via fileParser.mjs comme le fait agrhScraper.
const RIPME_MAX_AGE_MONTHS = 24;
const RIPME_DATE_SELECTOR = '.date';
const RIPME_PDF_LINK_SELECTOR = 'a[href*="/libraryFiles/downloadPublic/"], a[href$=".pdf"]';

const OJS_SUMMARY_SELECTOR = 'article.obj_announcement_summary';
const OJS_FULL_SELECTOR = 'article.obj_announcement_full .description';
const OJS_TITLE_KEYWORD_PATTERN = /call for papers|call for special issue|special issue|appels?\s*(à|a)\s*(contribution|articles?)|num[ée]ro sp[ée]cial/i;

// Finance Controle Strategie est sur OpenEdition Journals, pas sur OJS. La
// revue tient elle-meme la separation ouvert/clos : /4651 "Appels en cours"
// et /4652 "Appels clos". On ne scrape que /4651 -- passer /4652 au LLM
// couterait une extraction par appel deja termine, sans rien apporter (le
// site n'affiche de toute facon que les appels actifs, et les appels clotures
// deja en base y restent archives).
const FCS_CALL_LIST_URL = 'https://journals.openedition.org/fcs/4651';
const FCS_JOURNAL = 'Finance Contrôle Stratégie';

// Confirme via le HTML reel de /4651 : chaque appel est un <li> de la
// <ul class="summary">, titre dans .title > a (href relatif, ex. "15601")
// et precisions dans .subtitle (lieu, date de la journee de recherche).
const FCS_LIST_ITEM_SELECTOR = 'ul.summary li';
const FCS_LIST_LINK_SELECTOR = '.title a[href]';
const FCS_LIST_SUBTITLE_SELECTOR = '.subtitle';

// Confirme via le HTML reel d'une page de detail : #main porte le titre et
// tout le corps de l'appel (~6600 caracteres sur l'appel en cours), #docBody
// le corps seul. On prend #main pour garder le titre dans le contenu envoye
// au LLM, comme le scraper Springer.
const FCS_DETAIL_SELECTOR = '#main';

// OpenEdition a mis en place Anubis (challenge JavaScript de preuve de
// travail) devant journals.openedition.org : curl, meme curl-impersonate,
// ne recoit qu'une page d'interstitiel de ~5 Ko contenant
// <script id="anubis_challenge">. patchright le resout tout seul, mais en
// ~2 secondes -- soit apres domcontentloaded, qui se declenche sur
// l'interstitiel. Sans cette attente on parse la page de challenge et on
// croit la revue vide. Meme logique que waitForCloudflare pour Emerald/T&F.
const ANUBIS_CHALLENGE_SELECTOR = '#anubis_challenge';

export const scraperObject = {
    url: MGMT_CALL_URL,
    abbreviation: 'ojsfr',
    async scraper(browser) {
        const abbreviation = this.abbreviation;

        // Une revue en echec (site down, structure changee) ne doit pas
        // empecher les autres de remonter leurs appels : chaque source est
        // traitee independamment, comme quand les scrapers etaient separes.
        const sources = [
            { label: 'M@n@gement', journal: MGMT_JOURNAL, getEntries: get_mgmt_entries },
            { label: 'SIM', journal: SIM_JOURNAL, getEntries: browser => get_ojs_announcement_entries(browser, SIM_ANNOUNCEMENT_LIST_URL, 'SIM') },
            { label: 'RIPME', journal: RIPME_JOURNAL, getEntries: browser => get_ojs_announcement_entries(browser, RIPME_ANNOUNCEMENT_LIST_URL, 'RIPME', { maxAgeMonths: RIPME_MAX_AGE_MONTHS, followPdf: true }) },
            { label: 'FCS', journal: FCS_JOURNAL, getEntries: get_fcs_entries },
        ];

        const calls = [];
        for (const [index, source] of sources.entries()) {
            if (index > 0) await sleep(REQUEST_DELAY_MS);

            const issn = await matchIssn(source.journal);
            if (!issn) {
                console.warn(`[ojsfr] "${source.journal}" introuvable dans le CSV ISSN, ${source.label} ignoree`);
                continue;
            }

            const entries = await source.getEntries(browser);
            console.log(`[ojsfr] ${source.label} : ${entries.length} appel(s) trouve(s)`);
            for (const entry of entries) {
                calls.push({ journal: source.journal, abbreviation, issn, metaTitle: entry.metaTitle, url: entry.url, rawContent: entry.rawContent });
            }
        }

        return calls;
    }
}

async function get_mgmt_entries(browser) {
    const html = await get_page_html(browser, MGMT_CALL_URL, '[ojsfr]');
    if (!html) return [];

    const $ = cheerio.load(html);
    const container = $(MGMT_CONTAINER_SELECTOR).first();
    if (container.length === 0) {
        console.warn(`[ojsfr] Conteneur ${MGMT_CONTAINER_SELECTOR} introuvable sur ${MGMT_CALL_URL} (structure modifiee ?)`);
        return [];
    }

    const entries = extract_mgmt_entries(container.html() ?? '');
    if (entries.length === 0) {
        console.log(`[ojsfr] M@n@gement : conteneur trouve mais aucun <h1> d'appel dedans (page peut-etre vide en ce moment)`);
    }
    return entries;
}

function extract_mgmt_entries(containerHtml) {
    const $ = cheerio.load(containerHtml);

    // Meme technique que le scraper SAGE : positionne chaque <h1> dans le
    // HTML source via un curseur croissant (pas d'offset natif en cheerio).
    const headings = $('h1').toArray();
    let cursor = 0;
    const positioned = [];
    for (const h of headings) {
        const outer = $.html(h);
        const index = containerHtml.indexOf(outer, cursor);
        if (index === -1) continue;
        positioned.push({ text: heading_text($, h), index });
        cursor = index + outer.length;
    }

    const entries = [];
    for (let i = 0; i < positioned.length; i++) {
        const { text, index } = positioned[i];
        if (MGMT_SEPARATOR_PATTERN.test(text)) continue;

        const nextIndex = positioned[i + 1]?.index ?? containerHtml.length;
        const block = containerHtml.slice(index, nextIndex);
        const blockDollar = cheerio.load(block);
        const pdfHref = blockDollar(MGMT_PDF_LINK_SELECTOR).first().attr('href');

        entries.push({
            metaTitle: text,
            // Pas d'URL par-appel sur cette page statique : le PDF telecharge
            // par l'appel (stable, un identifiant par appel) sert d'URL unique.
            url: pdfHref ? new URL(pdfHref, MGMT_CALL_URL).href : `${MGMT_CALL_URL}#${encodeURIComponent(text)}`,
            rawContent: block,
        });
    }
    return entries;
}

// Les titres M@n@gement contiennent des <br> internes (retour a la ligne
// manuel) -- .text() seul les fait disparaitre sans espace ("cases,and
// forgotten" au lieu de "cases, and forgotten"), d'ou ce remplacement prealable.
function heading_text($, el) {
    const clone = $(el).clone();
    clone.find('br').replaceWith(' ');
    return clone.text().replace(/\s+/g, ' ').trim();
}

// Module Announcements standard d'OJS, partage par SIM et la RIPME.
// options.maxAgeMonths : ignore les annonces publiees avant ce delai.
// options.followPdf    : concatene le texte du PDF lie au contenu brut.
// Les deux sont utilisees par la RIPME seule, cf. commentaires plus haut.
async function get_ojs_announcement_entries(browser, listUrl, label, options = {}) {
    const html = await get_page_html(browser, listUrl, '[ojsfr]');
    if (!html) return [];

    const cutoff = options.maxAgeMonths
        ? new Date(new Date().setMonth(new Date().getMonth() - options.maxAgeMonths))
        : null;

    const $ = cheerio.load(html);
    const candidates = [];
    let tooOldCount = 0;
    $(OJS_SUMMARY_SELECTOR).each((_, el) => {
        const link = $(el).find('h2 a[href]').first();
        const title = link.text().trim();
        const href = link.attr('href');
        if (!title || !href || !OJS_TITLE_KEYWORD_PATTERN.test(title)) return;

        if (cutoff) {
            const posted = Date.parse($(el).find(RIPME_DATE_SELECTOR).first().text().trim());
            // Date illisible : on garde l'annonce plutot que de la perdre en
            // silence, quitte a laisser passer un appel clos.
            if (!Number.isNaN(posted) && posted < cutoff.getTime()) {
                tooOldCount++;
                return;
            }
        }

        candidates.push({ title, url: new URL(href, listUrl).href });
    });
    console.log(`[ojsfr] ${label} : ${candidates.length} announcement(s) "call for papers" trouve(s) sur ${$(OJS_SUMMARY_SELECTOR).length} au total, recuperation du detail`);
    if (tooOldCount > 0) {
        console.log(`[ojsfr] ${label} : ${tooOldCount} annonce(s) ecartee(s), publiee(s) il y a plus de ${options.maxAgeMonths} mois`);
    }

    const entries = [];
    for (const candidate of candidates) {
        await sleep(REQUEST_DELAY_MS);
        const detail = await get_ojs_announcement_detail(browser, candidate.url, options.followPdf);
        if (!detail) continue;
        entries.push({ metaTitle: candidate.title, url: candidate.url, rawContent: detail });
    }
    return entries;
}

async function get_ojs_announcement_detail(browser, url, followPdf) {
    const html = await get_page_html(browser, url, '[ojsfr]');
    if (!html) return null;

    const $ = cheerio.load(html);
    const description = $(OJS_FULL_SELECTOR).first();
    if (description.length === 0) {
        console.warn(`[ojsfr] Contenu (${OJS_FULL_SELECTOR}) introuvable sur ${url} (structure modifiee ?)`);
        return null;
    }

    const content = description.html() ?? '';
    if (!followPdf) return content;

    const pdfHref = description.find(RIPME_PDF_LINK_SELECTOR).first().attr('href');
    if (!pdfHref) {
        console.warn(`[ojsfr] Aucun PDF d'appel lie sur ${url}, echeances probablement absentes`);
        return content;
    }

    // Un PDF illisible (lien mort, format inattendu) ne doit pas faire
    // perdre l'appel : on retombe sur le seul contenu HTML.
    try {
        const pdfText = await parsePdf(browser, new URL(pdfHref, url).href);
        if (!pdfText) return content;
        return `${content}\n<hr>\n<pre>${pdfText}</pre>`;
    } catch (error) {
        console.warn(`[ojsfr] Lecture du PDF ${pdfHref} impossible : ${error.message}`);
        return content;
    }
}

async function get_fcs_entries(browser) {
    const html = await get_page_html(browser, FCS_CALL_LIST_URL, '[ojsfr]', wait_for_anubis);
    if (!html) return [];

    const $ = cheerio.load(html);
    const candidates = [];
    $(FCS_LIST_ITEM_SELECTOR).each((_, el) => {
        const link = $(el).find(FCS_LIST_LINK_SELECTOR).first();
        const title = link.text().replace(/\s+/g, ' ').trim();
        const href = link.attr('href');
        if (!title || !href) return;
        // Le sous-titre porte le lieu et la date de la journee de recherche,
        // absents du titre : on le garde dans le libelle transmis au LLM.
        const subtitle = $(el).find(FCS_LIST_SUBTITLE_SELECTOR).first().text().replace(/\s+/g, ' ').trim();
        candidates.push({
            title: subtitle ? `${title} — ${subtitle}` : title,
            url: new URL(href, FCS_CALL_LIST_URL).href,
        });
    });
    console.log(`[ojsfr] FCS : ${candidates.length} appel(s) en cours listes, recuperation du detail`);

    const entries = [];
    for (const candidate of candidates) {
        await sleep(REQUEST_DELAY_MS);
        const detail = await get_fcs_detail(browser, candidate.url);
        if (!detail) continue;
        entries.push({ metaTitle: candidate.title, url: candidate.url, rawContent: detail });
    }
    return entries;
}

async function get_fcs_detail(browser, url) {
    const html = await get_page_html(browser, url, '[ojsfr]', wait_for_anubis);
    if (!html) return null;

    const $ = cheerio.load(html);
    const content = $(FCS_DETAIL_SELECTOR).first();
    if (content.length === 0) {
        console.warn(`[ojsfr] Contenu (${FCS_DETAIL_SELECTOR}) introuvable sur ${url} (structure modifiee ?)`);
        return null;
    }
    return content.html() ?? null;
}

async function wait_for_anubis(page, url) {
    try {
        await page.waitForFunction(
            selector => !document.querySelector(selector),
            ANUBIS_CHALLENGE_SELECTOR,
            { timeout: 30000 }
        );
    } catch (error) {
        console.warn(`[ojsfr] Challenge Anubis non resolu apres 30s sur ${url} : ${error.message}`);
    }
}

async function get_page_html(browser, url, logPrefix, afterNavigation) {
    const page = await browser.newPage();
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        if (afterNavigation) await afterNavigation(page, url);
        return await page.content();
    } catch (error) {
        console.warn(`${logPrefix} Erreur (timeout ou navigation) sur ${url} : ${error.message}`);
        return null;
    } finally {
        await page.close();
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
