#!/usr/bin/env node
// Synchronise dans www/_data/journals.json les rangs FNEGE en conflit
// declares dans corrections-issn.json (fusions_connues, rang_retenu: null).
//
// Tant qu'aucun rang n'est retenu pour une fusion, la revue correspondante
// affiche les deux rangs (rangs_fnege_2025) et une note (rang_fnege_2025_note)
// sur le site. Des qu'un rang_retenu est renseigne dans corrections-issn.json,
// relancer ce script retire ces deux champs : le mecanisme est explicite (tout
// est dans corrections-issn.json) et reversible (un seul champ a changer, puis
// une relance).
//
// Usage : node enrichissement/appliquer-conflits-rang.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DOSSIER_SCRIPT = dirname(fileURLToPath(import.meta.url));
const JOURNALS = join(DOSSIER_SCRIPT, "..", "www", "_data", "journals.json");
const CORRECTIONS_JSON = join(DOSSIER_SCRIPT, "corrections-issn.json");

// Fonction pure, exportee pour test : ne touche pas `journaux` en entree,
// renvoie {journaux: nouvelle version, changements: [...]} pour le bilan.
export function calculerMisesAJour(journaux, fusionsConnues) {
    const sortie = { ...journaux };
    const changements = [];

    for (const [issnCle, fusion] of Object.entries(fusionsConnues)) {
        const entree = sortie[issnCle];
        if (!entree) continue;

        if (fusion.rang_retenu === null) {
            const rangs = fusion.rangs_affiches || [];
            const note = fusion.note_publique || "";
            const dejaAJour =
                JSON.stringify(entree.rangs_fnege_2025) === JSON.stringify(rangs) &&
                entree.rang_fnege_2025_note === note;
            if (dejaAJour) continue;
            sortie[issnCle] = { ...entree, rangs_fnege_2025: rangs, rang_fnege_2025_note: note };
            changements.push({ issn_cle: issnCle, action: "affiche les deux rangs", rangs });
        } else {
            if (!("rangs_fnege_2025" in entree) && !("rang_fnege_2025_note" in entree)) continue;
            const nouvelle = { ...entree };
            delete nouvelle.rangs_fnege_2025;
            delete nouvelle.rang_fnege_2025_note;
            sortie[issnCle] = nouvelle;
            changements.push({ issn_cle: issnCle, action: "rang resolu, retire l'affichage double", rang_retenu: fusion.rang_retenu });
        }
    }

    return { journaux: sortie, changements };
}

function main() {
    const { fusions_connues: fusionsConnues } = JSON.parse(readFileSync(CORRECTIONS_JSON, "utf8"));
    const journaux = JSON.parse(readFileSync(JOURNALS, "utf8"));

    const { journaux: sortie, changements } = calculerMisesAJour(journaux, fusionsConnues);

    console.log(`Fusions en conflit examinees : ${Object.keys(fusionsConnues).length}`);
    console.log(`Changements : ${changements.length}`);
    for (const c of changements) {
        console.log(`  ${c.issn_cle} : ${c.action}`);
    }

    if (changements.length) {
        writeFileSync(JOURNALS, JSON.stringify(sortie, null, 2), "utf8");
        console.log(`Ecrit : ${JOURNALS}`);
    } else {
        console.log("Aucune ecriture necessaire.");
    }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("appliquer-conflits-rang.mjs")) {
    main();
}
