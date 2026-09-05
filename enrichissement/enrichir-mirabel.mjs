#!/usr/bin/env node
// Ajoute un bloc "mirabel" a chaque entree de www/_data/journals.json.
//
// Mir@bel (reseau-mirabel.info) recense les revues francophones bien mieux
// qu'OpenAlex ou Open Policy Finder : c'est la piste retenue pour combler les
// trous constates sur les revues de gestion francophones, surtout au rang 4.
//
// L'API est publique, sans cle. On interroge /api/titres?issn=..., en essayant
// issn_cle puis eISSN puis pISSN, conformement a la regle de jointure du projet.
//
// Le script n'ecrit que la cle "mirabel" : toutes les autres sont recopiees
// telles quelles, dans leur ordre d'origine.
//
// Usage :
//   node enrichissement/enrichir-mirabel.mjs
//   node enrichissement/enrichir-mirabel.mjs --no-cache   (tout reinterroger)
//   node enrichissement/enrichir-mirabel.mjs --limit 20   (essai rapide)
//   node enrichissement/enrichir-mirabel.mjs --dry-run    (ne rien ecrire)

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DOSSIER_SCRIPT = dirname(fileURLToPath(import.meta.url));
const RACINE = join(DOSSIER_SCRIPT, "..");
const JOURNALS = join(RACINE, "www", "_data", "journals.json");
const RAPPORT = join(RACINE, "_tmp", "mirabel-rapport.md");
const DOSSIER_CACHE = join(DOSSIER_SCRIPT, ".cache-enrichissement");

const ENDPOINT = "https://reseau-mirabel.info/api/titres";
const DELAI_MS = 200;
const ATTENTE_RETRY = 2000;
const ORDRE_RANGS = { "1*": 0, "1": 1, "2": 2, "3": 3, "4": 4 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Cache disque, meme convention que doaj_ et sherpa_ ---------------------

const cheminCache = (issn) => join(DOSSIER_CACHE, `mirabel_${issn}.json`);

function lireCache(issn) {
  const p = cheminCache(issn);
  if (!existsSync(p)) return undefined;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return undefined; }
}

function ecrireCache(issn, valeur) {
  if (!existsSync(DOSSIER_CACHE)) mkdirSync(DOSSIER_CACHE, { recursive: true });
  writeFileSync(cheminCache(issn), JSON.stringify(valeur), "utf8");
}

// --- Requete ---------------------------------------------------------------

const erreurs = [];

// Une seule reprise apres 2 s. Au-dela, on laisse la revue non resolue plutot
// que de mettre un resultat vide en cache, pour la rejouer au passage suivant.
async function interrogerIssn(issn) {
  for (let tentative = 0; tentative < 2; tentative++) {
    try {
      const res = await fetch(`${ENDPOINT}?issn=${encodeURIComponent(issn)}`, {
        headers: { Accept: "application/json", "User-Agent": "kerostig/1.0 (https://kerostig.fr)" },
        signal: AbortSignal.timeout(30000),
      });
      if (res.status === 404) return { ok: true, titres: [] };
      if (res.ok) {
        const data = await res.json();
        return { ok: true, titres: Array.isArray(data) ? data : [] };
      }
      if (tentative === 0) { await sleep(ATTENTE_RETRY); continue; }
      return { ok: false, status: res.status };
    } catch (e) {
      if (tentative === 0) { await sleep(ATTENTE_RETRY); continue; }
      return { ok: false, status: 0, erreur: String(e).slice(0, 120) };
    }
  }
}

async function chercher(issns, { cache }) {
  for (const issn of issns) {
    let titres = cache ? lireCache(issn) : undefined;
    if (titres === undefined) {
      const r = await interrogerIssn(issn);
      if (!r.ok) {
        erreurs.push(`${issn} : HTTP ${r.status || "reseau"} ${r.erreur || ""}`.trim());
        await sleep(DELAI_MS);
        continue;
      }
      titres = r.titres;
      ecrireCache(issn, titres);
      await sleep(DELAI_MS);
    }
    if (titres && titres.length) return { issn, titres };
  }
  return null;
}

// --- Mise en forme ---------------------------------------------------------

// L'API ne renvoie aucune politique de depot : le schema Revue ne porte que
// id, dermodif, derverif et titres, et aucun champ de l'objet titre n'evoque
// une politique. Le bloc se limite donc a l'identite de la revue chez Mir@bel.
//
// Attention a la distinction des deux identifiants : `id` designe le TITRE,
// `revueid` la REVUE. C'est revueid qui adresse /revue/{id}, et c'est lui que
// porte url_revue_mirabel. Retenir `id` produirait une URL fausse.
function faconner(resultat) {
  if (!resultat) return { trouve: false };

  // Un ISSN peut porter plusieurs titres (changements de nom). On prend le
  // titre courant s'il en existe un, sinon le premier renvoye.
  const courant = resultat.titres.find((t) => !t.obsoletepar) || resultat.titres[0];
  const revueId = courant.revueid ?? null;
  const url = courant.url_revue_mirabel
    || (revueId != null ? `https://reseau-mirabel.info/revue/${revueId}` : null);

  return { trouve: true, url, id: revueId };
}

// --- Programme -------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const cache = !args.includes("--no-cache");
  const dryRun = args.includes("--dry-run");
  const iLimit = args.indexOf("--limit");
  const limite = iLimit !== -1 ? Number(args[iLimit + 1]) : Infinity;

  if (!existsSync(JOURNALS)) {
    console.error(`Fichier introuvable : ${JOURNALS}`);
    process.exit(1);
  }

  const journaux = JSON.parse(readFileSync(JOURNALS, "utf8"));
  const cles = Object.keys(journaux);
  const aTraiter = cles.slice(0, limite);
  console.log(`${cles.length} revues, ${aTraiter.length} a interroger. Cache ${cache ? "actif" : "ignore"}, ${DELAI_MS} ms entre requetes.`);

  const sortie = {};
  const absentes = [];
  const plusieursTitres = [];
  let trouvees = 0;

  for (const [i, cle] of cles.entries()) {
    const revue = journaux[cle];

    let bloc = { trouve: false };
    if (i < aTraiter.length) {
      const issns = [revue.issn_cle, revue.eissn, revue.pissn].filter((v, j, a) => v && a.indexOf(v) === j);
      const resultat = await chercher(issns, { cache });
      bloc = faconner(resultat);
      if (resultat && resultat.titres.length > 1) plusieursTitres.push(revue.titre_fnege);
      if (bloc.trouve) trouvees++; else absentes.push(revue);
    }

    // Recopie a l'identique, ordre des cles compris ; "mirabel" vient en dernier.
    sortie[cle] = { ...revue, mirabel: bloc };

    if ((i + 1) % 20 === 0 || i + 1 === cles.length) {
      process.stdout.write(`\r  ${i + 1}/${cles.length} — trouvees ${trouvees}, absentes ${absentes.length}, erreurs ${erreurs.length}   `);
    }
  }
  process.stdout.write("\n");

  if (!dryRun) writeFileSync(JOURNALS, JSON.stringify(sortie, null, 2), "utf8");

  // -- Rapport
  const parRang = {};
  for (const r of absentes) {
    (parRang[r.rang_fnege_2025] ||= []).push(r);
  }
  const rangsTries = Object.keys(parRang).sort((a, b) => ORDRE_RANGS[a] - ORDRE_RANGS[b]);

  // Denominateur sur les seules revues interrogees : sous --limit, compter les
  // autres les ferait passer pour trouvees.
  const totalParRang = {};
  for (const cle of aTraiter) {
    const r = journaux[cle].rang_fnege_2025;
    totalParRang[r] = (totalParRang[r] || 0) + 1;
  }

  const lignes = [
    "# Enrichissement Mir@bel",
    "",
    `Genere le ${new Date().toISOString().slice(0, 10)} sur ${aTraiter.length} revues.`,
    "",
    `Trouvees : ${trouvees}. Absentes : ${absentes.length}.`,
    "",
    "## Couverture par rang",
    "",
    "| Rang | Revues | Dans Mir@bel | Absentes |",
    "| --- | ---: | ---: | ---: |",
    ...Object.keys(totalParRang).sort((a, b) => ORDRE_RANGS[a] - ORDRE_RANGS[b]).map((r) => {
      const abs = (parRang[r] || []).length;
      return `| ${r} | ${totalParRang[r]} | ${totalParRang[r] - abs} | ${abs} |`;
    }),
    "",
    "## Revues absentes de Mir@bel",
    "",
  ];
  for (const r of rangsTries) {
    lignes.push(`### Rang ${r} (${parRang[r].length})`, "", "| Titre | issn_cle | Discipline |", "| --- | --- | --- |");
    for (const revue of parRang[r]) {
      lignes.push(`| ${revue.titre_fnege} | ${revue.issn_cle} | ${revue.discipline} |`);
    }
    lignes.push("");
  }
  if (plusieursTitres.length) {
    lignes.push(`## ISSN portant plusieurs titres (${plusieursTitres.length})`, "",
      "Changements de nom : le titre courant est retenu, le titre obsolete ignore.", "",
      ...plusieursTitres.map((t) => `- ${t}`), "");
  }
  if (erreurs.length) {
    lignes.push(`## Requetes en erreur (${erreurs.length})`, "", ...erreurs.map((e) => `- ${e}`), "");
  }
  if (!dryRun) {
    if (!existsSync(join(RACINE, "_tmp"))) mkdirSync(join(RACINE, "_tmp"), { recursive: true });
    writeFileSync(RAPPORT, lignes.join("\n") + "\n", "utf8");
  }

  console.log("");
  console.log(`Trouvees dans Mir@bel : ${trouvees}`);
  console.log(`Absentes              : ${absentes.length}`);
  if (erreurs.length) console.log(`Requetes en erreur    : ${erreurs.length}`);
  console.log("");
  console.log("Couverture par rang :");
  for (const r of Object.keys(totalParRang).sort((a, b) => ORDRE_RANGS[a] - ORDRE_RANGS[b])) {
    const abs = (parRang[r] || []).length;
    console.log(`  rang ${r.padEnd(2)} : ${String(totalParRang[r] - abs).padStart(3)}/${String(totalParRang[r]).padStart(3)} dans Mir@bel, ${abs} absentes`);
  }
  if (dryRun) console.log("\n--dry-run : aucun fichier ecrit.");
  else {
    console.log(`\nEcrit  : ${JOURNALS}`);
    console.log(`Rapport: ${RAPPORT}`);
  }
}

main().catch((err) => {
  console.error("\nEchec :", err);
  process.exit(1);
});
