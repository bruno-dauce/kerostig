import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CSV_PATH = path.join(__dirname, '..', 'enrichissement', 'kerostig-correspondance-issn-enrichi.csv');

let issnIndexPromise = null;
let loggedUnexpectedNameShape = false;

// Certaines API (WordPress REST) renvoient un champ texte sous forme
// d'objet ({ rendered: "..." } ou variantes) plutot qu'une chaine brute.
export function toText(name) {
    if (typeof name === 'string') return name;
    if (name == null) return '';
    if (typeof name === 'object') {
        const champ = name.rendered ?? name.raw ?? name.value ?? name.text ?? null;
        // Le repli String(name) rend "Nom" sur un tableau d'un seul element,
        // forme sous laquelle l'API WordPress de T&F sert parfois
        // _special_issues_journal_title -- le nom est donc bien recupere et la
        // jointure ISSN aboutit. L'ancien message annoncait la valeur du champ
        // nomme, soit "" dans ce cas, et faisait croire a une perte de donnee
        // qui n'a jamais eu lieu. On annonce desormais la valeur reellement
        // rendue.
        const valeurRendue = typeof champ === 'string' ? champ : String(name);
        if (!loggedUnexpectedNameShape) {
            loggedUnexpectedNameShape = true;
            console.warn(`[issnMatcher] Nom de revue recu sous forme d'objet, cles : ${Object.keys(name).join(', ')} -> valeur utilisee : "${valeurRendue}"`);
        }
        return valeurRendue;
    }
    return String(name);
}

function normalize(name) {
    return toText(name)
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

// Parser CSV conscient des guillemets (RFC4180) : le split naif sur "," casse
// des lignes du fichier enrichi dont le titre contient une virgule non echappee.
function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQuotes) {
            if (c === '"') {
                if (text[i + 1] === '"') { field += '"'; i++; }
                else inQuotes = false;
            } else {
                field += c;
            }
        } else if (c === '"') {
            inQuotes = true;
        } else if (c === ',') {
            row.push(field); field = '';
        } else if (c === '\r') {
            continue;
        } else if (c === '\n') {
            row.push(field); rows.push(row); row = []; field = '';
        } else {
            field += c;
        }
    }
    if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
    return rows;
}

function looksLikeIssn(value) {
    return /^\d{4}-\d{3}[\dXx]$/.test((value || '').trim());
}

// Historique, a ne pas reintroduire : ce fichier etait autrefois ecrit sans
// echappement CSV. Un titre a virgule ("ACCOUNTING, ORGANIZATION AND SOCIETY")
// combine a un champ "slug" absent decalait silencieusement tout ce qui suit
// le titre, et issn_cle se retrouvait a un index different selon les lignes.
// extractRow comptait donc les champs depuis la FIN de la ligne, les trois
// derniers etant les seuls surs.
//
// Ce contournement est leve : le fichier est desormais genere par
// scrapers/genererCorrespondance.mjs, en RFC 4180 propre. La lecture se fait
// par nom de colonne. C'est aussi ce qui rend le fichier tolerant aux colonnes
// supplementaires -- la lecture par la fin, elle, prenait sherpa_depot_hal
// pour nom_openalex et vidait getJournalsByPublisher sans un mot.
const COLONNES_REQUISES = ['titre', 'issn_cle', 'editeur', 'nom_openalex'];

// Fonction pure, exportee pour test.
export function indexerEntetes(entete) {
    const index = new Map();
    entete.forEach((nom, i) => index.set(nom.trim().toLowerCase(), i));
    const manquantes = COLONNES_REQUISES.filter((c) => !index.has(c));
    if (manquantes.length > 0) {
        throw new Error(
            `[issnMatcher] colonnes absentes de ${path.basename(CSV_PATH)} : ${manquantes.join(', ')}. ` +
            `Entete lue : ${entete.join(', ')}. Regenerez le fichier avec node scrapers/genererCorrespondance.mjs.`
        );
    }
    return index;
}

// Fonction pure, exportee pour test.
export function extractRow(row, entetes) {
    const lire = (nom) => (row[entetes.get(nom)] ?? '').trim();
    const issnCle = lire('issn_cle');
    return {
        titre: lire('titre'),
        nomOpenalex: lire('nom_openalex'),
        editeur: lire('editeur'),
        issnCle: looksLikeIssn(issnCle) ? issnCle : null,
    };
}

async function loadRows() {
    const text = await fs.readFile(CSV_PATH, 'utf-8');
    const rows = parseCsv(text);
    if (rows.length === 0) throw new Error(`[issnMatcher] ${CSV_PATH} est vide.`);
    return { entetes: indexerEntetes(rows[0]), lignes: rows.slice(1) };
}

// Deux passes, et non une boucle [nomOpenalex, titre] par ligne : le nom
// OpenAlex l'emporte sur le titre FNEGE d'une AUTRE ligne, quel que soit
// l'ordre du fichier.
//
// Le classement FNEGE liste parfois deux fois la meme revue, sous son nom
// courant et sous son ancien nom, avec deux ISSN. Leurs titres FNEGE se
// normalisent alors a l'identique -- « BUSINESS ETHICS, THE ENVIRONMENT AND
// RESPONSIBILITY » et « ... & RESPONSIBILITY » donnent la meme cle -- et le
// premier arrive gagnait. En une passe, l'ordre du fichier decidait donc a
// quelle revue se rattachaient les appels : l'ancien CSV renvoyait la revue
// courante, journals.json trie par rang puis titre renvoyait l'ancienne.
// Les noms OpenAlex, eux, restent distincts (« Business Ethics the
// Environment & Responsibility » contre « Business Ethics A European
// Review ») : les indexer tous d'abord tranche le conflit sur la donnee
// plutot que sur l'ordre des lignes.
async function buildIssnIndex() {
    const index = new Map();
    const { entetes, lignes } = await loadRows();
    const revues = lignes
        .map((row) => extractRow(row, entetes))
        .filter(({ issnCle }) => issnCle);

    for (const champ of ['nomOpenalex', 'titre']) {
        for (const revue of revues) {
            const key = normalize(revue[champ]);
            if (key && !index.has(key)) {
                index.set(key, revue.issnCle);
            }
        }
    }
    return index;
}

// On memorise la PROMESSE de l'index, jamais l'index en cours de
// construction. Les scrapers tournent en Promise.all (pageController) : avec
// un cache pose avant l'await de lecture du CSV, tout appelant arrivant
// pendant cette lecture recevait la Map encore vide et voyait donc chacune de
// ses revues comme absente du CSV. Un scraper qui enchaine ses matchIssn sans
// attente reseau entre deux (springer, apa, cup, dm, re) perdait ainsi la
// totalite de ses revues, silencieusement, et ne remontait aucun appel.
// Cacher la promesse fait attendre la meme lecture a tous : le CSV n'est
// toujours lu qu'une fois, mais personne ne lit un index a moitie construit.
function loadIssnIndex() {
    if (!issnIndexPromise) issnIndexPromise = buildIssnIndex();
    return issnIndexPromise;
}

// Retrouve l'ISSN cle d'une revue par correspondance normalisee (minuscules,
// "&" -> "and", ponctuation retiree) sur les colonnes titre / nom_openalex du
// CSV enrichi. Renvoie null si aucune correspondance.
export async function matchIssn(journalName) {
    const index = await loadIssnIndex();
    return index.get(normalize(journalName)) || null;
}

// Renvoie les revues du CSV enrichi dont l'editeur correspond exactement
// (ex. "Elsevier BV"), avec leur nom OpenAlex et leur ISSN cle.
export async function getJournalsByPublisher(publisherName) {
    const journals = [];
    const { entetes, lignes } = await loadRows();
    for (const row of lignes) {
        const { nomOpenalex, editeur, issnCle } = extractRow(row, entetes);
        if (editeur !== publisherName || !issnCle || !nomOpenalex) continue;
        journals.push({ nomOpenalex, issn: issnCle });
    }
    return journals;
}
