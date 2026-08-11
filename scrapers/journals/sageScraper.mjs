import * as cheerio from 'cheerio';
import { mkdtempSync } from 'fs';
import path from 'path';
import os from 'os';
import { matchIssn } from '../issnMatcher.mjs';
import { curlGet } from '../curlClient.mjs';

// SAGE centralise les appels de (quasi) toutes ses revues sur ce hub unique,
// classe par discipline (accordeon) -- une seule page a visiter au lieu de
// naviguer revue par revue (~60 revues FNEGE). L'URL "special-issue-calls-
// for-papers" evoquee au depart redirige en realite vers la page d'accueil
// generique (route obsolete, verifie manuellement) : les appels "special
// issue" sont deja listes ici, melanges aux appels generaux, par revue.
const HUB_URL = 'https://journals.sagepub.com/open-call-for-papers';

// Le hub est du HTML statique (confirme manuellement via curl, aucun script
// requis pour voir le contenu complet), mais Chromium/patchright s'y fait
// bloquer (403) malgre les evasions de patchright -- fingerprint detecte sur
// ce point precis, alors qu'un simple curl passe. On shell out donc vers
// curl plutot que d'ouvrir une page. ATTENTION, meme piege que sur Wiley :
// curl sous Windows (Schannel) peut passer la ou curl sous Linux/GitHub
// Actions (OpenSSL) est bloque (fingerprint TLS distingue par Cloudflare) --
// c'est pour ca que curlClient.mjs utilise curl-impersonate quand il est
// installe (cf .github/workflows/scrape.yml) plutot que curl standard. Le
// statut HTTP est logue explicitement a chaque run (dans curlClient.mjs)
// pour verifier en CI plutot que de supposer que ca marche partout parce
// que ca marche ici.
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Le hub fait un aller-retour de cookie avant de servir le vrai contenu
// (302 -> ?cookieSet=1 -> contenu) : sans moteur de cookies actif, curl ne
// renvoie pas le cookie recu lors du saut de redirection et se retrouve
// bascule vers la page d'accueil generique (200 mais contenu vide de tout
// appel) -- constate en pratique, intermittent selon les requetes. -c/-b
// avec un jar (meme vide au depart) suffit a fiabiliser le passage, verifie
// sur plusieurs execution successives.
const COOKIE_JAR_PATH = path.join(mkdtempSync(path.join(os.tmpdir(), 'sage-cookies-')), 'cookies.txt');

// Confirme via le HTML reel : conteneur unique regroupant toutes les
// sections disciplinaires. ".bs-accordion__control"/"__content" sont des
// classes distinctes (tokens differents), pas de collision avec ce selecteur.
const ACCORDION_SELECTOR = 'div.bs-accordion';

// Contenu CMS libre, sans wrapper dedie par appel : chaque revue apparait
// comme un lien <a href="/home/CODE">Nom de la revue</a>, suivi d'un ou
// plusieurs appels (chacun etant un lien vers une page de detail ou un PDF,
// suivi d'une ligne "Submission deadline: ..."). On decoupe donc le HTML de
// l'accordeon en tranches delimitees par la position de chaque lien texte :
// un lien /home/ met a jour la revue courante sans etre lui-meme un appel;
// tout autre lien texte devient un appel dont le contenu brut va jusqu'au
// lien suivant (capture au passage la ligne de deadline qui le suit).
const HOME_LINK_PATTERN = /^\/home\//i;

// Garde-fou contre les faux positifs (liens de navigation generiques) comme
// constate sur Wiley -- pas observes dans le HTML actuel du hub SAGE, mais
// le contenu est edite a la main et peut evoluer.
const IGNORED_LINK_TEXT_PATTERN = /^(author guidelines|submission guidelines|guide for authors|aims (and|&) scope|learn more)$/i;

// /author-instructions/{code} est la page generique de consignes aux
// auteurs de la revue, pas un appel -- constate en verifiant manuellement
// l'appel "General Call for Papers" de The American Review of Public
// Administration, qui y pointe malgre son intitule. Filtre sur l'URL (pas
// seulement le texte du lien, qui peut annoncer un "General Call for
// Papers" inexistant) comme pour les faux positifs Wiley.
const IGNORED_URL_PATTERN = /\/author-instructions\//i;

export const scraperObject = {
    url: HUB_URL,
    abbreviation: 'sage',
    async scraper() {
        const abbreviation = this.abbreviation;

        const accordionHtml = await get_accordion_html(HUB_URL);
        if (!accordionHtml) return [];

        // Certaines revues sont classees sous plusieurs disciplines : leur
        // appel apparait alors identique dans plusieurs sections. Deduplique
        // par URL pour ne pas interroger le LLM deux fois pour le meme appel.
        const entriesByUrl = new Map();
        for (const entry of extract_entries(accordionHtml)) {
            entriesByUrl.set(entry.url, entry);
        }
        console.log(`[sage] ${entriesByUrl.size} appel(s) distinct(s) trouve(s) sur le hub`);

        let skippedCount = 0;
        const calls = [];
        for (const entry of entriesByUrl.values()) {
            const issn = await matchIssn(entry.journal);
            if (!issn) {
                skippedCount++;
                continue;
            }
            calls.push({
                journal: entry.journal,
                abbreviation,
                issn,
                metaTitle: entry.metaTitle,
                url: entry.url,
                rawContent: entry.rawContent,
            });
        }
        console.log(`[sage] ${skippedCount} appel(s) ignore(s), revue hors perimetre FNEGE`);

        return calls;
    }
}

async function get_accordion_html(url) {
    let response;
    try {
        response = await curlGet(url, { cookieJarPath: COOKIE_JAR_PATH, userAgent: USER_AGENT });
    } catch (error) {
        console.warn(`[sage] Erreur reseau (curl) sur ${url} : ${error.message}`);
        return null;
    }

    // Logue toujours le statut, succes ou echec : c'est le seul moyen de
    // verifier depuis les logs GitHub Actions si curl (ou curl-impersonate)
    // passe aussi bien sous Linux que sous Windows (cf commentaire sur
    // USER_AGENT plus haut).
    console.log(`[sage] Statut HTTP ${response.status} sur ${url}`);
    if (response.status !== 200) {
        console.warn(`[sage] Statut HTTP ${response.status} (attendu 200) sur ${url} -- probable blocage anti-bot ou challenge`);
        return null;
    }

    const $ = cheerio.load(response.body);
    const container = $(ACCORDION_SELECTOR).first();
    if (container.length === 0) {
        console.warn(`[sage] Conteneur d'accordeon introuvable sur ${url} (structure modifiee, ou page bloquee malgre un statut 200)`);
        return null;
    }
    return container.html();
}

function extract_entries(accordionHtml) {
    const $ = cheerio.load(accordionHtml);

    const anchors = $('a[href]').toArray()
        .map(el => $(el))
        .filter(a => {
            const text = a.text().trim();
            if (!text || IGNORED_LINK_TEXT_PATTERN.test(text)) return false;
            const href = a.attr('href') ?? '';
            // Liens mail obscurcis par Cloudflare ou mailto: direct, jamais
            // le lien d'un appel (meme faux positif que sur Wiley).
            if (href.startsWith('mailto:') || href.includes('cdn-cgi/l/email-protection')) return false;
            if (IGNORED_URL_PATTERN.test(href)) return false;
            return true;
        });

    // Positionne chaque lien retenu dans le HTML source via un curseur
    // croissant (pas d'offset natif en cheerio) : indexOf en avancant
    // garantit l'ordre document meme si plusieurs liens partagent un HTML
    // identique.
    let cursor = 0;
    const positioned = [];
    for (const a of anchors) {
        const outerHtml = $.html(a);
        const index = accordionHtml.indexOf(outerHtml, cursor);
        if (index === -1) continue;
        positioned.push({ a, index });
        cursor = index + outerHtml.length;
    }

    let currentJournal = null;
    const entries = [];
    for (let i = 0; i < positioned.length; i++) {
        const { a, index } = positioned[i];
        const href = a.attr('href');
        const text = a.text().trim();

        if (HOME_LINK_PATTERN.test(href)) {
            currentJournal = text;
            continue;
        }
        if (!currentJournal) continue;

        const nextIndex = positioned[i + 1]?.index ?? accordionHtml.length;
        entries.push({
            journal: currentJournal,
            metaTitle: text,
            url: new URL(href, HUB_URL).href,
            rawContent: accordionHtml.slice(index, nextIndex),
        });
    }
    return entries;
}
