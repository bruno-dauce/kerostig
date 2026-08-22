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
        const text = name.rendered ?? name.raw ?? name.value ?? name.text ?? null;
        if (!loggedUnexpectedNameShape) {
            loggedUnexpectedNameShape = true;
            console.warn(`[issnMatcher] Nom de revue recu sous forme d'objet, cles : ${Object.keys(name).join(', ')} -> valeur utilisee : "${text ?? ''}"`);
        }
        if (typeof text === 'string') return text;
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

// Quelques lignes source ont un titre contenant une virgule non echappee
// (ex. "ACCOUNTING, ORGANIZATION AND SOCIETY") combine a un champ "slug"
// carrement absent (pas juste vide) dans le fichier d'origine. Les deux
// erreurs se compensent en nombre de colonnes mais decalent silencieusement
// tout ce qui suit le titre -- issn_cle se retrouve a un index different
// selon les lignes. editeur/openalex_id/nom_openalex, eux, sont toujours
// fiables : ce sont les 3 derniers champs, ajoutes proprement (avec
// echappement correct) par enrich-publishers.mjs, quoi qu'il arrive en
// amont. On les lit donc depuis la fin de la ligne plutot que par l'index
// fixe de l'entete, et on retrouve issn_cle en cherchant, en remontant
// depuis juste avant editeur, la premiere valeur qui a la forme d'un ISSN
// (issn_cle est toujours le plus proche de slug/editeur parmi pissn/eissn/
// issn_cle, corrompu ou non).
function extractRow(row) {
    const nomOpenalex = row[row.length - 1] ?? '';
    const editeur = row[row.length - 3] ?? '';
    let issnCle = null;
    for (let i = row.length - 4; i >= 0; i--) {
        if (looksLikeIssn(row[i])) { issnCle = row[i].trim(); break; }
    }
    return { titre: row[0] ?? '', nomOpenalex, editeur, issnCle };
}

async function loadRows() {
    const text = await fs.readFile(CSV_PATH, 'utf-8');
    return parseCsv(text).slice(1);
}

async function buildIssnIndex() {
    const index = new Map();
    for (const row of await loadRows()) {
        const { titre, nomOpenalex, issnCle } = extractRow(row);
        if (!issnCle) continue;
        for (const rawName of [nomOpenalex, titre]) {
            const key = normalize(rawName);
            if (key && !index.has(key)) {
                index.set(key, issnCle);
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
    for (const row of await loadRows()) {
        const { nomOpenalex, editeur, issnCle } = extractRow(row);
        if (editeur.trim() !== publisherName || !issnCle || !nomOpenalex) continue;
        journals.push({ nomOpenalex, issn: issnCle });
    }
    return journals;
}
