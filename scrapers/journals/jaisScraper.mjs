import * as cheerio from 'cheerio';
import { matchIssn } from '../issnMatcher.mjs';
import { getContent } from '../fileParser.mjs';

// Liste des numeros speciaux de JAIS (AIS eLibrary, Digital Commons). Les
// appels y sont des items <li> dont le lien commence par « Call for Papers: » ;
// les numeros deja publies (« Special Issue on ... - Published ... ») n'ont pas
// ce prefixe et restent donc ecartes. Le conteneur n'est pas un point d'ancrage
// fiable : l'ancien selecteur (div#main > div#breadcrumb + h2 + ul) a cesse de
// correspondre quand la page est passee a h2 / h3 / br / ul, et div.crumbs n'est
// que le fil d'Ariane. Le prefixe du lien est le seul critere qui ait tenu.
const LISTING_URL = 'https://aisel.aisnet.org/jais/specialissues.html';
const JOURNAL_NAME = 'Journal of the Association for Information Systems';
const PREFIXE_APPEL = /^Call for Papers:/i;
const REQUEST_DELAY_MS = 1000;
const NAVIGATION_TIMEOUT_MS = 60000;
const USER_AGENT = 'Mozilla/5.0 (compatible; kerostig-bot)';

// Le texte du lien est normalise (« Call for Papers:  Digital ... » porte un
// double espace sur le site) ; l'URL est gardee telle que publiee, c'est elle
// qui sert d'identite a la fiche. Fonction pure, exportee pour test.
export function extraire_liens_appels(html, baseUrl = LISTING_URL) {
    const $ = cheerio.load(html);
    const vus = new Set();
    const liens = [];
    $('li > a[href]').each((_, a) => {
        const titre = $(a).text().replace(/\s+/g, ' ').trim();
        if (!PREFIXE_APPEL.test(titre)) return;
        let url;
        try { url = new URL($(a).attr('href').trim(), baseUrl).href; } catch { return; }
        if (vus.has(url)) return;
        vus.add(url);
        liens.push({ titre, url });
    });
    return liens;
}

// L'URL de la fiche (celle que l'on garde et compare) reste celle du site ;
// seule la requete de telechargement est reecrite. Dropbox sert une page
// d'apercu avec dl=0 et le fichier avec dl=1. Fonction pure, exportee pour test.
export function url_de_telechargement(url) {
    let u;
    try { u = new URL(url); } catch { return url; }
    if (/(^|\.)dropbox\.com$/i.test(u.hostname)) {
        u.searchParams.set('dl', '1');
        return u.href;
    }
    return url;
}

// Type d'apres les premiers octets, pas d'apres l'URL ni le Content-Type :
// Dropbox sert un PDF en « application/binary », et un lien expire rend une
// page HTML en 200 (SharePoint, « the link has expired »). Une page d'erreur
// ne doit jamais etre prise pour le texte de l'appel. Fonction pure, exportee
// pour test.
export function detecter_type(buffer) {
    const tete = Buffer.from(buffer.subarray(0, 5)).toString('latin1');
    if (tete.startsWith('%PDF')) return 'pdf';
    if (tete.startsWith('PK')) return 'docx';
    return null;
}

export const scraperObject = {
    url: LISTING_URL,
    abbreviation: 'jais',
    async scraper(browser) {
        const abbreviation = this.abbreviation;

        const issn = await matchIssn(JOURNAL_NAME);
        if (!issn) {
            console.warn(`[jais] "${JOURNAL_NAME}" introuvable dans le CSV ISSN, abandon`);
            return [];
        }

        const liens = await get_listings(browser);
        console.log(`[jais] ${liens.length} appel(s) trouve(s) sur ${LISTING_URL}`);

        const calls = [];
        for (const lien of liens) {
            await sleep(REQUEST_DELAY_MS);
            const rawContent = await get_document_text(lien.url);
            // Pas de contenu de repli : un titre et une echeance de liste ne
            // suffisent pas a extraire un appel sans inventer le reste. Sans
            // texte, l'appel est ecarte et sa fiche eventuelle reste telle quelle.
            if (!rawContent) continue;
            calls.push({
                journal: JOURNAL_NAME,
                abbreviation,
                issn,
                metaTitle: lien.titre,
                url: lien.url,
                rawContent,
            });
        }
        return calls;
    }
}

async function get_listings(browser) {
    const page = await browser.newPage();
    try {
        await page.goto(LISTING_URL, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
        const liens = extraire_liens_appels(await page.content(), LISTING_URL);
        if (liens.length === 0) {
            console.warn(`[jais] Aucun lien « Call for Papers: » sur ${LISTING_URL} (structure modifiee, ou aucun appel ouvert)`);
        }
        return liens;
    } catch (error) {
        console.warn(`[jais] Erreur (timeout ou navigation) sur ${LISTING_URL} : ${error.message}`);
        return [];
    } finally {
        await page.close();
    }
}

// Telechargement direct plutot que par le navigateur (fileParser.parse) :
// celui-ci echouait de facon intermittente sur le .docx (« context closed »),
// alors que fetch rend exactement le meme texte (20 865 caracteres sur le
// .docx, le 2026-10-01, dans les deux cas).
async function get_document_text(url) {
    try {
        const reponse = await fetch(url_de_telechargement(url), { redirect: 'follow', headers: { 'User-Agent': USER_AGENT } });
        if (!reponse.ok) {
            console.warn(`[jais] HTTP ${reponse.status} sur ${url}, appel ecarte`);
            return null;
        }
        const buffer = Buffer.from(await reponse.arrayBuffer());
        const type = detecter_type(buffer);
        if (!type) {
            console.warn(`[jais] ${url} ne renvoie ni PDF ni docx (lien expire ?), appel ecarte`);
            return null;
        }
        const texte = await getContent(buffer, type);
        if (!texte || texte.trim() === '') {
            console.warn(`[jais] Texte vide sur ${url}, appel ecarte`);
            return null;
        }
        return texte;
    } catch (error) {
        console.warn(`[jais] Erreur de lecture sur ${url} : ${error.message}`);
        return null;
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
