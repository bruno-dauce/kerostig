import * as cheerio from 'cheerio';
import { mkdtempSync } from 'fs';
import path from 'path';
import os from 'os';
import { getJournalsByPublisher } from '../issnMatcher.mjs';
import { curlGet } from '../curlClient.mjs';

const PUBLISHER_NAME = 'Wiley';

// Le navigateur automatise (meme profil persistant que les autres
// scrapers) recoit systematiquement une page de connexion a la place du
// contenu reel -- Wiley bloque specifiquement ce fingerprint. Un simple
// fetch marche en curl (verifie manuellement) mais PAS avec fetch() natif
// de Node : undici a son propre fingerprint TLS/HTTP, distinct de celui de
// curl (qui passe par Schannel sous Windows) et reconnu/filtre separement
// par Cloudflare. Solution retenue : shell out vers curl plutot que
// d'utiliser fetch() -- curl gere aussi nativement les cookies et
// redirections via son cookie jar fichier, ce qui evite de reimplementer
// cette logique en JS. MEME PIEGE ENSUITE avec curl standard sous Linux/
// GitHub Actions (fingerprint OpenSSL bloque, la ou Schannel sous Windows
// passe) : curlClient.mjs utilise curl-impersonate quand il est installe
// (cf .github/workflows/scrape.yml) pour rejouer un fingerprint de vrai
// navigateur, et retombe sur curl standard sinon.
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const COOKIE_JAR_PATH = path.join(mkdtempSync(path.join(os.tmpdir(), 'wiley-cookies-')), 'cookies.txt');

// Pas de schema d'URL unique : verifie manuellement, differentes revues
// utilisent differents chemins selon l'anciennete/le redesign (ex.
// specialissues.html pour l'une, call_for_papers pour une autre -- 404 sur
// les chemins de l'autre a chaque fois). On essaie plusieurs candidats par
// revue, chacun etant un fetch leger (pas un chargement de page complet).
const PATH_CANDIDATES = [
    { prefix: 'page', path: 'homepage/specialissues.html' },
    { prefix: 'page', path: 'homepage/call_for_papers' },
    { prefix: 'page', path: 'homepage/call-for-papers' },
    { prefix: 'page', path: 'homepage/callforpapers' },
    { prefix: 'page', path: 'call-for-papers' },
    { prefix: 'plain', path: 'specialissues' },
    { prefix: 'plain', path: 'calls-for-papers' },
];

function build_urls(issn) {
    const issnSlug = issn.replace(/-/g, '').toLowerCase();
    return PATH_CANDIDATES.map(c => c.prefix === 'page'
        ? `https://onlinelibrary.wiley.com/page/journal/${issnSlug}/${c.path}`
        : `https://onlinelibrary.wiley.com/journal/${issnSlug}/${c.path}`
    );
}

// Meme structure de contenu que decouverte precedemment : la page melange
// trois sections sous des h2 distincts, seule la premiere nous interesse :
//   "Special Issue Calls for Papers"   -> les vrais appels ouverts (garde)
//   "Call For Special Issue Proposals" -> processus pour proposer un futur
//                                          numero special, pas un appel
//   "Latest Special Issues"            -> numeros deja publies
// Chaque appel dans la premiere section est un groupe de <p> separes par
// des <hr>.
const SECTION_HEADING_PATTERN = /call.*for.*papers/i;
const NON_CALL_LINK_TEXT_PATTERN = /^(author guidelines|submission guidelines|guide for authors)$/i;

// Un delai trop court entre requetes declenche un challenge Cloudflare
// (rate-limiting/comportemental) apres un certain volume -- constate en
// pratique lors des tests (les premieres dizaines de revues passent, puis
// Cloudflare commence a repondre "Just a moment..."). 1s reste rapide pour
// ~85 revues x quelques candidats mais parait moins automatise.
const REQUEST_DELAY_MS = 1000;
const CHALLENGE_PATTERN = /Just a moment|cf_chl_opt|challenges\.cloudflare\.com/i;
const MAX_DEBUG_LOGS = 5;
let noHeadingLogCount = 0;
let noLinkLogCount = 0;
let challengeLogged = false;

export const scraperObject = {
    url: 'https://onlinelibrary.wiley.com/',
    abbreviation: 'wiley',
    async scraper() {
        const abbreviation = this.abbreviation;

        const journals = await getJournalsByPublisher(PUBLISHER_NAME);
        console.log(`[wiley] ${journals.length} revue(s) a traiter`);

        const calls = [];
        let notFoundCount = 0;
        for (const journal of journals) {
            const page = await find_page(journal.nomOpenalex, build_urls(journal.issn));
            if (!page) {
                notFoundCount++;
                continue;
            }

            const entries = extract_entries(page.html, page.url, journal.nomOpenalex);
            for (const entry of entries) {
                calls.push({
                    journal: journal.nomOpenalex,
                    abbreviation,
                    issn: journal.issn,
                    metaTitle: entry.metaTitle,
                    url: entry.url,
                    rawContent: entry.rawContent,
                });
            }
        }
        console.log(`[wiley] ${calls.length} appel(s) trouve(s)`);
        console.log(`[wiley] ${notFoundCount} revue(s) sans page de calls-for-papers trouvee (aucun des chemins d'URL essayes n'a repondu)`);

        return calls;
    }
}

// Essaie chaque URL candidate jusqu'a en trouver une qui repond 200.
async function find_page(journalName, urls) {
    for (const url of urls) {
        await sleep(REQUEST_DELAY_MS);
        try {
            const response = await curlGet(url, { cookieJarPath: COOKIE_JAR_PATH, userAgent: USER_AGENT });
            if (response.status === 200) {
                return { html: response.body, url };
            }
            if (!challengeLogged && CHALLENGE_PATTERN.test(response.body)) {
                challengeLogged = true;
                console.warn(`[wiley] Challenge Cloudflare detecte sur ${url} (statut ${response.status}) -- augmenter REQUEST_DELAY_MS si ca se reproduit souvent.`);
            }
        } catch (error) {
            console.warn(`[wiley] "${journalName}" : erreur reseau sur ${url} : ${error.message}`);
        }
    }
    return null;
}

function extract_entries(html, pageUrl, journalName) {
    const $ = cheerio.load(html);
    const headings = $('h2').toArray();
    const startHeading = headings.find(h => SECTION_HEADING_PATTERN.test($(h).text()));

    if (!startHeading) {
        if (noHeadingLogCount < MAX_DEBUG_LOGS) {
            noHeadingLogCount++;
            console.warn(`[wiley] "${journalName}" : aucun h2 "call...for...papers" trouve sur ${pageUrl}. Titres h2 presents : ${headings.map(h => $(h).text().trim()).join(' | ')}`);
        }
        return [];
    }

    const sectionNodes = $(startHeading).nextUntil('h2').toArray();
    const groups = [];
    let current = [];
    for (const node of sectionNodes) {
        if (node.tagName === 'hr') {
            if (current.length) groups.push(current);
            current = [];
        } else {
            current.push(node);
        }
    }
    if (current.length) groups.push(current);

    const entries = groups
        .map(group => {
            // Ignore les liens mail obscurcis par Cloudflare
            // (/cdn-cgi/l/email-protection, texte affiche "[email protected]"),
            // les mailto: directs, et les liens de navigation generiques
            // (ex. "Author Guidelines" dans le paragraphe d'intro) -- jamais
            // le vrai lien d'un appel.
            let link = null;
            for (const node of group) {
                const candidate = $(node).find('a[href]').toArray()
                    .map(a => $(a))
                    .find(a => {
                        const href = a.attr('href') ?? '';
                        const text = a.text().trim();
                        return !href.includes('cdn-cgi/l/email-protection')
                            && !href.startsWith('mailto:')
                            && !NON_CALL_LINK_TEXT_PATTERN.test(text);
                    });
                if (candidate) { link = candidate; break; }
            }
            return {
                metaTitle: link ? link.text().trim() : null,
                url: link ? new URL(link.attr('href'), pageUrl).href : null,
                rawContent: group.map(n => $.html(n)).join(''),
            };
        })
        .filter(entry => entry.metaTitle && entry.url);

    if (entries.length === 0 && noLinkLogCount < MAX_DEBUG_LOGS) {
        noLinkLogCount++;
        const debugHtml = sectionNodes.map(n => $.html(n)).join('').slice(0, 500);
        console.warn(`[wiley] "${journalName}" : section trouvee mais aucun lien d'appel extrait sur ${pageUrl}. Debut du contenu : ${debugHtml}`);
    }

    return entries;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
