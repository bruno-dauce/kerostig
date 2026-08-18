#!/usr/bin/env node

/**
 * kerostig - enrichir le CSV de correspondance avec l'éditeur (OpenAlex)
 *
 * Usage :
 *   node enrich-publishers.mjs
 *
 * Entrée :  kerostigcorrespondanceissn.csv  (même dossier)
 * Sortie :  kerostigcorrespondanceissn-enrichi.csv
 *
 * Le script interroge OpenAlex par ISSN (eISSN puis pISSN en repli)
 * et ajoute deux colonnes : editeur et openalex_id.
 * Pas de clé API nécessaire, OpenAlex est gratuit et ouvert.
 * Rythme poli : ~10 requêtes/seconde, bien sous la limite OpenAlex.
 */

import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INPUT = resolve(__dirname, "kerostig-correspondance-issn.csv");
const OUTPUT = resolve(__dirname, "kerostig-correspondance-issn-enrichi.csv");

// Lire le CSV
const raw = readFileSync(INPUT, "utf-8");
const lines = raw.trim().split("\n");
const header = lines[0];
const rows = lines.slice(1).map((line) => {
  // Parser CSV simple (pas de virgules dans les champs ici)
  const cols = line.split(",");
  return {
    titre: cols[0],
    discipline_code: cols[1],
    discipline: cols[2],
    rang_fnege_2025: cols[3],
    pissn: cols[4],
    eissn: cols[5],
    issn_cle: cols[6],
    slug: cols[7],
  };
});

console.log(`${rows.length} revues a enrichir.\n`);

// Interroger OpenAlex
async function fetchPublisher(issn) {
  const url = `https://api.openalex.org/sources?filter=issn:${issn}&select=id,display_name,host_organization_name&mailto=bruno.dauce@univ-angers.fr`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const data = await resp.json();
    if (data.results && data.results.length > 0) {
      return {
        editeur: data.results[0].host_organization_name || "",
        openalex_id: data.results[0].id || "",
        nom_openalex: data.results[0].display_name || "",
      };
    }
  } catch {
    // silencieux
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const enriched = [];
let found = 0;
let notFound = 0;

for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  let result = null;

  // Essayer eISSN d'abord
  if (r.eissn) {
    result = await fetchPublisher(r.eissn);
  }
  // Repli sur pISSN
  if (!result && r.pissn) {
    result = await fetchPublisher(r.pissn);
  }

  if (result) {
    enriched.push({ ...r, ...result });
    found++;
  } else {
    enriched.push({ ...r, editeur: "", openalex_id: "", nom_openalex: "" });
    notFound++;
  }

  if ((i + 1) % 25 === 0 || i === rows.length - 1) {
    console.log(
      `  ${i + 1}/${rows.length}  (${found} trouvees, ${notFound} manquantes)`
    );
  }

  await sleep(100); // 10 req/s, poli
}

// Écrire le CSV enrichi
function escapeCsv(val) {
  const s = (val || "").toString();
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

const outHeader =
  "titre,discipline_code,discipline,rang_fnege_2025,pissn,eissn,issn_cle,slug,editeur,openalex_id,nom_openalex";
const outLines = enriched.map((r) =>
  [
    r.titre,
    r.discipline_code,
    r.discipline,
    r.rang_fnege_2025,
    r.pissn,
    r.eissn,
    r.issn_cle,
    r.slug,
    r.editeur,
    r.openalex_id,
    r.nom_openalex,
  ]
    .map(escapeCsv)
    .join(",")
);

writeFileSync(OUTPUT, outHeader + "\n" + outLines.join("\n") + "\n", "utf-8");

console.log(`\nTermine. Fichier enrichi : ${OUTPUT}`);
console.log(`  ${found} revues avec editeur, ${notFound} sans.`);

// Stats rapides
const pubs = {};
for (const r of enriched) {
  if (r.editeur) {
    pubs[r.editeur] = (pubs[r.editeur] || 0) + 1;
  }
}
const sorted = Object.entries(pubs).sort((a, b) => b[1] - a[1]);
console.log(`\nTop 15 editeurs :`);
for (const [pub, count] of sorted.slice(0, 15)) {
  console.log(`  ${String(count).padStart(4)}  ${pub}`);
}
