#!/usr/bin/env node
// enrichir-revues.mjs
// ---------------------------------------------------------------------------
// kerostig - etape 3 du guide de developpement.
// Transforme le CSV de correspondance ISSN en www/_data/journals.json,
// en enrichissant chaque revue via OpenAlex, DOAJ et Open Policy Finder.
//
// Aucune dependance externe : Node 18+ suffit (fetch natif).
//
// Usage :
//   node enrichir-revues.mjs
//   node enrichir-revues.mjs --limit 5          (tester sur les 5 premieres)
//   node enrichir-revues.mjs --offline          (ne rien appeler, valider le CSV)
//   node enrichir-revues.mjs --no-cache         (ignorer le cache disque)
//   node enrichir-revues.mjs --input chemin.csv --output journals.json
//
// Cles API : fichier .env a la racine du depot (voir .env.exemple), ou
// variables d'environnement.
//   SHERPA_API_KEY=...     requis pour Open Policy Finder (ex-Sherpa Romeo)
//   OPENALEX_MAILTO=...    recommande (email, pool poli d'OpenAlex)
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Tous les chemins par defaut (.env, cache, CSV d'entree) sont ancres sur le
// dossier du script, pas sur le repertoire courant : le script se comporte
// pareil qu'on l'appelle depuis enrichissement/ ou depuis la racine du depot.
// Les chemins passes en argument restent, eux, relatifs au repertoire courant.
const DOSSIER_SCRIPT = dirname(fileURLToPath(import.meta.url));

// --- 1. Petits utilitaires ------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Chargement minimal d'un fichier .env, sans dependance.
// Une valeur vide ne masque jamais une valeur deja definie : le .env local peut
// donc ne renseigner qu'une partie des cles, le .env racine complete le reste.
function loadEnvFile(path = ".env") {
  if (!existsSync(path)) return;
  for (const ligne of readFileSync(path, "utf8").split(/\r?\n/)) {
    const l = ligne.trim();
    if (!l || l.startsWith("#")) continue;
    const i = l.indexOf("=");
    if (i === -1) continue;
    const cle = l.slice(0, i).trim();
    let val = l.slice(i + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (val && !process.env[cle]) process.env[cle] = val;
  }
}

// Les cles vivent dans le .env a la racine du depot. Un .env a cote du script
// reste possible pour surcharger localement : il est lu en premier et l'emporte.
function chargerEnvironnement() {
  loadEnvFile(join(DOSSIER_SCRIPT, ".env"));
  loadEnvFile(join(DOSSIER_SCRIPT, "..", ".env"));
}

// Lecture des arguments de ligne de commande.
function lireArgs(argv) {
  const args = {
    input: join(DOSSIER_SCRIPT, "kerostig-correspondance-issn.csv"),
    output: join(DOSSIER_SCRIPT, "journals.json"),
    rapport: join(DOSSIER_SCRIPT, "journals-rapport.md"),
    limit: Infinity,
    offline: false,
    cache: true,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--offline") args.offline = true;
    else if (a === "--no-cache") args.cache = false;
    else if (a === "--limit") args.limit = parseInt(argv[++i], 10);
    else if (a === "--input") args.input = argv[++i];
    else if (a === "--output") args.output = argv[++i];
    else if (a === "--rapport") args.rapport = argv[++i];
  }
  return args;
}

// Parseur CSV (gere les champs entre guillemets contenant des virgules).
function parseCsv(texte) {
  const lignes = [];
  let champ = "";
  let ligne = [];
  let dansGuillemets = false;
  for (let i = 0; i < texte.length; i++) {
    const c = texte[i];
    if (dansGuillemets) {
      if (c === '"') {
        if (texte[i + 1] === '"') { champ += '"'; i++; }
        else dansGuillemets = false;
      } else champ += c;
    } else {
      if (c === '"') dansGuillemets = true;
      else if (c === ",") { ligne.push(champ); champ = ""; }
      else if (c === "\n") { ligne.push(champ); lignes.push(ligne); ligne = []; champ = ""; }
      else if (c === "\r") { /* ignore */ }
      else champ += c;
    }
  }
  if (champ !== "" || ligne.length) { ligne.push(champ); lignes.push(ligne); }
  const entetes = lignes.shift().map((h) => h.trim());
  return lignes
    .filter((l) => l.some((v) => v !== ""))
    .map((l) => Object.fromEntries(entetes.map((h, k) => [h, (l[k] ?? "").trim()])));
}

// --- 2. Cache disque + fetch robuste --------------------------------------

const DOSSIER_CACHE = join(DOSSIER_SCRIPT, ".cache-enrichissement");

function cheminCache(source, issn) {
  return join(DOSSIER_CACHE, `${source}_${issn}.json`);
}

function lireCache(source, issn) {
  const p = cheminCache(source, issn);
  if (!existsSync(p)) return undefined;
  try { return JSON.parse(readFileSync(p, "utf8")); }
  catch { return undefined; }
}

function ecrireCache(source, issn, valeur) {
  if (!existsSync(DOSSIER_CACHE)) mkdirSync(DOSSIER_CACHE, { recursive: true });
  writeFileSync(cheminCache(source, issn), JSON.stringify(valeur), "utf8");
}

// fetch avec reessais (429 et 5xx) et backoff. Renvoie {ok, status, data}.
async function fetchJson(url, { headers = {}, essais = 3 } = {}) {
  for (let tentative = 0; tentative <= essais; tentative++) {
    try {
      const res = await fetch(url, { headers });
      if (res.status === 404) return { ok: false, status: 404, data: null };
      if ((res.status === 429 || res.status >= 500) && tentative < essais) {
        await sleep(1000 * 2 ** tentative);
        continue;
      }
      if (!res.ok) {
        // Le corps porte souvent le motif exact ({"error": "..."}), utile pour
        // distinguer une cle invalide d'une requete mal formee.
        const detail = await res.text().catch(() => "");
        return { ok: false, status: res.status, data: null, erreur: detail.slice(0, 200) };
      }
      return { ok: true, status: res.status, data: await res.json() };
    } catch (e) {
      if (tentative < essais) { await sleep(1000 * 2 ** tentative); continue; }
      return { ok: false, status: 0, data: null, erreur: String(e) };
    }
  }
}

// --- 3. Les trois enrichissements -----------------------------------------

// Renvoie la liste des ISSN a essayer : la cle d'abord, puis l'autre.
function issnsAEssayer(row) {
  const l = [];
  for (const v of [row.issn_cle, row.eissn, row.pissn]) {
    if (v && !l.includes(v)) l.push(v);
  }
  return l;
}

// Renseignees dans main(), une fois le ou les .env charges.
let MAILTO = "";
let SHERPA_KEY = "";

// -- OpenAlex : nom propre, editeur, metriques, indicateurs d'acces ouvert.
async function enrichirOpenAlex(issns, { cache }) {
  const champs = [
    "id", "display_name", "issn", "issn_l", "host_organization_name",
    "summary_stats", "works_count", "cited_by_count", "counts_by_year",
    "is_oa", "is_in_doaj", "apc_usd", "topics",
  ].join(",");

  for (const issn of issns) {
    let src = cache ? lireCache("openalex", issn) : undefined;
    if (src === undefined) {
      const params = new URLSearchParams({ select: champs });
      if (MAILTO) params.set("mailto", MAILTO);
      const url = `https://api.openalex.org/sources/issn:${issn}?${params}`;
      const { ok, data } = await fetchJson(url);
      src = ok ? data : null;
      ecrireCache("openalex", issn, src);
      await sleep(120); // pool poli
    }
    if (src) return { issn, src };
  }
  return null;
}

function faconnerOpenAlex(resultat) {
  if (!resultat) {
    return {
      found: false, openalex_id: null, nom: null, editeur: null,
      citedness_2ans: null, h_index: null, volume_annuel: null,
      annee_volume: null, volume_total: null, thematiques: [],
      is_oa: null, is_in_doaj: null, apc_usd: null,
    };
  }
  const s = resultat.src;
  // Volume annuel : derniere annee complete (on exclut l'annee courante, souvent partielle).
  const anneeCourante = new Date().getFullYear();
  const annees = (s.counts_by_year || []).filter((y) => y.year < anneeCourante);
  const derniere = annees.sort((a, b) => b.year - a.year)[0];
  const topics = (s.topics || [])
    .slice(0, 5)
    .map((t) => t.display_name)
    .filter(Boolean);
  return {
    found: true,
    openalex_id: s.id || null,
    nom: s.display_name || null,               // nom propre, casse corrigee
    editeur: s.host_organization_name || null,
    citedness_2ans: s.summary_stats?.["2yr_mean_citedness"] ?? null, // impact factor approx.
    h_index: s.summary_stats?.h_index ?? null,
    volume_annuel: derniere?.works_count ?? null,
    annee_volume: derniere?.year ?? null,
    volume_total: s.works_count ?? null,
    thematiques: topics,
    is_oa: s.is_oa ?? null,
    is_in_doaj: s.is_in_doaj ?? null,
    apc_usd: s.apc_usd ?? null,
  };
}

// -- DOAJ : statut acces ouvert, APC, licence, type de relecture.
async function enrichirDoaj(issns, { cache }) {
  for (const issn of issns) {
    let rec = cache ? lireCache("doaj", issn) : undefined;
    if (rec === undefined) {
      const url = `https://doaj.org/api/search/journals/issn:${encodeURIComponent(issn)}`;
      const { ok, data } = await fetchJson(url);
      rec = ok && data?.results?.length ? data.results[0] : null;
      ecrireCache("doaj", issn, rec);
      await sleep(150);
    }
    if (rec) return { issn, rec };
  }
  return null;
}

function faconnerDoaj(resultat) {
  if (!resultat) {
    return { found: false, acces_ouvert: false, apc: null, licence: null, type_relecture: null };
  }
  const b = resultat.rec.bibjson || {};
  // APC
  let apc = null;
  if (b.apc) {
    if (b.apc.has_apc === false) apc = { gratuit: true, montant: 0, devise: null };
    else if (b.apc.has_apc === true) {
      const m = Array.isArray(b.apc.max) ? b.apc.max[0] : null;
      apc = { gratuit: false, montant: m?.price ?? null, devise: m?.currency ?? null };
    }
  }
  // Licence : premier type declare (ex "CC BY-NC")
  const licence = Array.isArray(b.license) && b.license[0]?.type ? b.license[0].type : null;
  // Type de relecture
  const rp = b.editorial?.review_process;
  const type_relecture = Array.isArray(rp) && rp.length ? rp.join(", ") : null;
  return {
    found: true,
    acces_ouvert: true, // presence dans DOAJ = revue entierement en acces ouvert (gold)
    apc,
    licence,
    type_relecture,
  };
}

// -- Open Policy Finder (ex-Sherpa Romeo) : version deposable, embargo, depot
//    en archive ouverte. L'ancienne API v2.sherpa.ac.uk est fermee ; le nouveau
//    point d'entree attend la cle dans l'en-tete x-api-key et non dans l'URL.
//    La forme des objets publication (publisher_policy > permitted_oa) est
//    restee identique. Cache disque conserve sous le prefixe "sherpa".
const SHERPA_ENDPOINT = "https://api.openpolicyfinder.jisc.ac.uk/retrieve";
const DELAI_SHERPA = 350; // ms entre deux appels, on ne bouscule pas Jisc

// Erreurs OPF rencontrees pendant le passage, reportees dans le rapport final.
const erreursSherpa = [];

// Une cle refusee doit arreter le programme : sinon on mettrait en cache 492
// reponses vides et le prochain passage croirait la couverture nulle.
class ErreurCleSherpa extends Error {}

async function enrichirSherpa(issns, { cache }) {
  if (!SHERPA_KEY) return { sansCle: true };
  for (const issn of issns) {
    let item = cache ? lireCache("sherpa", issn) : undefined;
    if (item === undefined) {
      const params = new URLSearchParams({
        "item-type": "publication",
        format: "Json",
        limit: "10",
        filter: JSON.stringify([["issn", "equals", issn]]),
      });
      const { ok, status, data, erreur } = await fetchJson(`${SHERPA_ENDPOINT}?${params}`, {
        headers: { "x-api-key": SHERPA_KEY, Accept: "application/json" },
      });

      if (!ok && (status === 401 || status === 403)) {
        throw new ErreurCleSherpa(
          `Open Policy Finder a refuse la cle (HTTP ${status}). ${erreur || ""}`.trim()
        );
      }
      if (!ok && status !== 404) {
        // Panne reseau ou serveur : on ne met rien en cache pour pouvoir
        // reessayer cette revue au prochain passage.
        erreursSherpa.push(`${issn} : HTTP ${status || "reseau"} ${erreur || ""}`.trim());
        await sleep(DELAI_SHERPA);
        continue;
      }

      item = ok && Array.isArray(data?.items) && data.items.length ? data.items[0] : null;
      ecrireCache("sherpa", issn, item);
      await sleep(DELAI_SHERPA);
    }
    if (item) return { issn, item };
  }
  return null;
}

// Priorite de version pour le depot vert : pouvoir deposer la version editeur
// est le cas le plus permissif, puis la version acceptee, puis le manuscrit
// soumis. On retient donc publie > accepte > soumis.
const RANG_VERSION = { published: 3, accepted: 2, submitted: 1 };

// Lieux de depot qui valent "archive ouverte" au sens HAL. La documentation OPF
// precise que any_website autorise de fait n'importe quel lieu.
const REPOS = [
  "institutional_repository",
  "non_commercial_institutional_repository",
  "subject_repository",
  "non_commercial_subject_repository",
  "any_repository",
  "non_commercial_repository",
  "named_repository",
  "preprint_repository",
  "any_website",
];

function embargoEnMois(embargo) {
  if (!embargo || embargo.amount == null) return 0;
  const u = String(embargo.units || "").toLowerCase();
  if (u.startsWith("year")) return embargo.amount * 12;
  if (u.startsWith("week")) return Math.round(embargo.amount / 4.345);
  if (u.startsWith("day")) return Math.round(embargo.amount / 30.44);
  return embargo.amount; // months (ou vide)
}

function faconnerSherpa(resultat) {
  if (resultat?.sansCle) {
    return { found: false, raison: "cle SHERPA_API_KEY absente",
             version_deposable: null, embargo_mois: null, depot_hal_possible: null };
  }
  if (!resultat) {
    return { found: false, version_deposable: null, embargo_mois: null, depot_hal_possible: null };
  }
  const politiques = resultat.item.publisher_policy || [];
  let meilleure = null; // {version, rang, embargo, avecFrais}
  for (const pol of politiques) {
    if (pol.open_access_prohibited === "yes") continue;
    for (const voie of pol.permitted_oa || []) {
      const lieux = voie.location?.location || [];
      const enRepo = lieux.some((l) => REPOS.includes(l));
      if (!enRepo) continue;
      const avecFrais = voie.additional_oa_fee === "yes";
      const emb = embargoEnMois(voie.embargo);
      for (const v of voie.article_version || []) {
        const rang = RANG_VERSION[v] || 0;
        // On privilegie une voie sans frais ; a frais egal, la meilleure version ;
        // a version egale, l'embargo le plus court.
        const candidat = { version: v, rang, embargo: emb, avecFrais };
        if (!meilleure) { meilleure = candidat; continue; }
        const mieux =
          (candidat.avecFrais === meilleure.avecFrais)
            ? (candidat.rang > meilleure.rang ||
               (candidat.rang === meilleure.rang && candidat.embargo < meilleure.embargo))
            : (!candidat.avecFrais && meilleure.avecFrais);
        if (mieux) meilleure = candidat;
      }
    }
  }
  // Depot type HAL : version acceptee ou publiee, en depot, sans frais additionnel.
  const depotHal =
    !!meilleure && meilleure.rang >= RANG_VERSION.accepted && !meilleure.avecFrais;
  return {
    found: true,
    version_deposable: meilleure?.version ?? null,
    embargo_mois: meilleure?.embargo ?? null,
    avec_frais_additionnels: meilleure?.avecFrais ?? null,
    depot_hal_possible: meilleure ? depotHal : null,
  };
}

// --- 4. Assemblage d'un enregistrement revue ------------------------------

function construireRevue(row, oa, doaj, sherpa) {
  const nomOpenAlex = oa.found ? oa.nom : null;
  return {
    // Identite (issue du CSV FNEGE)
    titre: nomOpenAlex || row.titre,          // nom propre OpenAlex, sinon titre FNEGE
    titre_fnege: row.titre,                   // titre original FNEGE (majuscules), conserve
    titre_source: nomOpenAlex ? "openalex" : "fnege",
    slug: row.slug,
    pissn: row.pissn || null,
    eissn: row.eissn || null,
    issn_cle: row.issn_cle,
    editeur: oa.editeur,                       // OpenAlex (null si absent)

    // Classement FNEGE (issu du CSV)
    discipline_code: row.discipline_code,
    discipline: row.discipline,
    rang_fnege_2025: row.rang_fnege_2025,

    // Metriques OpenAlex
    metriques: {
      found: oa.found,
      openalex_id: oa.openalex_id,
      citedness_2ans: oa.citedness_2ans,       // 2yr_mean_citedness (proxy facteur d'impact)
      h_index: oa.h_index,
      volume_annuel: oa.volume_annuel,
      annee_volume: oa.annee_volume,
      volume_total: oa.volume_total,
      thematiques: oa.thematiques,
    },

    // Acces ouvert (DOAJ + indicateurs OpenAlex en secours)
    acces_ouvert: {
      dans_doaj: doaj.found,
      est_oa: doaj.found ? true : oa.is_oa,    // DOAJ prime, sinon signal OpenAlex
      apc: doaj.apc ?? (oa.apc_usd != null ? { gratuit: false, montant: oa.apc_usd, devise: "USD" } : null),
      licence: doaj.licence,
      type_relecture: doaj.type_relecture,
    },

    // Auto-archivage (Sherpa Romeo)
    auto_archivage: {
      found: sherpa.found,
      version_deposable: sherpa.version_deposable,
      embargo_mois: sherpa.embargo_mois,
      avec_frais_additionnels: sherpa.avec_frais_additionnels ?? null,
      depot_hal_possible: sherpa.depot_hal_possible,
    },
  };
}

// --- 5. Programme principal ------------------------------------------------

async function main() {
  chargerEnvironnement();
  // Lecture apres chargement du .env : ces valeurs etaient auparavant figees a
  // l'import du module, donc toujours vides.
  MAILTO = process.env.OPENALEX_MAILTO || "";
  SHERPA_KEY = process.env.SHERPA_API_KEY || "";
  const args = lireArgs(process.argv);

  if (!existsSync(args.input)) {
    console.error(`Fichier d'entree introuvable : ${args.input}`);
    process.exit(1);
  }

  const lignes = parseCsv(readFileSync(args.input, "utf8"));
  const total = Math.min(lignes.length, args.limit);
  console.log(`Lecture de ${lignes.length} revues, traitement de ${total}.`);

  if (args.offline) console.log("Mode hors-ligne : aucune API n'est appelee.");
  else {
    if (!SHERPA_KEY) console.log("Attention : SHERPA_API_KEY absente, Open Policy Finder sera ignore.");
    else console.log("Open Policy Finder : cle detectee, interrogation activee.");
    if (!MAILTO) console.log("Astuce : renseignez OPENALEX_MAILTO pour le pool poli d'OpenAlex.");
  }

  const journaux = {};
  const stats = { oa: 0, doaj: 0, sherpa: 0 };
  const sansOpenAlex = [];

  for (let i = 0; i < total; i++) {
    const row = lignes[i];
    const issns = issnsAEssayer(row);

    let oa, doaj, sherpa;
    if (args.offline) {
      oa = faconnerOpenAlex(null);
      doaj = faconnerDoaj(null);
      sherpa = faconnerSherpa(null);
    } else {
      oa = faconnerOpenAlex(await enrichirOpenAlex(issns, args));
      doaj = faconnerDoaj(await enrichirDoaj(issns, args));
      sherpa = faconnerSherpa(await enrichirSherpa(issns, args));
    }

    if (oa.found) stats.oa++; else sansOpenAlex.push(`${row.issn_cle}  ${row.titre}`);
    if (doaj.found) stats.doaj++;
    if (sherpa.found) stats.sherpa++;

    journaux[row.issn_cle] = construireRevue(row, oa, doaj, sherpa);

    const drapeaux = [
      oa.found ? "OA" : "oa-",
      doaj.found ? "DOAJ" : "doaj-",
      sherpa.found ? `Sherpa:${sherpa.version_deposable || "?"}/${sherpa.embargo_mois ?? "?"}m` : "sherpa-",
    ].join(" ");
    console.log(`[${String(i + 1).padStart(3)}/${total}] ${journaux[row.issn_cle].titre}  (${drapeaux})`);
  }

  writeFileSync(args.output, JSON.stringify(journaux, null, 2), "utf8");
  console.log(`\nEcrit : ${args.output} (${Object.keys(journaux).length} revues)`);

  // Rapport de couverture au format markdown.
  const rapport = [
    `# Rapport d'enrichissement journals.json`,
    ``,
    `Genere le ${new Date().toISOString().slice(0, 10)}. Revues traitees : ${total}.`,
    ``,
    `## Couverture par source`,
    ``,
    `| Source | Trouvees | Manquantes |`,
    `|---|---|---|`,
    `| OpenAlex | ${stats.oa} | ${total - stats.oa} |`,
    `| DOAJ (acces ouvert) | ${stats.doaj} | ${total - stats.doaj} |`,
    `| Open Policy Finder (auto-archivage) | ${stats.sherpa} | ${total - stats.sherpa} |`,
    ``,
    `Note : une revue absente de DOAJ n'est pas forcement fermee ; DOAJ ne liste que l'acces ouvert integral.`,
    `Note : une revue absente d'Open Policy Finder est laissee a null, aucune politique n'est deduite.`,
    ``,
    `## Erreurs Open Policy Finder`,
    ``,
    erreursSherpa.length
      ? erreursSherpa.map((s) => `- ${s}`).join("\n")
      : "_Aucune._",
    ``,
    `## Revues sans correspondance OpenAlex`,
    ``,
    `Leur titre reste au format FNEGE (majuscules) et doit etre corrige a la main si besoin.`,
    ``,
    sansOpenAlex.length ? sansOpenAlex.map((s) => `- ${s}`).join("\n") : "_Aucune._",
    ``,
  ].join("\n");
  writeFileSync(args.rapport, rapport, "utf8");
  console.log(`Ecrit : ${args.rapport}`);
  console.log(`\nCouverture : OpenAlex ${stats.oa}/${total}, DOAJ ${stats.doaj}/${total}, Sherpa ${stats.sherpa}/${total}.`);
}

export { parseCsv, faconnerOpenAlex, faconnerDoaj, faconnerSherpa, construireRevue, embargoEnMois };

main().catch((e) => {
  if (e instanceof ErreurCleSherpa) {
    console.error(`\n${e.message}`);
    console.error("Aucune reponse n'a ete mise en cache. Corrigez SHERPA_API_KEY puis relancez.");
    process.exit(1);
  }
  console.error(e);
  process.exit(1);
});
