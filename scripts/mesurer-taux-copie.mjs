// Mesure le taux de copie (sequences de 8 mots, cf scrapers/mesureCopie.mjs)
// et la longueur des descriptions d'un lot d'appels.
//
// Depuis l'ajout de call.controle (scrapers/llmParser.mjs, parse()), un appel
// reextrait porte deja { longueur, tauxCopie, relance } dans calls.json : ce
// script les lit directement, sans re-scraper. Pour un appel plus ancien, sans
// controle, il retombe sur l'ancien mode : fournir rawContent en plus de
// description dans le JSON d'entree, obtenu en re-scrapant la page source
// (sans jamais appeler le modele) et en verifiant que son contentHash
// recalcule correspond a celui de calls.json -- sinon la page a change depuis
// l'extraction d'origine et la comparaison ne vaudrait rien.
//
// A l'origine de scrapers/mesureCopie.mjs et du seuil de 30 % du garde-fou de
// llmParser.mjs : mesure faite le 2026-09-27 sur les 227 appels actifs
// extraits depuis le correctif du prompt (commit fc9899224, 2026-09-03),
// taux maximal observe 13,3 %.
//
// Usage :
//   node scripts/mesurer-taux-copie.mjs <chemin-vers-un-json-de-correspondances-ou-un-extrait-de-calls.json>

import { promises as fs } from 'fs';

import { descriptionEnTexte, tauxDeCopie } from '../scrapers/mesureCopie.mjs';

// Fonction pure, exportee pour test.
export function longueurDescription(description) {
    const paragraphes = Array.isArray(description?.paragraphs) ? description.paragraphs : [];
    return paragraphes.reduce((total, p) => total + (typeof p === 'string' ? p.length : 0), 0);
}

// Fonction pure, exportee pour test. Statut :
//   'mesure'      taux de copie et longueur disponibles ;
//   'trop_court'  description sous les 8 mots necessaires a une mesure ;
//   'sans_donnee' ni controle ni rawContent : rien a mesurer pour cet appel.
export function extraireMesure(c) {
    if (c.controle) {
        return {
            abbreviation: c.abbreviation,
            slug: c.slug,
            longueur: c.controle.longueur,
            tauxCopie: c.controle.tauxCopie,
            relance: c.controle.relance ?? null,
            statut: c.controle.tauxCopie === null ? 'trop_court' : 'mesure',
        };
    }
    if (typeof c.rawContent === 'string' && c.rawContent) {
        const tauxCopie = tauxDeCopie(descriptionEnTexte(c.description), c.rawContent);
        return {
            abbreviation: c.abbreviation,
            slug: c.slug,
            longueur: longueurDescription(c.description),
            tauxCopie,
            relance: null, // inconnue : rien dans une source re-scrapee n'indique une relance
            statut: tauxCopie === null ? 'trop_court' : 'mesure',
        };
    }
    return { abbreviation: c.abbreviation, slug: c.slug, longueur: null, tauxCopie: null, relance: null, statut: 'sans_donnee' };
}

// Fonction pure, exportee pour test. Ne compte que les mesures qui savent si
// une relance a eu lieu (controle.relance connu) : une mesure re-scrapee
// (relance: null) ne doit pas etre lue comme "pas de relance".
export function resumerRelances(resultats) {
    const connus = resultats.filter((r) => r.relance !== null);
    const relances = connus.filter((r) => r.relance === true);
    return { connus: connus.length, relances: relances.length };
}

async function main() {
    const entree = process.argv[2];
    if (!entree) {
        console.error('Usage : node scripts/mesurer-taux-copie.mjs <chemin-vers-un-json-de-correspondances-ou-un-extrait-de-calls.json>');
        process.exitCode = 1;
        return;
    }

    const correspondances = JSON.parse(await fs.readFile(entree, 'utf8'));
    console.log(`[mesure] ${correspondances.length} correspondance(s) chargee(s)`);

    const mesures = correspondances.map(extraireMesure);
    const resultats = mesures.filter((m) => m.statut === 'mesure');
    const exclusTropCourts = mesures.filter((m) => m.statut === 'trop_court').length;
    const exclusSansDonnee = mesures.filter((m) => m.statut === 'sans_donnee').length;

    resultats.sort((a, b) => b.tauxCopie - a.tauxCopie);

    console.log(`[mesure] ${resultats.length} mesure(s), ${exclusTropCourts} exclue(s) (description < 8 mots), ${exclusSansDonnee} sans donnee (ni controle ni rawContent)`);

    const { connus, relances } = resumerRelances(mesures);
    console.log('\n--- Relances du garde-fou ---');
    if (connus === 0) {
        console.log('  aucune information de relance (aucun appel avec controle dans ce lot)');
    } else {
        console.log(`  ${relances} / ${connus} (${((100 * relances) / connus).toFixed(1)}%) ont declenche une relance`);
    }

    console.log('\n--- Distribution du taux de copie ---');
    for (const seuil of [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]) {
        const n = resultats.filter((r) => r.tauxCopie >= seuil).length;
        console.log(`  taux >= ${(seuil * 100).toFixed(0)}% : ${n} (${resultats.length ? ((100 * n) / resultats.length).toFixed(1) : '0.0'}%)`);
    }

    console.log('\n--- Longueur des descriptions ---');
    const longueurs = resultats.map((r) => r.longueur).filter((l) => typeof l === 'number');
    if (longueurs.length) {
        const moyenne = longueurs.reduce((a, b) => a + b, 0) / longueurs.length;
        const depassent = longueurs.filter((l) => l > 1200).length;
        console.log(`  moyenne=${moyenne.toFixed(0)} caracteres, max=${Math.max(...longueurs)}, > 1200 caracteres : ${depassent}`);
    }

    const parEditeur = {};
    for (const r of resultats) (parEditeur[r.abbreviation] ??= []).push(r.tauxCopie);
    console.log('\n--- Par editeur (moyenne, max) ---');
    for (const [abbr, taux] of Object.entries(parEditeur)) {
        const moyenne = taux.reduce((a, b) => a + b, 0) / taux.length;
        console.log(`  ${abbr} : n=${taux.length}, moyenne=${(moyenne * 100).toFixed(1)}%, max=${(Math.max(...taux) * 100).toFixed(1)}%`);
    }

    console.log('\n--- Top 10 taux de copie ---');
    for (const r of resultats.slice(0, 10)) {
        console.log(`  ${(r.tauxCopie * 100).toFixed(1)}% | ${r.abbreviation} | ${r.slug}`);
    }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('mesurer-taux-copie.mjs')) {
    main();
}
