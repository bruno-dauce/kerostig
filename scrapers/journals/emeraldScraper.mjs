import { matchIssn } from '../issnMatcher.mjs';

const LISTING_CARD_SELECTOR = 'a.calls-grid__card';
const LISTING_TITLE_SELECTOR = 'h3.calls-grid__title';
const LISTING_JOURNAL_SELECTOR = 'span.calls-grid__journal';

// Confirme via le HTML reel de la page de liste : le site n'a pas de balise
// <main>, le conteneur de contenu est <div id="main" role="main">. Le reste
// de la liste est un repli au cas ou la page de detail suit un autre gabarit.
const DETAIL_CONTENT_SELECTOR = '#main, .calls-detail_content, main';

// Garde-fou contre une boucle infinie si Cloudflare bloque systematiquement
// la pagination au lieu de renvoyer une page reellement vide.
const MAX_PAGES = 100;

export const scraperObject = {
    url: 'https://www.emerald.com/calls-for-submissions/',
    abbreviation: 'emerald',
    async scraper(browser) {
        const abbreviation = this.abbreviation;

        let listings = [];
        let pageNumber = 1;
        while (pageNumber <= MAX_PAGES) {
            const pageListings = await get_listings_for_page(browser, this.url, pageNumber);
            if (pageListings.length === 0) break;
            listings.push(...pageListings);
            pageNumber++;
        }
        console.log(`[emerald] ${listings.length} appel(s) trouve(s) sur ${pageNumber - 1} page(s)`);

        let skippedCount = 0;
        const calls = [];
        for (const listing of listings) {
            if (!listing.metaTitle || !listing.journal) continue;
            const issn = await matchIssn(listing.journal);
            if (!issn) {
                skippedCount++;
                continue;
            }
            calls.push({
                journal: listing.journal,
                abbreviation,
                issn,
                metaTitle: listing.metaTitle,
                url: listing.url,
                rawContent: await get_raw_content(browser, listing.url),
            });
        }
        console.log(`[emerald] ${skippedCount} appel(s) ignore(s), revue hors perimetre FNEGE`);

        return calls;
    }
}

async function get_listings_for_page(browser, baseUrl, pageNumber) {
    const page = await browser.newPage();
    const pageUrl = pageNumber === 1 ? baseUrl : `${baseUrl}?page=${pageNumber}`;
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
    await waitForCloudflare(page);

    const found = await page.waitForSelector(LISTING_CARD_SELECTOR, { timeout: 30000 })
        .then(() => true)
        .catch(() => false);
    if (!found) {
        console.warn(`[emerald] Aucune carte trouvee sur ${pageUrl} (fin de pagination ou probleme de chargement)`);
        await page.close();
        return [];
    }

    const listings = await page.$$eval(LISTING_CARD_SELECTOR, (items, selectors) => items.map(item => ({
        metaTitle: item.querySelector(selectors.title)?.textContent.trim() ?? '',
        journal: item.querySelector(selectors.journal)?.textContent.trim() ?? '',
        url: item.href,
    })), { title: LISTING_TITLE_SELECTOR, journal: LISTING_JOURNAL_SELECTOR });

    await page.close();
    return listings;
}

async function get_raw_content(browser, url) {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await waitForCloudflare(page);
    const rawContent = await page.waitForSelector(DETAIL_CONTENT_SELECTOR, { timeout: 30000 })
        .then(() => page.$eval(DETAIL_CONTENT_SELECTOR, element => element.innerHTML))
        .catch(() => null);
    await page.close();
    if (!rawContent) {
        console.warn(`[emerald] Extraction du contenu brut echouee pour ${url}`);
    }
    return rawContent;
}

// Emerald sert un challenge Cloudflare ("Just a moment...") avant le vrai
// contenu. On attend qu'il se resolve (changement de titre) plutot que de se
// fier a domcontentloaded, qui se declenche deja sur la page d'interstitiel.
async function waitForCloudflare(page) {
    try {
        await page.waitForFunction(
            () => !document.title.includes('Just a moment'),
            { timeout: 30000 }
        );
    } catch (error) {
        console.warn(`[emerald] Le challenge Cloudflare ne semble pas resolu apres 30s : ${error.message}`);
    }
}
