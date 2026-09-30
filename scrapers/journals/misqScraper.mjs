import * as cheerio from 'cheerio';
import { matchIssn } from '../issnMatcher.mjs';
import { waitForCloudflare } from '../cloudflare.mjs';

// misq.umn.edu sert un challenge Cloudflare : curl recoit un 403 meme en
// local, le navigateur (profil persistant) passe seul en environ 6 s
// (mesure le 2026-10-01). Non teste depuis un runner GitHub ; par prudence,
// MISQ se lance a la main avec les editeurs bloques en CI (scripts/lancement-
// manuel.mjs).
const LISTING_URL = 'https://misq.umn.edu/pages/special_issues';
const JOURNAL_NAME = 'MIS Quarterly';
const SELECTEUR_LISTE = '.forthcoming-item';
const SELECTEUR_DETAIL = 'div.container';
const REQUEST_DELAY_MS = 1000;
const NAVIGATION_TIMEOUT_MS = 60000;

// Les appels a venir sont des .forthcoming-item au titre en h2. Une entree
// dont le h2 n'a pas de lien n'a pas de page de detail (« Registered Reports »,
// qui ne fournit qu'un PDF, echeance en 2023) : elle est ignoree, sa fiche
// heritee reste archivee. Fonction pure, exportee pour test.
export function extraire_liens_appels(html, baseUrl = LISTING_URL) {
    const $ = cheerio.load(html);
    const vus = new Set();
    const liens = [];
    $(SELECTEUR_LISTE).each((_, item) => {
        const a = $(item).find('h2 a[href]').first();
        if (a.length === 0) return;
        const titre = a.text().replace(/\s+/g, ' ').trim();
        let url;
        try { url = new URL(a.attr('href').trim(), baseUrl).href; } catch { return; }
        if (!titre || vus.has(url)) return;
        vus.add(url);
        liens.push({ titre, url });
    });
    return liens;
}

// div.container contient l'appel seul, du titre aux editeurs ; la page entiere
// (en-tete, pied, cookies) n'a rien a faire dans le contenu envoye au modele.
// Fonction pure, exportee pour test.
export function extraire_contenu_appel(html) {
    const $ = cheerio.load(html);
    const conteneur = $(SELECTEUR_DETAIL).first();
    const contenu = conteneur.length ? conteneur.html() : null;
    return contenu && contenu.trim() !== '' ? contenu : null;
}

export const scraperObject = {
    url: LISTING_URL,
    abbreviation: 'misq',
    async scraper(browser) {
        const abbreviation = this.abbreviation;

        const issn = await matchIssn(JOURNAL_NAME);
        if (!issn) {
            console.warn(`[misq] "${JOURNAL_NAME}" introuvable dans le CSV ISSN, abandon`);
            return [];
        }

        const liens = await get_listings(browser);
        console.log(`[misq] ${liens.length} appel(s) trouve(s) sur ${LISTING_URL}`);

        const calls = [];
        for (const lien of liens) {
            await sleep(REQUEST_DELAY_MS);
            const rawContent = await get_detail_content(browser, lien.url);
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
        const passe = await waitForCloudflare(page, '[misq]', SELECTEUR_LISTE);
        if (!passe) return [];
        const liens = extraire_liens_appels(await page.content(), LISTING_URL);
        if (liens.length === 0) {
            console.warn(`[misq] Aucun appel lie (${SELECTEUR_LISTE} h2 a) sur ${LISTING_URL} (structure modifiee ?)`);
        }
        return liens;
    } catch (error) {
        console.warn(`[misq] Erreur (timeout ou navigation) sur ${LISTING_URL} : ${error.message}`);
        return [];
    } finally {
        await page.close();
    }
}

async function get_detail_content(browser, url) {
    const page = await browser.newPage();
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
        await waitForCloudflare(page, '[misq]', SELECTEUR_DETAIL);
        const contenu = extraire_contenu_appel(await page.content());
        if (!contenu) console.warn(`[misq] Aucun contenu (${SELECTEUR_DETAIL}) extrait sur ${url}`);
        return contenu;
    } catch (error) {
        console.warn(`[misq] Erreur (timeout ou navigation) sur ${url} : ${error.message}`);
        return null;
    } finally {
        await page.close();
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
