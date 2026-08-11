import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CSV_PATH = path.join(__dirname, '..', 'enrichissement', 'hubecall-correspondance-issn-enrichi.csv');

let issnByNormalizedName = null;

function normalize(name) {
    return (name || '')
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

async function loadIssnIndex() {
    if (issnByNormalizedName) return issnByNormalizedName;

    const text = await fs.readFile(CSV_PATH, 'utf-8');
    const rows = parseCsv(text);
    const header = rows[0];
    const col = Object.fromEntries(header.map((h, i) => [h, i]));

    issnByNormalizedName = new Map();
    for (const row of rows.slice(1)) {
        const issn = row[col.issn_cle];
        if (!issn) continue;
        for (const rawName of [row[col.nom_openalex], row[col.titre]]) {
            const key = normalize(rawName);
            if (key && !issnByNormalizedName.has(key)) {
                issnByNormalizedName.set(key, issn);
            }
        }
    }
    return issnByNormalizedName;
}

// Retrouve l'ISSN cle d'une revue par correspondance normalisee (minuscules,
// "&" -> "and", ponctuation retiree) sur les colonnes titre / nom_openalex du
// CSV enrichi. Renvoie null si aucune correspondance.
export async function matchIssn(journalName) {
    const index = await loadIssnIndex();
    return index.get(normalize(journalName)) || null;
}
