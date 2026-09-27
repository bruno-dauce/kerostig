// Mesure le taux de copie (sequences de 8 mots, cf scrapers/mesureCopie.mjs)
// d'un lot d'appels par rapport a leur page source.
//
// rawContent n'est jamais persiste dans calls.json (delete call.rawContent
// dans scrapers/llmParser.mjs, parse()) : ce script ne peut donc pas relire
// les donnees stockees seules. Il attend en entree un fichier JSON, une
// liste d'objets { abbreviation, slug, description, rawContent }, produit en
// re-scrapant les pages sources des appels vises (sans jamais appeler le
// modele) et en verifiant que leur contentHash recalcule correspond a celui
// de calls.json -- sinon la page a change depuis l'extraction d'origine et
// la comparaison ne vaudrait rien.
//
// A l'origine de scrapers/mesureCopie.mjs et du seuil de 30 % du garde-fou de
// llmParser.mjs : mesure faite le 2026-09-27 sur les 227 appels actifs
// extraits depuis le correctif du prompt (commit fc9899224, 2026-09-03),
// taux maximal observe 13,3 %. A rejouer sur le meme principe apres la
// reextraction pour verifier que le garde-fou tient sa promesse.
//
// Usage :
//   node scripts/mesurer-taux-copie.mjs <chemin-vers-le-json-de-correspondances>

import { promises as fs } from 'fs';

import { descriptionEnTexte, tauxDeCopie } from '../scrapers/mesureCopie.mjs';

async function main() {
    const entree = process.argv[2];
    if (!entree) {
        console.error('Usage : node scripts/mesurer-taux-copie.mjs <chemin-vers-le-json-de-correspondances>');
        process.exitCode = 1;
        return;
    }

    const correspondances = JSON.parse(await fs.readFile(entree, 'utf8'));
    console.log(`[mesure] ${correspondances.length} correspondance(s) chargee(s)`);

    const resultats = [];
    let exclusTropCourts = 0;
    for (const c of correspondances) {
        const tauxCopie = tauxDeCopie(descriptionEnTexte(c.description), c.rawContent || '');
        if (tauxCopie === null) { exclusTropCourts++; continue; }
        resultats.push({ abbreviation: c.abbreviation, slug: c.slug, tauxCopie });
    }

    resultats.sort((a, b) => b.tauxCopie - a.tauxCopie);

    console.log(`[mesure] ${resultats.length} mesure(s), ${exclusTropCourts} exclue(s) (description < 8 mots)`);
    console.log('\n--- Distribution ---');
    for (const seuil of [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]) {
        const n = resultats.filter((r) => r.tauxCopie >= seuil).length;
        console.log(`  taux >= ${(seuil * 100).toFixed(0)}% : ${n} (${resultats.length ? ((100 * n) / resultats.length).toFixed(1) : '0.0'}%)`);
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

main();
