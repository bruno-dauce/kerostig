import { matchIssn } from '../issnMatcher.mjs';

// Seul scraper francophone de ce lot a passer par le navigateur : curl
// (avec ou sans user-agent navigateur) recoit systematiquement un 403
// generique sur ce domaine (page "403 - Forbidden" habillee -- un vrai
// blocage WAF, pas un challenge Cloudflare resoluble en attendant) --
// confirme manuellement. patchright (navigateur reel) contourne ce blocage
// specifique, a l'inverse des 3 autres scrapers francophones de ce lot qui
// utilisent curl (curl fonctionnant directement chez eux).
const LISTING_URL = 'https://www.managementinternational.ca/appels-a-contribution/';
const JOURNAL_NAME = 'Management international';

// Site WordPress "classique" (pas OJS) : chaque appel est un lien de titre
// vers un permalien date (/AAAA/MM/JJ/slug/). La structure exacte du theme
// (classe du conteneur article, niveau de titre) n'a pas pu etre confirmee
// via curl (bloque, cf commentaire ci-dessus) -- on filtre donc les titres
// candidats par la forme de l'URL cible plutot que par une classe CSS
// precise, plus robuste a une variation de theme. A affiner si le premier
// run reel (patchright) ne trouve rien : voir logs [mi] pour diagnostiquer.
const TITLE_LINK_SELECTOR = 'h2 a[href], h3 a[href], h4 a[href]';
const DATE_PERMALINK_PATTERN = /managementinternational\.ca\/\d{4}\/\d{2}\/\d{2}\//i;

// Chaine de selecteurs de contenu essayes dans l'ordre sur la page de detail
// d'un appel, du plus specifique (theme WordPress usuel) au plus large.
const DETAIL_CONTENT_SELECTORS = ['article .entry-content', '.entry-content', 'article', 'main'];

const REQUEST_DELAY_MS = 1000;

export const scraperObject = {
    url: LISTING_URL,
    abbreviation: 'mi',
    async scraper(browser) {
        const abbreviation = this.abbreviation;

        const issn = await matchIssn(JOURNAL_NAME);
        if (!issn) {
            console.warn(`[mi] "${JOURNAL_NAME}" introuvable dans le CSV ISSN, abandon`);
            return [];
        }

        const listings = await get_listings(browser);
        console.log(`[mi] ${listings.length} appel(s) trouve(s) sur ${LISTING_URL}`);

        const calls = [];
        for (const listing of listings) {
            await sleep(REQUEST_DELAY_MS);
            const rawContent = await get_detail_content(browser, listing.url);
            if (!rawContent) continue;
            calls.push({
                journal: JOURNAL_NAME,
                abbreviation,
                issn,
                metaTitle: listing.title,
                url: listing.url,
                rawContent,
            });
        }
        return calls;
    }
}

async function get_listings(browser) {
    const page = await browser.newPage();
    try {
        await page.goto(LISTING_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

        const found = await page.waitForSelector(TITLE_LINK_SELECTOR, { timeout: 30000 })
            .then(() => true)
            .catch(() => false);
        if (!found) {
            console.warn(`[mi] Aucun lien de titre (${TITLE_LINK_SELECTOR}) trouve sur ${LISTING_URL} (structure modifiee, ou page bloquee malgre le navigateur)`);
            return [];
        }

        const links = await page.$$eval(TITLE_LINK_SELECTOR, els => els.map(el => ({ title: el.textContent.trim(), href: el.href })));

        const seen = new Set();
        const entries = [];
        for (const { title, href } of links) {
            if (!title || !href || !DATE_PERMALINK_PATTERN.test(href) || seen.has(href)) continue;
            seen.add(href);
            entries.push({ title, url: href });
        }
        if (entries.length === 0) {
            console.warn(`[mi] ${links.length} lien(s) de titre trouve(s) mais aucun ne correspond au format de permalien date attendu -- structure a reverifier`);
        }
        return entries;
    } catch (error) {
        console.warn(`[mi] Erreur (timeout ou navigation) sur ${LISTING_URL} : ${error.message}`);
        return [];
    } finally {
        await page.close();
    }
}

async function get_detail_content(browser, url) {
    const page = await browser.newPage();
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

        for (const selector of DETAIL_CONTENT_SELECTORS) {
            const html = await page.$eval(selector, el => el.innerHTML).catch(() => null);
            if (html && html.trim().length > 0) return html;
        }
        console.warn(`[mi] Aucun contenu extrait sur ${url} (selecteurs essayes : ${DETAIL_CONTENT_SELECTORS.join(', ')})`);
        return null;
    } catch (error) {
        console.warn(`[mi] Erreur (timeout ou navigation) sur ${url} : ${error.message}`);
        return null;
    } finally {
        await page.close();
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
