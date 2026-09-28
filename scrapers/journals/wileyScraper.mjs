import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getJournalsByPublisher } from '../issnMatcher.mjs';
import { estHorsInterstitiel } from '../cloudflare.mjs';
import { getContent } from '../fileParser.mjs';

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

// Memoire par ISSN, versionnee pour que le CI et le poste local en profitent :
//  - { chemin } : URL qui a fonctionne, essayee en premier au passage suivant
//    (une page au lieu de jusqu'a sept) ;
//  - { absences, verifie } : runs consecutifs sans page (404 sur tous les
//    chemins) et date de la derniere verification. Mesure le 2026-09-27 :
//    61 revues sans page coutaient 427 des 474 pages d'un run. Une revue
//    confirmee absente n'est plus reverifiee qu'une fois par semaine.
const DOSSIER = path.dirname(fileURLToPath(import.meta.url));
const CHEMINS_PATH = path.join(DOSSIER, 'wileyChemins.json');
const CALLS_PATH = path.join(DOSSIER, '..', '..', 'www', '_data', 'calls.json');
const ABSENCES_AVANT_SAUT = 2;
const DELAI_REVERIFICATION_MS = 7 * 24 * 3600 * 1000;
// npm.cmd run scrape -- --only wiley --reverifier-wiley : verifie toutes les
// revues, y compris celles confirmees absentes.
const OPTION_REVERIFIER = '--reverifier-wiley';

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
    // Constate le 2026-09-27 sur Journal of Organizational Behavior : 5 appels
    // ouverts a cette adresse, la revue passait pour absente.
    { prefix: 'plain', path: 'call-for-papers' },
];

// Revues servies par un sous-domaine societe. Constat du 2026-09-27 : sur les
// 108 revues Wiley, 9 ont une page d'accueil qui redirige vers
// {societe}.onlinelibrary.wiley.com. Leurs pages d'appels y vivent sous
// /hub/journal/{id}/..., prefixe que l'hote principal ne redirige pas : les
// candidats ci-dessus y prennent tous un 404, et ces 9 revues passaient pour
// absentes. Chaque URL a ete trouvee par le lien « Call for Papers » de la
// page d'accueil de la revue, pas deduite d'un schema.
export const PAGES_SOCIETE = {
    // Applied Psychology (IAAP)
    '1464-0597': 'https://iaap-journals.onlinelibrary.wiley.com/hub/journal/14640597/homepage/call-for-papers',
    // British Educational Research Journal (BERA)
    '1469-3518': 'https://bera-journals.onlinelibrary.wiley.com/hub/journal/14693518/call-for-papers',
    // British Journal of Educational Technology (BERA)
    '1467-8535': 'https://bera-journals.onlinelibrary.wiley.com/hub/journal/14678535/bjet_special_issues.htm',
};

// Page commune de la Strategic Management Society : les appels de ses trois
// revues sur une seule page, sans page propre a chacune (le lien « Call for
// Papers » des trois pages d'accueil y mene). Chaque appel est rattache par
// le debut de son titre (« Strategic Entrepreneurship Journal Special Issue:
// ... »), jamais par son slug : le 2026-09-27, un appel SEJ avait pour URL
// .../smj-judgment-ecosystems.
export const PAGE_COMMUNE_SMS = {
    url: 'https://sms.onlinelibrary.wiley.com/hub/call-for-papers/',
    revues: [
        { prefixe: 'Strategic Management Journal', issn: '1097-0266' },
        { prefixe: 'Strategic Entrepreneurship Journal', issn: '1932-443X' },
        { prefixe: 'Global Strategy Journal', issn: '2042-5805' },
    ],
};
const ISSN_SMS = new Set(PAGE_COMMUNE_SMS.revues.map(r => r.issn));

// Sous-domaines verifies le 2026-09-27 sans page d'appels a lire : JOOP
// (BPS) n'a qu'une page de numeros publies, JASIST et ARIST (ASIS&T) aucune
// page au format appel. Connus, ils ne declenchent pas le signalement « a
// completer » du bilan.
const SOUS_DOMAINES_SANS_APPELS = {
    '2044-8325': 'bpspsychub.onlinelibrary.wiley.com',
    '2330-1643': 'asistdl.onlinelibrary.wiley.com',
    '1550-8382': 'asistdl.onlinelibrary.wiley.com',
};

// Fonction pure, exportee pour test.
export function build_urls(issn) {
    const issnSlug = issn.replace(/-/g, '').toLowerCase();
    const candidats = PATH_CANDIDATES.map(c => c.prefix === 'page'
        ? `https://onlinelibrary.wiley.com/page/journal/${issnSlug}/${c.path}`
        : `https://onlinelibrary.wiley.com/journal/${issnSlug}/${c.path}`
    );
    return PAGES_SOCIETE[issn] ? [PAGES_SOCIETE[issn], ...candidats] : candidats;
}

// Fonction pure, exportee pour test.
export function estSousDomaineSociete(url) {
    try {
        return new URL(url).host.endsWith('.onlinelibrary.wiley.com');
    } catch {
        return false;
    }
}

// Que signaler quand une revue absente a une page d'accueil servie par
// hote ? null : hote principal, rien a signaler. 'connu-sans-appels' :
// sous-domaine deja verifie. 'a-completer' : sous-domaine a ajouter a
// PAGES_SOCIETE -- y compris une revue qui y figure deja, sa page ayant
// alors change d'adresse.
// Fonction pure, exportee pour test.
export function classerRedirection(issn, hote) {
    if (!hote || !hote.endsWith('.onlinelibrary.wiley.com')) return null;
    if (SOUS_DOMAINES_SANS_APPELS[issn] === hote) return 'connu-sans-appels';
    return 'a-completer';
}

const normaliserTitre = texte => (texte ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

// ISSN de la revue dont le nom ouvre le titre, ou null. Nom complet
// uniquement, suivi d'une limite de mot : ni sigle, ni recherche dans le
// corps du titre -- un appel non reconnu est ecarte, pas devine.
// Fonction pure, exportee pour test.
export function revueParTitre(titre, table) {
    const t = normaliserTitre(titre);
    for (const { prefixe, issn } of table) {
        const p = normaliserTitre(prefixe);
        if (t.startsWith(p) && !/[a-z0-9]/.test(t.charAt(p.length))) return issn;
    }
    return null;
}

// Rattache les entrees de la page commune a leur revue. revues : celles du
// CSV ({ issn, nomOpenalex }), source du nom affiche. Un appel dont la revue
// n'est pas reconnue, ou n'est pas dans le CSV, est ecarte.
// Fonction pure, exportee pour test.
export function rattacherAppelsCommuns(entries, table, revues) {
    const noms = new Map(revues.map(r => [r.issn, r.nomOpenalex]));
    const appels = [];
    const ecartes = [];
    for (const entry of entries) {
        const issn = revueParTitre(entry.metaTitle, table);
        if (!issn || !noms.has(issn)) {
            ecartes.push(entry.metaTitle);
            continue;
        }
        appels.push({ ...entry, issn, journal: noms.get(issn) });
    }
    return { appels, ecartes };
}

const TEXTE_DETAIL_MIN = 200;

// Texte complet d'un appel sur sa page de detail d'un sous-domaine societe :
// le plus long bloc .pb-rich-text, les autres etant des menus de la societe
// (« Resources About Us Join SMS... »). null sous 200 caracteres : page
// d'erreur ou gabarit inconnu.
// Fonction pure, exportee pour test.
export function extraire_detail(html) {
    const $ = cheerio.load(html);
    const longueur = el => $(el).text().replace(/\s+/g, ' ').trim().length;
    const blocs = $('.pb-rich-text').toArray().sort((a, b) => longueur(b) - longueur(a));
    if (!blocs.length || longueur(blocs[0]) < TEXTE_DETAIL_MIN) return null;
    return $.html(blocs[0]);
}

// Texte complet d'un appel sur sa page de detail de l'hote principal. Un
// seul conteneur pour toutes les pages, plutot que « .pb-rich-text, sinon
// autre chose » : une page ne peut pas basculer d'un selecteur a l'autre.
// Mesure le 2026-09-27 sur 69 pages : present partout ; sur les 66 qui ont
// un .pb-rich-text, meme texte au caractere pres ; sur les 3 autres (Expert
// Systems, Journal of Business Logistics), l'appel complet, echeance et
// editeurs compris. La barre laterale (alertes courriel) est hors du
// conteneur. null sous 200 caracteres.
// Fonction pure, exportee pour test.
export function extraire_detail_page(html) {
    const $ = cheerio.load(html);
    const bloc = $('.publications-page-body .main-content').first();
    if (!bloc.length) return null;
    bloc.find('script, style, noscript').remove();
    if (bloc.text().replace(/\s+/g, ' ').trim().length < TEXTE_DETAIL_MIN) return null;
    return $.html(bloc);
}

// D'ou vient le rawContent d'un appel, d'apres son seul lien :
//   'page'         page de l'hote principal -> extraire_detail_page
//   'page-societe' page d'un sous-domaine societe -> extraire_detail
//   'pdf'          PDF servi par Wiley (pb-assets) -> texte du PDF
//   'liste'        tout autre lien (site externe, PDF hors Wiley) -> bloc de
//                  liste, sans suivre le lien
// Le type ne depend que du lien, jamais de ce qu'on a pu lire : la source
// d'un appel ne bascule pas d'un run a l'autre, son hash non plus.
// Fonction pure, exportee pour test.
export function sourceDuLien(url) {
    let u;
    try { u = new URL(url); } catch { return 'liste'; }
    const wiley = u.host === 'onlinelibrary.wiley.com' || u.host.endsWith('.onlinelibrary.wiley.com');
    if (!wiley) return 'liste';
    if (/\.pdf$/i.test(u.pathname)) return 'pdf';
    return u.host === 'onlinelibrary.wiley.com' ? 'page' : 'page-societe';
}

// Suit-on le lien d'une entree ? Oui sur un sous-domaine societe (tous
// gabarits), et sur l'hote principal pour le seul gabarit de liste. Les
// groupes de l'ancien gabarit portent deja le texte de l'appel : les suivre
// changerait leur hash sans rien apporter.
// Fonction pure, exportee pour test.
export function doitSuivre(pageUrl, entry) {
    return estSousDomaineSociete(pageUrl) || entry.gabarit === 'liste';
}

// Lecture de la source prevue (texte, ou null si illisible) -> entree a
// publier, ou { preserver: true }. Jamais de repli sur le bloc de liste
// quand la source prevue est illisible : le rawContent alternerait entre
// deux formes d'un run a l'autre, avec une reextraction a chaque bascule et
// des champs vides a chaque retour au bloc de liste. L'appelant ecarte
// l'appel et preserve celui en base (issnBloques).
// Fonction pure, exportee pour test.
export function resoudreEntree(entry, source, lecture) {
    if (source === 'liste') return { entry };
    if (!lecture || !lecture.trim()) return { preserver: true };
    return { entry: { ...entry, rawContent: lecture } };
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
        const force = process.argv.includes(OPTION_REVERIFIER);
        const actifs = issn_avec_appels_actifs(abbreviation);
        const maintenant = Date.now();
        const calls = [];
        const motifs = { bloque: 0, absent: 0, reseau: 0, autre: 0 };
        let sautees = 0;
        let atteintes = 0;
        let avecAppels = 0;
        let requetes = 0;
        let debloquees = 0;
        const revuesSms = journals.filter(j => ISSN_SMS.has(j.issn));
        const commune = { appels: 0, ecartes: 0, bloquee: null };
        const details = { page: 0, pdf: 0, liste: 0, echecs: 0 };
        const sousDomaines = [];

        // Le bloc de liste ne porte que le titre et une echeance (parfois
        // celle d'un atelier) : on lit la source que designe le lien de
        // l'appel (cf sourceDuLien), qui devient son rawContent. Une source
        // illisible fait ecarter l'appel et preserver ceux de la revue en
        // base, jamais retomber sur le bloc de liste (cf resoudreEntree).
        const lireSource = async (page, entry, issn, journalName) => {
            const source = sourceDuLien(entry.url);
            let lecture = null;
            let motif = null;
            if (source === 'page' || source === 'page-societe') {
                const resultat = await find_page(page, journalName, [entry.url]);
                requetes += resultat.requetes;
                motif = resultat.motif ?? 'aucun bloc de texte';
                if (resultat.page) {
                    lecture = source === 'page' ? extraire_detail_page(resultat.page.html) : extraire_detail(resultat.page.html);
                }
            } else if (source === 'pdf') {
                requetes += 1;
                motif = 'PDF illisible';
                lecture = await lire_pdf(page, entry.url, journalName);
            }
            const resolu = resoudreEntree(entry, source, lecture);
            if (resolu.preserver) {
                details.echecs += 1;
                this.issnBloques.push(issn);
                console.warn(`[wiley] "${journalName}" : source ${source} illisible (${motif}) sur ${entry.url}, appel ecarte, appels en base preserves`);
                return null;
            }
            details[source === 'page-societe' ? 'page' : source] += 1;
            return resolu.entry;
        };

        const ajouter = (journal, issn, entry) => calls.push({
            journal,
            abbreviation,
            issn,
            metaTitle: entry.metaTitle,
            url: entry.url,
            rawContent: entry.rawContent,
        });

        // Rend le motif d'echec, ou null si la page a ete lue.
        const traiter = async (page, journal) => {
            const entree = lireEntree(chemins[journal.issn]);
            const urls = ordonnerUrls(build_urls(journal.issn), entree.chemin);
            const resultat = await find_page(page, journal.nomOpenalex, urls);
            requetes += resultat.requetes;
            chemins[journal.issn] = noterResultat(entree, resultat.page ? { page: resultat.page.url } : resultat, maintenant);
            if (!resultat.page) {
                if (resultat.motif === 'absent') await signalerSousDomaine(page, journal);
                return resultat.motif;
            }
            atteintes += 1;

            const entries = extract_entries(resultat.page.html, resultat.page.url, journal.nomOpenalex);
            if (entries.length) avecAppels += 1;
            for (const entry of entries) {
                const lue = doitSuivre(resultat.page.url, entry) ? await lireSource(page, entry, journal.issn, journal.nomOpenalex) : entry;
                if (lue) ajouter(journal.nomOpenalex, journal.issn, lue);
            }
            return null;
        };

        // Une revue absente dont la page d'accueil redirige vers un
        // sous-domaine inconnu a sans doute ses appels sur ce sous-domaine.
        // Une page de plus, pour les seules revues absentes.
        const signalerSousDomaine = async (page, journal) => {
            const accueil = await hote_accueil(page, journal.issn);
            requetes += 1;
            if (classerRedirection(journal.issn, accueil) === 'a-completer') {
                sousDomaines.push({ issn: journal.issn, hote: accueil });
            }
        };

        // Une page, trois revues. Non lue : les appels en base des trois sont
        // preserves -- une page commune qui disparait a plus probablement
        // demenage que perdu tous ses appels.
        const traiterPageCommune = async page => {
            const resultat = await find_page(page, 'page commune SMS', [PAGE_COMMUNE_SMS.url]);
            requetes += resultat.requetes;
            if (!resultat.page) {
                commune.bloquee = resultat.motif;
                this.issnBloques.push(...revuesSms.map(j => j.issn));
                console.warn(`[wiley] Page commune SMS non lue (${resultat.motif}) sur ${PAGE_COMMUNE_SMS.url} : appels de ${revuesSms.map(j => j.issn).join(', ')} preserves`);
                return;
            }
            for (const journal of revuesSms) chemins[journal.issn] = { chemin: resultat.page.url };
            const entries = extract_entries(resultat.page.html, resultat.page.url, 'page commune SMS');
            const { appels, ecartes } = rattacherAppelsCommuns(entries, PAGE_COMMUNE_SMS.revues, revuesSms);
            commune.ecartes = ecartes.length;
            for (const titre of ecartes) {
                console.warn(`[wiley] Page commune SMS : appel ecarte, aucune revue de la table ne correspond au titre "${titre}"`);
            }
            for (const appel of appels) {
                const lue = await lireSource(page, appel, appel.issn, appel.journal);
                if (!lue) continue;
                commune.appels += 1;
                ajouter(appel.journal, appel.issn, lue);
            }
        };

        const page = await browser.newPage();
        try {
            const bloquees = [];
            if (force) console.log(`[wiley] ${OPTION_REVERIFIER} : toutes les revues sont verifiees`);
            if (revuesSms.length) await traiterPageCommune(page);
            for (const journal of journals) {
                if (ISSN_SMS.has(journal.issn)) continue;
                // actifs === null : calls.json illisible, on ne saute personne.
                const appelsActifs = actifs === null || actifs.has(journal.issn);
                if (!doitVerifier(lireEntree(chemins[journal.issn]), { appelsActifs, force, maintenant })) {
                    sautees += 1;
                    continue;
                }
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

        this.issnBloques = [...new Set(this.issnBloques)];
        console.log(formaterBilan({
            total: journals.length, atteintes, avecAppels, debloquees, sautees, motifs, appels: calls.length, requetes,
            commune: revuesSms.length ? commune : undefined, details, sousDomaines,
        }));
        if (sousDomaines.length) {
            console.warn(`[wiley] Revues absentes dont la page d'accueil redirige vers un sous-domaine societe inconnu : chercher leur page d'appels (lien « Call for Papers » de l'accueil) et l'ajouter a PAGES_SOCIETE.`);
        }
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
export function formaterBilan({ total, atteintes, avecAppels, debloquees = 0, sautees = 0, motifs, appels, requetes, commune, details, sousDomaines }) {
    const lignes = [];
    if (commune) {
        lignes.push(commune.bloquee
            ? `[wiley]   page commune SMS non lue (${commune.bloquee}), appels en base preserves`
            : `[wiley]   page commune SMS ${commune.appels} appel(s), ${commune.ecartes} ecarte(s) faute de revue reconnue`);
    }
    if (details) {
        lignes.push(`[wiley]   sources lues ${details.page} page(s) de detail, ${details.pdf} PDF, ${details.liste} bloc(s) de liste ; ${details.echecs} echec(s), appels en base preserves`);
    }
    if (sousDomaines) {
        lignes.push(sousDomaines.length
            ? `[wiley]   sous-domaines a completer dans PAGES_SOCIETE : ${sousDomaines.map(s => `${s.issn} (${s.hote})`).join(', ')}`
            : `[wiley]   sous-domaines a completer : aucun`);
    }
    return [
        `[wiley] Bilan sur ${total} revue(s) :`,
        `[wiley]   OK          ${atteintes} (dont ${avecAppels} avec au moins un appel, ${debloquees} au second passage)`,
        `[wiley]   bloquees    ${motifs.bloque}`,
        `[wiley]   absentes    ${motifs.absent} (404 sur les ${PATH_CANDIDATES.length} chemins)`,
        `[wiley]   non reverifiees ${sautees} (absentes confirmees, verifiees il y a moins de 7 jours ; ${OPTION_REVERIFIER} pour forcer)`,
        `[wiley]   reseau      ${motifs.reseau}`,
        `[wiley]   autre       ${motifs.autre}`,
        ...lignes,
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

// Ancien format : l'URL seule. Fonction pure, exportee pour test.
export function lireEntree(valeur) {
    if (!valeur) return {};
    if (typeof valeur === 'string') return { chemin: valeur };
    return { ...valeur };
}

// Une revue n'est sautee que si elle est confirmee absente (deux runs
// consecutifs sans page), sans appel actif en base, et verifiee il y a moins
// d'une semaine. Dans le doute (date illisible), on verifie.
// Fonction pure, exportee pour test.
export function doitVerifier(entree, { appelsActifs, force, maintenant }) {
    if (force || appelsActifs) return true;
    if ((entree.absences ?? 0) < ABSENCES_AVANT_SAUT) return true;
    const verifie = Date.parse(entree.verifie);
    if (Number.isNaN(verifie)) return true;
    return maintenant - verifie >= DELAI_REVERIFICATION_MS;
}

// Nouvelle entree apres un passage. Page trouvee : chemin retenu, compteur
// remis a zero. 404 partout : une absence de plus, chemin oublie. Blocage,
// erreur reseau ou statut inattendu : on ne sait rien, l'entree ne bouge pas.
// Fonction pure, exportee pour test.
export function noterResultat(entree, resultat, maintenant) {
    if (resultat.page) return { chemin: resultat.page };
    if (resultat.motif === 'absent') {
        return { absences: (entree.absences ?? 0) + 1, verifie: new Date(maintenant).toISOString().slice(0, 10) };
    }
    return entree;
}

// ISSN des revues de ce scraper qui ont au moins un appel actif en base. null
// si calls.json est illisible : l'appelant ne saute alors aucune revue.
function issn_avec_appels_actifs(abbreviation) {
    try {
        const appels = JSON.parse(fs.readFileSync(CALLS_PATH, 'utf8'));
        return new Set(appels.filter(c => c.abbreviation === abbreviation && c.active).map(c => c.issn));
    } catch (error) {
        console.warn(`[wiley] ${CALLS_PATH} illisible, aucune revue absente ne sera sautee : ${error.message}`);
        return null;
    }
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

// Cles triees : le fichier ne change dans Git que si une entree change.
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

// Texte d'un PDF Wiley, ou null. Meme chaine que sageScraper : fetch DANS la
// page, qui porte les cookies du profil (cf_clearance) et l'empreinte du
// navigateur -- un fetch Node ou curl prend le challenge Cloudflare -- puis
// pdfjs via getContent. La page doit etre sur l'origine du PDF, sans quoi
// le fetch casse sur CORS : c'est le cas, les PDF (pb-assets) sont servis
// par l'hote de la page d'appels qui vient d'etre lue. Pas de repli sur le
// bloc de liste, cf resoudreEntree.
async function lire_pdf(page, url, journalName) {
    if (new URL(page.url()).origin !== new URL(url).origin) {
        console.warn(`[wiley] "${journalName}" : PDF ${url} hors de l'origine de la page (${page.url()}), non lu`);
        return null;
    }
    await sleep(REQUEST_DELAY_MS);
    let resultat;
    try {
        resultat = await page.evaluate(async (adresse) => {
            const reponse = await fetch(adresse, { credentials: 'include' });
            const octets = new Uint8Array(await reponse.arrayBuffer());
            // Par tranches : String.fromCharCode sur un grand tableau depasse
            // la taille d'appel maximale.
            let binaire = '';
            for (let i = 0; i < octets.length; i += 8192) {
                binaire += String.fromCharCode(...octets.subarray(i, i + 8192));
            }
            return { status: reponse.status, type: reponse.headers.get('content-type') ?? '', base64: btoa(binaire) };
        }, url);
    } catch (error) {
        console.warn(`[wiley] "${journalName}" : telechargement impossible du PDF ${url} : ${error.message.split('\n')[0]}`);
        return null;
    }
    if (resultat.status !== 200 || !/pdf/i.test(resultat.type)) {
        console.warn(`[wiley] "${journalName}" : PDF ${url} en statut ${resultat.status}, type "${resultat.type}"`);
        return null;
    }
    try {
        const texte = await getContent(Buffer.from(resultat.base64, 'base64'), 'pdf');
        return texte && texte.trim() ? texte : null;
    } catch (error) {
        console.warn(`[wiley] "${journalName}" : PDF ${url} illisible : ${error.message}`);
        return null;
    }
}

// Hote ou aboutit la page d'accueil de la revue, apres redirection, ou null
// si elle n'a pas pu etre lue.
async function hote_accueil(page, issn) {
    const url = `https://onlinelibrary.wiley.com/journal/${issn.replace(/-/g, '').toLowerCase()}`;
    await sleep(REQUEST_DELAY_MS);
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
        await page.waitForFunction(estHorsInterstitiel, undefined, { timeout: DELAI_CHALLENGE_MS });
        return new URL(page.url()).host;
    } catch {
        return null;
    }
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
        : split_on_call_links($, sectionNodes, pageUrl);

    const entries = groups
        .map(group => {
            let link = null;
            for (const node of group) {
                link = find_call_link($, node, pageUrl);
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

// Identifiant de revue (ISSN sans tiret) dans une URL de page revue Wiley,
// /page/journal/{id}/... ou /journal/{id}/... ; null pour toute autre URL.
const JOURNAL_ID_PATTERN = /onlinelibrary\.wiley\.com\/(?:page\/)?journal\/([0-9]{7}[0-9x])\//i;

// Vrai quand href mene a la page d'une AUTRE revue que celle de pageUrl.
// Constate sur International Transactions in Operational Research : sous son
// h2 « Call for Papers » trainait un module de Children & Society (numero
// virtuel), dont le lien devenait un faux appel ITOR. Un PDF, un site externe
// ou une page de la meme revue ne sont pas concernes.
// Fonction pure, exportee pour test.
export function pointeVersAutreRevue(href, pageUrl) {
    const idPage = pageUrl.match(JOURNAL_ID_PATTERN)?.[1]?.toLowerCase();
    if (!idPage) return false;
    let absolue;
    try { absolue = new URL(href, pageUrl).href; } catch { return false; }
    const idLien = absolue.match(JOURNAL_ID_PATTERN)?.[1]?.toLowerCase();
    return Boolean(idLien) && idLien !== idPage;
}

// Ignore les liens mail obscurcis par Cloudflare
// (/cdn-cgi/l/email-protection, texte affiche "[email protected]"), les
// mailto: directs, les liens de navigation generiques (ex. "Author
// Guidelines" dans le paragraphe d'intro) et les liens vers une autre revue
// -- jamais le vrai lien d'un appel.
function find_call_link($, node, pageUrl) {
    return $(node).find('a[href]').toArray()
        .map(a => $(a))
        .find(a => {
            const href = a.attr('href') ?? '';
            const text = a.text().trim();
            return !href.includes('cdn-cgi/l/email-protection')
                && !href.startsWith('mailto:')
                && !NON_CALL_LINK_TEXT_PATTERN.test(text)
                && !pointeVersAutreRevue(href, pageUrl);
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
function split_on_call_links($, nodes, pageUrl) {
    const groups = [];
    let current = [];
    let currentHasLink = false;
    for (const node of nodes) {
        const hasLink = Boolean(find_call_link($, node, pageUrl));
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
    const entries = $('.DST-CFP-listing-item:not(.DST-CFP-listing-item--intro)').toArray()
        .map(item => {
            const link = $(item).find('h3 a[href]').first();
            if (link.length === 0) return null;
            return {
                metaTitle: link.text().trim(),
                url: new URL(link.attr('href'), pageUrl).href,
                rawContent: $.html(item),
                gabarit: 'liste',
            };
        })
        .filter(entry => entry && entry.metaTitle && entry.url);
    return dedoublonnerParTitre(entries);
}

const normaliserTitreListe = texte => (texte ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

// Une meme page peut annoncer un appel deux fois sous deux blocs distincts :
// constate sur R&D Management, "Open Innovation in Action..." en double, un
// bloc pointant vers un PDF (pb-assets), l'autre vers la page moderne
// (call-for-papers/si-...). Meme titre, deux liens -- sans ce filtre,
// dataPreparation.generateSlug les prend pour deux appels homonymes et
// suffixe l'un des deux en -2 a chaque run.
// A titre identique, on garde le lien non-PDF : la page moderne est le
// gabarit prioritaire (cf wiley-structures-de-page), lisible sans extraction
// PDF. Sinon, le premier rencontre.
// Fonction pure, exportee pour test.
export function dedoublonnerParTitre(entries) {
    const parTitre = new Map();
    for (const entry of entries) {
        const cle = normaliserTitreListe(entry.metaTitle);
        const existant = parTitre.get(cle);
        if (!existant || (sourceDuLien(existant.url) === 'pdf' && sourceDuLien(entry.url) !== 'pdf')) {
            parTitre.set(cle, entry);
        }
    }
    return [...parTitre.values()];
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
