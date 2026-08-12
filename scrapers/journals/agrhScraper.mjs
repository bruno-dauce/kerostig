import * as cheerio from 'cheerio';
import { matchIssn } from '../issnMatcher.mjs';
import { parse as parsePdf } from '../fileParser.mjs';

const PAGE_URL = 'https://www.agrh.fr/revue-agrh';
const JOURNAL_NAME = 'GRH';
const REQUEST_DELAY_MS = 1000;

// Site Squarespace. Contrairement aux autres revues de ce lot, les appels de
// @GRH ne sont pas des pages HTML mais des PDF en piece jointe (confirme via
// le HTML reel, curl) -- d'ou l'usage de fileParser.mjs (deja present dans
// le repo, jamais encore utilise par un scraper) qui telecharge le fichier
// via le navigateur puis en extrait le texte avec pdfjs-dist. browser.mjs
// est deja configure pour ce cas (always_open_pdf_externally +
// acceptDownloads), donc la navigation directe vers un lien .pdf declenche
// bien un telechargement plutot que la visionneuse PDF de Chrome.
//
// Le meme bloc contient aussi des documents de reference sans rapport avec
// un appel en cours (presentation de la revue, politique des numeros
// speciaux, comite de lecture, consignes aux auteurs, charte, reglement
// interieur). Le theme d'un appel specifique ne contient pas forcement les
// mots "appel" ou "numero special" dans son texte de lien (ex. "Dialogue
// social sur le travail en mutations..."), donc un filtre par mot-cle sur
// le titre du lien manquerait cet appel. En revanche, verifie sur les 8
// liens PDF de la page : les documents de reference sont systematiquement
// introduits par un lien "Afficher ..." (convention du site), jamais les
// appels eux-memes -- c'est ce critere qui est utilise pour filtrer.
const PDF_LINK_SELECTOR = 'a[href$=".pdf"]';
const REFERENCE_DOC_PATTERN = /^afficher\b/i;

export const scraperObject = {
    url: PAGE_URL,
    abbreviation: 'agrh',
    async scraper(browser) {
        const abbreviation = this.abbreviation;

        const issn = await matchIssn(JOURNAL_NAME);
        if (!issn) {
            console.warn(`[agrh] "${JOURNAL_NAME}" introuvable dans le CSV ISSN, abandon`);
            return [];
        }

        const links = await get_call_pdf_links(browser);
        console.log(`[agrh] ${links.length} PDF d'appel trouve(s) sur ${PAGE_URL}`);

        const calls = [];
        for (const link of links) {
            await sleep(REQUEST_DELAY_MS);
            const rawContent = await get_pdf_content(browser, link.url);
            if (!rawContent) continue;
            calls.push({
                journal: JOURNAL_NAME,
                abbreviation,
                issn,
                metaTitle: link.title,
                url: link.url,
                rawContent,
            });
        }
        return calls;
    }
}

async function get_call_pdf_links(browser) {
    const page = await browser.newPage();
    try {
        await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
        const html = await page.content();

        const $ = cheerio.load(html);
        const links = [];
        $(PDF_LINK_SELECTOR).each((_, el) => {
            const title = $(el).text().replace(/\s+/g, ' ').trim();
            const href = $(el).attr('href');
            if (!title || !href || REFERENCE_DOC_PATTERN.test(title)) return;
            links.push({ title, url: new URL(href, PAGE_URL).href });
        });
        if (links.length === 0) {
            console.log(`[agrh] Aucun PDF d'appel trouve sur ${PAGE_URL} (pas d'appel actif en ce moment, ou structure modifiee)`);
        }
        return links;
    } catch (error) {
        console.warn(`[agrh] Erreur (timeout ou navigation) sur ${PAGE_URL} : ${error.message}`);
        return [];
    } finally {
        await page.close();
    }
}

async function get_pdf_content(browser, url) {
    try {
        const content = await parsePdf(browser, url);
        if (!content || content.trim().length === 0) {
            console.warn(`[agrh] PDF vide ou illisible : ${url}`);
            return null;
        }
        return content;
    } catch (error) {
        console.warn(`[agrh] Erreur lors de l'extraction du PDF ${url} : ${error.message}`);
        return null;
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
