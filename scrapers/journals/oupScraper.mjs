import { matchIssn } from '../issnMatcher.mjs';
import { waitForCloudflare } from '../cloudflare.mjs';

// academic.oup.com est hors d'atteinte : 403 sur toutes les pages d'appels, y
// compris en local avec patchright et son profil persistant (donc pas seulement
// depuis les IP GitHub Actions, contrairement a SAGE et Wiley). Les 6 revues
// Oxford qui y avaient une page d'appels reperable ont donc ete retirees de ce
// scraper plutot que d'y laisser des URL qui echouent a chaque run : Industrial
// and Corporate Change, Journal of Economic Geography, Journal of Financial
// Econometrics, Socio-Economic Review, The Review of Corporate Finance Studies
// et The Review of Asset Pricing Studies. A retenter si une autre voie
// apparait (flux RSS, API, service tiers), cf la strategie d'acces par editeur.
//
// Reste Review of Finance, seule revue Oxford du perimetre dont les appels sont
// publies hors academic.oup.com : sur revfin.org, le site de l'European Finance
// Association, qui n'oppose aucun blocage. C'est la revue que la table FNEGE
// liste encore sous son ancien nom "European Finance Review" (meme eISSN
// 1573-692X, les deux noms sont resolus par matchIssn).
const JOURNALS = [
    { name: 'Review of Finance', url: 'https://revfin.org/for-authors/special-issues/' },
];

// ATTENTION, selecteurs non confirmes sur le HTML reel de revfin.org. On essaie
// plusieurs conteneurs candidats dans l'ordre, du plus precis au plus large, et
// le conteneur retenu est logue a chaque page. Au premier run reel, verifier
// dans les logs lequel repond et resserrer cette liste sur le bon plutot que de
// la laisser deviner. Le repli final sur <body> garantit qu'on remonte quelque
// chose meme si le gabarit change.
const CONTENT_SELECTORS = [
    'article .entry-content',
    '.entry-content',
    'main article',
    'main',
    'body',
];

// Un conteneur qui ne contient presque rien signale une page servie mais vide
// (page depubliee, contenu charge en JS) : autant remonter 0 appel que d'envoyer
// une coquille vide au modele d'extraction.
const MIN_CONTENT_LENGTH = 400;

export const scraperObject = {
    url: 'https://revfin.org/for-authors/special-issues/',
    abbreviation: 'oup',
    async scraper(browser) {
        const abbreviation = this.abbreviation;

        const calls = [];
        for (const journal of JOURNALS) {
            const issn = await matchIssn(journal.name);
            if (!issn) {
                console.warn(`[oup] "${journal.name}" non trouve dans le CSV ISSN, verifier l'orthographe`);
                continue;
            }

            const entry = await get_entry(browser, journal.url);
            if (!entry) {
                console.log(`[oup] Aucun appel pour "${journal.name}" (${journal.url})`);
                continue;
            }

            // La page regroupe plusieurs numeros speciaux sans balisage propre a
            // chacun : on remonte la page entiere comme un seul appel et on laisse
            // l'extraction structuree faire le tri. Si le HTML reel revele un
            // decoupage fiable (titres h2 par appel, comme chez INFORMS), c'est
            // ici qu'il faudra le brancher.
            calls.push({
                journal: journal.name,
                abbreviation,
                issn,
                metaTitle: entry.metaTitle || `Appels a publications - ${journal.name}`,
                url: journal.url,
                rawContent: entry.rawContent,
            });
        }
        console.log(`[oup] ${calls.length} appel(s) trouve(s) sur ${JOURNALS.length} revue(s)`);

        return calls;
    }
}

async function get_entry(browser, pageUrl) {
    const page = await browser.newPage();
    try {
        const response = await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await waitForCloudflare(page, '[oup]');

        // Logue le statut systematiquement : c'est le seul moyen de reperer
        // depuis les logs GitHub Actions un blocage anti-bot (403) ou une page
        // d'appels deplacee (404), les deux se traduisant autrement par un
        // silencieux "0 appel".
        const status = response?.status();
        console.log(`[oup] Statut HTTP ${status ?? 'inconnu'} sur ${pageUrl}`);
        if (status && status !== 200) {
            console.warn(`[oup] Statut HTTP ${status} (attendu 200) sur ${pageUrl} -- blocage anti-bot ou page deplacee`);
            return null;
        }

        const found = await page.waitForSelector(CONTENT_SELECTORS.join(', '), { timeout: 30000 })
            .then(() => true)
            .catch(() => false);
        if (!found) {
            console.warn(`[oup] Aucun conteneur de contenu trouve sur ${pageUrl}`);
            return null;
        }

        const entry = await page.evaluate(([selectors, minLength]) => {
            for (const selector of selectors) {
                const element = document.querySelector(selector);
                if (!element) continue;
                const html = element.innerHTML;
                if (html.length < minLength) continue;
                return {
                    selector,
                    metaTitle: document.querySelector('h1')?.textContent.trim() ?? '',
                    rawContent: html,
                };
            }
            return null;
        }, [CONTENT_SELECTORS, MIN_CONTENT_LENGTH]);

        if (!entry) {
            console.warn(`[oup] Contenu trop court ou vide sur ${pageUrl} (page servie mais sans appel visible)`);
            return null;
        }

        console.log(`[oup] Conteneur "${entry.selector}" retenu sur ${pageUrl} (${entry.rawContent.length} caracteres)`);
        return entry;
    } catch (error) {
        console.warn(`[oup] Erreur (timeout ou navigation) sur ${pageUrl} : ${error.message}`);
        return null;
    } finally {
        await page.close();
    }
}
