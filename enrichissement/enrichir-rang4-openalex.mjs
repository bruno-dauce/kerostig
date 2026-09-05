#!/usr/bin/env node
// Enrichit rang4_brut.csv via OpenAlex : identifiant, nom propre, editeur.
//
// Pour chaque revue on interroge /sources?filter=issn:... avec l'eISSN, puis le
// pISSN en secours. Une revue absente d'OpenAlex ressort avec les trois colonnes
// vides : le script ne s'arrete jamais sur un echec, il le compte et le liste.
//
// Usage : node enrichissement/enrichir-rang4-openalex.mjs
// Variable d'environnement facultative : OPENALEX_MAILTO (pool poli d'OpenAlex).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ICI = path.dirname(fileURLToPath(import.meta.url));
const ENTREE = path.join(ICI, "rang4_brut.csv");
const SORTIE = path.join(ICI, "rang4_enrichi_openalex.csv");
const RAPPORT = path.join(ICI, "rang4-rapport-openalex.md");

const COLONNES = [
  "titre", "discipline_code", "discipline", "rang_fnege_2025",
  "pissn", "eissn", "issn_cle", "slug", "editeur", "openalex_id", "nom_openalex",
];

const DELAI_MS = 100;
const CHAMPS = "id,display_name,issn,issn_l,host_organization_name";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// -- CSV (RFC 4180) -----------------------------------------------------------

function lireCsv(chemin) {
  const texte = fs.readFileSync(chemin, "utf8").replace(/^﻿/, "");
  const lignes = [];
  let champ = "";
  let ligne = [];
  let dansGuillemets = false;

  for (let i = 0; i < texte.length; i++) {
    const c = texte[i];
    if (dansGuillemets) {
      if (c === '"' && texte[i + 1] === '"') { champ += '"'; i++; }
      else if (c === '"') dansGuillemets = false;
      else champ += c;
      continue;
    }
    if (c === '"') dansGuillemets = true;
    else if (c === ",") { ligne.push(champ); champ = ""; }
    else if (c === "\n") { ligne.push(champ); lignes.push(ligne); ligne = []; champ = ""; }
    else if (c !== "\r") champ += c;
  }
  if (champ !== "" || ligne.length) { ligne.push(champ); lignes.push(ligne); }

  const entetes = lignes.shift();
  return lignes.map((l) => Object.fromEntries(entetes.map((h, i) => [h, l[i] ?? ""])));
}

function echapper(valeur) {
  const v = String(valeur ?? "");
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function ecrireCsv(chemin, lignes) {
  const corps = lignes.map((r) => COLONNES.map((c) => echapper(r[c])).join(","));
  fs.writeFileSync(chemin, [COLONNES.join(","), ...corps].join("\n") + "\n", "utf8");
}

// -- OpenAlex -----------------------------------------------------------------

let MAILTO = "";

// Renvoie la source OpenAlex, null si l'ISSN n'a pas de correspondance,
// et leve seulement si le reseau ou l'API refuse durablement.
async function chercherSource(issn) {
  const params = new URLSearchParams({ filter: `issn:${issn}`, select: CHAMPS, "per-page": "1" });
  if (MAILTO) params.set("mailto", MAILTO);
  const url = `https://api.openalex.org/sources?${params}`;

  for (let essai = 1; essai <= 3; essai++) {
    let reponse;
    try {
      reponse = await fetch(url, {
        headers: { "User-Agent": `kerostig/1.0 (${MAILTO || "https://kerostig.fr"})` },
      });
    } catch (err) {
      if (essai === 3) throw err;
      await sleep(500 * essai);
      continue;
    }
    if (reponse.status === 404) return null;
    if (reponse.status === 429 || reponse.status >= 500) {
      if (essai === 3) throw new Error(`HTTP ${reponse.status}`);
      await sleep(1000 * essai);
      continue;
    }
    if (!reponse.ok) throw new Error(`HTTP ${reponse.status}`);
    const data = await reponse.json();
    return data?.results?.[0] ?? null;
  }
  return null;
}

// -- Programme ----------------------------------------------------------------

function chargerEnv() {
  for (const nom of [".env", "enrichissement/.env"]) {
    const chemin = path.join(ICI, "..", nom);
    if (!fs.existsSync(chemin)) continue;
    for (const ligne of fs.readFileSync(chemin, "utf8").split(/\r?\n/)) {
      const m = ligne.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

async function main() {
  chargerEnv();
  MAILTO = process.env.OPENALEX_MAILTO || "";

  if (!fs.existsSync(ENTREE)) {
    console.error(`Fichier introuvable : ${ENTREE}\nLancez d'abord : python enrichissement/extraire-rang4.py`);
    process.exit(1);
  }

  const lignes = lireCsv(ENTREE);
  console.log(`${lignes.length} revues a enrichir.`);
  if (!MAILTO) console.log("Astuce : renseignez OPENALEX_MAILTO pour le pool poli d'OpenAlex.");

  const trouvees = [];
  const manquantes = [];
  const enErreur = [];

  for (const [i, row] of lignes.entries()) {
    // eISSN d'abord, pISSN en secours ; on ignore un pISSN identique a l'eISSN.
    const candidats = [row.eissn, row.pissn].filter((v, j, a) => v && a.indexOf(v) === j);
    let source = null;
    let issnUtilise = null;

    for (const issn of candidats) {
      try {
        source = await chercherSource(issn);
      } catch (err) {
        enErreur.push({ ...row, motif: `${issn} : ${err.message}` });
        source = null;
      }
      await sleep(DELAI_MS);
      if (source) { issnUtilise = issn; break; }
    }

    if (source) {
      row.openalex_id = source.id || "";
      row.nom_openalex = source.display_name || "";
      row.editeur = source.host_organization_name || "";
      trouvees.push({ ...row, issnUtilise });
    } else {
      row.openalex_id = "";
      row.nom_openalex = "";
      row.editeur = "";
      manquantes.push(row);
    }

    if ((i + 1) % 25 === 0 || i + 1 === lignes.length) {
      process.stdout.write(`\r  ${i + 1}/${lignes.length} — trouvees ${trouvees.length}, absentes ${manquantes.length}   `);
    }
  }
  process.stdout.write("\n");

  ecrireCsv(SORTIE, lignes);

  const sansEditeur = trouvees.filter((r) => !r.editeur);
  const lignesRapport = [
    "# Enrichissement OpenAlex des revues de rang 4",
    "",
    `Genere le ${new Date().toISOString().slice(0, 10)} a partir de \`rang4_brut.csv\`.`,
    "",
    "| Resultat | Revues |",
    "| --- | ---: |",
    `| Trouvees dans OpenAlex | ${trouvees.length} |`,
    `| Absentes d'OpenAlex | ${manquantes.length} |`,
    `| Total | ${lignes.length} |`,
    "",
    `Parmi les revues trouvees, ${sansEditeur.length} n'ont pas d'editeur renseigne dans OpenAlex.`,
    "",
    "## Revues absentes d'OpenAlex",
    "",
    "A verifier a la main : ISSN errone dans le classement FNEGE, revue trop recente,",
    "ou revue reellement absente d'OpenAlex.",
    "",
  ];
  if (manquantes.length) {
    lignesRapport.push("| Titre FNEGE | pISSN | eISSN | Discipline |", "| --- | --- | --- | --- |");
    for (const r of manquantes) {
      lignesRapport.push(`| ${r.titre} | ${r.pissn || "—"} | ${r.eissn || "—"} | ${r.discipline} |`);
    }
  } else {
    lignesRapport.push("_Aucune._");
  }
  if (enErreur.length) {
    lignesRapport.push("", "## Requetes en erreur", "");
    for (const r of enErreur) lignesRapport.push(`- ${r.titre} — ${r.motif}`);
  }
  fs.writeFileSync(RAPPORT, lignesRapport.join("\n") + "\n", "utf8");

  console.log("");
  console.log(`Trouvees dans OpenAlex : ${trouvees.length}`);
  console.log(`Absentes d'OpenAlex    : ${manquantes.length}`);
  if (enErreur.length) console.log(`Requetes en erreur     : ${enErreur.length}`);
  console.log(`Sortie                 : ${SORTIE}`);
  console.log(`Rapport                : ${RAPPORT}`);

  if (manquantes.length) {
    console.log("\nRevues a verifier a la main :");
    for (const r of manquantes) {
      console.log(`  ${(r.pissn || "—").padEnd(9)} ${(r.eissn || "—").padEnd(9)} ${r.titre}`);
    }
  }
}

main().catch((err) => {
  console.error("\nEchec :", err);
  process.exit(1);
});
