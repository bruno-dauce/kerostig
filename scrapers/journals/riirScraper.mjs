import * as cheerio from 'cheerio';
import { matchIssn } from '../issnMatcher.mjs';

// Page Drupal statique (Universite Laval). curl passe en local mais se fait
// bloquer sur le runner GitHub Actions (meme curl-impersonate) -- meme
// symptome que SAGE/Wiley (fingerprint reseau du runner CI, distinct d'un
// poste local) alors que la page est du HTML statique sans anti-bot
// apparent en local. D'ou l'usage du navigateur (patchright).
const PAGE_URL = 'https://www.riir.ulaval.ca/numeros-thematiques/appel-de-textes-en-cours';
const JOURNAL_NAME = 'Relations industrielles';

// Confirme via le HTML reel : chaque appel actif est une section
// d'accordeon <section class="accordion-section"> avec un titre
// (<h3 class="accordion-section-title">) et le contenu complet de l'appel
// (<div class="accordion-section-content">). Pas d'appel actif => le
// selecteur ne trouve aucune section (comportement attendu, pas verifie en
// pratique faute d'exemple reel).
const ACCORDION_SECTION_SELECTOR = '.content-paragraph.accordion .accordion-section';
const TITLE_SELECTOR = '.accordion-section-title';
const CONTENT_SELECTOR = '.accordion-section-content';

export const scraperObject = {
    url: PAGE_URL,
    abbreviation: 'riir',
    async scraper(browser) {
        const abbreviation = this.abbreviation;

        const issn = await matchIssn(JOURNAL_NAME);
        if (!issn) {
            console.warn(`[riir] "${JOURNAL_NAME}" introuvable dans le CSV ISSN, abandon`);
            return [];
        }

        const html = await get_page_html(browser);
        if (!html) return [];

        const entries = extract_entries(html);
        console.log(`[riir] ${entries.length} appel(s) trouve(s) sur ${PAGE_URL}`);

        return entries.map(entry => ({
            journal: JOURNAL_NAME,
            abbreviation,
            issn,
            metaTitle: entry.metaTitle,
            url: `${PAGE_URL}#${encodeURIComponent(entry.metaTitle)}`,
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
        console.warn(`[riir] Erreur (timeout ou navigation) sur ${PAGE_URL} : ${error.message}`);
        return null;
    } finally {
        await page.close();
    }
}

function extract_entries(html) {
    const $ = cheerio.load(html);
    const sections = $(ACCORDION_SECTION_SELECTOR);
    if (sections.length === 0) {
        console.log(`[riir] Aucune section d'accordeon trouvee sur ${PAGE_URL} (pas d'appel actif en ce moment, ou structure modifiee)`);
        return [];
    }

    const entries = [];
    sections.each((_, section) => {
        const title = $(section).find(TITLE_SELECTOR).first().text().replace(/\s+/g, ' ').trim();
        const content = $(section).find(CONTENT_SELECTOR).first();
        if (!title || content.length === 0) return;
        entries.push({ metaTitle: title, rawContent: content.html() ?? '' });
    });
    return entries;
}
