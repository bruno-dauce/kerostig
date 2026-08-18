import * as cheerio from 'cheerio';
import { mkdtempSync, readFileSync } from 'fs';
import path from 'path';
import os from 'os';
import { matchIssn } from '../issnMatcher.mjs';
import { curlGet } from '../curlClient.mjs';

// COLLECTE LOCALE UNIQUEMENT (decision v1, 2026-08-18).
//
// journals.sagepub.com renvoie un 403 Cloudflare depuis GitHub Actions, y
// compris avec curl-impersonate installe et fonctionnel : la variable
// discriminante est la reputation de l'IP de sortie (plages Azure du
// runner), pas le fingerprint TLS -- les memes requetes passent depuis une
// IP domestique avec un curl standard, moins credible. Ce scraper ne
// rapporte donc rien en CI ; ses appels sont collectes en lancant le
// pipeline a la main (`npm run scrape -- --only sage`) depuis un poste
// personnel. La contrainte est assumee pour la v1 : la sortir demanderait
// de router SAGE par un service tiers ou un runner auto-heberge.
//
// Consequence a garder en tete : le garde-fou "scraper vide" de
// diffChecker.mjs voit ce scraper rentrer bredouille a chaque passage CI.
// C'est bien lui qui evite que les appels SAGE deja en base basculent en
// active:false faute d'avoir ete revus -- ne pas le contourner ici.

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
//
// /toc/{code}/{volume}/{numero} est le sommaire d'un numero DEJA PARU : un
// appel ne pointe jamais vers un sommaire. C'est la forme que prennent les
// encarts "Special issue" a bouton "Read Now" (4 faux positifs au passage du
// 2026-08-18 : Journal of International Marketing, Journal of Interactive
// Marketing, Medical Decision Making, Journal of Public Policy & Marketing),
// dont l'intitule seul ne permet pas de les distinguer d'un vrai appel.
const IGNORED_URL_PATTERN = /\/author-instructions\/|\/toc\//i;

// Widget "vous pourriez etre interesse par" affiche sur la page propre
// d'une revue (systeme CMS distinct de l'accordeon du hub). Constate
// manuellement sur RAM (Recherche et Applications en Marketing) : son lien
// "/home/ram" est present dans l'accordeon du hub mais avec un texte vide
// (bug cote SAGE), et de toute facon aucun appel n'y est liste pour cette
// revue -- l'appel actif n'existe que sous cette forme, absente du hub.
// Plusieurs spots coexistent sur une page (pub, reseaux sociaux, "Publish
// with us"...), d'ou le filtre sur le titre.
const MARKETING_SPOT_SELECTOR = 'div.marketing-spot';

// Retenu large a dessein : le releve des 60 pages FNEGE (2026-08-18) donne
// 35 intitules distincts pour 87 encarts -- "Call for papers", "Special
// issue call for papers", "Special issue", "SO! Call for papers", "Grand
// Challenges Special Issue CFP"... Un motif strict en rate la majorite (le
// precedent, /^call for papers$/, laissait passer 16 encarts sur 87 et
// ratait justement le Journal of International Marketing). Le tri fin ne se
// fait donc pas ici mais par exclusion (cf NON_CALL_PATTERN).
const MARKETING_SPOT_TITLE_PATTERN = /call for paper|call for submission|special issue|\bcfp\b/i;

// Critere de tri, par EXCLUSION. Un premier essai en sens inverse (ne
// garder que les encarts annoncant une echeance) a ete abandonne apres
// mesure sur 8 pages FNEGE : il laissait passer 6 appels et en ratait au
// moins 6, parce que beaucoup de revues n'affichent que le titre de l'appel
// et un bouton "Learn more", l'echeance vivant sur la page liee (constate
// sur Entrepreneurship Theory and Practice, Human Relations, Urban Studies).
// L'exclusion resiste mieux aux variations de mise en page : les encarts qui
// ne sont PAS des appels se nomment, eux, de facon tres reguliere.
//
//  - "Virtual special issue", "Latest special issues", "Read our latest
//    Special Issue", "Special Issues in Process" : collections d'articles
//    deja publies, bouton "Read Now".
//  - "proposals" : sollicite une PROPOSITION de numero special aupres de
//    futurs editeurs invites, pas des articles. Meme distinction que la
//    section "Call For Special Issue Proposals" deja ecartee chez Wiley.
//    Le mot apparait tantot dans le titre de l'encart ("Special Issue
//    Proposals", ETP), tantot seulement dans le corps ("Deadlines for
//    Special Issue Proposals", Organization Studies) -- d'ou le test sur
//    les deux.
//  - "conference" : appel a communications pour un colloque (deux encarts
//    "BSA Conference call for papers" sur Sociology), hors perimetre d'un
//    site d'appels a publications. Conserve du filtre precedent.
const NON_CALL_PATTERN = /virtual special issue|latest special issue|read our (?:latest )?special issue|special issues in process|\bproposals?\b|\bconference\b/i;

// Les appels d'une meme revue peuvent etre listes dans un seul encart, sous
// forme de <li> (un appel par puce, avec son lien et son echeance) au lieu
// d'un encart par appel avec bouton en pied. Constate sur le Journal of
// International Marketing : 3 appels dans un unique encart "Call for
// papers", liens dans le corps et pied de widget vide -- l'extracteur
// d'origine, qui ne lisait que le premier lien du pied, n'en rendait aucun.
const MARKETING_SPOT_LIST_ITEM_SELECTOR = '.marketing-spot__list li';
const MARKETING_SPOT_TEXT_SELECTOR = '.marketing-spot__text';
const MARKETING_SPOT_FOOTER_SELECTOR = '.marketing-spot__footer';

// Liens de navigation generiques, jamais le lien d'un appel (meme garde-fou
// que sur le hub et chez Wiley).
const IGNORED_SPOT_LINK_TEXT_PATTERN = /^(author guidelines|submission guidelines|guide for authors|aims (and|&) scope)$/i;

// Certains liens d'encart sont enrobes par le Safe Links d'Outlook : l'URL
// reelle est passee dans le parametre ?url= d'un domaine
// *.safelinks.protection.outlook.com (les appels du Journal of International
// Marketing pointent ainsi vers ama.org via nam12.safelinks...). Stocker le
// lien enrobe donnerait une URL illisible sur la fiche, instable dans le
// temps (jeton de tracking) et donc un slug instable : on deballe.
const SAFELINK_HOST_PATTERN = /(^|\.)safelinks\.protection\.outlook\.com$/i;

// Les 60 revues FNEGE publiees par SAGE, avec le code de leur page
// /home/{code} et leur ISSN canonique (cle de jointure avec journals.json).
//
// C'est desormais la source PRINCIPALE de ce scraper. Le releve du
// 2026-08-18 a montre que le hub ne liste que 4 de ces 60 revues : sa
// section "Business & Management" est dominee par des revues hors
// perimetre, et des revues aussi importantes que le Journal of
// International Marketing n'y figurent pas du tout alors que leur propre
// page affiche des appels ouverts. Le pari initial "un hub unique evite de
// naviguer revue par revue" ne tient pas pour la gestion.
//
// Le mapping vit dans un fichier a part (donnee de reference, pas du code)
// et a ete construit depuis le repertoire /action/showPublications, puis
// verifie revue par revue en comparant l'ISSN affiche sur la page a celui
// de journals.json. Piege releve a cette occasion : le repertoire donne
// "rmea" pour Recherche et Applications en Marketing, qui est l'edition
// ANGLAISE (eISSN 2051-5707) ; l'edition francaise du perimetre FNEGE est
// "ram". Refaire cette verification par l'ISSN avant d'ajouter une revue.
const JOURNAL_PAGES = JSON.parse(
    readFileSync(new URL('./sage-fnege-codes.json', import.meta.url), 'utf8')
);

// 60 requetes par passage au lieu d'une seule : on espace, comme chez
// Wiley, ou un rythme trop soutenu finit par declencher un challenge
// Cloudflare apres quelques dizaines de requetes.
const REQUEST_DELAY_MS = 1000;

export const scraperObject = {
    url: HUB_URL,
    abbreviation: 'sage',
    async scraper() {
        const abbreviation = this.abbreviation;

        // Le hub est conserve en complement (il couvre 4 revues du
        // perimetre, cf commentaire sur JOURNAL_PAGES), mais son
        // indisponibilite ne doit pas empecher de parcourir les pages
        // revue : pas de retour anticipe ici.
        const accordionHtml = await get_accordion_html(HUB_URL);

        // Certaines revues sont classees sous plusieurs disciplines : leur
        // appel apparait alors identique dans plusieurs sections. Deduplique
        // par URL pour ne pas interroger le LLM deux fois pour le meme appel.
        const entriesByUrl = new Map();
        if (accordionHtml) {
            for (const entry of extract_entries(accordionHtml)) {
                entriesByUrl.set(entry.url, entry);
            }
        }
        console.log(`[sage] ${entriesByUrl.size} appel(s) distinct(s) trouve(s) sur le hub`);

        // Les pages revue portent deja leur ISSN (cf JOURNAL_PAGES) : leurs
        // appels arrivent apparies, sans passer par matchIssn. Un appel deja
        // vu sur le hub n'est pas remplace -- meme URL, meme appel.
        let journauxAvecAppel = 0;
        let pagesInjoignables = 0;
        for (const { code, titre, issn } of JOURNAL_PAGES) {
            await sleep(REQUEST_DELAY_MS);
            const pageEntries = await get_marketing_spot_calls(code, titre);
            if (pageEntries === null) {
                pagesInjoignables++;
                continue;
            }
            if (pageEntries.length > 0) journauxAvecAppel++;
            for (const entry of pageEntries) {
                if (!entriesByUrl.has(entry.url)) entriesByUrl.set(entry.url, { ...entry, issn });
            }
        }
        console.log(`[sage] ${journauxAvecAppel} revue(s) FNEGE sur ${JOURNAL_PAGES.length} avec au moins un appel sur leur page`);
        if (pagesInjoignables > 0) {
            console.warn(`[sage] ${pagesInjoignables} page(s) revue injoignable(s) -- appels de ces revues absents de ce passage`);
        }

        let skippedCount = 0;
        const calls = [];
        for (const entry of entriesByUrl.values()) {
            const issn = entry.issn ?? await matchIssn(entry.journal);
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
        console.log(`[sage] ${skippedCount} appel(s) du hub ignore(s), revue hors perimetre FNEGE`);
        console.log(`[sage] ${calls.length} appel(s) retenu(s)`);

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

// Recupere le(s) appel(s) affiche(s) via les widgets "marketing spot" sur la
// page propre d'une revue (cf commentaire sur MARKETING_SPOT_SELECTOR).
//
// Renvoie null si la page n'a pas pu etre lue, [] si elle a ete lue et
// n'annonce aucun appel : la distinction compte, une page injoignable n'est
// pas une revue sans appel. Le statut n'est logue que s'il n'est pas 200 --
// 60 lignes "Statut HTTP 200" a chaque passage noieraient les vrais
// problemes dans les logs.
async function get_marketing_spot_calls(code, journalName) {
    const url = `https://journals.sagepub.com/home/${code}`;
    let response;
    try {
        response = await curlGet(url, { cookieJarPath: COOKIE_JAR_PATH, userAgent: USER_AGENT });
    } catch (error) {
        console.warn(`[sage] Erreur reseau (curl) sur ${url} (${journalName}) : ${error.message}`);
        return null;
    }

    if (response.status !== 200) {
        console.warn(`[sage] Statut HTTP ${response.status} (attendu 200) sur ${url} (${journalName}) -- probable blocage anti-bot ou challenge`);
        return null;
    }

    return extract_spot_calls(response.body, url, journalName);
}

// Fonction pure (HTML -> appels), exportee pour pouvoir etre rejouee sur du
// HTML reel sans navigateur ni reseau.
export function extract_spot_calls(html, pageUrl, journalName) {
    const $ = cheerio.load(html);
    const entries = [];

    $(MARKETING_SPOT_SELECTOR).each((_, el) => {
        const spot = $(el);
        const title = spot.find('.marketing-spot__title').first().text().trim();
        if (!MARKETING_SPOT_TITLE_PATTERN.test(title)) return;
        if (NON_CALL_PATTERN.test(title)) return;

        for (const call of read_spot($, spot, title, pageUrl)) {
            if (!call.url || !call.rawContent.trim()) continue;
            if (IGNORED_URL_PATTERN.test(call.url)) continue;
            // Teste sur le texte visible et non sur le HTML : le balisage
            // peut couper "special issue proposals" par une balise, et une
            // classe CSS ne doit pas declencher l'exclusion.
            if (NON_CALL_PATTERN.test(cheerio.load(call.rawContent).text())) continue;
            // Et sur l'URL : un appel a propositions de numero special peut
            // n'annoncer sa nature que la (constate sur Family Business
            // Review, dont l'encart affiche "Family Offices in the
            // Spotlight:" et pointe vers .../call-for-fbr-special-issue-
            // proposals-...). Separateurs remis en espaces pour que le motif
            // s'applique de la meme facon que sur du texte.
            if (NON_CALL_PATTERN.test(call.url.replace(/[-_+]+|%20/g, ' '))) continue;
            entries.push({ journal: journalName, ...call });
        }
    });

    return entries;
}

// Un encart prend l'une des deux formes rencontrees sur les pages revue :
// une liste de puces (un appel par <li>) ou un bloc de texte unique avec
// bouton en pied. On lit la liste en priorite : quand elle existe, le pied
// de l'encart est vide et le texte global melangerait tous les appels.
function read_spot($, spot, spotTitle, pageUrl) {
    const items = spot.find(MARKETING_SPOT_LIST_ITEM_SELECTOR).toArray();
    if (items.length > 0) {
        return items.map(item => {
            const li = $(item);
            const link = find_call_link($, li);
            const url = link ? resolve_call_url(link.attr('href'), pageUrl) : null;
            // Le lien est reecrit AVANT de serialiser rawContent : un
            // safelink Outlook porte un jeton de tracking regenere par
            // l'editeur, qui ferait changer le contentHash sans que l'appel
            // ait bouge -- donc un rappel du modele a chaque passage. Le
            // mecanisme de diff repose sur un rawContent stable.
            if (link && url) link.attr('href', url);
            return {
                // Le texte du lien porte le vrai titre de l'appel ("Global
                // Endorsers in Marketing"), bien plus utile que l'intitule
                // de l'encart, commun a toutes les puces.
                metaTitle: link ? link.text().trim() : null,
                url,
                rawContent: $.html(li),
            };
        });
    }

    const text = spot.find(MARKETING_SPOT_TEXT_SELECTOR).first();
    // Le pied de l'encart d'abord (bouton "Learn More"), puis le corps en
    // repli : certaines revues n'ont pas de pied du tout.
    const link = find_call_link($, spot.find(MARKETING_SPOT_FOOTER_SELECTOR).first())
        ?? find_call_link($, text);
    const url = link ? resolve_call_url(link.attr('href'), pageUrl) : null;
    if (link && url) link.attr('href', url); // cf commentaire ci-dessus
    return [{
        // Forme simple : l'encart entier ne decrit qu'un appel, son intitule
        // reste le meilleur repli disponible (et garder ce choix preserve le
        // slug des appels deja en base, cf dataPreparation.generateSlug).
        metaTitle: spotTitle,
        url,
        rawContent: text.length ? ($.html(text) ?? '') : '',
    }];
}

function find_call_link($, scope) {
    if (!scope || scope.length === 0) return null;
    return scope.find('a[href]').toArray()
        .map(a => $(a))
        .find(a => {
            const href = a.attr('href') ?? '';
            if (href.startsWith('mailto:') || href.includes('cdn-cgi/l/email-protection')) return false;
            return !IGNORED_SPOT_LINK_TEXT_PATTERN.test(a.text().trim());
        }) ?? null;
}

function resolve_call_url(href, pageUrl) {
    if (!href) return null;
    let url;
    try {
        url = new URL(href, pageUrl);
    } catch {
        return null;
    }
    if (!SAFELINK_HOST_PATTERN.test(url.hostname)) return url.href;

    // Le parametre ?url= porte l'URL reelle, encodee. On ne renvoie le lien
    // deballe que s'il est exploitable : mieux vaut le lien enrobe qu'un
    // appel sans URL du tout (pageController ecarte les appels sans contenu,
    // et un slug se construit sur le metaTitle, pas sur l'URL).
    const inner = url.searchParams.get('url');
    if (!inner) return url.href;
    try {
        return new URL(inner).href;
    } catch {
        return url.href;
    }
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

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
