import { matchIssn } from '../issnMatcher.mjs';
import { waitForCloudflare } from '../cloudflare.mjs';

const LISTING_CARD_SELECTOR = 'a.calls-grid__card';
const LISTING_TITLE_SELECTOR = 'h3.calls-grid__title';
const LISTING_JOURNAL_SELECTOR = 'span.calls-grid__journal';

// Confirme via le HTML reel de la page de liste : le site n'a pas de balise
// <main>, le conteneur de contenu est <div id="main" role="main">. Le reste
// de la liste est un repli au cas ou la page de detail suit un autre gabarit.
const DETAIL_CONTENT_SELECTOR = '#main, .calls-detail_content, main';

// Compteur servi par le site sur chaque page de liste ("1-6 of 209"), y
// compris sur la premiere page vide qui suit la derniere ("589-209 of 209").
// Il sert a deux choses : distinguer une vraie fin de pagination d'un blocage
// (une page bloquee n'a ni carte ni compteur), et verifier en fin de course
// que la collecte est complete.
const LISTING_STATS_SELECTOR = '.sr-statistics';

// Garde-fou contre une boucle infinie si Cloudflare bloque systematiquement
// la pagination au lieu de renvoyer une page reellement vide.
const MAX_PAGES = 100;

// Lit le total annonce par le site dans le compteur de resultats. Renvoie null
// si le compteur est absent ou illisible. Fonction pure, exportee pour test.
export function lireTotalAnnonce(texte) {
    if (!texte) return null;
    const trouve = String(texte).match(/of\s+(\d+)/i);
    return trouve ? Number(trouve[1]) : null;
}

// Decide si une collecte est exploitable. Une remontee partielle est pire
// qu'une remontee vide : le pipeline archive les appels manquants au lieu de
// les geler. On prefere donc rendre zero appel et laisser le garde-fou de
// diffChecker conserver l'existant. Fonction pure, exportee pour test.
export function evaluerCollecte({ cartesCollectees, totalAnnonce, echec }) {
    if (echec) {
        return { complet: false, motif: 'echec de chargement sur au moins une page de liste' };
    }
    if (totalAnnonce !== null && cartesCollectees < totalAnnonce) {
        return {
            complet: false,
            motif: `collecte tronquee, ${cartesCollectees} carte(s) pour ${totalAnnonce} annoncee(s)`,
        };
    }
    return { complet: true, motif: null };
}

export const scraperObject = {
    url: 'https://www.emerald.com/calls-for-submissions/',
    abbreviation: 'emerald',
    async scraper(browser) {
        const abbreviation = this.abbreviation;

        let listings = [];
        let pageNumber = 1;
        let totalAnnonce = null;
        let echec = false;
        while (pageNumber <= MAX_PAGES) {
            const { statut, items, total } = await get_listings_for_page(browser, this.url, pageNumber);
            if (statut === 'echec') { echec = true; break; }
            if (statut === 'fin') break;
            if (totalAnnonce === null) totalAnnonce = total;
            listings.push(...items);
            pageNumber++;
        }
        console.log(`[emerald] ${listings.length} appel(s) trouve(s) sur ${pageNumber - 1} page(s)`);

        // Une liste amputee ferait passer les appels manquants pour retires :
        // diffChecker les basculerait en inactif. On rend plutot zero appel,
        // ce qui declenche son gel et preserve l'existant jusqu'au prochain
        // passage. Voir evaluerCollecte ci-dessus.
        const bilan = evaluerCollecte({ cartesCollectees: listings.length, totalAnnonce, echec });
        if (!bilan.complet) {
            console.warn(`[emerald] Collecte abandonnee : ${bilan.motif}.`);
            console.warn(`[emerald] Aucun appel rendu pour ce passage, les appels existants seront geles et non archives.`);
            return [];
        }

        let skippedCount = 0;
        let contenusManques = 0;
        const calls = [];
        for (const listing of listings) {
            if (!listing.metaTitle || !listing.journal) continue;
            const issn = await matchIssn(listing.journal);
            if (!issn) {
                skippedCount++;
                continue;
            }
            const rawContent = await get_raw_content(browser, listing.url);
            if (!rawContent) contenusManques++;
            calls.push({
                journal: listing.journal,
                abbreviation,
                issn,
                metaTitle: listing.metaTitle,
                url: listing.url,
                rawContent,
            });
        }
        // Ces appels seront ecartes par pageController, qui filtre sur
        // rawContent. On le dit ici, sinon la perte est indiscernable d'un
        // retrait cote editeur. Le passage n'est pas abandonne pour autant :
        // sans reprise sur erreur, une seule page de detail capricieuse sur
        // plus de deux cents suffirait a geler la source indefiniment.
        if (contenusManques > 0) {
            console.warn(`[emerald] ${contenusManques} appel(s) sans contenu brut, ils seront perdus pour ce passage`);
        }
        console.log(`[emerald] ${skippedCount} appel(s) ignore(s), revue hors perimetre FNEGE`);

        return calls;
    }
}

async function get_listings_for_page(browser, baseUrl, pageNumber) {
    const page = await browser.newPage();
    const pageUrl = pageNumber === 1 ? baseUrl : `${baseUrl}?page=${pageNumber}`;
    try {
        await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await waitForCloudflare(page, '[emerald]');

        const found = await page.waitForSelector(LISTING_CARD_SELECTOR, { timeout: 30000 })
            .then(() => true)
            .catch(() => false);

        const total = lireTotalAnnonce(
            await page.$eval(LISTING_STATS_SELECTOR, element => element.textContent).catch(() => null)
        );

        if (!found) {
            // Le compteur de resultats depart la vraie fin de pagination du
            // blocage : le site le sert encore sur sa page vide de fin, une
            // page d'interstitiel ou d'erreur ne le porte pas.
            if (total !== null) {
                console.log(`[emerald] Fin de pagination sur ${pageUrl}`);
                return { statut: 'fin', items: [], total };
            }
            console.warn(`[emerald] Ni carte ni compteur sur ${pageUrl} : page bloquee ou gabarit modifie`);
            return { statut: 'echec', items: [], total: null };
        }

        const items = await page.$$eval(LISTING_CARD_SELECTOR, (items, selectors) => items.map(item => ({
            metaTitle: item.querySelector(selectors.title)?.textContent.trim() ?? '',
            journal: item.querySelector(selectors.journal)?.textContent.trim() ?? '',
            url: item.href,
        })), { title: LISTING_TITLE_SELECTOR, journal: LISTING_JOURNAL_SELECTOR });
        return { statut: 'ok', items, total };
    } catch (error) {
        console.warn(`[emerald] Erreur (timeout ou navigation) sur ${pageUrl} : ${error.message}`);
        return { statut: 'echec', items: [], total: null };
    } finally {
        await page.close();
    }
}

async function get_raw_content(browser, url) {
    const page = await browser.newPage();
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await waitForCloudflare(page, '[emerald]');
        const rawContent = await page.waitForSelector(DETAIL_CONTENT_SELECTOR, { timeout: 30000 })
            .then(() => page.$eval(DETAIL_CONTENT_SELECTOR, element => element.innerHTML))
            .catch(() => null);
        if (!rawContent) {
            console.warn(`[emerald] Extraction du contenu brut echouee pour ${url}`);
        }
        return rawContent;
    } catch (error) {
        console.warn(`[emerald] Erreur (timeout ou navigation) sur ${url} : ${error.message}`);
        return null;
    } finally {
        await page.close();
    }
}
