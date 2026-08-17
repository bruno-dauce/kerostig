import * as cheerio from 'cheerio';
import { matchIssn } from '../issnMatcher.mjs';

// La Revue de l'Entrepreneuriat est diffusee sur Cairn, mais ses appels sont
// publies par l'Academie de l'Entrepreneuriat et de l'Innovation, qui edite
// la revue. Le site est un WordPress dont l'API REST est ouverte : on
// l'interroge directement plutot que de parser le HTML du blog, comme le
// font deja aomScraper (tribe_events) et tfScraper (special_issues).
const API_BASE = 'https://entrepreneuriat.com/wp-json/wp/v2/posts';
const POST_URL_BASE = 'https://entrepreneuriat.com/';
const JOURNAL_NAME = "Revue de l'Entrepreneuriat";
const REQUEST_DELAY_MS = 1000;

// Categorie 18 = "Revue de l'Entrepreneuriat" (confirme via
// /wp-json/wp/v2/categories?search=revue ; la 19 est Entreprendre &
// Innover, une autre revue).
const CATEGORY_ID = '18';
const API_FIELDS = 'id,date,link,title,content';
const API_PAGE_SIZE = 100;

// La categorie est un archive permanent : elle contient 83 posts remontant a
// 2007, et le filtre sur les titres en retient 22 dont des appels de 2011,
// 2015 et 2016. Or diffChecker ne repasse un appel a active:false que quand
// il DISPARAIT de sa source, et isActiveCall (eleventy.config.mjs) ne
// regarde que ce drapeau, jamais l'echeance : sans borne, une vingtaine
// d'appels morts s'afficheraient comme courants a vie. Meme piege que la
// page d'annonces de la RIPME, meme parade.
//
// On laisse WordPress filtrer via ?after= plutot que de tout rapatrier pour
// jeter ensuite : la reponse passe de 1,9 Mo a 23 Ko.
const MAX_AGE_MONTHS = 24;

// Les posts melangent appels a contributions, appels a propositions de
// numeros speciaux, recrutements d'editeurs, annonces de parution,
// webinaires et temoignages d'auteurs -- d'ou le filtre sur le titre.
// "candidature" s'ajoute aux exclusions demandees : les appels a
// candidature pour un poste de redacteur en chef ne sont pas des appels a
// publications.
const TITLE_KEEP_PATTERN = /appels?\s*(à|a)\s*(contribution|proposition)|call for/i;
const TITLE_DROP_PATTERN = /recrutons|éditeurs?\s+associés?|candidatures?/i;

export const scraperObject = {
    url: `${API_BASE}?categories=${CATEGORY_ID}`,
    abbreviation: 're',
    async scraper(browser) {
        const abbreviation = this.abbreviation;

        const issn = await matchIssn(JOURNAL_NAME);
        if (!issn) {
            console.warn(`[re] "${JOURNAL_NAME}" introuvable dans le CSV ISSN, abandon`);
            return [];
        }

        const posts = await fetch_posts(browser);
        console.log(`[re] ${posts.length} post(s) publie(s) depuis ${MAX_AGE_MONTHS} mois dans la categorie ${CATEGORY_ID}`);

        const calls = [];
        let skippedCount = 0;
        for (const post of posts) {
            const metaTitle = decode_html(post?.title?.rendered);
            const rawContent = post?.content?.rendered ?? '';
            if (!metaTitle || !rawContent) {
                skippedCount++;
                continue;
            }
            if (!TITLE_KEEP_PATTERN.test(metaTitle) || TITLE_DROP_PATTERN.test(metaTitle)) {
                skippedCount++;
                continue;
            }

            calls.push({
                journal: JOURNAL_NAME,
                abbreviation,
                issn,
                metaTitle,
                url: post.link ? new URL(post.link, POST_URL_BASE).href : `${POST_URL_BASE}?p=${post.id}`,
                rawContent,
            });
        }

        console.log(`[re] ${calls.length} appel(s) retenu(s), ${skippedCount} post(s) ecarte(s) (pas un appel a publications)`);
        return calls;
    }
}

async function fetch_posts(browser) {
    const cutoff = new Date(new Date().setMonth(new Date().getMonth() - MAX_AGE_MONTHS));

    const posts = [];
    let pageNumber = 1;
    while (true) {
        const items = await fetch_api_page(browser, cutoff, pageNumber);
        if (items.length === 0) break;
        posts.push(...items);
        if (items.length < API_PAGE_SIZE) break;
        pageNumber++;
        await sleep(REQUEST_DELAY_MS);
    }
    return posts;
}

async function fetch_api_page(browser, cutoff, pageNumber) {
    const url = new URL(API_BASE);
    url.searchParams.set('categories', CATEGORY_ID);
    url.searchParams.set('_fields', API_FIELDS);
    url.searchParams.set('per_page', String(API_PAGE_SIZE));
    url.searchParams.set('after', cutoff.toISOString());
    url.searchParams.set('page', String(pageNumber));

    const page = await browser.newPage();
    try {
        await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // Meme extraction que aomScraper/tfScraper : la reponse JSON est
        // servie telle quelle dans le body, on la relit depuis la page.
        return await page.evaluate(() => {
            try {
                const data = JSON.parse(document.body.innerText);
                return Array.isArray(data) ? data : [];
            } catch {
                return [];
            }
        });
    } catch (error) {
        console.warn(`[re] Echec de l'appel API ${url.href} : ${error.message}`);
        return [];
    } finally {
        await page.close();
    }
}

// Les titres WordPress arrivent encodes (&rsquo;, &#8211;, &laquo;) : sans
// decodage, le filtre sur le titre et le libelle transmis au LLM traitent
// des entites plutot que du texte.
function decode_html(value) {
    if (!value) return '';
    return cheerio.load(`<x>${value}</x>`)('x').text().replace(/\s+/g, ' ').trim();
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
