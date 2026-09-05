#!/usr/bin/env node
// Enrichit _tmp/journals_rang4.csv avec DOAJ et Open Policy Finder (ex-Sherpa
// Romeo) pour les 884 revues, et ecrit _tmp/journals_rang4_enrichi.csv.
//
// DOAJ    : presence, montant et devise d'APC, licence, type de relecture.
// Sherpa  : version deposable, embargo en mois, depot en archive ouverte (HAL).
//
// La jointure essaie issn_cle, puis eISSN, puis pISSN, conformement a la regle
// du projet. Une revue absente d'une source ressort avec les champs de cette
// source vides, et une colonne *_trouve a "non" : l'absence est explicite,
// jamais comblee par une valeur inventee.
//
// Usage :
//   node enrichissement/enrichir-oa-rang4.mjs
//   node enrichissement/enrichir-oa-rang4.mjs --no-cache   (tout reinterroger)
//   node enrichissement/enrichir-oa-rang4.mjs --limit 20   (essai rapide)
//
// Cle API : SHERPA_API_KEY dans le .env a la racine.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DOSSIER_SCRIPT = dirname(fileURLToPath(import.meta.url));
const RACINE = join(DOSSIER_SCRIPT, "..");
const ENTREE = join(RACINE, "_tmp", "journals_rang4.csv");
const SORTIE = join(RACINE, "_tmp", "journals_rang4_enrichi.csv");
const RAPPORT = join(RACINE, "_tmp", "journals_rang4_enrichi-rapport.md");
const DOSSIER_CACHE = join(DOSSIER_SCRIPT, ".cache-enrichissement");

// L'ancien point d'entree v2.sherpa.ac.uk est ferme et repond 403 : Jisc a
// migre l'API vers openpolicyfinder, qui attend la cle dans l'en-tete x-api-key
// et non plus dans l'URL. La forme des objets publication n'a pas bouge.
const DOAJ_ENDPOINT = "https://doaj.org/api/search/journals/issn:";
const SHERPA_ENDPOINT = "https://api.openpolicyfinder.jisc.ac.uk/retrieve";

const DELAI_MS = 200;      // entre deux requetes, pour chaque API
const ATTENTE_RETRY = 2000; // une seule reprise, apres 2 s

const COLONNES_SOURCE = [
  "titre", "discipline_code", "discipline", "rang_fnege_2025",
  "pissn", "eissn", "issn_cle", "slug", "editeur", "openalex_id", "nom_openalex",
];
const COLONNES_AJOUTEES = [
  "doaj_trouve", "doaj_acces_ouvert", "doaj_apc_montant", "doaj_apc_devise",
  "doaj_licence", "doaj_type_relecture",
  "sherpa_trouve", "sherpa_version_deposable", "sherpa_embargo_mois",
  "sherpa_depot_hal",
];
const COLONNES = [...COLONNES_SOURCE, ...COLONNES_AJOUTEES];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- CSV (RFC 4180) ---------------------------------------------------------

function lireCsv(chemin) {
  const texte = readFileSync(chemin, "utf8").replace(/^﻿/, "");
  const lignes = [];
  let champ = "", ligne = [], dansGuillemets = false;
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
  return { entetes, lignes: lignes.map((l) => Object.fromEntries(entetes.map((h, i) => [h, l[i] ?? ""]))) };
}

const echapper = (v) => {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function ecrireCsv(chemin, lignes) {
  const corps = lignes.map((r) => COLONNES.map((c) => echapper(r[c])).join(","));
  writeFileSync(chemin, [COLONNES.join(","), ...corps].join("\n") + "\n", "utf8");
}

// --- Cache disque -----------------------------------------------------------

const cheminCache = (source, issn) => join(DOSSIER_CACHE, `${source}_${issn}.json`);

function lireCache(source, issn) {
  const p = cheminCache(source, issn);
  if (!existsSync(p)) return undefined;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return undefined; }
}

function ecrireCache(source, issn, valeur) {
  if (!existsSync(DOSSIER_CACHE)) mkdirSync(DOSSIER_CACHE, { recursive: true });
  writeFileSync(cheminCache(source, issn), JSON.stringify(valeur), "utf8");
}

// --- Requetes ---------------------------------------------------------------

const erreurs = [];

// Une seule reprise apres 2 s, comme demande. Au-dela on renvoie l'echec et
// l'appelant laissera les champs vides : jamais de valeur devinee.
async function fetchJson(url, headers = {}) {
  for (let tentative = 0; tentative < 2; tentative++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
      if (res.status === 404) return { ok: true, data: null };
      if (res.ok) return { ok: true, data: await res.json() };
      if (tentative === 0) { await sleep(ATTENTE_RETRY); continue; }
      const detail = await res.text().catch(() => "");
      return { ok: false, status: res.status, erreur: detail.slice(0, 120) };
    } catch (e) {
      if (tentative === 0) { await sleep(ATTENTE_RETRY); continue; }
      return { ok: false, status: 0, erreur: String(e).slice(0, 120) };
    }
  }
}

// Une cle refusee doit arreter le programme : sinon on mettrait en cache 884
// reponses vides et le prochain passage croirait la couverture nulle.
class ErreurCleSherpa extends Error {}

async function interroger(source, issns, { cache }, requete) {
  for (const issn of issns) {
    let brut = cache ? lireCache(source, issn) : undefined;
    if (brut === undefined) {
      const resultat = await requete(issn);
      if (resultat.refusCle) {
        throw new ErreurCleSherpa(`Open Policy Finder a refuse la cle (HTTP ${resultat.status}).`);
      }
      if (!resultat.ok) {
        // Panne reseau ou serveur : rien en cache, la revue reste rejouable.
        erreurs.push(`${source} ${issn} : HTTP ${resultat.status || "reseau"} ${resultat.erreur || ""}`.trim());
        await sleep(DELAI_MS);
        continue;
      }
      brut = resultat.valeur;
      ecrireCache(source, issn, brut);
      await sleep(DELAI_MS);
    }
    if (brut) return { issn, brut };
  }
  return null;
}

const requeteDoaj = async (issn) => {
  const r = await fetchJson(DOAJ_ENDPOINT + encodeURIComponent(issn));
  if (!r.ok) return r;
  return { ok: true, valeur: r.data?.results?.length ? r.data.results[0] : null };
};

const requeteSherpa = (cle) => async (issn) => {
  const params = new URLSearchParams({
    "item-type": "publication",
    format: "Json",
    limit: "10",
    filter: JSON.stringify([["issn", "equals", issn]]),
  });
  const r = await fetchJson(`${SHERPA_ENDPOINT}?${params}`, {
    "x-api-key": cle,
    Accept: "application/json",
  });
  if (!r.ok && (r.status === 401 || r.status === 403)) return { refusCle: true, status: r.status };
  if (!r.ok) return r;
  return { ok: true, valeur: Array.isArray(r.data?.items) && r.data.items.length ? r.data.items[0] : null };
};

// --- Mise en forme ----------------------------------------------------------

const VIDE_DOAJ = {
  doaj_trouve: "non", doaj_acces_ouvert: "", doaj_apc_montant: "",
  doaj_apc_devise: "", doaj_licence: "", doaj_type_relecture: "",
};

function faconnerDoaj(resultat) {
  if (!resultat) return { ...VIDE_DOAJ };
  const b = resultat.brut.bibjson || {};

  let montant = "", devise = "";
  if (b.apc?.has_apc === false) {
    montant = "0"; // frais de publication declares nuls : c'est une valeur, pas un trou
  } else if (b.apc?.has_apc === true) {
    const m = Array.isArray(b.apc.max) ? b.apc.max[0] : null;
    if (m?.price != null) montant = String(m.price);
    if (m?.currency) devise = m.currency;
  }
  const rp = b.editorial?.review_process;
  return {
    doaj_trouve: "oui",
    // Presence dans DOAJ = revue integralement en acces ouvert (voie doree).
    doaj_acces_ouvert: "oui",
    doaj_apc_montant: montant,
    doaj_apc_devise: devise,
    doaj_licence: Array.isArray(b.license) && b.license[0]?.type ? b.license[0].type : "",
    doaj_type_relecture: Array.isArray(rp) && rp.length ? rp.join(", ") : "",
  };
}

// Pouvoir deposer la version editeur est le cas le plus permissif, puis la
// version acceptee, puis le manuscrit soumis.
const RANG_VERSION = { published: 3, accepted: 2, submitted: 1 };

// Lieux de depot qui valent archive ouverte au sens HAL. any_website autorise
// de fait n'importe quel lieu, d'apres la documentation OPF.
const REPOS = [
  "institutional_repository", "non_commercial_institutional_repository",
  "subject_repository", "non_commercial_subject_repository",
  "any_repository", "non_commercial_repository", "named_repository",
  "preprint_repository", "any_website",
];

// embargo.units vaut days, weeks, months ou years : pas seulement des mois.
function embargoEnMois(embargo) {
  if (!embargo || embargo.amount == null) return 0;
  const u = String(embargo.units || "").toLowerCase();
  if (u.startsWith("year")) return embargo.amount * 12;
  if (u.startsWith("week")) return Math.round(embargo.amount / 4.345);
  if (u.startsWith("day")) return Math.round(embargo.amount / 30.44);
  return embargo.amount;
}

const VIDE_SHERPA = {
  sherpa_trouve: "non", sherpa_version_deposable: "",
  sherpa_embargo_mois: "", sherpa_depot_hal: "",
};

function faconnerSherpa(resultat) {
  if (!resultat) return { ...VIDE_SHERPA };
  let meilleure = null;
  for (const pol of resultat.brut.publisher_policy || []) {
    if (pol.open_access_prohibited === "yes") continue;
    for (const voie of pol.permitted_oa || []) {
      const lieux = voie.location?.location || [];
      if (!lieux.some((l) => REPOS.includes(l))) continue;
      const avecFrais = voie.additional_oa_fee === "yes";
      const emb = embargoEnMois(voie.embargo);
      for (const v of voie.article_version || []) {
        const candidat = { version: v, rang: RANG_VERSION[v] || 0, embargo: emb, avecFrais };
        if (!meilleure) { meilleure = candidat; continue; }
        // Une voie sans frais l'emporte ; a frais egal la meilleure version ;
        // a version egale l'embargo le plus court.
        const mieux = candidat.avecFrais === meilleure.avecFrais
          ? (candidat.rang > meilleure.rang ||
             (candidat.rang === meilleure.rang && candidat.embargo < meilleure.embargo))
          : (!candidat.avecFrais && meilleure.avecFrais);
        if (mieux) meilleure = candidat;
      }
    }
  }
  if (!meilleure) {
    // Revue connue d'OPF, mais aucune voie de depot en archive ouverte.
    return { sherpa_trouve: "oui", sherpa_version_deposable: "", sherpa_embargo_mois: "", sherpa_depot_hal: "non" };
  }
  return {
    sherpa_trouve: "oui",
    sherpa_version_deposable: meilleure.version,
    sherpa_embargo_mois: String(meilleure.embargo),
    // Depot type HAL : version acceptee ou publiee, sans frais additionnel.
    sherpa_depot_hal: meilleure.rang >= RANG_VERSION.accepted && !meilleure.avecFrais ? "oui" : "non",
  };
}

// --- Programme --------------------------------------------------------------

function chargerEnv() {
  for (const chemin of [join(RACINE, ".env"), join(DOSSIER_SCRIPT, ".env")]) {
    if (!existsSync(chemin)) continue;
    for (const ligne of readFileSync(chemin, "utf8").split(/\r?\n/)) {
      const l = ligne.trim();
      if (!l || l.startsWith("#")) continue;
      const i = l.indexOf("=");
      if (i === -1) continue;
      const cle = l.slice(0, i).trim();
      const val = l.slice(i + 1).trim().replace(/^["']|["']$/g, "");
      if (val && !process.env[cle]) process.env[cle] = val;
    }
  }
}

async function main() {
  chargerEnv();
  const args = process.argv.slice(2);
  const cache = !args.includes("--no-cache");
  const iLimit = args.indexOf("--limit");
  const limite = iLimit !== -1 ? Number(args[iLimit + 1]) : Infinity;

  const cleSherpa = process.env.SHERPA_API_KEY || "";
  if (!cleSherpa) {
    console.error("SHERPA_API_KEY absente du .env : l'enrichissement Sherpa serait vide sur les 884 revues.");
    process.exit(1);
  }
  if (!existsSync(ENTREE)) {
    console.error(`Fichier introuvable : ${ENTREE}\nLancez d'abord : python enrichissement/fusionner-journals.py`);
    process.exit(1);
  }

  const { entetes, lignes } = lireCsv(ENTREE);
  if (JSON.stringify(entetes) !== JSON.stringify(COLONNES_SOURCE)) {
    console.error("Colonnes inattendues dans l'entree : " + entetes.join(","));
    process.exit(1);
  }

  const aTraiter = lignes.slice(0, limite);
  console.log(`${aTraiter.length} revues. Cache ${cache ? "actif" : "ignore"}, ${DELAI_MS} ms entre requetes.`);

  const sansDoaj = [], sansSherpa = [];
  let nDoaj = 0, nSherpa = 0;

  for (const [i, ligne] of aTraiter.entries()) {
    const issns = [ligne.issn_cle, ligne.eissn, ligne.pissn].filter((v, j, a) => v && a.indexOf(v) === j);

    const doaj = await interroger("doaj", issns, { cache }, requeteDoaj);
    Object.assign(ligne, faconnerDoaj(doaj));
    if (doaj) nDoaj++; else sansDoaj.push(ligne);

    const sherpa = await interroger("sherpa", issns, { cache }, requeteSherpa(cleSherpa));
    Object.assign(ligne, faconnerSherpa(sherpa));
    if (sherpa) nSherpa++; else sansSherpa.push(ligne);

    if ((i + 1) % 20 === 0 || i + 1 === aTraiter.length) {
      process.stdout.write(`\r  ${i + 1}/${aTraiter.length} — DOAJ ${nDoaj}, Sherpa ${nSherpa}, erreurs ${erreurs.length}   `);
    }
  }
  process.stdout.write("\n");

  // Les lignes non traitees (--limit) gardent des colonnes vides explicites.
  for (const ligne of lignes.slice(aTraiter.length)) Object.assign(ligne, VIDE_DOAJ, VIDE_SHERPA);

  ecrireCsv(SORTIE, lignes);

  const total = aTraiter.length;
  const listeMd = (revues) => revues.length
    ? ["| Titre | Rang | issn_cle |", "| --- | --- | --- |",
       ...revues.map((r) => `| ${r.titre} | ${r.rang_fnege_2025} | ${r.issn_cle} |`)].join("\n")
    : "_Aucune._";

  writeFileSync(RAPPORT, [
    "# Enrichissement DOAJ et Open Policy Finder",
    "",
    `Genere le ${new Date().toISOString().slice(0, 10)} sur ${total} revues.`,
    "",
    "| Source | Trouvees | Absentes |",
    "| --- | ---: | ---: |",
    `| DOAJ | ${nDoaj} | ${sansDoaj.length} |`,
    `| Open Policy Finder | ${nSherpa} | ${sansSherpa.length} |`,
    "",
    "Une revue absente d'une source a les colonnes de cette source vides et",
    "`*_trouve` a `non`. Aucune valeur n'est deduite ni inventee.",
    "",
    `## Revues absentes de DOAJ (${sansDoaj.length})`, "", listeMd(sansDoaj), "",
    `## Revues absentes d'Open Policy Finder (${sansSherpa.length})`, "", listeMd(sansSherpa), "",
    ...(erreurs.length ? [`## Requetes en erreur (${erreurs.length})`, "", ...erreurs.map((e) => `- ${e}`), ""] : []),
  ].join("\n"), "utf8");

  console.log("");
  console.log(`DOAJ                : ${nDoaj} trouvees, ${sansDoaj.length} absentes`);
  console.log(`Open Policy Finder  : ${nSherpa} trouvees, ${sansSherpa.length} absentes`);
  if (erreurs.length) console.log(`Requetes en erreur  : ${erreurs.length}`);
  console.log(`Sortie              : ${SORTIE}`);
  console.log(`Rapport             : ${RAPPORT}`);
  console.log("\nLa liste complete des revues absentes est dans le rapport.");
}

main().catch((err) => {
  if (err instanceof ErreurCleSherpa) {
    console.error("\n" + err.message + "\nRien n'a ete mis en cache, le passage est rejouable.");
  } else {
    console.error("\nEchec :", err);
  }
  process.exit(1);
});
