import { matchIssn } from '../issnMatcher.mjs';
import { waitForCloudflare } from '../cloudflare.mjs';

// Hub centralise (equivalent Emerald), trouve par l'utilisateur.
const LISTING_URL = 'https://www.sciencedirect.com/browse/calls-for-papers';

// Confirme via le HTML reel du hub. Pas de pagination par URL (pas de
// parametre ?page=, pas de "Load more") : tout est charge en une fois
// (~2827 appels tous editeurs/disciplines confondus). La boucle de
// pagination est gardee par robustesse mais devrait s'arreter des la page 2.
const LISTING_CARD_SELECTOR = 'li.js-publication';
const LISTING_TITLE_SELECTOR = 'a.js-publication-title';
const LISTING_JOURNAL_SELECTOR = '.publication-text a';

const MAX_PAGES = 100;

export const scraperObject = {
    url: LISTING_URL,
    abbreviation: 'elsevier',
    async scraper(browser) {
        const abbreviation = this.abbreviation;

        let listings = [];
        let pageNumber = 1;
        while (pageNumber <= MAX_PAGES) {
            const pageListings = await get_listings_for_page(browser, LISTING_URL, pageNumber);
            if (pageListings.length === 0) break;
            listings.push(...pageListings);
            pageNumber++;
        }
        console.log(`[elsevier] ${listings.length} appel(s) trouve(s) sur ${pageNumber - 1} page(s)`);

        // Les pages de detail /special-issue/{id} sont bloquees par Cloudflare
        // de facon systematique (contrairement au hub lui-meme). On ne les
        // visite plus pour l'instant : seules les donnees de la carte de liste
        // (titre, revue, echeance si affichee) sont utilisees. rawContent est
        // reconstruit a partir de ca, a enrichir plus tard si l'acces au
        // detail est debloque.
        let skippedCount = 0;
        const calls = [];
        for (const listing of listings) {
            if (!listing.metaTitle || !listing.journal || !listing.url) continue;
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
                rawContent: build_placeholder_content(listing),
            });
        }
        console.log(`[elsevier] ${skippedCount} appel(s) ignore(s), revue hors perimetre FNEGE`);

        return calls;
    }
}

function build_placeholder_content(listing) {
    const parts = [
        `<h2>${escape_html(listing.metaTitle)}</h2>`,
        `<p>${escape_html(listing.journal)}</p>`,
    ];
    if (listing.deadline) {
        parts.push(`<p>Submission deadline: ${escape_html(listing.deadline)}</p>`);
    }
    return parts.join('');
}

function escape_html(text) {
    return (text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function get_listings_for_page(browser, baseUrl, pageNumber) {
    const page = await browser.newPage();
    const pageUrl = pageNumber === 1 ? baseUrl : `${baseUrl}?page=${pageNumber}`;
    try {
        await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await waitForCloudflare(page, '[elsevier]');

        // ScienceDirect est une SPA React : le contenu se peuple apres le
        // chargement initial, d'ou waitForSelector plutot qu'un $$eval immediat.
        const found = await page.waitForSelector(LISTING_CARD_SELECTOR, { timeout: 30000 })
            .then(() => true)
            .catch(() => false);
        if (!found) {
            console.warn(`[elsevier] Aucune carte trouvee sur ${pageUrl} (fin de pagination, ou selecteurs pas encore configures)`);
            return [];
        }

        return await page.$$eval(LISTING_CARD_SELECTOR, (items, selectors) => items.map(item => {
            const titleLink = item.querySelector(selectors.title);
            const deadlineBlock = Array.from(item.querySelectorAll('div.text-s'))
                .find(el => el.textContent.includes('Submission deadline'));
            return {
                metaTitle: titleLink?.textContent.trim() ?? '',
                journal: item.querySelector(selectors.journal)?.textContent.trim() ?? '',
                url: titleLink?.href ?? null,
                deadline: deadlineBlock?.querySelector('strong')?.textContent.trim() ?? null,
            };
        }), { title: LISTING_TITLE_SELECTOR, journal: LISTING_JOURNAL_SELECTOR });
    } catch (error) {
        console.warn(`[elsevier] Erreur (timeout ou navigation) sur ${pageUrl} : ${error.message}`);
        return [];
    } finally {
        await page.close();
    }
}
