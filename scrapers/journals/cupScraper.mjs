import { matchIssn } from '../issnMatcher.mjs';
import { waitForCloudflare } from '../cloudflare.mjs';

const BASE_URL = 'https://www.cambridge.org';

// Pas de hub centralise chez Cambridge : chaque revue expose ses annonces sur
// cambridge.org/core/journals/{slug}/announcements, decoupees en categories
// (Prizes and awards, News, Call for papers, Events). Scraper mutualise sur le
// meme patron d'URL, comme Emerald, mais avec une liste de revues en dur : le
// slug CUP ne se deduit pas du nom FNEGE (cf astin-bulletin-journal-of-the-iaa
// pour "Astin Bulletin").
const JOURNALS = [
    { slug: 'journal-of-financial-and-quantitative-analysis', name: 'Journal of Financial and Quantitative Analysis' },
    { slug: 'business-ethics-quarterly', name: 'Business Ethics Quarterly' },
    { slug: 'business-history-review', name: 'The Business History Review' },
    { slug: 'astin-bulletin-journal-of-the-iaa', name: 'Astin Bulletin' },
    { slug: 'enterprise-and-society', name: 'Enterprise & Society' },
    { slug: 'judgment-and-decision-making', name: 'Judgment and Decision Making' },
    { slug: 'management-and-organization-review', name: 'Management and Organization Review' },
];

// Confirme via le HTML reel des pages de liste : conteneur unique de contenu
// (le site n'a pas de balise <main>, c'est <div id="maincontent">). Sert aussi
// de conteneur de contenu brut sur les pages de detail.
const CONTENT_SELECTOR = '#maincontent';

// Chaque annonce est une <div class="row margin-bottom"> sans classe propre,
// contenant une vignette et une <ul class="overview"> avec un <li class="title">
// (le lien vers le detail) et un <li class="description"> (le chapo). On cible
// le lien de titre plutot que la ligne : c'est le seul marqueur stable, et il
// evite au passage les liens du bloc CMS d'introduction, qui vit dans une
// <div class="row"> voisine sans ul.overview.
const LISTING_LINK_SELECTOR = '#maincontent ul.overview li.title a';

// Les categories d'annonces ne repondent pas toutes, et pas toutes en erreur :
// /announcements/call-for-papers renvoie 404 pour Judgment and Decision Making,
// 500 pour Enterprise & Society, et 200 avec zero annonce pour The Business
// History Review (verifie manuellement sur les 7 revues). Dans les trois cas on
// retombe sur /announcements pour y chercher une categorie d'appels sous un
// autre libelle, et on renvoie 0 appel proprement si elle n'existe pas.
const ANNOUNCEMENTS_PATH = '/announcements';
const CALL_FOR_PAPERS_PATH = '/announcements/call-for-papers';
const CALL_FOR_PAPERS_CATEGORY_PATTERN = /calls?[-\s]?for[-\s]?papers?/i;

export const scraperObject = {
    url: 'https://www.cambridge.org/core/journals/business-ethics-quarterly/announcements/call-for-papers',
    abbreviation: 'cup',
    async scraper(browser) {
        const abbreviation = this.abbreviation;

        const calls = [];
        for (const journal of JOURNALS) {
            const issn = await matchIssn(journal.name);
            if (!issn) {
                console.warn(`[cup] "${journal.name}" non trouve dans le CSV ISSN, verifier l'orthographe`);
                continue;
            }

            const listings = await get_listings_for_journal(browser, journal);
            if (listings.length === 0) {
                console.log(`[cup] Aucun appel pour "${journal.name}"`);
                continue;
            }

            for (const listing of listings) {
                const rawContent = await get_raw_content(browser, listing.url);
                if (!rawContent) continue;
                calls.push({
                    journal: journal.name,
                    abbreviation,
                    issn,
                    metaTitle: listing.metaTitle,
                    url: listing.url,
                    rawContent,
                });
            }
        }
        console.log(`[cup] ${calls.length} appel(s) trouve(s) sur ${JOURNALS.length} revue(s)`);

        return calls;
    }
}

// Cherche les appels d'une revue : d'abord la categorie standard
// /announcements/call-for-papers, puis, si elle est absente ou vide, les
// categories d'appels reperees sur l'index /announcements (cf commentaire sur
// CALL_FOR_PAPERS_PATH).
async function get_listings_for_journal(browser, journal) {
    const journalUrl = `${BASE_URL}/core/journals/${journal.slug}`;
    const defaultCategoryUrl = `${journalUrl}${CALL_FOR_PAPERS_PATH}`;

    const listings = await get_listings_for_category(browser, defaultCategoryUrl);
    if (listings.length > 0) return listings;

    const categoryUrls = await get_call_for_papers_categories(browser, `${journalUrl}${ANNOUNCEMENTS_PATH}`);

    // Deduplique par URL : une meme annonce peut etre listee sous plusieurs
    // categories, et l'index peut renvoyer la categorie deja essayee ci-dessus.
    const listingsByUrl = new Map();
    for (const categoryUrl of categoryUrls) {
        if (categoryUrl === defaultCategoryUrl) continue;
        for (const listing of await get_listings_for_category(browser, categoryUrl)) {
            if (!listingsByUrl.has(listing.url)) listingsByUrl.set(listing.url, listing);
        }
    }
    return [...listingsByUrl.values()];
}

// Lit une page de categorie d'annonces et renvoie le titre et l'URL de detail
// de chaque appel liste.
async function get_listings_for_category(browser, categoryUrl) {
    const page = await browser.newPage();
    try {
        const response = await page.goto(categoryUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await waitForCloudflare(page, '[cup]');

        // Une categorie absente repond 404 ou 500 selon la revue : ce n'est pas
        // une anomalie a signaler, le repli sur /announcements s'en charge.
        const status = response?.status();
        if (status && status !== 200) {
            console.log(`[cup] Statut HTTP ${status} sur ${categoryUrl}, categorie absente`);
            return [];
        }

        const found = await page.waitForSelector(CONTENT_SELECTOR, { timeout: 30000 })
            .then(() => true)
            .catch(() => false);
        if (!found) {
            console.warn(`[cup] Conteneur de contenu introuvable sur ${categoryUrl}`);
            return [];
        }

        const listings = await page.$$eval(LISTING_LINK_SELECTOR, links => links.map(link => ({
            metaTitle: link.textContent.trim(),
            href: link.getAttribute('href'),
        })));

        return listings
            .filter(listing => listing.metaTitle && listing.href)
            .map(listing => ({ metaTitle: listing.metaTitle, url: new URL(listing.href, BASE_URL).href }));
    } catch (error) {
        console.warn(`[cup] Erreur (timeout ou navigation) sur ${categoryUrl} : ${error.message}`);
        return [];
    } finally {
        await page.close();
    }
}

// Lit l'index /announcements d'une revue et renvoie les URL des categories qui
// ressemblent a des appels a publications. ATTENTION : l'index utilise le meme
// gabarit (ul.overview) que les pages de categorie, mais ses entrees sont des
// categories ("Prizes and awards", "News", "Events"...), pas des appels -- d'ou
// le filtre, sans lequel on remonterait un prix comme un appel.
async function get_call_for_papers_categories(browser, announcementsUrl) {
    const entries = await get_listings_for_category(browser, announcementsUrl);
    return entries
        .filter(entry => CALL_FOR_PAPERS_CATEGORY_PATTERN.test(entry.metaTitle) || CALL_FOR_PAPERS_CATEGORY_PATTERN.test(entry.url))
        .map(entry => entry.url);
}

async function get_raw_content(browser, url) {
    const page = await browser.newPage();
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await waitForCloudflare(page, '[cup]');
        const rawContent = await page.waitForSelector(CONTENT_SELECTOR, { timeout: 30000 })
            .then(() => page.$eval(CONTENT_SELECTOR, element => element.innerHTML))
            .catch(() => null);
        if (!rawContent) {
            console.warn(`[cup] Extraction du contenu brut echouee pour ${url}`);
        }
        return rawContent;
    } catch (error) {
        console.warn(`[cup] Erreur (timeout ou navigation) sur ${url} : ${error.message}`);
        return null;
    } finally {
        await page.close();
    }
}
