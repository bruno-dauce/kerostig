import * as cheerio from 'cheerio';
import { matchIssn } from '../issnMatcher.mjs';
import { parse as parsePdf } from '../fileParser.mjs';

// Hub unique de l'American Accounting Association, rendu cote serveur (Drupal,
// verifie sur le HTML brut : les 28 cartes sont deja la sans JS). Les deux
// onglets "Upcoming Deadlines" (#upcoming) et "Ongoing Calls" (#ongoing) sont
// tous les deux presents dans le DOM au chargement, l'onglet inactif etant
// seulement masque en CSS -- inutile de cliquer sur les onglets, on lit toutes
// les cartes d'un coup.
const PAGE_URL = 'https://aaahq.org/Research/Calls-for-Submissions';
const REQUEST_DELAY_MS = 1000;

// Structure reelle d'une carte :
//   <div class="card call  noMeeting  AUD">
//     <div class="left">
//       <h4 class="callTitle"><a href="...">Mixed Method Papers</a></h4>
//       <p class="callDetail"><em>Auditing: A Journal of Practice & Theory (AJPT)</em></p>
//       <span class="AUD badge">AUD</span>
//       <div class="info"><h5 class="callDeadline">09/30/2026</h5><a class="btn btn-success">View Details</a></div>
// Le badge ("AUD") designe la section AAA, pas la revue : il ne sert pas au
// filtrage. Le lien du titre et le bouton "View Details" pointent vers la meme
// cible, on prend celui du titre.
const CARD_SELECTOR = 'div.card.call';
const CARD_TITLE_SELECTOR = 'h4.callTitle';
const CARD_DETAIL_SELECTOR = 'p.callDetail';
const CARD_LINK_SELECTOR = 'h4.callTitle a[href], a.btn[href]';

// Conteneur de contenu des rares appels dont le lien mene a une page HTML du
// site (1 sur 28 au moment de l'ecriture : Studies in Accounting Research).
const DETAIL_CONTENT_SELECTOR = 'main';

// Les 6 revues AAA du perimetre FNEGE. `name` est le nom que matchIssn resout
// (colonne nom_openalex du CSV enrichi), `patterns` les formes sous lesquelles
// le hub designe la revue, dans le titre ou dans le sous-titre.
//
// ATTENTION au motif "Auditing" seul : le hub liste aussi "Current Issues in
// Auditing" (revue AAA hors perimetre) et un numero special de Critical
// Perspectives on Accounting intitule "Studies of Auditing On-the-Ground in the
// Majority World". Les deux seraient captes a tort. On n'accepte donc que le
// titre complet ou le sigle AJPT.
const JOURNALS = [
    { name: 'The Accounting Review', patterns: ['The Accounting Review', 'Accounting Review'] },
    { name: 'Accounting Horizons', patterns: ['Accounting Horizons'] },
    { name: 'Auditing A Journal of Practice & Theory', patterns: ['Auditing: A Journal of Practice & Theory', 'AJPT'] },
    { name: 'Behavioral Research in Accounting', patterns: ['Behavioral Research in Accounting', 'BRIA'] },
    { name: 'Journal of International Accounting Research', patterns: ['Journal of International Accounting Research', 'JIAR'] },
    { name: 'Journal of Management Accounting Research', patterns: ['Journal of Management Accounting Research', 'JMAR'] },
];

// Le hub melange appels de revues, conferences, colloques et bourses. Ces
// entrees sont ecartees avant meme de chercher un nom de revue : sans ce filtre
// on remonterait par exemple "Call for Papers Accounting Horizons AI
// Conference" comme un appel d'Accounting Horizons.
const HORS_PERIMETRE_PATTERN = /\b(conferences?|symposi(um|a)|scholarships?)\b/i;

export const scraperObject = {
    url: PAGE_URL,
    abbreviation: 'aaa',
    async scraper(browser) {
        const abbreviation = this.abbreviation;

        const journals = [];
        for (const journal of JOURNALS) {
            const issn = await matchIssn(journal.name);
            if (!issn) {
                console.warn(`[aaa] "${journal.name}" non trouve dans le CSV ISSN, verifier l'orthographe`);
                continue;
            }
            journals.push({ ...journal, issn });
        }
        if (journals.length === 0) {
            console.warn('[aaa] Aucune des 6 revues du perimetre resolue en ISSN, abandon');
            return [];
        }

        const entries = await get_entries(browser);
        console.log(`[aaa] ${entries.length} entree(s) listee(s) sur le hub`);

        const calls = [];
        let skippedCount = 0;
        for (const entry of entries) {
            const journal = detect_journal(entry, journals);
            if (!journal) {
                skippedCount++;
                continue;
            }
            await sleep(REQUEST_DELAY_MS);
            const rawContent = await get_raw_content(browser, entry.url);
            if (!rawContent) continue;
            calls.push({
                journal: journal.name,
                abbreviation,
                issn: journal.issn,
                metaTitle: entry.metaTitle,
                url: entry.url,
                rawContent,
            });
        }
        console.log(`[aaa] ${skippedCount} entree(s) ignoree(s) : conference, bourse, ou revue hors perimetre FNEGE`);
        console.log(`[aaa] ${calls.length} appel(s) trouve(s) sur ${journals.length} revue(s)`);

        return calls;
    }
}

async function get_entries(browser) {
    const page = await browser.newPage();
    try {
        await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
        const html = await page.content();
        const entries = parse_cards(html);
        if (entries.length === 0) {
            console.warn(`[aaa] Aucune carte d'appel trouvee sur ${PAGE_URL} (structure modifiee ?)`);
        }
        return entries;
    } catch (error) {
        console.warn(`[aaa] Erreur (timeout ou navigation) sur ${PAGE_URL} : ${error.message}`);
        return [];
    } finally {
        await page.close();
    }
}

// Fonction pure, exportee pour pouvoir etre testee sur un extrait de HTML reel.
export function parse_cards(html) {
    const $ = cheerio.load(html);
    const entries = [];
    $(CARD_SELECTOR).each((_, el) => {
        const card = $(el);
        const title = normalize_space(card.find(CARD_TITLE_SELECTOR).first().text());
        const detail = normalize_space(card.find(CARD_DETAIL_SELECTOR).first().text());
        const href = card.find(CARD_LINK_SELECTOR).first().attr('href');
        const metaTitle = build_meta_title(title, detail);
        if (!metaTitle || !href) return;
        entries.push({
            metaTitle,
            title,
            detail,
            url: new URL(href, PAGE_URL).href,
        });
    });
    return entries;
}

// Le titre seul ne suffit pas a identifier un appel : selon les cartes il porte
// soit le theme ("Mixed Method Papers", le sous-titre portant alors la revue),
// soit le nom de la revue, le theme etant renvoye au sous-titre. Deux appels
// AJPT distincts partagent ainsi le meme <h4>, et le slug (abreviation +
// metaTitle, cf dataPreparation.mjs) les confondrait. On concatene donc les deux
// champs, sauf quand l'un contient deja l'autre.
function build_meta_title(title, detail) {
    if (!title) return detail;
    if (!detail) return title;
    if (detail.includes(title)) return detail;
    if (title.includes(detail)) return title;
    return `${title} - ${detail}`;
}

// Fonction pure, exportee pour pouvoir etre testee isolement.
export function detect_journal(entry, journals) {
    const text = `${entry.title} ${entry.detail}`;
    if (HORS_PERIMETRE_PATTERN.test(text)) return null;
    // Espaces encadrants : la comparaison se fait sur du texte normalise reduit
    // a des mots separes par un espace, " ajpt " ne peut donc pas matcher un
    // fragment de mot.
    const haystack = ` ${normalize(text)} `;
    return journals.find(journal =>
        journal.patterns.some(pattern => haystack.includes(` ${normalize(pattern)} `))
    ) ?? null;
}

// Meme normalisation que issnMatcher (minuscules, "&" -> "and", ponctuation
// retiree) : elle absorbe les variantes de ponctuation du hub, notamment les
// deux-points et les parentheses autour du sigle.
function normalize(text) {
    return text
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

function normalize_space(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
}

// Les liens "View Details" pointent presque toujours vers un PDF depose dans
// /portals/0/documents/calls/ (27 des 28 entrees au moment de l'ecriture), pas
// vers une page de detail. On telecharge donc le PDF et on en extrait le texte
// via fileParser.mjs, comme agrhScraper. Le cas HTML minoritaire reste gere.
async function get_raw_content(browser, url) {
    if (/\.pdf(\?|#|$)/i.test(url)) return get_pdf_content(browser, url);
    return get_page_content(browser, url);
}

async function get_pdf_content(browser, url) {
    try {
        const content = await parsePdf(browser, url);
        if (!content || content.trim().length === 0) {
            console.warn(`[aaa] PDF vide ou illisible : ${url}`);
            return null;
        }
        return content;
    } catch (error) {
        console.warn(`[aaa] Erreur lors de l'extraction du PDF ${url} : ${error.message}`);
        return null;
    }
}

async function get_page_content(browser, url) {
    const page = await browser.newPage();
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        const rawContent = await page.waitForSelector(DETAIL_CONTENT_SELECTOR, { timeout: 30000 })
            .then(() => page.$eval(DETAIL_CONTENT_SELECTOR, element => element.innerHTML))
            .catch(() => null);
        if (!rawContent) {
            console.warn(`[aaa] Extraction du contenu brut echouee pour ${url}`);
        }
        return rawContent;
    } catch (error) {
        console.warn(`[aaa] Erreur (timeout ou navigation) sur ${url} : ${error.message}`);
        return null;
    } finally {
        await page.close();
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
