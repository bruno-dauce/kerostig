import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getJournalsByPublisher } from '../issnMatcher.mjs';
import { estHorsInterstitiel } from '../cloudflare.mjs';

const PUBLISHER_NAME = 'Wiley';

// Acces par le navigateur (profil persistant commun, cf browser.mjs), et non
// plus par curl. Historique : Wiley passait en curl standard depuis le poste
// local, le navigateur etant a l'epoque renvoye vers une page de connexion.
// Mesure le 2026-09-27 : c'est l'inverse. curl (Schannel comme OpenSSL) prend
// 403 + challenge Cloudflare « managed » sur toutes les pages, tandis que
// patchright franchit le challenge en ~5 s au premier contact, puis obtient
// 200 d'emblee grace au cf_clearance pose dans le profil. Meme bascule que
// SAGE le 2026-08-31. Portee : collecte LOCALE ; en CI le blocage tient a
// l'IP du runner, le navigateur n'y change rien.

// Chemin qui a fonctionne au dernier passage, par ISSN, essaye en premier au
// passage suivant : une requete par revue au lieu de jusqu'a sept. Versionne
// pour que le CI et le poste local en profitent.
const CHEMINS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'wileyChemins.json');

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
const SECTION_HEADING_PATTERN = /call.*for.*papers|special issue calls/i;
const NON_CALL_LINK_TEXT_PATTERN = /^(author guidelines|submission guidelines|guide for authors)$/i;

// Pause entre deux pages. Un rythme trop soutenu declenche un challenge
// comportemental apres quelques dizaines de pages (constate du temps de curl
// a 1 s) ; le navigateur charge en plus les ressources de chaque page.
const REQUEST_DELAY_MS = 2500;
const NAVIGATION_TIMEOUT_MS = 45000;
const DELAI_CHALLENGE_MS = 30000;
const PAUSE_AVANT_REPRISE_MS = 60000;
const MAX_DEBUG_LOGS = 5;
let noHeadingLogCount = 0;
let noLinkLogCount = 0;
let challengeLogged = false;

export const scraperObject = {
    url: 'https://onlinelibrary.wiley.com/',
    abbreviation: 'wiley',
    async scraper(browser) {
        const abbreviation = this.abbreviation;

        const journals = await getJournalsByPublisher(PUBLISHER_NAME);
        console.log(`[wiley] ${journals.length} revue(s) a traiter`);

        // Lu par pageController apres le run : les appels deja en base de ces
        // revues sont preserves au lieu de passer en inactif (cf
        // diffChecker.integrateCalls). Remis a zero a chaque run.
        this.issnBloques = [];

        const chemins = lire_chemins();
        const calls = [];
        const motifs = { bloque: 0, absent: 0, reseau: 0, autre: 0 };
        let atteintes = 0;
        let avecAppels = 0;
        let requetes = 0;
        let debloquees = 0;

        // Rend le motif d'echec, ou null si la page a ete lue.
        const traiter = async (page, journal) => {
            const urls = ordonnerUrls(build_urls(journal.issn), chemins[journal.issn]);
            const resultat = await find_page(page, journal.nomOpenalex, urls);
            requetes += resultat.requetes;
            if (!resultat.page) {
                // Un blocage ne dit rien du chemin : on le garde. Une absence
                // confirmee sur tous les chemins, si.
                if (resultat.motif === 'absent') delete chemins[journal.issn];
                return resultat.motif;
            }
            atteintes += 1;
            chemins[journal.issn] = resultat.page.url;

            const entries = extract_entries(resultat.page.html, resultat.page.url, journal.nomOpenalex);
            if (entries.length) avecAppels += 1;
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
            return null;
        };

        const page = await browser.newPage();
        try {
            const bloquees = [];
            for (const journal of journals) {
                const motif = await traiter(page, journal);
                if (motif === 'bloque') bloquees.push(journal);
                else if (motif) motifs[motif] += 1;
            }

            // Second passage sur les seules revues bloquees, apres une pause
            // longue : un challenge non franchi tient souvent a un rythme juge
            // trop soutenu, qui retombe en une minute.
            if (bloquees.length) {
                console.log(`[wiley] ${bloquees.length} revue(s) bloquee(s), nouvelle tentative dans ${PAUSE_AVANT_REPRISE_MS / 1000} s`);
                await sleep(PAUSE_AVANT_REPRISE_MS);
                for (const journal of bloquees) {
                    const motif = await traiter(page, journal);
                    if (!motif) {
                        debloquees += 1;
                        continue;
                    }
                    motifs[motif] += 1;
                    if (motif === 'bloque') this.issnBloques.push(journal.issn);
                }
            }
        } finally {
            await page.close();
            ecrire_chemins(chemins);
        }

        console.log(formaterBilan({ total: journals.length, atteintes, avecAppels, debloquees, motifs, appels: calls.length, requetes }));
        if (this.issnBloques.length) {
            console.warn(`[wiley] ISSN toujours bloques, appels en base preserves : ${this.issnBloques.join(', ')}`);
        }
        if (motifs.bloque) {
            console.warn(`[wiley] Revues bloquees : challenge Cloudflare non franchi en ${DELAI_CHALLENGE_MS / 1000} s, ou 403 persistant. Leur page existe peut-etre. En CI, cause attendue : l'IP du runner.`);
        }
        if (motifs.reseau) {
            console.warn(`[wiley] Revues injoignables : erreur de navigation sur tous les chemins.`);
        }
        if (motifs.autre) {
            console.warn(`[wiley] Revues ecartees sur un statut inattendu (ni 200, ni 404, ni blocage).`);
        }

        return calls;
    }
}

// Fonction pure, exportee pour test.
export function formaterBilan({ total, atteintes, avecAppels, debloquees = 0, motifs, appels, requetes }) {
    return [
        `[wiley] Bilan sur ${total} revue(s) :`,
        `[wiley]   OK          ${atteintes} (dont ${avecAppels} avec au moins un appel, ${debloquees} au second passage)`,
        `[wiley]   bloquees    ${motifs.bloque}`,
        `[wiley]   absentes    ${motifs.absent} (404 sur les ${PATH_CANDIDATES.length} chemins)`,
        `[wiley]   reseau      ${motifs.reseau}`,
        `[wiley]   autre       ${motifs.autre}`,
        `[wiley]   appels      ${appels}`,
        `[wiley]   pages chargees ${requetes}`,
    ].join('\n');
}

// Le chemin memorise passe en tete, les autres suivent dans leur ordre
// habituel, sans doublon. Un chemin memorise qui ne figure plus parmi les
// candidats est essaye quand meme : il a fonctionne.
// Fonction pure, exportee pour test.
export function ordonnerUrls(urls, memorise) {
    if (!memorise) return urls;
    return [memorise, ...urls.filter(url => url !== memorise)];
}

function lire_chemins() {
    try {
        return JSON.parse(fs.readFileSync(CHEMINS_PATH, 'utf8'));
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.warn(`[wiley] ${CHEMINS_PATH} illisible, on repart de zero : ${error.message}`);
        }
        return {};
    }
}

// Cles triees : le fichier ne change dans Git que si un chemin change.
function ecrire_chemins(chemins) {
    const trie = Object.fromEntries(Object.keys(chemins).sort().map(issn => [issn, chemins[issn]]));
    const contenu = JSON.stringify(trie, null, 2) + '\n';
    let actuel = null;
    try { actuel = fs.readFileSync(CHEMINS_PATH, 'utf8'); } catch { /* premier passage */ }
    if (actuel !== contenu) fs.writeFileSync(CHEMINS_PATH, contenu);
}

// Pourquoi aucune des URL candidates n'a rendu de page.
//
// Le compteur disait « aucun des chemins d'URL essayes n'a repondu » quel que
// soit le motif. C'etait faux et trompeur : verifie le 2026-09-03 sur quatre
// revues portant des appels actifs (Gender Work and Organization, Journal of
// Product Innovation Management, Information Systems Journal, Psychology and
// Marketing), les chemins ont bien repondu -- 403 ou 302 -- et les pages
// existent, a des URL que cette fonction essaie deja. Un navigateur y obtient
// 200 et plus de 100 Ko. Le blocage vient de curl standard, dont l'empreinte
// TLS Schannel est filtree par Cloudflare quand curl-impersonate n'est pas
// installe. Rapporter cela comme une page absente envoie le prochain
// diagnostic sur une fausse piste : on cherche des chemins d'URL alors que le
// probleme est le client HTTP.
//
// L'ordre des tests compte : le blocage l'emporte, parce qu'il masque tout le
// reste -- une revue bloquee peut aussi bien avoir une page qu'aucune, on n'en
// sait rien.
// Fonction pure, exportee pour test.
export function classerTentatives(tentatives) {
    if (!tentatives.length) return 'autre';
    // 403 ou redirection : chez Wiley, les deux menent au challenge Cloudflare.
    if (tentatives.some(t => t.challenge || t.statut === 403 || (t.statut >= 300 && t.statut < 400))) return 'bloque';
    if (tentatives.some(t => t.erreur)) return 'reseau';
    if (tentatives.every(t => t.statut === 404)) return 'absent';
    return 'autre';
}

// Essaie chaque URL candidate jusqu'a en trouver une qui repond 200.
// Rend { page, requetes } en cas de succes, { motif, requetes } sinon --
// l'appelant compte les motifs separement au lieu de tout verser dans « page
// introuvable ».
//
// Le statut retenu est celui de la DERNIERE reponse de document du cadre
// principal, pas celui que rend goto : au premier contact, goto rapporte le
// 403 de l'interstitiel, puis Cloudflare recharge la vraie page une fois le
// challenge franchi (mesure : 403 puis page complete de 243 Ko). Seul ce
// dernier statut distingue une vraie page (200) d'une absence (404).
async function find_page(page, journalName, urls) {
    const tentatives = [];
    let requetes = 0;
    let dernierStatut = null;
    const ecoute = response => {
        if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) {
            dernierStatut = response.status();
        }
    };
    page.on('response', ecoute);
    try {
        for (const url of urls) {
            await sleep(REQUEST_DELAY_MS);
            requetes += 1;
            dernierStatut = null;
            try {
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
            } catch (error) {
                tentatives.push({ erreur: error.message });
                console.warn(`[wiley] "${journalName}" : navigation impossible sur ${url} : ${error.message.split('\n')[0]}`);
                continue;
            }

            let franchi = true;
            try {
                await page.waitForFunction(estHorsInterstitiel, undefined, { timeout: DELAI_CHALLENGE_MS });
            } catch {
                franchi = false;
            }
            if (!franchi) {
                tentatives.push({ statut: dernierStatut, challenge: true });
                if (!challengeLogged) {
                    challengeLogged = true;
                    console.warn(`[wiley] Challenge Cloudflare non franchi en ${DELAI_CHALLENGE_MS / 1000} s sur ${url} (statut ${dernierStatut})`);
                }
                continue;
            }

            if (dernierStatut === 200) {
                return { page: { html: await page.content(), url }, requetes };
            }
            tentatives.push({ statut: dernierStatut });
        }
    } finally {
        page.off('response', ecoute);
    }
    return { motif: classerTentatives(tentatives), requetes };
}

export function extract_entries(html, pageUrl, journalName) {
    const $ = cheerio.load(html);

    // Structure moderne Wiley : chaque appel est un bloc autonome
    // .DST-CFP-listing-item (titre en h3 > a, echeance dans
    // p.DST-CFP-listing-item__deadline). Le premier bloc porte le
    // modificateur --intro : c'est le chapeau de la section (h2 "Calls for
    // Papers" + texte de presentation), pas un appel. Cette structure ne
    // passe pas par la decoupe h2/hr ci-dessous, d'ou une strategie propre
    // essayee en premier ; les revues encore sur l'ancien gabarit
    // retombent sur la logique historique.
    const listingEntries = extract_listing_items($, pageUrl);
    if (listingEntries.length > 0) {
        return listingEntries;
    }

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
    const groups = sectionNodes.some(node => node.tagName === 'hr')
        ? split_on_separators(sectionNodes)
        : split_on_call_links($, sectionNodes);

    const entries = groups
        .map(group => {
            let link = null;
            for (const node of group) {
                link = find_call_link($, node);
                if (link) break;
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

// Ignore les liens mail obscurcis par Cloudflare
// (/cdn-cgi/l/email-protection, texte affiche "[email protected]"), les
// mailto: directs, et les liens de navigation generiques (ex. "Author
// Guidelines" dans le paragraphe d'intro) -- jamais le vrai lien d'un appel.
function find_call_link($, node) {
    return $(node).find('a[href]').toArray()
        .map(a => $(a))
        .find(a => {
            const href = a.attr('href') ?? '';
            const text = a.text().trim();
            return !href.includes('cdn-cgi/l/email-protection')
                && !href.startsWith('mailto:')
                && !NON_CALL_LINK_TEXT_PATTERN.test(text);
        }) ?? null;
}

function split_on_separators(nodes) {
    const groups = [];
    let current = [];
    for (const node of nodes) {
        if (node.tagName === 'hr') {
            if (current.length) groups.push(current);
            current = [];
        } else {
            current.push(node);
        }
    }
    if (current.length) groups.push(current);
    return groups;
}

// Certaines sections listent plusieurs appels sans aucun <hr> (ex. Journal
// of Management Studies : quatre <p>, chacun avec son lien PDF et sa propre
// echeance). Sans separateur, la decoupe ci-dessus renvoie un groupe unique
// qui agglomere tous les appels : un seul enregistrement, avec le titre du
// premier et les echeances de tous les autres dans le rawContent. On repli
// donc sur un decoupage par lien : un nouveau groupe demarre des qu'un noeud
// porte un lien d'appel alors que le groupe courant en a deja un. Les noeuds
// sans lien (chapeau, precisions) restent rattaches au groupe en cours.
function split_on_call_links($, nodes) {
    const groups = [];
    let current = [];
    let currentHasLink = false;
    for (const node of nodes) {
        const hasLink = Boolean(find_call_link($, node));
        if (hasLink && currentHasLink) {
            groups.push(current);
            current = [];
            currentHasLink = false;
        }
        current.push(node);
        currentHasLink = currentHasLink || hasLink;
    }
    if (current.length) groups.push(current);
    return groups;
}

function extract_listing_items($, pageUrl) {
    return $('.DST-CFP-listing-item:not(.DST-CFP-listing-item--intro)').toArray()
        .map(item => {
            const link = $(item).find('h3 a[href]').first();
            if (link.length === 0) return null;
            return {
                metaTitle: link.text().trim(),
                url: new URL(link.attr('href'), pageUrl).href,
                rawContent: $.html(item),
            };
        })
        .filter(entry => entry && entry.metaTitle && entry.url);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
