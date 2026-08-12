import * as cheerio from 'cheerio';
import { matchIssn } from '../issnMatcher.mjs';

// Page revue unique (pas de hub separe) : jle.com y liste les appels
// ouverts, suivis d'un bloc "Appels clotures". curl passe en local mais se
// fait bloquer sur le runner GitHub Actions (meme curl-impersonate) --
// meme symptome que SAGE/Wiley (fingerprint reseau du runner CI, distinct
// d'un poste local). D'ou l'usage du navigateur (patchright, cf
// miScraper.mjs), qui contourne ce blocage specifique au CI.
const PAGE_URL = 'https://www.jle.com/fr/revues/rfg/revue.phtml';
const JOURNAL_NAME = 'Revue française de gestion';

// Confirme via le HTML reel : une section unique <h2>Appels a articles</h2>
// contient d'abord les appels ouverts (un <p> par appel : lien vers le PDF
// de l'appel + ligne "Date limite de soumission : ..."), puis un
// <h3>Appels clotures :</h3> qui marque le debut des appels perimes -- on
// s'arrete la, seuls les <p> avant ce <h3> sont retenus.
const OPEN_HEADING_PATTERN = /appels?\s*(à|a)\s*articles/i;
const CLOSED_HEADING_PATTERN = /appels?\s*cl(ô|o)tur/i;

export const scraperObject = {
    url: PAGE_URL,
    abbreviation: 'rfg',
    async scraper(browser) {
        const abbreviation = this.abbreviation;

        const issn = await matchIssn(JOURNAL_NAME);
        if (!issn) {
            console.warn(`[rfg] "${JOURNAL_NAME}" introuvable dans le CSV ISSN, abandon`);
            return [];
        }

        const html = await get_page_html(browser);
        if (!html) return [];

        const entries = extract_entries(html);
        console.log(`[rfg] ${entries.length} appel(s) ouvert(s) trouve(s) sur ${PAGE_URL}`);

        return entries.map(entry => ({
            journal: JOURNAL_NAME,
            abbreviation,
            issn,
            metaTitle: entry.metaTitle,
            url: entry.url,
            rawContent: entry.rawContent,
        }));
    }
}

async function get_page_html(browser) {
    const page = await browser.newPage();
    try {
        await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
        return await page.content();
    } catch (error) {
        console.warn(`[rfg] Erreur (timeout ou navigation) sur ${PAGE_URL} : ${error.message}`);
        return null;
    } finally {
        await page.close();
    }
}

function extract_entries(html) {
    const $ = cheerio.load(html);
    const openHeading = $('h2').toArray().find(h => OPEN_HEADING_PATTERN.test($(h).text()));
    if (!openHeading) {
        console.warn(`[rfg] Section "Appels a articles" introuvable sur ${PAGE_URL} (structure modifiee ?)`);
        return [];
    }

    const entries = [];
    for (const node of $(openHeading).nextUntil().toArray()) {
        if (node.tagName === 'h3' && CLOSED_HEADING_PATTERN.test($(node).text())) break;
        if (node.tagName !== 'p') continue;

        const link = $(node).find('a[href]').first();
        if (link.length === 0) continue;

        entries.push({
            metaTitle: link.text().trim(),
            url: new URL(link.attr('href'), PAGE_URL).href,
            rawContent: $.html(node),
        });
    }
    return entries;
}
