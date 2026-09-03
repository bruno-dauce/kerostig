import { matchIssn } from '../issnMatcher.mjs';
import { waitForCloudflare } from '../cloudflare.mjs';

// Le hub authorservices.taylorandfrancis.com interroge cette API REST
// WordPress (think.taylorandfrancis.com, meme site que les pages de detail)
// directement depuis le navigateur pour peupler ses resultats. Confirme via
// l'onglet Network : le hub ne sert donc que de catalogue de categories, la
// vraie donnee vient d'ici.
const LISTING_URL = 'https://authorservices.taylorandfrancis.com/call-for-papers/';
const API_BASE = 'https://think.taylorandfrancis.com/wp-json/wp/v2/special_issues';
// Les identifiants de categorie viennent de l'API et non plus des cases a
// cocher du hub. Le 2026-09-03, celles-ci portaient « AS », « AR », « BE » la
// ou l'API attend un Term ID entier : les 30 requetes repondaient 400 et le
// scraper rentrait bredouille sans un mot. Lire la taxonomie a la source
// supprime la dependance au gabarit HTML du hub, qui peut etre refondu a tout
// moment sans que l'API bouge.
const TAXONOMY_BASE = 'https://think.taylorandfrancis.com/wp-json/wp/v2/special_issues_tax_subject_areas';
const TAXONOMY_PAGE_SIZE = 100;
const API_FIELDS = [
    'link',
    'special_issues_tax_subject_areas',
    'special_issues._special_issues_journal_title',
    'special_issues._special_issues_title',
    'special_issues._special_issues_copy',
    'special_issues._special_issues_deadline',
    'special_issues._special_issues_journal_cover_image',
].join(',');
const API_PAGE_SIZE = 100;

// On interroge l'API une fois par categorie (le format multi-valeurs du
// parametre special_issues_tax_subject_areas n'est pas confirme) et on
// deduplique par URL ensuite.

// Confirme via le HTML reel d'une page de detail (site think.taylorandfrancis.com,
// WordPress, custom post type "special_issues").
const DETAIL_CONTENT_SELECTOR = 'article';

let loggedUnexpectedShape = false;

// Interprete une reponse de l'API. Rend le tableau d'items, ou LEVE.
//
// Le mode de panne que cette fonction ferme : l'ancien code faisait
// JSON.parse puis « Array.isArray(data) ? data : [] ». Une reponse d'erreur
// WordPress etant du JSON parfaitement valide, elle franchissait le parse et
// ressortait en tableau vide -- soit exactement le signal de fin de
// pagination. Un echec total devenait « plus rien a lire », en silence. C'est
// la meme confusion entre [] et l'echec qui avait fait archiver 41 appels
// vivants chez Emerald.
//
// Un tableau valide est accepte quel que soit le statut : page.goto rend
// celui de la PREMIERE reponse, et Cloudflare sert son interstitiel en 403
// avant de remplacer le document sur place (cf scrapers/cloudflare.mjs). Le
// corps final est donc la seule autorite ; sans cette tolerance, un challenge
// franchi passerait pour une panne.
//
// Fonction pure, exportee pour test.
export function interpreterReponseApi({ statut, corps, url }) {
    let donnees = null;
    let lisible = true;
    try {
        donnees = JSON.parse(corps);
    } catch {
        lisible = false;
    }

    if (lisible && Array.isArray(donnees)) return donnees;

    const detail = !lisible
        ? ' (reponse non JSON)'
        : donnees && donnees.code
            ? ` (${donnees.code})`
            : ' (JSON valide mais pas un tableau)';
    const prefixe = statut != null && (statut < 200 || statut >= 300)
        ? `HTTP ${statut}`
        : 'reponse inattendue';
    throw new Error(`[tandf] ${prefixe} sur ${url}${detail}`);
}

// WordPress refuse une page au-dela de la derniere avec ce code. Ce n'est pas
// une panne mais une fin de liste : la boucle de pagination s'arrete au lieu
// d'invalider la categorie. Filet derriere doitDemanderPageSuivante, qui evite
// deja de demander cette page dans le cas courant -- il reste le cas ou le
// nombre d'appels d'une categorie est un multiple exact de la taille de page.
const CODE_PAGE_HORS_BORNES = 'rest_post_invalid_page_number';

// Fonction pure, exportee pour test.
export function estFinDePagination(erreur) {
    return Boolean(erreur && typeof erreur.message === 'string' && erreur.message.includes(CODE_PAGE_HORS_BORNES));
}

// Une page incomplete est la derniere : la demander quand meme valait a
// l'ancien code un 400 systematique en fin de chaque categorie, avale en []
// et pris pour une fin de pagination. La boucle ne terminait donc que grace au
// repli muet qu'on vient de supprimer.
// Fonction pure, exportee pour test.
export function doitDemanderPageSuivante(nombreItems, taillePage) {
    return nombreItems > 0 && nombreItems >= taillePage;
}

// Term ID entiers de la reponse de taxonomie. Tout ce qui n'est pas un entier
// est ecarte : c'est precisement ce que rendaient les cases a cocher du hub
// (« AS »), et que l'API refuse avec un rest_invalid_param.
// Fonction pure, exportee pour test.
export function extraireIdsCategories(donnees) {
    if (!Array.isArray(donnees)) {
        throw new Error('[tandf] reponse de taxonomie inattendue : un tableau de categories etait attendu');
    }
    const ids = donnees.map(terme => terme && terme.id).filter(id => Number.isInteger(id));
    return [...new Set(ids)];
}

export const scraperObject = {
    url: LISTING_URL,
    abbreviation: 'tandf',
    async scraper(browser) {
        const abbreviation = this.abbreviation;

        // Un echec rend [] et ne leve pas : scrapeAll enchaine les scrapers
        // dans un Promise.all, une exception ferait donc echouer le passage
        // entier et integrateCalls ne s'executerait pas -- aucune donnee
        // ecrite, pour tous les editeurs. Rendre [] laisse la decision au
        // garde-fou des scrapers vides (diffChecker), qui gele les appels
        // existants au lieu de les archiver. Le bruit, lui, est en console.error.
        let subjectAreaIds;
        try {
            subjectAreaIds = await get_subject_area_ids(browser);
        } catch (error) {
            console.error(`[tandf] ECHEC : categories illisibles (${error.message}). Collecte abandonnee.`);
            return [];
        }
        console.log(`[tandf] ${subjectAreaIds.length} categorie(s) de sujet a interroger`);

        const entriesByUrl = new Map();
        let echecCollecte = false;
        for (const subjectAreaId of subjectAreaIds) {
            try {
                const entries = await get_entries_for_subject_area(browser, subjectAreaId);
                for (const entry of entries) {
                    if (entry.url) entriesByUrl.set(entry.url, entry);
                }
            } catch (error) {
                echecCollecte = true;
                console.error(`[tandf] ECHEC sur la categorie ${subjectAreaId} : ${error.message}`);
            }
        }
        // Meme regle que chez Emerald (evaluerCollecte) : une collecte
        // incomplete n'est pas publiee. Une liste tronquee ferait passer pour
        // disparus des appels bien vivants.
        if (echecCollecte) {
            console.error(`[tandf] Collecte incomplete (${entriesByUrl.size} appel(s) avant echec) : liste abandonnee plutot que publiee tronquee.`);
            return [];
        }
        console.log(`[tandf] ${entriesByUrl.size} appel(s) distinct(s) trouve(s)`);

        let skippedCount = 0;
        const calls = [];
        for (const entry of entriesByUrl.values()) {
            if (!entry.journal) {
                skippedCount++;
                continue;
            }
            const issn = await matchIssn(entry.journal);
            if (!issn) {
                skippedCount++;
                continue;
            }

            const rawContent = await get_raw_content(browser, entry.url);
            if (!rawContent) continue;

            calls.push({
                journal: entry.journal,
                abbreviation,
                issn,
                metaTitle: entry.metaTitle ?? entry.journal,
                url: entry.url,
                rawContent,
            });
        }
        console.log(`[tandf] ${skippedCount} appel(s) ignore(s), revue hors perimetre FNEGE`);

        return calls;
    }
}

// Lecture d'une reponse JSON de l'API, via le navigateur : l'hote est derriere
// Cloudflare et refuse tout client sans empreinte de navigateur. Aucun catch
// ici -- les erreurs de navigation comme celles d'interpretation doivent
// remonter jusqu'a l'appelant, qui seul sait s'il peut continuer.
async function lire_json_api(browser, url) {
    const page = await browser.newPage();
    try {
        const reponse = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await waitForCloudflare(page, '[tandf]');
        const corps = await page.evaluate(() => document.body.innerText);
        return interpreterReponseApi({ statut: reponse ? reponse.status() : null, corps, url });
    } finally {
        await page.close();
    }
}

async function get_subject_area_ids(browser) {
    const url = new URL(TAXONOMY_BASE);
    url.searchParams.set('per_page', String(TAXONOMY_PAGE_SIZE));
    url.searchParams.set('_fields', 'id,name,slug');
    return extraireIdsCategories(await lire_json_api(browser, url.href));
}

async function get_entries_for_subject_area(browser, subjectAreaId) {
    const entries = [];
    let pageNumber = 1;
    while (true) {
        let items;
        try {
            items = await fetch_api_page(browser, subjectAreaId, pageNumber);
        } catch (error) {
            if (estFinDePagination(error)) break;
            throw error;
        }
        if (items.length === 0) break;
        entries.push(...items.map(parse_entry));
        if (!doitDemanderPageSuivante(items.length, API_PAGE_SIZE)) break;
        pageNumber++;
    }
    return entries;
}

async function fetch_api_page(browser, subjectAreaId, pageNumber) {
    const url = new URL(API_BASE);
    url.searchParams.set('_fields', API_FIELDS);
    url.searchParams.set('per_page', String(API_PAGE_SIZE));
    url.searchParams.set('special_issues_tax_subject_areas', subjectAreaId);
    url.searchParams.set('page', String(pageNumber));

    // Plus de catch qui rend [] : c'est ce repli qui rendait la panne muette.
    // L'erreur remonte a scraper(), qui abandonne la collecte plutot que d'en
    // publier une version tronquee.
    return lire_json_api(browser, url.href);
}

// Les champs meta de WordPress sont des tableaux : depuis la refonte du
// 2026-09-03, _special_issues_title et _special_issues_journal_title arrivent
// sous la forme ["Titre"] la ou ils etaient des chaines. Les 83 appels T&F
// deja stockes portent tous des chaines : sans ce depliage, le meme appel
// ressortirait avec un titre tableau, illisible dans les gabarits et dans le
// slug. matchIssn s'en tirait deja par un garde-fou, mais en journalisant une
// alerte a chaque appel.
// Fonction pure, exportee pour test.
export function lireChampMeta(valeur) {
    const brut = Array.isArray(valeur) ? valeur[0] : valeur;
    if (typeof brut !== 'string') return null;
    const propre = brut.trim();
    return propre === '' ? null : propre;
}

function parse_entry(item) {
    const journal = lireChampMeta(
        item?.special_issues?._special_issues_journal_title ?? item?._special_issues_journal_title,
    );
    const metaTitle = lireChampMeta(
        item?.special_issues?._special_issues_title ?? item?._special_issues_title,
    );

    if (!journal && !loggedUnexpectedShape) {
        loggedUnexpectedShape = true;
        console.warn(`[tandf] Forme de reponse API inattendue, cles recues : ${Object.keys(item ?? {}).join(', ')}`);
    }

    return { url: item?.link ?? null, journal, metaTitle };
}

async function get_raw_content(browser, url) {
    const page = await browser.newPage();
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await waitForCloudflare(page, '[tandf]');
        const rawContent = await page.waitForSelector(DETAIL_CONTENT_SELECTOR, { timeout: 30000 })
            .then(() => page.$eval(DETAIL_CONTENT_SELECTOR, element => element.innerHTML))
            .catch(() => null);
        if (!rawContent) {
            console.warn(`[tandf] Extraction du contenu brut echouee pour ${url}`);
        }
        return rawContent;
    } catch (error) {
        console.warn(`[tandf] Erreur (timeout ou navigation) sur ${url} : ${error.message}`);
        return null;
    } finally {
        await page.close();
    }
}
