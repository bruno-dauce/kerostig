#!/usr/bin/env node
// Reenrichit dans www/_data/journals.json les revues concernees par
// corrections-issn.json (table des corrections ISSN verifiees sur le portail
// ISSN), pour que leurs donnees OpenAlex, DOAJ et Open Policy Finder viennent
// bien des ISSN corriges plutot que d'une retouche manuelle du JSON.
//
// Ne touche pas enrichir-revues.mjs (le pipeline hebdomadaire) : ce script est
// autonome, a but reduit (quelques revues), pas un remplacement du pipeline
// complet.
//
// Usage :
//   node enrichissement/reenrichir-issn-corriges.mjs                (toutes les revues corrigees, presentes dans journals.json)
//   node enrichissement/reenrichir-issn-corriges.mjs APPETITE "SYSTEMS RESEARCH AND BEHAVIORAL SCIENCES"   (titres_fnege precis)

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DOSSIER_SCRIPT = dirname(fileURLToPath(import.meta.url));
const RACINE = join(DOSSIER_SCRIPT, "..");
const JOURNALS = join(RACINE, "www", "_data", "journals.json");
const CORRECTIONS_JSON = join(DOSSIER_SCRIPT, "corrections-issn.json");

function chargerEnv() {
  for (const chemin of [join(RACINE, ".env"), join(DOSSIER_SCRIPT, ".env")]) {
    let texte;
    try { texte = readFileSync(chemin, "utf8"); } catch { continue; }
    for (const ligne of texte.split(/\r?\n/)) {
      const l = ligne.trim();
      if (!l || l.startsWith("#")) continue;
      const i = l.indexOf("=");
      if (i === -1) continue;
      const cle = l.slice(0, i).trim();
      let val = l.slice(i + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (val && !process.env[cle]) process.env[cle] = val;
    }
  }
}
chargerEnv();
const SHERPA_KEY = process.env.SHERPA_API_KEY || "";
const MAILTO = process.env.OPENALEX_MAILTO || "";

// -- Corrections, depuis la table partagee avec corrections_issn.py --------

const { corrections: CORRECTIONS } = JSON.parse(readFileSync(CORRECTIONS_JSON, "utf8"));

// Meme logique que corrections_issn.appliquer_corrections : ne remplace un
// champ que si sa valeur actuelle correspond exactement a "ancien".
export function appliquerCorrections(titreFnege, pissn, eissn) {
  const appliquees = [];
  for (const c of CORRECTIONS) {
    if (c.titre_fnege !== titreFnege) continue;
    if (c.champ === "pissn" && pissn === c.ancien) { pissn = c.nouveau; appliquees.push(c); }
    else if (c.champ === "eissn" && eissn === c.ancien) { eissn = c.nouveau; appliquees.push(c); }
  }
  return { pissn, eissn, appliquees };
}

// -- Mise en forme, identique a enrichir-revues.mjs (non importable : ce
//    module lance sa propre boucle sur tout le CSV des l'import) ------------

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
  const anneeCourante = new Date().getFullYear();
  const annees = (s.counts_by_year || []).filter((y) => y.year < anneeCourante);
  const derniere = annees.sort((a, b) => b.year - a.year)[0];
  const topics = (s.topics || []).slice(0, 5).map((t) => t.display_name).filter(Boolean);
  return {
    found: true,
    openalex_id: s.id || null,
    nom: s.display_name || null,
    editeur: s.host_organization_name || null,
    citedness_2ans: s.summary_stats?.["2yr_mean_citedness"] ?? null,
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

function faconnerDoaj(resultat) {
  if (!resultat) {
    return { found: false, acces_ouvert: false, apc: null, licence: null, type_relecture: null };
  }
  const b = resultat.rec.bibjson || {};
  let apc = null;
  if (b.apc) {
    if (b.apc.has_apc === false) apc = { gratuit: true, montant: 0, devise: null };
    else if (b.apc.has_apc === true) {
      const m = Array.isArray(b.apc.max) ? b.apc.max[0] : null;
      apc = { gratuit: false, montant: m?.price ?? null, devise: m?.currency ?? null };
    }
  }
  const licence = Array.isArray(b.license) && b.license[0]?.type ? b.license[0].type : null;
  const rp = b.editorial?.review_process;
  const type_relecture = Array.isArray(rp) && rp.length ? rp.join(", ") : null;
  return { found: true, acces_ouvert: true, apc, licence, type_relecture };
}

const RANG_VERSION = { published: 3, accepted: 2, submitted: 1 };
const REPOS = [
  "institutional_repository", "non_commercial_institutional_repository",
  "subject_repository", "non_commercial_subject_repository",
  "any_repository", "non_commercial_repository", "named_repository",
  "preprint_repository", "any_website",
];

function embargoEnMois(embargo) {
  if (!embargo || embargo.amount == null) return 0;
  const u = String(embargo.units || "").toLowerCase();
  if (u.startsWith("year")) return embargo.amount * 12;
  if (u.startsWith("week")) return Math.round(embargo.amount / 4.345);
  if (u.startsWith("day")) return Math.round(embargo.amount / 30.44);
  return embargo.amount;
}

function faconnerSherpa(resultat) {
  if (resultat?.sansCle) {
    return { found: false, raison: "cle SHERPA_API_KEY absente", version_deposable: null, embargo_mois: null, depot_hal_possible: null };
  }
  if (!resultat) {
    return { found: false, version_deposable: null, embargo_mois: null, depot_hal_possible: null };
  }
  const politiques = resultat.item.publisher_policy || [];
  let meilleure = null;
  for (const pol of politiques) {
    if (pol.open_access_prohibited === "yes") continue;
    for (const voie of pol.permitted_oa || []) {
      const lieux = voie.location?.location || [];
      if (!lieux.some((l) => REPOS.includes(l))) continue;
      const avecFrais = voie.additional_oa_fee === "yes";
      const emb = embargoEnMois(voie.embargo);
      for (const v of voie.article_version || []) {
        const rang = RANG_VERSION[v] || 0;
        const candidat = { version: v, rang, embargo: emb, avecFrais };
        if (!meilleure) { meilleure = candidat; continue; }
        const mieux = (candidat.avecFrais === meilleure.avecFrais)
          ? (candidat.rang > meilleure.rang || (candidat.rang === meilleure.rang && candidat.embargo < meilleure.embargo))
          : (!candidat.avecFrais && meilleure.avecFrais);
        if (mieux) meilleure = candidat;
      }
    }
  }
  const depotHal = !!meilleure && meilleure.rang >= RANG_VERSION.accepted && !meilleure.avecFrais;
  return {
    found: true,
    version_deposable: meilleure?.version ?? null,
    embargo_mois: meilleure?.embargo ?? null,
    avec_frais_additionnels: meilleure?.avecFrais ?? null,
    depot_hal_possible: meilleure ? depotHal : null,
  };
}

function construireRevue(row, oa, doaj, sherpa) {
  return {
    titre: oa.found ? oa.nom : row.titre,
    titre_fnege: row.titre,
    titre_source: oa.found ? "openalex" : "fnege",
    slug: row.slug,
    pissn: row.pissn || null,
    eissn: row.eissn || null,
    issn_cle: row.issn_cle,
    editeur: oa.editeur,
    discipline_code: row.discipline_code,
    discipline: row.discipline,
    rang_fnege_2025: row.rang_fnege_2025,
    metriques: {
      found: oa.found,
      openalex_id: oa.openalex_id,
      citedness_2ans: oa.citedness_2ans,
      h_index: oa.h_index,
      volume_annuel: oa.volume_annuel,
      annee_volume: oa.annee_volume,
      volume_total: oa.volume_total,
      thematiques: oa.thematiques,
    },
    acces_ouvert: {
      dans_doaj: doaj.found,
      source_oa: doaj.found ? "DOAJ" : "OpenAlex",
      est_oa: doaj.found ? true : oa.is_oa,
      apc: doaj.apc ?? (oa.apc_usd != null ? { gratuit: false, montant: oa.apc_usd, devise: "USD" } : null),
      licence: doaj.licence,
      type_relecture: doaj.type_relecture,
    },
    auto_archivage: {
      found: sherpa.found,
      version_deposable: sherpa.version_deposable,
      embargo_mois: sherpa.embargo_mois,
      avec_frais_additionnels: sherpa.avec_frais_additionnels ?? null,
      depot_hal_possible: sherpa.depot_hal_possible,
    },
  };
}

// -- Requetes reseau ----------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function chercherOpenAlex(issns) {
  const champs = [
    "id", "display_name", "issn", "issn_l", "host_organization_name",
    "summary_stats", "works_count", "cited_by_count", "counts_by_year",
    "is_oa", "is_in_doaj", "apc_usd", "topics",
  ].join(",");
  for (const issn of issns) {
    const params = new URLSearchParams({ select: champs });
    if (MAILTO) params.set("mailto", MAILTO);
    const res = await fetch(`https://api.openalex.org/sources/issn:${issn}?${params}`);
    if (res.ok) return { issn, src: await res.json() };
    await sleep(120);
  }
  return null;
}

async function chercherDoaj(issns) {
  for (const issn of issns) {
    const res = await fetch(`https://doaj.org/api/search/journals/issn:${encodeURIComponent(issn)}`);
    const data = res.ok ? await res.json() : null;
    const rec = data?.results?.length ? data.results[0] : null;
    if (rec) return { issn, rec };
    await sleep(150);
  }
  return null;
}

async function chercherSherpa(issns) {
  if (!SHERPA_KEY) return { sansCle: true };
  for (const issn of issns) {
    const params = new URLSearchParams({
      "item-type": "publication", format: "Json", limit: "10",
      filter: JSON.stringify([["issn", "equals", issn]]),
    });
    const res = await fetch(`https://api.openpolicyfinder.jisc.ac.uk/retrieve?${params}`, {
      headers: { "x-api-key": SHERPA_KEY, Accept: "application/json" },
    });
    const data = res.ok ? await res.json() : null;
    const item = Array.isArray(data?.items) && data.items.length ? data.items[0] : null;
    if (item) return { issn, item };
    await sleep(350);
  }
  return null;
}

function issnsAEssayer(row) {
  const l = [];
  for (const v of [row.issn_cle, row.eissn, row.pissn]) if (v && !l.includes(v)) l.push(v);
  return l;
}

// -- Programme ----------------------------------------------------------------

async function main() {
  const journaux = JSON.parse(readFileSync(JOURNALS, "utf8"));

  const titresDemandes = process.argv.slice(2);
  const titresCorriges = [...new Set(CORRECTIONS.map((c) => c.titre_fnege))];
  const titresCibles = titresDemandes.length
    ? titresDemandes.map((t) => t.toUpperCase())
    : titresCorriges;

  let ecrit = false;

  for (const titreFnege of titresCibles) {
    const ancienneCle = Object.keys(journaux).find((k) => journaux[k].titre_fnege === titreFnege);
    if (!ancienneCle) {
      console.log(`ABSENTE de journals.json : ${titreFnege} (ignoree)`);
      continue;
    }
    const ancienneEntree = journaux[ancienneCle];

    const { pissn, eissn, appliquees } = appliquerCorrections(
      titreFnege, ancienneEntree.pissn, ancienneEntree.eissn
    );
    if (!appliquees.length) {
      console.log(`${titreFnege} : deja a jour (pissn=${ancienneEntree.pissn}, eissn=${ancienneEntree.eissn}), rien a refaire.`);
      continue;
    }

    const issnCle = eissn || pissn;
    const row = {
      titre: titreFnege,
      slug: ancienneEntree.slug,
      pissn, eissn, issn_cle: issnCle,
      discipline_code: ancienneEntree.discipline_code,
      discipline: ancienneEntree.discipline,
      rang_fnege_2025: ancienneEntree.rang_fnege_2025,
    };
    const issns = issnsAEssayer(row);

    const [oaRes, doajRes, sherpaRes] = await Promise.all([
      chercherOpenAlex(issns), chercherDoaj(issns), chercherSherpa(issns),
    ]);
    const oa = faconnerOpenAlex(oaRes);
    const doaj = faconnerDoaj(doajRes);
    const sherpa = faconnerSherpa(sherpaRes);

    const nouvelleEntree = {
      ...construireRevue(row, oa, doaj, sherpa),
      // mirabel et francophone sont des passes additives posterieures
      // (enrichir-mirabel.mjs, marquer-francophones.mjs) : on les conserve.
      ...(ancienneEntree.mirabel ? { mirabel: ancienneEntree.mirabel } : {}),
      ...("francophone" in ancienneEntree ? { francophone: ancienneEntree.francophone } : {}),
    };

    console.log(`\n${titreFnege} :`);
    for (const c of appliquees) {
      console.log(`  correction appliquee : ${c.champ} ${c.ancien} -> ${c.nouveau}`);
    }
    for (const champ of ["pissn", "eissn", "issn_cle", "editeur"]) {
      if (ancienneEntree[champ] !== nouvelleEntree[champ]) {
        console.log(`  ${champ.padEnd(10)} : ${JSON.stringify(ancienneEntree[champ])} -> ${JSON.stringify(nouvelleEntree[champ])}`);
      }
    }
    if (JSON.stringify(ancienneEntree.metriques) !== JSON.stringify(nouvelleEntree.metriques)) {
      console.log(`  metriques  : changees (openalex_id ${ancienneEntree.metriques?.openalex_id} -> ${nouvelleEntree.metriques?.openalex_id})`);
    } else {
      console.log(`  metriques  : inchangees`);
    }
    if (JSON.stringify(ancienneEntree.acces_ouvert) !== JSON.stringify(nouvelleEntree.acces_ouvert)) {
      console.log(`  acces_ouvert : change`);
    } else {
      console.log(`  acces_ouvert : inchange`);
    }
    if (JSON.stringify(ancienneEntree.auto_archivage) !== JSON.stringify(nouvelleEntree.auto_archivage)) {
      console.log(`  auto_archivage : change`);
    } else {
      console.log(`  auto_archivage : inchange`);
    }

    if (issnCle !== ancienneCle) {
      delete journaux[ancienneCle];
    }
    journaux[issnCle] = nouvelleEntree;
    ecrit = true;
  }

  if (ecrit) {
    writeFileSync(JOURNALS, JSON.stringify(journaux, null, 2), "utf8");
    console.log(`\nEcrit : ${JOURNALS}`);
  } else {
    console.log("\nAucune ecriture necessaire.");
  }
}

main();
