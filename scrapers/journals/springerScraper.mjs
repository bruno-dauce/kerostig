import { matchIssn } from '../issnMatcher.mjs';
import { waitForCloudflare } from '../cloudflare.mjs';

// Pas de hub centralise chez Springer (link.springer.com) : chaque revue
// expose ses appels sur sa propre page /journal/{id}/collections?filter=Open
// (memes classes "Collections and calls for papers" sur toutes les revues,
// verifie manuellement). L'ID numerique Springer ne se derive pas de l'ISSN
// depuis le site lui-meme (la recherche interne link.springer.com/search
// est rendue cote client, aucun resultat dans le HTML statique ; les URLs
// /journal/{issn} et www.springer.com/journal/{issn} renvoient 400). Resolu
// une fois pour les 34 revues du perimetre via le champ homepage_url de
// l'API OpenAlex (https://api.openalex.org/sources/issn/{issn}, gratuite,
// sans cle), qui pointe vers www.springer.com/.../journal/{id} pour chaque
// revue -- verifie manuellement pour chacune (statut 200 + <title> de la
// page /collections correspondant au nom de la revue).
//
// EURO Journal on Transportation and Logistics (2192-4384) est exclue : son
// homepage_url OpenAlex pointe desormais vers journals.elsevier.com
// (revue transferee chez Elsevier/ScienceDirect, confirme par recherche :
// Springer n'en publie plus). Deja couverte par elsevierScraper.mjs si des
// appels y paraissent.
//
// Les revues Palgrave Macmillan (editeur du groupe Springer Nature) sont
// servies par la meme plateforme link.springer.com, au meme format : 4 des 6
// revues Palgrave du perimetre FNEGE sont donc ajoutees ici (ID resolus par
// le champ homepage_url d'OpenAlex comme ci-dessus, sauf 41267/JIBS dont le
// homepage_url pointe vers l'ancien jibs.net -- ID confirme manuellement par
// le <title> de la page /collections).
//
// European Journal of Information Systems (1476-9344) et Journal of the
// Operational Research Society (1476-9360) sont exclues bien que le CSV les
// rattache encore a Palgrave : les deux revues sont passees chez Taylor &
// Francis (confirme via api.crossref.org/journals/{pissn}, qui renvoie
// "Informa UK (Taylor & Francis)"). Leurs pages link.springer.com existent
// toujours (41303 et 41274, statut 200) mais ne sont que des coquilles
// d'archive : zero app-card-collection, verifie manuellement. Elles sont
// couvertes par tfScraper.mjs, dont le matching par nom resout bien les deux
// ISSN. Ne pas les rajouter ici sans reverifier Crossref.
const JOURNALS = [
    { id: '11142', name: 'Review of Accounting Studies' },
    { id: '10640', name: 'Environmental and Resource Economics' },
    { id: '780', name: 'Finance and Stochastics' },
    { id: '11166', name: 'Journal of Risk and Uncertainty' },
    { id: '10693', name: 'Journal of Financial Services Research' },
    { id: '11146', name: 'The Journal of Real Estate Finance and Economics' },
    { id: '11147', name: 'Review of Derivatives Research' },
    { id: '11156', name: 'Review of Quantitative Finance and Accounting' },
    { id: '10726', name: 'Group Decision and Negotiation' },
    { id: '10869', name: 'Journal of Business and Psychology' },
    { id: '10961', name: 'The Journal of Technology Transfer' },
    { id: '11187', name: 'Small Business Economics' },
    { id: '11365', name: 'International Entrepreneurship and Management Journal' },
    { id: '11192', name: 'Scientometrics' },
    { id: '11575', name: 'Management International Review' },
    { id: '10551', name: 'Journal of Business Ethics' },
    { id: '10479', name: 'Annals of Operations Research' },
    { id: '10490', name: 'Asia Pacific Journal of Management' },
    { id: '11123', name: 'Journal of Productivity Analysis' },
    { id: '11846', name: 'Review of Managerial Science' },
    { id: '11747', name: 'Journal of the Academy of Marketing Science' },
    { id: '11002', name: 'Marketing Letters' },
    { id: '11129', name: 'Quantitative Marketing and Economics' },
    { id: '10198', name: 'The European Journal of Health Economics' },
    { id: '10729', name: 'Health Care Management Science' },
    { id: '10754', name: 'International Journal of Health Economics and Management' },
    { id: '11136', name: 'Quality of Life Research' },
    { id: '11116', name: 'Transportation' },
    { id: '10796', name: 'Information Systems Frontiers' },
    { id: '12599', name: 'Business & Information Systems Engineering' },
    { id: '12525', name: 'Electronic Markets' },
    { id: '10257', name: 'Information Systems and e-Business Management' },
    { id: '11151', name: 'Review of Industrial Organization' },
    // Palgrave Macmillan (cf. commentaire ci-dessus)
    { id: '41267', name: 'Journal of International Business Studies' },
    { id: '41288', name: 'The Geneva Papers on Risk and Insurance Issues and Practice' },
    { id: '10713', name: 'The Geneva Risk and Insurance Review' },
    { id: '41262', name: 'Journal of Brand Management' },
];

// Confirme via le HTML reel de la page /collections?filter=Open : chaque
// appel ouvert est une <article class="app-card-collection">, avec le titre
// et le lien vers la page de detail dans h2 > a. Pas de pagination observee
// (le nombre d'appels ouverts par revue reste faible, quelques unites au
// plus) ; le filtre "Open" ecarte les collections "Upcoming"/"Closed" qui ne
// sont pas des appels actifs.
const CARD_SELECTOR = 'article.app-card-collection';
const CARD_TITLE_LINK_SELECTOR = 'h2.app-card-collection__heading a.app-card-collection__heading-link';

// Confirme via le HTML reel d'une page de detail /collections/{code} : le
// titre et la revue participante (div.app-collection-masthead) sont hors de
// <main id="main"> (freres dans le document, pas un parent commun exploitable
// a part <body>), alors que le statut, l'echeance et la description
// (guest editors, sujet, instructions de soumission) sont dans <main>. On
// concatene les deux plutot que de se fier a un seul conteneur, sinon le
// titre serait absent du contenu envoye au LLM.
const MASTHEAD_SELECTOR = '.app-collection-masthead';
const MAIN_SELECTOR = '#main, main';

// Redirection cookie (idp.springer.com) constatee sur chaque premiere visite
// d'une page link.springer.com, meme piege que le hub SAGE : un aller-retour
// qui pose un cookie de session puis revient sur l'URL d'origine, sans
// authentification requise (verifie manuellement via curl). Un navigateur
// (patchright) suit ca de façon transparente, aucun traitement particulier
// necessaire ici. Aucun challenge Cloudflare observe sur ces pages
// (contrairement a Emerald/T&F) ; l'attente reste gardee par coherence avec
// les autres scrapers patchright, cout negligeable si rien n'apparait.
const REQUEST_DELAY_MS = 1000;

export const scraperObject = {
    url: 'https://link.springer.com/',
    abbreviation: 'springer',
    async scraper(browser) {
        const abbreviation = this.abbreviation;

        const calls = [];
        let notFoundCount = 0;
        for (const journal of JOURNALS) {
            const issn = await matchIssn(journal.name);
            if (!issn) {
                console.warn(`[springer] "${journal.name}" non trouve dans le CSV ISSN, verifier l'orthographe`);
                continue;
            }

            await sleep(REQUEST_DELAY_MS);
            const listingUrl = `https://link.springer.com/journal/${journal.id}/collections?filter=Open`;
            const entries = await get_listings(browser, listingUrl);

            for (const entry of entries) {
                await sleep(REQUEST_DELAY_MS);
                const rawContent = await get_raw_content(browser, entry.url);
                if (!rawContent) {
                    notFoundCount++;
                    continue;
                }
                calls.push({
                    journal: journal.name,
                    abbreviation,
                    issn,
                    metaTitle: entry.metaTitle,
                    url: entry.url,
                    rawContent,
                });
            }
        }
        console.log(`[springer] ${calls.length} appel(s) trouve(s) sur ${JOURNALS.length} revue(s)`);
        console.log(`[springer] ${notFoundCount} appel(s) ignore(s), extraction du contenu brut echouee`);

        return calls;
    }
}

async function get_listings(browser, listingUrl) {
    const page = await browser.newPage();
    try {
        await page.goto(listingUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await waitForCloudflare(page, '[springer]');

        // Timeout court : la plupart des revues n'ont aucun appel ouvert a un
        // instant donne, attendre 30s a chaque fois sur ~33 revues ralentirait
        // inutilement le run entier.
        const found = await page.waitForSelector(CARD_SELECTOR, { timeout: 8000 })
            .then(() => true)
            .catch(() => false);
        if (!found) return [];

        const entries = await page.$$eval(CARD_SELECTOR, (items, selector) => items.map(item => {
            const link = item.querySelector(selector);
            return {
                metaTitle: link?.textContent.trim() ?? '',
                url: link?.href ?? null,
            };
        }), CARD_TITLE_LINK_SELECTOR);
        return entries.filter(entry => entry.metaTitle && entry.url);
    } catch (error) {
        console.warn(`[springer] Erreur (timeout ou navigation) sur ${listingUrl} : ${error.message}`);
        return [];
    } finally {
        await page.close();
    }
}

async function get_raw_content(browser, url) {
    const page = await browser.newPage();
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await waitForCloudflare(page, '[springer]');

        const found = await page.waitForSelector(MAIN_SELECTOR, { timeout: 30000 })
            .then(() => true)
            .catch(() => false);
        if (!found) {
            console.warn(`[springer] Conteneur de contenu introuvable sur ${url}`);
            return null;
        }

        const rawContent = await page.evaluate(([mastheadSelector, mainSelector]) => {
            const masthead = document.querySelector(mastheadSelector)?.innerHTML ?? '';
            const main = document.querySelector(mainSelector)?.innerHTML ?? '';
            return masthead + main;
        }, [MASTHEAD_SELECTOR, MAIN_SELECTOR]);

        if (!rawContent) {
            console.warn(`[springer] Extraction du contenu brut echouee pour ${url}`);
            return null;
        }
        return rawContent;
    } catch (error) {
        console.warn(`[springer] Erreur (timeout ou navigation) sur ${url} : ${error.message}`);
        return null;
    } finally {
        await page.close();
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
