import slugify from 'slugify';
import { createHash } from 'crypto';
import TurndownService from 'turndown';
import { toText } from './issnMatcher.mjs';
import { normaliserUrl } from './url.mjs';

// oldCalls : etat actuel de calls.json (integrateCalls le lit deja pour son
// propre usage). Sert uniquement a stabiliser les slugs -- cf construireIdentiteSlugs.
export async function clean(issues, oldCalls = []) {
    // Filet de securite : si un scraper renvoie deux fois le meme appel dans
    // un meme run (ex. bug de pagination), on ne garde que la premiere
    // occurrence par ISSN+URL, sinon integrateCalls les fait passer pour deux
    // appels distincts (meme contentHash, slugs "-2" generes plus bas).
    // Cle sur l'URL normalisee (pas la chaine brute) : ScienceDirect ajoute
    // parfois un parametre de tracking qui ne change rien a la page, et deux
    // occurrences n'en seraient sinon pas reconnues comme le meme appel.
    // ISSN dans la cle (pas l'abreviation seule) : un numero special conjoint
    // partage sa page entre plusieurs revues du meme editeur, ce sont deux
    // appels distincts a garder tous les deux (cf elsevierScraper.mjs).
    const seenUrls = new Set();
    issues = issues.filter(issue => {
        const url = normaliserUrl(issue.url);
        if (url === null || !issue.issn) return true;
        const cle = `${issue.issn}|${url}`;
        if (seenUrls.has(cle)) return false;
        seenUrls.add(cle);
        return true;
    });

    const identiteSlugs = construireIdentiteSlugs(oldCalls);

    // Traitement sequentiel (pas Promise.all) : generateSlug a besoin de
    // connaitre les slugs deja attribues dans ce lot pour garantir leur
    // unicite (ex. deux revues avec le meme titre d'appel -- special issue
    // conjointe entre plusieurs revues Elsevier).
    const usedSlugs = new Set();
    const results = [];
    for (let issue of issues) {
        issue = await normalizeTextFields(issue);
        issue = await cleanTitles(issue);
        issue = await generateSlug(issue, usedSlugs, identiteSlugs);
        issue = await parseHTML(issue);
        issue = await hash(issue);
        results.push(issue);
    }

    // Second filet, apres calcul du contentHash : le meme appel peut arriver
    // deux fois sous deux URL differentes (constate sur SAGE le 23 aout 2026,
    // deux liens PDF vers le meme document). Le filtre par URL ci-dessus ne
    // les voit pas. integrateCalls resolvait alors les deux vers la meme
    // entree ancienne via oldHashMap et la poussait deux fois, d'ou des
    // doublons stricts dans calls.json et un build en echec sur
    // DuplicatePermalinkOutputError. On garde la premiere occurrence, qui
    // porte le slug de base -- la suivante aurait le suffixe -2.
    // Pas de faux positif quand rawContent est vide : le hash retombe alors
    // sur le slug, unique par construction dans ce lot.
    const seenHashes = new Set();
    const dedoublonnes = results.filter(issue => {
        if (seenHashes.has(issue.contentHash)) return false;
        seenHashes.add(issue.contentHash);
        return true;
    });
    if (dedoublonnes.length < results.length) {
        // Sans cette ligne, l'evenement est indetectable : c'est ce qui a
        // rendu le cas SAGE si long a identifier.
        console.warn(`[clean] ${results.length - dedoublonnes.length} appel(s) ecarte(s), contenu deja vu sous une autre URL`);
    }
    return dedoublonnes;
}

// Certains scrapers (API JSON, ex. Taylor & Francis) peuvent fournir ces
// champs sous forme d'objet ({ rendered: "..." }) ou null au lieu d'une
// chaine ; on les normalise ici avant tout traitement texte en aval.
async function normalizeTextFields(issue) {
    issue.metaTitle = toText(issue.metaTitle);
    issue.title = toText(issue.title);
    issue.journal = toText(issue.journal);
    return issue;
}

// Identite = abreviation + ISSN + URL normalisee -> slug deja attribue dans
// calls.json. Sans ceci, le suffixe -2 d'un appel homonyme (deux revues avec
// le meme titre d'appel dans le meme run) depend de l'ordre d'arrivee des
// appels ce run-la, qui varie d'un passage a l'autre (ex. hub Elsevier dont
// le nombre de cartes rendues n'est pas stable, cf hub-elsevier-deux-
// variantes). Un appel qui obtenait le slug de base un jour peut se
// retrouver seul dans un run ulterieur -- sans memoire de son identite, il
// recalculerait alors ce meme slug de base, qui appartient deja a son
// homonyme historique : celui-ci se retrouve aussitot orphelin (son
// contentHash et son slug ne correspondant plus a rien de nouveau, la
// boucle des disparus l'archive), pendant qu'un doublon frais est cree pour
// le meme appel reel. Constate sur calls.json : elsevier-pathways-for-eco-
// industrial-transformations... et elsevier-how-government-policy-shapes...
// ISSN dans la cle, pas seulement l'abreviation : un numero special
// conjoint partage sa page entre plusieurs revues du meme editeur (meme
// abreviation, ISSN differents), chacune garde sa propre identite.
function construireIdentiteSlugs(oldCalls) {
    const identite = new Map();
    for (const call of oldCalls || []) {
        const url = normaliserUrl(call.url);
        if (url === null || !call.issn || !call.abbreviation || !call.slug) continue;
        const cle = `${call.abbreviation}|${call.issn}|${url}`;
        const existant = identite.get(cle);
        // En cas de doublon deja present (nettoyage pas encore fait), le plus
        // recent l'emporte : c'est generalement celui reste actif.
        if (!existant || new Date(call.pubDate) > new Date(existant.pubDate)) {
            identite.set(cle, { slug: call.slug, pubDate: call.pubDate });
        }
    }
    return new Map([...identite].map(([cle, v]) => [cle, v.slug]));
}

async function generateSlug(issue, usedSlugs, identiteSlugs = new Map()) {
    const url = normaliserUrl(issue.url);
    if (url !== null && issue.issn && issue.abbreviation) {
        const ancien = identiteSlugs.get(`${issue.abbreviation}|${issue.issn}|${url}`);
        if (ancien && !usedSlugs.has(ancien)) {
            usedSlugs.add(ancien);
            issue.slug = ancien;
            return issue;
        }
    }
    issue.slug = await slugUnique(issue.abbreviation, issue.metaTitle, usedSlugs);
    return issue;
}

// Un statut de cloture affiche par la source (« (CLOSED) », « (clos) »...)
// n'est pas une partie de l'identite de l'appel : sans ce retrait, la meme
// page qui change de libelle au fil du temps (ex. CUP "Risk Sharing" ->
// "Risk Sharing (CLOSED)") change de slug de base et cree un doublon. Seule
// la forme suffixe entre parentheses est visee, pour ne pas amputer un titre
// qui contiendrait legitimement l'un de ces mots ailleurs que dans un
// marqueur de statut.
const MARQUEUR_CLOTURE = /\s*\((?:closed|clos(?:e|es)?|clôtur[ée]e?|cloture)\)\s*$/i;
function titrePourSlug(metaTitle) {
    return typeof metaTitle === 'string' ? metaTitle.replace(MARQUEUR_CLOTURE, '').trim() : metaTitle;
}

// Un metaTitle generique ("Call for papers", sans plus de precision) ne doit
// jamais entrer dans le calcul du slug : deux appels differents d'une meme
// source qui rendent ce meme texte generique se retrouveraient avec le meme
// slug de base (l'un des deux hérite alors d'un suffixe -2 sans rapport avec
// son contenu). Exportee : integrateCalls (diffChecker.mjs) s'en sert pour
// recalculer le slug d'un appel neuf a partir du titre extrait par le modele
// (disponible seulement apres parse(), donc hors de cette fonction).
const METATITRES_GENERIQUES = new Set([
    'call for papers', 'calls for papers', 'cfp',
    'appel a communications', 'appel a contributions',
]);
export function estMetaTitreGenerique(metaTitle) {
    if (typeof metaTitle !== 'string') return false;
    const normalise = metaTitle.toLowerCase().trim().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ');
    return METATITRES_GENERIQUES.has(normalise);
}

// Calcule un slug et l'ajoute a usedSlugs. Fonction pure (a l'effet de bord
// pres sur usedSlugs, partage avec generateSlug), exportee pour permettre a
// integrateCalls de recalculer le slug d'un appel neuf a partir d'un autre
// texte que metaTitle (cf estMetaTitreGenerique).
export async function slugUnique(abbreviation, texte, usedSlugs) {
    const baseSlug = await slugify(`${abbreviation} ${titrePourSlug(texte)}`, { lower: true, strict: true });
    let slug = baseSlug;
    for (let suffix = 2; usedSlugs.has(slug); suffix++) {
        slug = `${baseSlug}-${suffix}`;
    }
    usedSlugs.add(slug);
    return slug;
}

async function parseHTML(issue) {
    if (!issue.rawContent || typeof issue.rawContent !== 'string') {
        return issue;
    }
    var turndownService = new TurndownService();
    issue.rawContent = turndownService.turndown(issue.rawContent);
    return issue;
}

async function hash(issue) {
    if (!issue.rawContent || issue.rawContent.trim() === '') {
        issue.contentHash = await createHash('sha256').update(issue.slug).digest('hex');
    } else {
        issue.contentHash = await createHash('sha256').update(issue.rawContent).digest('hex');
    }
    return issue;
}

async function cleanTitles(issue) {
    const patterns = [
        /DSS Special Issue on /g,
        /Call for Papers on Special Issue: /g,
        /Call for Papers \(Special Section @ ?IJIM\) Theme: /g,
        /Call for Papers:  ?Special [I|i]ssue on /g,
        /Call for Papers: /g,
        /Special Issue: /g,
        /Special Issue on /g,
        /(\- )?Short Title SI: .+/g,
        /Special Section:? /g,
        /\(PDF\)/g,
        /'/g,
        /"/g,
        /”/g,
        /“/g
    ];
    for (let pattern of patterns) {
        issue.metaTitle = issue.metaTitle.replace(pattern, '').trim();
    }
    issue.metaTitle = issue.metaTitle.replace('–', '-').trim();
    return issue;
}
