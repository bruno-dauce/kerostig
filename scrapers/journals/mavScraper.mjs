import * as cheerio from 'cheerio';
import { interpreterReponseApi } from '../apiJson.mjs';

// Management & Avenir publie ses appels sur un WordPress dont l'API REST est
// ouverte : on l'interroge directement plutot que de parser le HTML de la page
// categorie, comme le font deja reScraper (posts), aomScraper (tribe_events) et
// tfScraper (special_issues). robots.txt n'interdit que /wp-admin/ et le panier
// WooCommerce, rien de ce qui est lu ici.
//
// Un seul aller-retour suffit apres la resolution de categorie : le champ
// content.rendered porte le texte integral de l'appel, il n'y a donc aucune
// page de detail a visiter (contrairement a miScraper, l'autre WordPress
// francophone du lot).
const API_BASE = 'https://managementetavenir.fr/wp-json/wp/v2/';
const SITE_BASE = 'https://managementetavenir.fr/';
const LISTING_URL = 'https://managementetavenir.fr/category/appels-a-publications/';
const JOURNAL_NAME = 'Management & Avenir';

// La categorie est resolue par son slug a chaque passage plutot que figee sur
// son identifiant (1218 au 2026-09-07). Un identifiant fige qui ne repond plus
// rendrait une liste vide -- soit, pour diffChecker, une source qui a perdu
// tous ses appels. Le slug, lui, est stable et visible dans l'URL publique.
const CATEGORY_SLUG = 'appels-a-publications';

// ISSN litteral et non matchIssn(JOURNAL_NAME) : c'est l'issn_cle du CSV
// enrichi et de journals.json, donc la cle de jointure elle-meme. Une variation
// du libelle cote CSV ferait rendre null a matchIssn et couperait la collecte
// pour un changement purement cosmetique.
const ISSN = '1969-6574';

// La categorie ne contient que 2 posts (2026-09-07) et n'accueille qu'un ou
// deux appels par an : une page de 100 les couvre tres largement. Pas de boucle
// de pagination, mais un avertissement si la page revient pleine -- c'est
// exactement la troncature muette qui avait archive 41 appels Emerald vivants.
const API_PAGE_SIZE = 100;

// Seuls ces quatre champs sont lus. Sans _fields, WordPress joint a chaque post
// ses metadonnees d'auteur, de taxonomie et de SEO, jamais consultees ici.
const API_FIELDS = 'id,link,title,content';

// Un intertitre purement decoratif ne fait pas un titre. Le site en utilise
// reellement : sa mise en page separe les sections par des <h2> de petits
// cercles degrés.
const TEXTE_UTILE_PATTERN = /[\p{L}\p{N}]/u;

export const scraperObject = {
    url: LISTING_URL,
    abbreviation: 'mav',
    async scraper(browser) {
        const abbreviation = this.abbreviation;

        // Un echec rend [] et ne leve pas : scrapeAll enchaine les scrapers
        // dans un Promise.all, une exception ferait echouer le passage entier
        // et aucune donnee ne serait ecrite, pour tous les editeurs. La
        // decision reste au garde-fou de diffChecker, qui gele les appels
        // existants au lieu de les archiver.
        let categorieId;
        try {
            categorieId = await fetch_category_id(browser);
        } catch (error) {
            console.error(`[mav] ECHEC : categorie "${CATEGORY_SLUG}" illisible (${error.message}). Collecte abandonnee.`);
            return [];
        }
        if (categorieId === null) {
            console.error(`[mav] ECHEC : aucune categorie de slug "${CATEGORY_SLUG}" sur ${API_BASE}. Collecte abandonnee plutot que lancee sans filtre.`);
            return [];
        }

        let posts;
        try {
            posts = await fetch_posts(browser, categorieId);
        } catch (error) {
            console.error(`[mav] ECHEC de la collecte : ${error.message}. Liste abandonnee plutot que publiee tronquee.`);
            return [];
        }
        console.log(`[mav] ${posts.length} post(s) dans la categorie ${categorieId} (${CATEGORY_SLUG})`);

        if (posts.length >= API_PAGE_SIZE) {
            console.warn(`[mav] page pleine (${posts.length} posts) : la categorie depasse peut-etre une page, une boucle de pagination devient necessaire`);
        }

        const calls = [];
        let ecartes = 0;
        for (const post of posts) {
            const call = formater_appel(post, abbreviation);
            if (!call) {
                ecartes++;
                continue;
            }
            calls.push(call);
        }

        const suffixe = ecartes > 0 ? `, ${ecartes} post(s) ecarte(s) (titre ou contenu absent)` : '';
        console.log(`[mav] ${calls.length} appel(s) retenu(s)${suffixe}`);
        return calls;
    }
}

async function fetch_category_id(browser) {
    const url = new URL('categories', API_BASE);
    url.searchParams.set('slug', CATEGORY_SLUG);
    url.searchParams.set('_fields', 'id,slug');

    const donnees = await fetch_api(browser, url.href);
    return extraire_id_categorie(donnees);
}

async function fetch_posts(browser, categorieId) {
    const url = new URL('posts', API_BASE);
    url.searchParams.set('categories', String(categorieId));
    url.searchParams.set('per_page', String(API_PAGE_SIZE));
    url.searchParams.set('_fields', API_FIELDS);

    return await fetch_api(browser, url.href);
}

// Interpretation partagee avec reScraper, aomScraper et tfScraper : la reponse
// JSON est servie telle quelle dans le body, on la relit depuis la page. Aucun
// catch qui rend [] -- c'est ce repli qui rendait la panne muette.
async function fetch_api(browser, href) {
    const page = await browser.newPage();
    try {
        const reponse = await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 30000 });
        const corps = await page.evaluate(() => document.body.innerText);
        return interpreterReponseApi({ statut: reponse ? reponse.status() : null, corps, url: href, prefixe: '[mav]' });
    } finally {
        await page.close();
    }
}

// Rend l'identifiant de la categorie, ou null si le slug n'existe pas. Leve si
// la reponse n'a pas la forme attendue : sans identifiant, la requete de posts
// partirait sans filtre et ramenerait tout le blog.
// Fonction pure, exportee pour test.
export function extraire_id_categorie(donnees) {
    if (!Array.isArray(donnees)) {
        throw new Error('[mav] reponse de categorie inattendue : un tableau etait attendu');
    }
    const id = donnees.map(terme => terme && terme.id).find(valeur => Number.isInteger(valeur));
    return id === undefined ? null : id;
}

// Les deux appels en ligne portent le MEME titre WordPress ("APPEL a
// PUBLICATIONS - RMA - Cahier special") : la revue s'en sert comme d'un libelle
// de rubrique, pas comme d'un titre. Utilise tel quel, il donnerait deux fiches
// indistinguables et deux slugs en collision (generateSlug, dataPreparation).
// Le titre reel est le premier intertitre du corps.
// Fonction pure, exportee pour test.
export function extraire_titre(post) {
    const repli = decode_html(post?.title?.rendered);
    const contenu = post?.content?.rendered;
    if (!contenu || typeof contenu !== 'string') return repli;

    const $ = cheerio.load(contenu);
    for (const element of $('h1, h2, h3, h4, h5, h6').toArray()) {
        const texte = normaliser($(element).text());
        if (TEXTE_UTILE_PATTERN.test(texte)) return texte;
    }
    return repli;
}

// Rend l'appel au format attendu par dataPreparation, ou null si le post n'a
// pas de quoi en faire un.
// Fonction pure, exportee pour test.
export function formater_appel(post, abbreviation) {
    const rawContent = post?.content?.rendered;
    if (!rawContent || typeof rawContent !== 'string' || rawContent.trim() === '') return null;

    const metaTitle = extraire_titre(post);
    if (!metaTitle) return null;

    const url = post?.link
        ? new URL(post.link, SITE_BASE).href
        : Number.isInteger(post?.id) ? `${SITE_BASE}?p=${post.id}` : null;
    if (!url) return null;

    return {
        journal: JOURNAL_NAME,
        abbreviation,
        issn: ISSN,
        metaTitle,
        url,
        rawContent,
    };
}

// Les titres WordPress arrivent encodes (&rsquo;, &#8211;, &laquo;) : sans
// decodage, le libelle transmis au LLM porte des entites plutot que du texte.
// Fonction pure, exportee pour test.
export function decode_html(value) {
    if (!value || typeof value !== 'string') return '';
    return normaliser(cheerio.load(`<x>${value}</x>`)('x').text());
}

function normaliser(texte) {
    return texte.replace(/\s+/g, ' ').trim();
}
