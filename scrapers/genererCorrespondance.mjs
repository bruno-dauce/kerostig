// Genere la table de correspondance ISSN lue par issnMatcher, a partir de
// www/_data/journals.json.
//
// Le CSV etait auparavant versionne. Il ne l'est plus (commit 4a8bbcb97) :
// il portait le classement FNEGE integral, que le projet ne republie pas.
// Sans lui, le runner CI n'avait plus aucune table et les 20 scrapers qui
// appellent matchIssn levaient ENOENT. On le derive donc de journals.json,
// lui versionne, au demarrage de chaque passage.
//
// Les 11 colonnes reprennent celles de l'ancien fichier, ni plus ni moins :
// les colonnes DOAJ et Sherpa du fichier d'enrichissement n'ont aucun
// consommateur cote scraping.
//
// Usage : node scrapers/genererCorrespondance.mjs
// Appele automatiquement par scraper.mjs avant toute collecte.

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JOURNALS = path.join(__dirname, '..', 'www', '_data', 'journals.json');
const SORTIE = path.join(__dirname, '..', 'enrichissement', 'kerostig-correspondance-issn-enrichi.csv');

export const COLONNES = [
    'titre', 'discipline_code', 'discipline', 'rang_fnege_2025',
    'pissn', 'eissn', 'issn_cle', 'slug', 'editeur', 'openalex_id', 'nom_openalex',
];

// RFC 4180. L'ancien fichier etait ecrit sans echappement : un titre a virgule
// y decalait toutes les colonnes suivantes, et extractRow devait compter les
// champs depuis la fin pour s'en sortir. On n'y revient pas.
function echapper(valeur) {
    const s = valeur == null ? '' : String(valeur);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Fonction pure, exportee pour test.
export function ligneDepuisRevue(issnCle, revue) {
    return {
        titre: revue.titre_fnege ?? '',
        discipline_code: revue.discipline_code ?? '',
        discipline: revue.discipline ?? '',
        rang_fnege_2025: revue.rang_fnege_2025 ?? '',
        pissn: revue.pissn ?? '',
        eissn: revue.eissn ?? '',
        issn_cle: revue.issn_cle ?? issnCle,
        slug: revue.slug ?? '',
        editeur: revue.editeur ?? '',
        openalex_id: revue.metriques?.openalex_id ?? '',
        // Le nom d'affichage OpenAlex : c'est sur lui que tombent la plupart
        // des titres lus sur les sites d'editeurs, le titre FNEGE etant en
        // capitales et parfois suivi d'une mention « (FORMERLY: ...) ».
        nom_openalex: revue.titre ?? '',
    };
}

// Fonction pure, exportee pour test.
export function construireCsv(journaux) {
    const lignes = [COLONNES.join(',')];
    for (const [issnCle, revue] of Object.entries(journaux)) {
        const ligne = ligneDepuisRevue(issnCle, revue);
        lignes.push(COLONNES.map((c) => echapper(ligne[c])).join(','));
    }
    return lignes.join('\n') + '\n';
}

export async function genererCorrespondance({ silencieux = false } = {}) {
    const journaux = JSON.parse(await fs.readFile(JOURNALS, 'utf-8'));
    const nb = Object.keys(journaux).length;
    if (nb === 0) {
        throw new Error(`${JOURNALS} ne contient aucune revue : generation interrompue.`);
    }
    await fs.mkdir(path.dirname(SORTIE), { recursive: true });
    await fs.writeFile(SORTIE, construireCsv(journaux), 'utf-8');
    if (!silencieux) {
        console.log(`[correspondance] ${nb} revues ecrites dans ${path.relative(process.cwd(), SORTIE)}`);
    }
    return nb;
}

// Execution directe : node scrapers/genererCorrespondance.mjs
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('genererCorrespondance.mjs')) {
    genererCorrespondance().catch((err) => {
        console.error('[correspondance] echec :', err.message);
        process.exitCode = 1;
    });
}
