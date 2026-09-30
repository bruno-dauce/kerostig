import * as cheerio from 'cheerio';
import { matchIssn } from '../issnMatcher.mjs';
import { getContent } from '../fileParser.mjs';

// Page des appels de JMIS sur le site propre de la revue. Chaque appel est un
// <h3> « Special Issue: ... » ou « Special Section: ... » suivi d'un lien
// « (PDF) » vers /cfps/*.pdf. L'ancien scraper lisait des <p> et supposait un
// lien dans chacun : la page est passee aux <h3>, et il aurait leve sur le
// premier element sans lien. Le titre du site est lui aussi un <h3> (lien vers
// « / ») : le critere est donc le lien vers un PDF de /cfps/, pas la balise.
const LISTING_URL = 'https://www.jmis-web.org/cfp';
const JOURNAL_NAME = 'Journal of Management Information Systems';
const LIEN_APPEL = /\/cfps\/[^/]+\.pdf$/i;
const REQUEST_DELAY_MS = 1000;
const NAVIGATION_TIMEOUT_MS = 60000;
const USER_AGENT = 'Mozilla/5.0 (compatible; kerostig-bot)';

// Le titre est le texte du <h3> sans le lien « (PDF) ». Fonction pure,
// exportee pour test.
export function extraire_liens_appels(html, baseUrl = LISTING_URL) {
    const $ = cheerio.load(html);
    const vus = new Set();
    const liens = [];
    $('h3').each((_, h3) => {
        const a = $(h3).find('a[href]').first();
        if (a.length === 0) return;
        let url;
        try { url = new URL(a.attr('href').trim(), baseUrl); } catch { return; }
        if (!LIEN_APPEL.test(url.pathname)) return;
        const titre = $(h3).clone().children('a').remove().end().text().replace(/\s+/g, ' ').trim();
        if (!titre || vus.has(url.href)) return;
        vus.add(url.href);
        liens.push({ titre, url: url.href });
    });
    return liens;
}

// Une reponse qui n'est pas un PDF (page d'erreur servie en 200) ne doit
// jamais etre prise pour le texte de l'appel. Fonction pure, exportee pour test.
export function est_pdf(buffer) {
    return Buffer.from(buffer.subarray(0, 4)).toString('latin1') === '%PDF';
}

export const scraperObject = {
    url: LISTING_URL,
    abbreviation: 'jmis',
    async scraper(browser) {
        const abbreviation = this.abbreviation;

        const issn = await matchIssn(JOURNAL_NAME);
        if (!issn) {
            console.warn(`[jmis] "${JOURNAL_NAME}" introuvable dans le CSV ISSN, abandon`);
            return [];
        }

        const liens = await get_listings(browser);
        console.log(`[jmis] ${liens.length} appel(s) trouve(s) sur ${LISTING_URL}`);

        const calls = [];
        for (const lien of liens) {
            await sleep(REQUEST_DELAY_MS);
            const rawContent = await get_pdf_text(lien.url);
            // Pas de contenu de repli : sans le texte, rien ne permet
            // d'extraire l'appel sans inventer.
            if (!rawContent) continue;
            calls.push({
                journal: JOURNAL_NAME,
                abbreviation,
                issn,
                metaTitle: lien.titre,
                url: lien.url,
                rawContent,
            });
        }
        return calls;
    }
}

async function get_listings(browser) {
    const page = await browser.newPage();
    try {
        await page.goto(LISTING_URL, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
        const liens = extraire_liens_appels(await page.content(), LISTING_URL);
        if (liens.length === 0) {
            console.warn(`[jmis] Aucun lien vers un PDF /cfps/ sur ${LISTING_URL} (structure modifiee, ou aucun appel ouvert)`);
        }
        return liens;
    } catch (error) {
        console.warn(`[jmis] Erreur (timeout ou navigation) sur ${LISTING_URL} : ${error.message}`);
        return [];
    } finally {
        await page.close();
    }
}

async function get_pdf_text(url) {
    try {
        const reponse = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': USER_AGENT } });
        if (!reponse.ok) {
            console.warn(`[jmis] HTTP ${reponse.status} sur ${url}, appel ecarte`);
            return null;
        }
        const buffer = Buffer.from(await reponse.arrayBuffer());
        if (!est_pdf(buffer)) {
            console.warn(`[jmis] ${url} ne renvoie pas un PDF, appel ecarte`);
            return null;
        }
        const texte = await getContent(buffer, 'pdf');
        if (!texte || texte.trim() === '') {
            console.warn(`[jmis] Texte vide sur ${url}, appel ecarte`);
            return null;
        }
        return texte;
    } catch (error) {
        console.warn(`[jmis] Erreur de lecture sur ${url} : ${error.message}`);
        return null;
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
