import * as cheerio from 'cheerio';
import { mkdtempSync } from 'fs';
import path from 'path';
import os from 'os';
import { getJournalsByPublisher } from '../issnMatcher.mjs';
import { curlGet } from '../curlClient.mjs';

const PUBLISHER_NAME = 'Wiley';

// Le navigateur automatise (meme profil persistant que les autres
// scrapers) recoit systematiquement une page de connexion a la place du
// contenu reel -- Wiley bloque specifiquement ce fingerprint. Un simple
// fetch marche en curl (verifie manuellement) mais PAS avec fetch() natif
// de Node : undici a son propre fingerprint TLS/HTTP, distinct de celui de
// curl (qui passe par Schannel sous Windows) et reconnu/filtre separement
// par Cloudflare. Solution retenue : shell out vers curl plutot que
// d'utiliser fetch() -- curl gere aussi nativement les cookies et
// redirections via son cookie jar fichier, ce qui evite de reimplementer
// cette logique en JS. MEME PIEGE ENSUITE avec curl standard sous Linux/
// GitHub Actions (fingerprint OpenSSL bloque, la ou Schannel sous Windows
// passe) : curlClient.mjs utilise curl-impersonate quand il est installe
// (cf .github/workflows/scrape.yml) pour rejouer un fingerprint de vrai
// navigateur, et retombe sur curl standard sinon.
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const COOKIE_JAR_PATH = path.join(mkdtempSync(path.join(os.tmpdir(), 'wiley-cookies-')), 'cookies.txt');

// Pas de schema d'URL unique : verifie manuellement, differentes revues
// utilisent differents chemins selon l'anciennete/le redesign (ex.
// specialissues.html pour l'une, call_for_papers pour une autre -- 404 sur
// les chemins de l'autre a chaque fois). On essaie plusieurs candidats par
// revue, chacun etant un fetch leger (pas un chargement de page complet).
const PATH_CANDIDATES = [
    { prefix: 'page', path: 'homepage/specialissues.html' },
    { prefix: 'page', path: 'homepage/call_for_papers' },
    { prefix: 'page', path: 'homepage/call-for-papers' },
    { prefix: 'page', path: 'homepage/callforpapers' },
    { prefix: 'page', path: 'call-for-papers' },
    { prefix: 'plain', path: 'specialissues' },
    { prefix: 'plain', path: 'calls-for-papers' },
];

function build_urls(issn) {
    const issnSlug = issn.replace(/-/g, '').toLowerCase();
    return PATH_CANDIDATES.map(c => c.prefix === 'page'
        ? `https://onlinelibrary.wiley.com/page/journal/${issnSlug}/${c.path}`
        : `https://onlinelibrary.wiley.com/journal/${issnSlug}/${c.path}`
    );
}

// Meme structure de contenu que decouverte precedemment : la page melange
// trois sections sous des h2 distincts, seule la premiere nous interesse :
//   "Special Issue Calls for Papers"   -> les vrais appels ouverts (garde)
//   "Call For Special Issue Proposals" -> processus pour proposer un futur
//                                          numero special, pas un appel
//   "Latest Special Issues"            -> numeros deja publies
// Chaque appel dans la premiere section est un groupe de <p> separes par
// des <hr>.
const SECTION_HEADING_PATTERN = /call.*for.*papers|special issue calls/i;
const NON_CALL_LINK_TEXT_PATTERN = /^(author guidelines|submission guidelines|guide for authors)$/i;

// Un delai trop court entre requetes declenche un challenge Cloudflare
// (rate-limiting/comportemental) apres un certain volume -- constate en
// pratique lors des tests (les premieres dizaines de revues passent, puis
// Cloudflare commence a repondre "Just a moment..."). 1s reste rapide pour
// ~85 revues x quelques candidats mais parait moins automatise.
const REQUEST_DELAY_MS = 1000;
const CHALLENGE_PATTERN = /Just a moment|cf_chl_opt|challenges\.cloudflare\.com/i;
const MAX_DEBUG_LOGS = 5;
let noHeadingLogCount = 0;
let noLinkLogCount = 0;
let challengeLogged = false;

export const scraperObject = {
    url: 'https://onlinelibrary.wiley.com/',
    abbreviation: 'wiley',
    async scraper() {
        const abbreviation = this.abbreviation;

        const journals = await getJournalsByPublisher(PUBLISHER_NAME);
        console.log(`[wiley] ${journals.length} revue(s) a traiter`);

        const calls = [];
        const motifs = { bloque: 0, absent: 0, reseau: 0, autre: 0 };
        let atteintes = 0;
        for (const journal of journals) {
            const resultat = await find_page(journal.nomOpenalex, build_urls(journal.issn));
            if (!resultat.page) {
                motifs[resultat.motif] += 1;
                continue;
            }
            atteintes += 1;

            const entries = extract_entries(resultat.page.html, resultat.page.url, journal.nomOpenalex);
            for (const entry of entries) {
                calls.push({
                    journal: journal.nomOpenalex,
                    abbreviation,
                    issn: journal.issn,
                    metaTitle: entry.metaTitle,
                    url: entry.url,
                    rawContent: entry.rawContent,
                });
            }
        }
        console.log(`[wiley] ${calls.length} appel(s) trouve(s) sur ${atteintes} revue(s) atteinte(s)`);
        // Un blocage n'est pas une absence : il passe en avertissement, avec sa
        // cause probable, parce qu'il se repare (curl-impersonate) la ou une
        // page reellement absente ne se repare pas.
        if (motifs.bloque) {
            console.warn(`[wiley] ${motifs.bloque} revue(s) BLOQUEE(S) : 403 ou redirection vers un challenge Cloudflare. Leur page existe peut-etre. Cause la plus frequente : curl-impersonate absent du systeme, curl standard etant filtre sur son empreinte TLS.`);
        }
        if (motifs.absent) {
            console.log(`[wiley] ${motifs.absent} revue(s) sans page de calls-for-papers (404 sur les ${PATH_CANDIDATES.length} chemins essayes)`);
        }
        if (motifs.reseau) {
            console.warn(`[wiley] ${motifs.reseau} revue(s) injoignable(s) (erreur reseau sur tous les chemins)`);
        }
        if (motifs.autre) {
            console.warn(`[wiley] ${motifs.autre} revue(s) ecartee(s) sur un statut inattendu (ni 200, ni 404, ni blocage)`);
        }

        return calls;
    }
}

// Pourquoi aucune des URL candidates n'a rendu de page.
//
// Le compteur disait « aucun des chemins d'URL essayes n'a repondu » quel que
// soit le motif. C'etait faux et trompeur : verifie le 2026-09-03 sur quatre
// revues portant des appels actifs (Gender Work and Organization, Journal of
// Product Innovation Management, Information Systems Journal, Psychology and
// Marketing), les chemins ont bien repondu -- 403 ou 302 -- et les pages
// existent, a des URL que cette fonction essaie deja. Un navigateur y obtient
// 200 et plus de 100 Ko. Le blocage vient de curl standard, dont l'empreinte
// TLS Schannel est filtree par Cloudflare quand curl-impersonate n'est pas
// installe. Rapporter cela comme une page absente envoie le prochain
// diagnostic sur une fausse piste : on cherche des chemins d'URL alors que le
// probleme est le client HTTP.
//
// L'ordre des tests compte : le blocage l'emporte, parce qu'il masque tout le
// reste -- une revue bloquee peut aussi bien avoir une page qu'aucune, on n'en
// sait rien.
// Fonction pure, exportee pour test.
export function classerTentatives(tentatives) {
    if (!tentatives.length) return 'autre';
    // 403 ou redirection : chez Wiley, les deux menent au challenge Cloudflare.
    if (tentatives.some(t => t.challenge || t.statut === 403 || (t.statut >= 300 && t.statut < 400))) return 'bloque';
    if (tentatives.some(t => t.erreur)) return 'reseau';
    if (tentatives.every(t => t.statut === 404)) return 'absent';
    return 'autre';
}

// Essaie chaque URL candidate jusqu'a en trouver une qui repond 200.
// Rend { page } en cas de succes, { motif } sinon -- l'appelant compte les
// motifs separement au lieu de tout verser dans « page introuvable ».
async function find_page(journalName, urls) {
    const tentatives = [];
    for (const url of urls) {
        await sleep(REQUEST_DELAY_MS);
        try {
            const response = await curlGet(url, { cookieJarPath: COOKIE_JAR_PATH, userAgent: USER_AGENT });
            if (response.status === 200) {
                return { page: { html: response.body, url } };
            }
            const challenge = CHALLENGE_PATTERN.test(response.body ?? '');
            tentatives.push({ statut: response.status, challenge });
            if (!challengeLogged && challenge) {
                challengeLogged = true;
                console.warn(`[wiley] Challenge Cloudflare detecte sur ${url} (statut ${response.status}) -- augmenter REQUEST_DELAY_MS si ca se reproduit souvent.`);
            }
        } catch (error) {
            tentatives.push({ erreur: error.message });
            console.warn(`[wiley] "${journalName}" : erreur reseau sur ${url} : ${error.message}`);
        }
    }
    return { motif: classerTentatives(tentatives) };
}

export function extract_entries(html, pageUrl, journalName) {
    const $ = cheerio.load(html);

    // Structure moderne Wiley : chaque appel est un bloc autonome
    // .DST-CFP-listing-item (titre en h3 > a, echeance dans
    // p.DST-CFP-listing-item__deadline). Le premier bloc porte le
    // modificateur --intro : c'est le chapeau de la section (h2 "Calls for
    // Papers" + texte de presentation), pas un appel. Cette structure ne
    // passe pas par la decoupe h2/hr ci-dessous, d'ou une strategie propre
    // essayee en premier ; les revues encore sur l'ancien gabarit
    // retombent sur la logique historique.
    const listingEntries = extract_listing_items($, pageUrl);
    if (listingEntries.length > 0) {
        return listingEntries;
    }

    const headings = $('h2').toArray();
    const startHeading = headings.find(h => SECTION_HEADING_PATTERN.test($(h).text()));

    if (!startHeading) {
        if (noHeadingLogCount < MAX_DEBUG_LOGS) {
            noHeadingLogCount++;
            console.warn(`[wiley] "${journalName}" : aucun h2 "call...for...papers" trouve sur ${pageUrl}. Titres h2 presents : ${headings.map(h => $(h).text().trim()).join(' | ')}`);
        }
        return [];
    }

    const sectionNodes = $(startHeading).nextUntil('h2').toArray();
    const groups = sectionNodes.some(node => node.tagName === 'hr')
        ? split_on_separators(sectionNodes)
        : split_on_call_links($, sectionNodes);

    const entries = groups
        .map(group => {
            let link = null;
            for (const node of group) {
                link = find_call_link($, node);
                if (link) break;
            }
            return {
                metaTitle: link ? link.text().trim() : null,
                url: link ? new URL(link.attr('href'), pageUrl).href : null,
                rawContent: group.map(n => $.html(n)).join(''),
            };
        })
        .filter(entry => entry.metaTitle && entry.url);

    if (entries.length === 0 && noLinkLogCount < MAX_DEBUG_LOGS) {
        noLinkLogCount++;
        const debugHtml = sectionNodes.map(n => $.html(n)).join('').slice(0, 500);
        console.warn(`[wiley] "${journalName}" : section trouvee mais aucun lien d'appel extrait sur ${pageUrl}. Debut du contenu : ${debugHtml}`);
    }

    return entries;
}

// Ignore les liens mail obscurcis par Cloudflare
// (/cdn-cgi/l/email-protection, texte affiche "[email protected]"), les
// mailto: directs, et les liens de navigation generiques (ex. "Author
// Guidelines" dans le paragraphe d'intro) -- jamais le vrai lien d'un appel.
function find_call_link($, node) {
    return $(node).find('a[href]').toArray()
        .map(a => $(a))
        .find(a => {
            const href = a.attr('href') ?? '';
            const text = a.text().trim();
            return !href.includes('cdn-cgi/l/email-protection')
                && !href.startsWith('mailto:')
                && !NON_CALL_LINK_TEXT_PATTERN.test(text);
        }) ?? null;
}

function split_on_separators(nodes) {
    const groups = [];
    let current = [];
    for (const node of nodes) {
        if (node.tagName === 'hr') {
            if (current.length) groups.push(current);
            current = [];
        } else {
            current.push(node);
        }
    }
    if (current.length) groups.push(current);
    return groups;
}

// Certaines sections listent plusieurs appels sans aucun <hr> (ex. Journal
// of Management Studies : quatre <p>, chacun avec son lien PDF et sa propre
// echeance). Sans separateur, la decoupe ci-dessus renvoie un groupe unique
// qui agglomere tous les appels : un seul enregistrement, avec le titre du
// premier et les echeances de tous les autres dans le rawContent. On repli
// donc sur un decoupage par lien : un nouveau groupe demarre des qu'un noeud
// porte un lien d'appel alors que le groupe courant en a deja un. Les noeuds
// sans lien (chapeau, precisions) restent rattaches au groupe en cours.
function split_on_call_links($, nodes) {
    const groups = [];
    let current = [];
    let currentHasLink = false;
    for (const node of nodes) {
        const hasLink = Boolean(find_call_link($, node));
        if (hasLink && currentHasLink) {
            groups.push(current);
            current = [];
            currentHasLink = false;
        }
        current.push(node);
        currentHasLink = currentHasLink || hasLink;
    }
    if (current.length) groups.push(current);
    return groups;
}

function extract_listing_items($, pageUrl) {
    return $('.DST-CFP-listing-item:not(.DST-CFP-listing-item--intro)').toArray()
        .map(item => {
            const link = $(item).find('h3 a[href]').first();
            if (link.length === 0) return null;
            return {
                metaTitle: link.text().trim(),
                url: new URL(link.attr('href'), pageUrl).href,
                rawContent: $.html(item),
            };
        })
        .filter(entry => entry && entry.metaTitle && entry.url);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
