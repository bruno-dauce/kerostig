import { matchIssn } from '../issnMatcher.mjs';
import { parse as parsePdf } from '../fileParser.mjs';

const BASE_URL = 'https://www.apa.org';

// robots.txt de apa.org : "Crawl-delay: 1" pour User-agent *. On s'y tient.
const REQUEST_DELAY_MS = 1000;

// Pas de hub exploitable chez l'APA : /pubs/journals/resources/calls-for-papers
// regroupe bien les appels de toutes les revues APA, mais melange les ~70 revues
// du catalogue (dont une large majorite hors perimetre FNEGE) et n'y liste que
// celles ayant un appel actif. Chaque revue expose en revanche sa propre page
// d'appels sur le meme patron d'URL (les 4 confirmees dans le sitemap
// apa.org/sitemap.xml, seule ressource du site accessible sans navigateur).
// Le slug APA est un code court a 3 lettres, indeduisible du nom FNEGE, d'ou la
// liste en dur -- meme logique que cupScraper.
const JOURNALS = [
    { slug: 'apl', name: 'Journal of Applied Psychology' },
    { slug: 'ocp', name: 'Journal of Occupational Health Psychology' },
    { slug: 'psp', name: 'Journal of Personality and Social Psychology' },
    { slug: 'gdn', name: 'Group Dynamics Theory Research and Practice' },
];

// Le CMS de l'APA emboite #maincontent (page entiere) puis #ctcol (la colonne
// de contenu, aussi porteuse de la balise <main>). La presence de l'un d'eux
// signale une page reellement rendue, donc un challenge Incapsula franchi ; on
// extrait ensuite depuis le plus interne des trois presents.
//
// ATTENTION : ne pas ajouter .main-region a cette chaine. Cette classe change de
// place selon le gabarit -- enfant de #ctcol sur une page de liste, mais parent
// de #ctcol sur une page d'appel -- et ramenerait alors toute la page.
const PAGE_READY_SELECTOR = '#ctcol, #maincontent, main';
const CONTENT_SELECTORS = ['#ctcol', '#maincontent', 'main'];

// Sur une page d'appel, le corps est decoupe en blocs .article-body (un par
// section : Instructions, Review process...) et le titre vit dans le <hgroup>
// qui les precede, hors de ces blocs. On concatene les deux : llmParser.mjs
// n'envoie au modele que rawContent, le titre doit donc y figurer. Cadrer ainsi
// evite de faire dependre le contentHash des encarts de la colonne (promo
// newsletter, liens sociaux), qui bougent sans que l'appel ait change et
// declencheraient une re-extraction payante a chaque passage.
const CALL_TITLE_SELECTOR = 'hgroup.pageHeader';
const CALL_BODY_SELECTOR = '.article-body';

// Structure reelle d'une page d'appels de revue (verifiee sur apl) :
//   <div class="journal-block journal-calls-for-papers-block">
//     <section class="linkWidget link square">
//       <div class="module first last">
//         <a class="module-link" href="/pubs/journals/apl/integrative-conceptual-reviews.html">
//           <div class="bodyleft">
//             <p class="title">Integrative conceptual reviews</p>
//             <div class="wysiwyg lengthy">The Journal of Applied Psychology invites...</div>
// Le lien enveloppe toute la carte : son textContent concatene le titre et le
// chapo, d'ou la lecture du titre dans <p class="title"> plutot que dans <a>.
//
// ATTENTION : ne pas elargir la recherche a la colonne de contenu entiere. La
// page porte un second bloc .journal-general-calls-block ("le JAP accepte aussi
// les soumissions generales") monte sur le meme gabarit .module, et un pied de
// page dont les liens vivent dans des blocs .wysiwyg -- c'est en visant .wysiwyg
// que la premiere version de ce scraper ne remontait que des liens de
// newsletters, tous ecartes ensuite, donc zero appel.
const CALLS_BLOCK_SELECTOR = '.journal-calls-for-papers-block';
const CALL_CARD_SELECTOR = '.module';
const CARD_TITLE_SELECTOR = 'p.title';
const CARD_LINK_SELECTOR = 'a[href]';

// Une revue sans appel en cours n'affiche pas de bloc d'appels vide : le bloc
// est absent de la page. Son absence apres ce delai vaut donc "aucun appel",
// pas "page cassee" -- delai court, la page est deja rendue a ce stade.
const CALLS_BLOCK_TIMEOUT_MS = 5000;

// Le site est derriere Incapsula, qui repond 200 avec une page de challenge
// (script /_Incapsula_Resource, ou iframe "Request unsuccessful. Incapsula
// incident ID"). Sans navigateur, c'est ce qu'on obtient sur 100 % des pages du
// site -- y compris via web.archive.org, dont une capture sur deux est un
// challenge. patchright doit donc resoudre le challenge : on attend le
// conteneur de contenu plutot que la fin du chargement, l'attente survivant au
// rechargement declenche par Incapsula.
const INCAPSULA_PATTERN = /_Incapsula_Resource|Incapsula incident/i;
const CONTENT_TIMEOUT_MS = 45000;

// Filet de securite en cas de derive du gabarit : le bloc d'appels est deja
// selectif, on se contente donc d'ecarter les pages de service que toute revue
// APA porte sous /pubs/journals/{slug}/ et les pages d'article, numerotees
// (ex. /pubs/journals/apl/2040213). Le filtre porte sur le dernier segment de
// l'URL, extension comprise : les liens de la page melangent les deux formes
// (integrative-conceptual-reviews.html mais submit sans extension).
//
// Un appel est une page fille d'une revue, /pubs/journals/{slug}/{page} : ce
// motif ecarte a lui seul les liens de rubrique du pied de colonne
// (/pubs/journals/contact, /pubs/highlights/spotlight, /news/...) et la page
// d'accueil de la revue elle-meme. La revue n'est volontairement pas contrainte
// a celle en cours de collecte : un appel conjoint a plusieurs revues APA est
// publie sous l'une d'elles seulement, et reste un appel legitime des autres.
const CALL_PATH_PATTERN = /^\/pubs\/journals\/[^/]+\/[^/]+/;
const NON_CALL_SLUGS = new Set([
    'about',
    'calls-for-papers',
    'editorial-board',
    'index',
    'pricing',
    'publishing-policies',
    'sample',
    'special-issues',
    'spotlight',
    'submit',
]);
const NON_CALL_SLUG_PATTERNS = [
    /^\d+$/,                 // pages d'article (ex. 2040213)
    /^edboard-/,             // comites de section (ex. edboard-irgp)
    /^best-article-award/,   // prix de la revue
];

// Certains appels APA sont intitules "General call for papers" (verifie sur le
// hub) : deux revues peuvent donc produire le meme metaTitle, et le slug
// (abbreviation + metaTitle, cf dataPreparation.mjs) les confondrait, l'ordre du
// suffixe "-2" pouvant s'inverser d'un run a l'autre. On desambiguise ces seuls
// titres generiques par le nom de la revue.
const GENERIC_TITLE_PATTERN = /^(general\s+)?calls?\s+for\s+papers?$/i;

export const scraperObject = {
    url: `${BASE_URL}/pubs/journals/apl/calls-for-papers`,
    abbreviation: 'apa',
    async scraper(browser) {
        const abbreviation = this.abbreviation;

        const calls = [];
        let blockedCount = 0;
        for (const journal of JOURNALS) {
            const issn = await matchIssn(journal.name);
            if (!issn) {
                console.warn(`[apa] "${journal.name}" non trouve dans le CSV ISSN, verifier l'orthographe`);
                continue;
            }

            const listingUrl = `${BASE_URL}/pubs/journals/${journal.slug}/calls-for-papers`;
            await sleep(REQUEST_DELAY_MS);
            const listings = await get_listings(browser, journal, listingUrl);
            if (listings === null) {
                blockedCount++;
                continue;
            }
            if (listings.length === 0) {
                console.log(`[apa] Aucun appel pour "${journal.name}" (${listingUrl})`);
                continue;
            }

            for (const listing of listings) {
                await sleep(REQUEST_DELAY_MS);
                const rawContent = await get_raw_content(browser, listing.url);
                if (!rawContent) continue;
                calls.push({
                    journal: journal.name,
                    abbreviation,
                    issn,
                    metaTitle: build_meta_title(listing.metaTitle, journal.name),
                    url: listing.url,
                    rawContent,
                });
            }
        }

        if (blockedCount > 0) {
            console.warn(`[apa] ${blockedCount} revue(s) sur ${JOURNALS.length} inaccessibles : challenge Incapsula non resolu`);
        }
        console.log(`[apa] ${calls.length} appel(s) trouve(s) sur ${JOURNALS.length} revue(s)`);

        return calls;
    }
}

// Renvoie les appels listes sur la page d'une revue, ou null si la page n'a pas
// pu etre lue (challenge Incapsula, timeout) -- distinction volontaire avec le
// tableau vide, qui signifie "page lue, aucun appel en cours".
async function get_listings(browser, journal, listingUrl) {
    const page = await browser.newPage();
    try {
        await page.goto(listingUrl, { waitUntil: 'domcontentloaded', timeout: CONTENT_TIMEOUT_MS });

        const contentSelector = await wait_for_content(page);
        if (!contentSelector) {
            await report_unreadable_page(page, journal, listingUrl);
            return null;
        }

        const hasCallsBlock = await page.waitForSelector(CALLS_BLOCK_SELECTOR, { timeout: CALLS_BLOCK_TIMEOUT_MS })
            .then(() => true)
            .catch(() => false);
        if (!hasCallsBlock) return [];

        const cards = await page.$$eval(
            `${CALLS_BLOCK_SELECTOR} ${CALL_CARD_SELECTOR}`,
            (modules, selectors) => modules.map(module => ({
                title: module.querySelector(selectors.title)?.textContent ?? '',
                fallbackTitle: module.querySelector(selectors.link)?.textContent ?? '',
                href: module.querySelector(selectors.link)?.getAttribute('href') ?? null,
            })),
            { title: CARD_TITLE_SELECTOR, link: CARD_LINK_SELECTOR }
        );

        return dedupe_listings(cards.map(parse_listing).filter(is_call_listing));
    } catch (error) {
        console.warn(`[apa] Erreur (timeout ou navigation) sur ${listingUrl} : ${error.message}`);
        return null;
    } finally {
        await page.close();
    }
}

// Renvoie le selecteur du conteneur de contenu le plus interne present, ou null
// si la page n'a jamais fini de se rendre (challenge Incapsula, timeout). Une
// seule attente pour toute la chaine : les selecteurs de repli sont ensuite lus
// sans attendre, sinon une page au gabarit inattendu couterait un timeout plein
// par selecteur.
async function wait_for_content(page) {
    const ready = await page.waitForSelector(PAGE_READY_SELECTOR, { timeout: CONTENT_TIMEOUT_MS })
        .then(() => true)
        .catch(() => false);
    if (!ready) return null;

    return await page.evaluate(
        selectors => selectors.find(selector => document.querySelector(selector)) ?? null,
        CONTENT_SELECTORS
    );
}

async function report_unreadable_page(page, journal, url) {
    const html = await page.content().catch(() => '');
    if (INCAPSULA_PATTERN.test(html)) {
        console.warn(`[apa] Challenge Incapsula non resolu pour "${journal.name}" (${url}) : 0 appel remonte pour cette revue`);
    } else {
        console.warn(`[apa] Conteneur de contenu introuvable pour "${journal.name}" (${url}) : gabarit APA modifie ?`);
    }
}

// Fonction pure, exportee pour pouvoir etre testee sur un extrait de HTML reel.
export function parse_listing(card) {
    const metaTitle = normalize_space(card.title) || normalize_space(card.fallbackTitle);
    if (!metaTitle || !card.href) return null;
    let url;
    try {
        url = new URL(card.href, BASE_URL);
    } catch {
        return null;
    }
    return { metaTitle, url: url.href, pathname: url.pathname, host: url.host };
}

// Fonction pure, exportee pour pouvoir etre testee isolement. Les liens sortants
// (Editorial Manager, PsycNet, APA Style) et les pages de service sont ecartes.
export function is_call_listing(listing) {
    if (!listing) return false;
    if (listing.host !== 'www.apa.org') return false;
    if (!CALL_PATH_PATTERN.test(listing.pathname)) return false;

    const segments = listing.pathname.replace(/\/$/, '').split('/');
    const slug = decodeURIComponent(segments[segments.length - 1] ?? '')
        .toLowerCase()
        .replace(/\.(html?|aspx)$/, '');
    if (!slug) return false;
    if (NON_CALL_SLUGS.has(slug)) return false;
    return !NON_CALL_SLUG_PATTERNS.some(pattern => pattern.test(slug));
}

function normalize_space(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
}

function dedupe_listings(listings) {
    const listingsByUrl = new Map();
    for (const listing of listings) {
        if (!listingsByUrl.has(listing.url)) listingsByUrl.set(listing.url, listing);
    }
    return [...listingsByUrl.values()];
}

// Fonction pure, exportee pour pouvoir etre testee isolement.
export function build_meta_title(metaTitle, journalName) {
    return GENERIC_TITLE_PATTERN.test(metaTitle) ? `${metaTitle} - ${journalName}` : metaTitle;
}

// Quelques appels APA sont deposes en PDF plutot qu'en page (ex.
// /pubs/journals/ocp/ocp-preventing-interpersonal-stressors-work-pdf), comme
// chez AAA : on en extrait le texte via fileParser.mjs. Le suffixe "-pdf" de
// l'URL ne suffit pas a les reconnaitre a coup sur (certaines de ces pages sont
// des pages HTML de presentation), on ne se fie donc qu'a l'extension.
async function get_raw_content(browser, url) {
    if (/\.pdf(\?|#|$)/i.test(url)) return get_pdf_content(browser, url);
    return get_page_content(browser, url);
}

async function get_pdf_content(browser, url) {
    try {
        const content = await parsePdf(browser, url);
        if (!content || content.trim().length === 0) {
            console.warn(`[apa] PDF vide ou illisible : ${url}`);
            return null;
        }
        return content;
    } catch (error) {
        console.warn(`[apa] Erreur lors de l'extraction du PDF ${url} : ${error.message}`);
        return null;
    }
}

async function get_page_content(browser, url) {
    const page = await browser.newPage();
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: CONTENT_TIMEOUT_MS });

        const contentSelector = await wait_for_content(page);
        if (!contentSelector) {
            const html = await page.content().catch(() => '');
            const cause = INCAPSULA_PATTERN.test(html) ? 'challenge Incapsula non resolu' : 'conteneur de contenu introuvable';
            console.warn(`[apa] Extraction du contenu brut echouee pour ${url} : ${cause}`);
            return null;
        }

        return await extract_raw_content(page, contentSelector);
    } catch (error) {
        console.warn(`[apa] Erreur (timeout ou navigation) sur ${url} : ${error.message}`);
        return null;
    } finally {
        await page.close();
    }
}

// Titre + blocs de corps quand la page suit le gabarit d'appel ; a defaut (page
// montee autrement), toute la colonne de contenu, quitte a embarquer du decor.
async function extract_raw_content(page, contentSelector) {
    const callContent = await page.evaluate(selectors => {
        const bodies = [...document.querySelectorAll(selectors.body)];
        if (bodies.length === 0) return null;
        const title = document.querySelector(selectors.title);
        return [title?.outerHTML ?? '', ...bodies.map(body => body.innerHTML)].join('\n');
    }, { title: CALL_TITLE_SELECTOR, body: CALL_BODY_SELECTOR });

    if (callContent) return callContent;
    return await page.$eval(contentSelector, element => element.innerHTML);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
