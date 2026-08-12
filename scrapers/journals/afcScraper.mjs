import * as cheerio from 'cheerio';
import { matchIssn } from '../issnMatcher.mjs';

// Site propre de l'AFC. curl passe en local mais se fait bloquer sur le
// runner GitHub Actions (meme curl-impersonate) -- meme symptome que
// SAGE/Wiley (fingerprint reseau du runner CI, distinct d'un poste local).
// D'ou l'usage du navigateur (patchright).
const PAGE_URL = 'https://www.afc-cca.com/pages/revue-cca';
const JOURNAL_NAME = 'Comptabilité - Contrôle - Audit';

// Cette page melange, dans un seul fil d'actualites (<article class="art">),
// des dizaines d'annonces sans rapport avec un appel (activation de compte,
// composition du comite editorial, recommandations aux auteurs...).
// Confirme via le HTML reel : sur 21 articles, un seul evoque explicitement
// un appel a communications/contributions/articles ou un numero special --
// meme filtre par mot-cle sur le titre que SIM dans ojsFrScraper.mjs.
const ARTICLE_SELECTOR = 'article.art';
const TITLE_SELECTOR = 'h2';
const CONTENT_SELECTOR = '.row .col-12';
const CALL_TITLE_PATTERN = /appels?\s*(à|a)\s*(communications?|contributions?|articles?)|num[ée]ro\s*sp[ée]cial/i;

export const scraperObject = {
    url: PAGE_URL,
    abbreviation: 'afc',
    async scraper(browser) {
        const abbreviation = this.abbreviation;

        const issn = await matchIssn(JOURNAL_NAME);
        if (!issn) {
            console.warn(`[afc] "${JOURNAL_NAME}" introuvable dans le CSV ISSN, abandon`);
            return [];
        }

        const html = await get_page_html(browser);
        if (!html) return [];

        const entries = extract_entries(html);

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
        console.warn(`[afc] Erreur (timeout ou navigation) sur ${PAGE_URL} : ${error.message}`);
        return null;
    } finally {
        await page.close();
    }
}

function extract_entries(html) {
    const $ = cheerio.load(html);
    const articles = $(ARTICLE_SELECTOR);

    const entries = [];
    articles.each((_, article) => {
        const title = $(article).find(TITLE_SELECTOR).first().text().replace(/\s+/g, ' ').trim();
        if (!title || !CALL_TITLE_PATTERN.test(title)) return;

        const content = $(article).find(CONTENT_SELECTOR).first();
        if (content.length === 0) return;

        entries.push({ metaTitle: title, rawContent: content.html() ?? '' });
    });
    console.log(`[afc] ${entries.length} appel(s) retenu(s) sur ${articles.length} actualite(s) au total sur ${PAGE_URL}`);
    return entries;
}
