import * as cheerio from 'cheerio';
import { mkdtempSync } from 'fs';
import path from 'path';
import os from 'os';
import { matchIssn } from '../issnMatcher.mjs';
import { curlGet } from '../curlClient.mjs';

// Page revue unique (pas de hub separe) : jle.com y liste les appels
// ouverts, suivis d'un bloc "Appels clotures" -- confirme manuellement via
// curl direct (200, HTML statique, aucun blocage constate).
const PAGE_URL = 'https://www.jle.com/fr/revues/rfg/revue.phtml';
const JOURNAL_NAME = 'Revue française de gestion';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const COOKIE_JAR_PATH = path.join(mkdtempSync(path.join(os.tmpdir(), 'rfg-cookies-')), 'cookies.txt');

// Confirme via le HTML reel : une section unique <h2>Appels a articles</h2>
// contient d'abord les appels ouverts (un <p> par appel : lien vers le PDF
// de l'appel + ligne "Date limite de soumission : ..."), puis un
// <h3>Appels clotures :</h3> qui marque le debut des appels perimes -- on
// s'arrete la, seuls les <p> avant ce <h3> sont retenus.
const OPEN_HEADING_PATTERN = /appels?\s*(à|a)\s*articles/i;
const CLOSED_HEADING_PATTERN = /appels?\s*cl(ô|o)tur/i;

export const scraperObject = {
    url: PAGE_URL,
    abbreviation: 'rfg',
    async scraper() {
        const abbreviation = this.abbreviation;

        const issn = await matchIssn(JOURNAL_NAME);
        if (!issn) {
            console.warn(`[rfg] "${JOURNAL_NAME}" introuvable dans le CSV ISSN, abandon`);
            return [];
        }

        const entries = await get_entries();
        console.log(`[rfg] ${entries.length} appel(s) ouvert(s) trouve(s) sur ${PAGE_URL}`);

        return entries.map(entry => ({
            journal: JOURNAL_NAME,
            abbreviation,
            issn,
            metaTitle: entry.metaTitle,
            url: entry.url,
            rawContent: entry.rawContent,
        }));
    }
}

async function get_entries() {
    let response;
    try {
        response = await curlGet(PAGE_URL, { cookieJarPath: COOKIE_JAR_PATH, userAgent: USER_AGENT });
    } catch (error) {
        console.warn(`[rfg] Erreur reseau (curl) sur ${PAGE_URL} : ${error.message}`);
        return [];
    }

    console.log(`[rfg] Statut HTTP ${response.status} sur ${PAGE_URL}`);
    if (response.status !== 200) {
        console.warn(`[rfg] Statut HTTP ${response.status} (attendu 200) sur ${PAGE_URL} -- probable blocage anti-bot`);
        return [];
    }

    const $ = cheerio.load(response.body);
    const openHeading = $('h2').toArray().find(h => OPEN_HEADING_PATTERN.test($(h).text()));
    if (!openHeading) {
        console.warn(`[rfg] Section "Appels a articles" introuvable sur ${PAGE_URL} (structure modifiee ?)`);
        return [];
    }

    const entries = [];
    for (const node of $(openHeading).nextUntil().toArray()) {
        if (node.tagName === 'h3' && CLOSED_HEADING_PATTERN.test($(node).text())) break;
        if (node.tagName !== 'p') continue;

        const link = $(node).find('a[href]').first();
        if (link.length === 0) continue;

        entries.push({
            metaTitle: link.text().trim(),
            url: new URL(link.attr('href'), PAGE_URL).href,
            rawContent: $.html(node),
        });
    }
    return entries;
}
