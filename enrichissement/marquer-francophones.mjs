#!/usr/bin/env node
// Ajoute un champ "francophone" a chaque entree de www/_data/journals.json,
// derive du marqueur Fr du classement FNEGE 2025.
//
// Le xlsx source n'est pas versionne : c'est une passe manuelle, comme celle
// de Mir@bel, pas une etape de CI. Voir NOTES.md pour l'emplacement attendu.
//
// Passe ADDITIVE : toutes les autres cles sont recopiees telles quelles, dans
// leur ordre d'origine. Attention, une regeneration complete par
// enrichir-revues.mjs effacerait ce champ comme elle effacerait mirabel :
// construireRevue reconstruit chaque entree de zero. Ordre de rejeu documente
// dans NOTES.md.
//
// Usage :
//   node enrichissement/marquer-francophones.mjs
//   node enrichissement/marquer-francophones.mjs --dry-run
//   node enrichissement/marquer-francophones.mjs --xlsx chemin/vers/fichier.xlsx

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..');
const JOURNALS = join(RACINE, 'www', '_data', 'journals.json');
const XLSX_DEFAUT = join(RACINE, '_tmp', 'Classement-FNEGE-2025.xlsx');

// Revues francophones que le classement FNEGE ne marque PAS d'un Fr.
// Le marqueur du xlsx est incomplet : ces quatre titres sont edites et
// rediges en francais, verification faite a la main le 2026-09-06. On ne
// corrige pas la source, on documente l'ecart ici.
// A l'inverse, deux revues marquees Fr manquaient a l'ancienne liste tenue
// dans eleventy.config.mjs (Revue canadienne des sciences de l'administration,
// Logistique et Management) : elles entrent d'elles-memes, aucune exception
// n'est necessaire pour elles.
const EXCEPTIONS_FRANCOPHONES = new Map([
    ['2101-0145', 'Finance'],
    ['1703-8138', 'Relations industrielles'],
    ['2271-2186', 'Revue de gestion des ressources humaines'],
    ['1630-7542', "Revue de l'Entrepreneuriat"],
]);

// Le classeur est lu par openpyxl : le projet n'a pas de dependance Node
// capable d'ouvrir un xlsx, et cette passe est manuelle.
//
// Ce fragment Python ne contient volontairement AUCUN antislash : passe dans
// un litteral de gabarit JS, "\s" y perdrait son antislash et la regex
// deviendrait "s". Il se contente donc de sortir les cellules brutes, toute
// la normalisation se faisant cote JS ci-dessous.
const SCRIPT_PYTHON = [
    'import openpyxl, json, sys',
    'ws = openpyxl.load_workbook(sys.argv[1], data_only=True, read_only=True).worksheets[0]',
    'out = []',
    'for r in ws.iter_rows(min_row=2, values_only=True):',
    '    if not r[0] or not r[7]: continue',
    '    out.append([str(r[0]), str(r[6]).strip(), r[2], r[3]])',
    'sys.stdout.write(json.dumps(out, ensure_ascii=False))',
].join('\n');

// Meme nettoyage que le reste du pipeline : espaces fines invisibles, espaces
// au milieu du numero, et ISSN convertis en nombres par Excel (le zero de tete
// saute, d'ou le zfill).
function normaliserIssn(valeur) {
    if (valeur === null || valeur === undefined) return null;
    let texte = String(valeur);
    if (typeof valeur === 'number') {
        const chiffres = String(Math.trunc(valeur)).padStart(8, '0');
        texte = `${chiffres.slice(0, 4)}-${chiffres.slice(4)}`;
    }
    texte = texte.replace(/[​ \s]/g, '').toUpperCase();
    return /^\d{4}-\d{3}[\dX]$/.test(texte) ? texte : null;
}

function lireMarqueursFr(cheminXlsx) {
    const sortie = execFileSync('python', ['-c', SCRIPT_PYTHON, cheminXlsx], {
        encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024,
    });
    return JSON.parse(sortie).map(([titre, rang, pissn, eissn]) => ({
        titre,
        rang,
        // eISSN d'abord, puis pISSN : regle de jointure du projet.
        issns: [normaliserIssn(eissn), normaliserIssn(pissn)].filter(Boolean),
    }));
}

function main() {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    const iXlsx = args.indexOf('--xlsx');
    const cheminXlsx = iXlsx !== -1 ? args[iXlsx + 1] : XLSX_DEFAUT;

    if (!existsSync(cheminXlsx)) {
        console.error(`Classeur introuvable : ${cheminXlsx}`);
        console.error("Ce fichier n'est pas versionne. Voir NOTES.md, section « Rejouer marquer-francophones.mjs ».");
        process.exit(1);
    }

    const journaux = JSON.parse(readFileSync(JOURNALS, 'utf-8'));
    const marques = lireMarqueursFr(cheminXlsx);

    const francophones = new Set();
    const nonJointes = [];
    for (const { titre, issns } of marques) {
        const trouve = issns.find((i) => journaux[i]);
        if (trouve) francophones.add(trouve);
        else nonJointes.push({ titre, issns });
    }
    const depuisXlsx = francophones.size;

    for (const [issn, nom] of EXCEPTIONS_FRANCOPHONES) {
        if (!journaux[issn]) {
            console.warn(`[francophones] exception ${issn} (${nom}) absente de journals.json, ignoree`);
            continue;
        }
        francophones.add(issn);
    }

    const sortie = {};
    for (const [cle, revue] of Object.entries(journaux)) {
        sortie[cle] = { ...revue, francophone: francophones.has(cle) };
    }

    if (!dryRun) writeFileSync(JOURNALS, JSON.stringify(sortie, null, 2), 'utf-8');

    const parRang = {};
    for (const issn of francophones) {
        const r = journaux[issn].rang_fnege_2025;
        parRang[r] = (parRang[r] || 0) + 1;
    }

    console.log(`Revues                : ${Object.keys(journaux).length}`);
    console.log(`Marquees Fr au xlsx   : ${depuisXlsx}`);
    console.log(`Exceptions ajoutees   : ${francophones.size - depuisXlsx}`);
    console.log(`Francophones au total : ${francophones.size}`);
    console.log('\nPar rang :');
    for (const r of ['1*', '1', '2', '3', '4']) {
        if (parRang[r]) console.log(`  rang ${r.padEnd(2)} : ${parRang[r]}`);
    }
    for (const { titre, issns } of nonJointes) {
        console.warn(`  NON JOINTE : ${titre} (${issns.join(', ') || 'aucun ISSN exploitable'})`);
    }
    if (dryRun) console.log('\n--dry-run : aucun fichier ecrit.');
    else console.log(`\nEcrit : ${JOURNALS}`);
}

main();
