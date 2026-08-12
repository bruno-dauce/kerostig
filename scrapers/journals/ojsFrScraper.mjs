import * as cheerio from 'cheerio';
import { mkdtempSync } from 'fs';
import path from 'path';
import os from 'os';
import { matchIssn } from '../issnMatcher.mjs';
import { curlGet } from '../curlClient.mjs';

// M@n@gement et SIM tournent toutes les deux sur OJS/PKP, mais leurs appels
// vivent a des endroits differents de la plateforme (verifie manuellement,
// cf commentaires plus bas) -- regroupees ici dans un seul scraper comme
// suggere pour ce lot, meme si l'extraction reste specifique a chacune.
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const COOKIE_JAR_PATH = path.join(mkdtempSync(path.join(os.tmpdir(), 'ojsfr-cookies-')), 'cookies.txt');
const REQUEST_DELAY_MS = 1000;

// M@n@gement publie tous ses appels actifs sur une page statique unique,
// maintenue a la main par la redaction (PAS le module Announcements
// standard d'OJS) -- confirme via curl direct (200). Chaque appel est un
// bloc <h1>Titre</h1>...contenu... jusqu'au <h1> suivant ; les appels sont
// separes par un <h1> de simples underscores (repere visuel, pas un appel).
const MGMT_CALL_URL = 'https://management-aims.com/index.php/mgmt/call';
const MGMT_JOURNAL = 'M@n@gement';
const MGMT_CONTAINER_SELECTOR = '#pkp_content_main';
const MGMT_SEPARATOR_PATTERN = /^_+$/;
const MGMT_PDF_LINK_SELECTOR = 'a[href*="/libraryFiles/downloadPublic/"]';

// La page /special_issues suggeree au depart ne contient en realite QUE la
// procedure interne de selection par le comite editorial -- confirme en
// lisant tout le HTML, aucun appel n'y est jamais liste (verifie aussi en
// changeant de locale). Les vrais appels vivent parmi les announcements
// generiques d'OJS (melanges a des appels a candidature de comite
// editorial, prix, etc.), d'ou le filtre sur le titre.
const SIM_ANNOUNCEMENT_LIST_URL = 'https://revuesim.org/index.php/sim/announcement';
const SIM_JOURNAL = "Systèmes d'information & management";
const SIM_SUMMARY_SELECTOR = 'article.obj_announcement_summary';
const SIM_FULL_SELECTOR = 'article.obj_announcement_full .description';
const SIM_TITLE_KEYWORD_PATTERN = /call for papers|call for special issue|special issue|appels?\s*(à|a)\s*(contribution|articles?)|num[ée]ro sp[ée]cial/i;

export const scraperObject = {
    url: MGMT_CALL_URL,
    abbreviation: 'ojsfr',
    async scraper() {
        const abbreviation = this.abbreviation;
        const calls = [];

        const mgmtIssn = await matchIssn(MGMT_JOURNAL);
        if (mgmtIssn) {
            const entries = await get_mgmt_entries();
            console.log(`[ojsfr] M@n@gement : ${entries.length} appel(s) trouve(s)`);
            for (const entry of entries) {
                calls.push({ journal: MGMT_JOURNAL, abbreviation, issn: mgmtIssn, metaTitle: entry.metaTitle, url: entry.url, rawContent: entry.rawContent });
            }
        } else {
            console.warn(`[ojsfr] "${MGMT_JOURNAL}" introuvable dans le CSV ISSN, abandon`);
        }

        await sleep(REQUEST_DELAY_MS);

        const simIssn = await matchIssn(SIM_JOURNAL);
        if (simIssn) {
            const entries = await get_sim_entries();
            console.log(`[ojsfr] SIM : ${entries.length} appel(s) trouve(s)`);
            for (const entry of entries) {
                calls.push({ journal: SIM_JOURNAL, abbreviation, issn: simIssn, metaTitle: entry.metaTitle, url: entry.url, rawContent: entry.rawContent });
            }
        } else {
            console.warn(`[ojsfr] "${SIM_JOURNAL}" introuvable dans le CSV ISSN, abandon`);
        }

        return calls;
    }
}

async function get_mgmt_entries() {
    let response;
    try {
        response = await curlGet(MGMT_CALL_URL, { cookieJarPath: COOKIE_JAR_PATH, userAgent: USER_AGENT });
    } catch (error) {
        console.warn(`[ojsfr] Erreur reseau (curl) sur ${MGMT_CALL_URL} : ${error.message}`);
        return [];
    }

    console.log(`[ojsfr] Statut HTTP ${response.status} sur ${MGMT_CALL_URL}`);
    if (response.status !== 200) {
        console.warn(`[ojsfr] Statut HTTP ${response.status} (attendu 200) sur ${MGMT_CALL_URL} -- probable blocage anti-bot`);
        return [];
    }

    const $ = cheerio.load(response.body);
    const container = $(MGMT_CONTAINER_SELECTOR).first();
    if (container.length === 0) {
        console.warn(`[ojsfr] Conteneur ${MGMT_CONTAINER_SELECTOR} introuvable sur ${MGMT_CALL_URL} (structure modifiee ?)`);
        return [];
    }

    const entries = extract_mgmt_entries(container.html() ?? '');
    if (entries.length === 0) {
        console.log(`[ojsfr] M@n@gement : conteneur trouve mais aucun <h1> d'appel dedans (page peut-etre vide en ce moment)`);
    }
    return entries;
}

function extract_mgmt_entries(containerHtml) {
    const $ = cheerio.load(containerHtml);

    // Meme technique que le scraper SAGE : positionne chaque <h1> dans le
    // HTML source via un curseur croissant (pas d'offset natif en cheerio).
    const headings = $('h1').toArray();
    let cursor = 0;
    const positioned = [];
    for (const h of headings) {
        const outer = $.html(h);
        const index = containerHtml.indexOf(outer, cursor);
        if (index === -1) continue;
        positioned.push({ text: heading_text($, h), index });
        cursor = index + outer.length;
    }

    const entries = [];
    for (let i = 0; i < positioned.length; i++) {
        const { text, index } = positioned[i];
        if (MGMT_SEPARATOR_PATTERN.test(text)) continue;

        const nextIndex = positioned[i + 1]?.index ?? containerHtml.length;
        const block = containerHtml.slice(index, nextIndex);
        const blockDollar = cheerio.load(block);
        const pdfHref = blockDollar(MGMT_PDF_LINK_SELECTOR).first().attr('href');

        entries.push({
            metaTitle: text,
            // Pas d'URL par-appel sur cette page statique : le PDF telecharge
            // par l'appel (stable, un identifiant par appel) sert d'URL unique.
            url: pdfHref ? new URL(pdfHref, MGMT_CALL_URL).href : `${MGMT_CALL_URL}#${encodeURIComponent(text)}`,
            rawContent: block,
        });
    }
    return entries;
}

// Les titres M@n@gement contiennent des <br> internes (retour a la ligne
// manuel) -- .text() seul les fait disparaitre sans espace ("cases,and
// forgotten" au lieu de "cases, and forgotten"), d'ou ce remplacement prealable.
function heading_text($, el) {
    const clone = $(el).clone();
    clone.find('br').replaceWith(' ');
    return clone.text().replace(/\s+/g, ' ').trim();
}

async function get_sim_entries() {
    let response;
    try {
        response = await curlGet(SIM_ANNOUNCEMENT_LIST_URL, { cookieJarPath: COOKIE_JAR_PATH, userAgent: USER_AGENT });
    } catch (error) {
        console.warn(`[ojsfr] Erreur reseau (curl) sur ${SIM_ANNOUNCEMENT_LIST_URL} : ${error.message}`);
        return [];
    }

    console.log(`[ojsfr] Statut HTTP ${response.status} sur ${SIM_ANNOUNCEMENT_LIST_URL}`);
    if (response.status !== 200) {
        console.warn(`[ojsfr] Statut HTTP ${response.status} (attendu 200) sur ${SIM_ANNOUNCEMENT_LIST_URL} -- probable blocage anti-bot`);
        return [];
    }

    const $ = cheerio.load(response.body);
    const candidates = [];
    $(SIM_SUMMARY_SELECTOR).each((_, el) => {
        const link = $(el).find('h2 a[href]').first();
        const title = link.text().trim();
        const href = link.attr('href');
        if (!title || !href || !SIM_TITLE_KEYWORD_PATTERN.test(title)) return;
        candidates.push({ title, url: new URL(href, SIM_ANNOUNCEMENT_LIST_URL).href });
    });
    console.log(`[ojsfr] SIM : ${candidates.length} announcement(s) "call for papers" trouve(s) sur ${$(SIM_SUMMARY_SELECTOR).length} au total, recuperation du detail`);

    const entries = [];
    for (const candidate of candidates) {
        await sleep(REQUEST_DELAY_MS);
        const detail = await get_sim_detail(candidate.url);
        if (!detail) continue;
        entries.push({ metaTitle: candidate.title, url: candidate.url, rawContent: detail });
    }
    return entries;
}

async function get_sim_detail(url) {
    let response;
    try {
        response = await curlGet(url, { cookieJarPath: COOKIE_JAR_PATH, userAgent: USER_AGENT });
    } catch (error) {
        console.warn(`[ojsfr] Erreur reseau (curl) sur ${url} : ${error.message}`);
        return null;
    }

    if (response.status !== 200) {
        console.warn(`[ojsfr] Statut HTTP ${response.status} (attendu 200) sur ${url}`);
        return null;
    }

    const $ = cheerio.load(response.body);
    const description = $(SIM_FULL_SELECTOR).first();
    if (description.length === 0) {
        console.warn(`[ojsfr] Contenu (${SIM_FULL_SELECTOR}) introuvable sur ${url} (structure modifiee ?)`);
        return null;
    }
    return description.html() ?? null;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
