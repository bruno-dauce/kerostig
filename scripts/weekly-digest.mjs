// Digest hebdomadaire : les appels entres dans calls.json depuis sept jours,
// classes par rang FNEGE puis par echeance. Sortie terminal uniquement, aucun
// fichier produit, aucune dependance hors Node.
//
//   node scripts/weekly-digest.mjs
//
// Ce que mesure la fenetre : pubDate, que diffChecker pose une seule fois, a
// la premiere apparition de l'appel (scrapers/diffChecker.mjs). Une mise a
// jour ulterieure -- nouveau hash sur un slug connu -- conserve la pubDate
// d'origine. Le digest liste donc les appels ajoutes, pas les appels modifies :
// calls.json ne porte aucune date de derniere modification qui permettrait de
// les distinguer.

import { readFileSync } from "node:fs";

const JOUR_MS = 24 * 60 * 60 * 1000;
const FENETRE_JOURS = 7;

const lireJson = (chemin) =>
    JSON.parse(readFileSync(new URL(chemin, import.meta.url), "utf8"));

const calls = lireJson("../www/_data/calls.json");
const journals = lireJson("../www/_data/journals.json");

// Jointure par ISSN, clef directe de journals.json, avec repli sur le titre
// exact : meme regle que trouverRevueDeLAppel dans eleventy.config.mjs. Jamais
// de rapprochement approximatif sur le nom scrape.
const trouverRevue = (call) => {
    if (call.issn && journals[call.issn]) return journals[call.issn];
    const nom = (call.journal || "").trim().toLowerCase();
    if (!nom) return null;
    for (const revue of Object.values(journals)) {
        if ((revue.titre || "").toLowerCase() === nom) return revue;
        if ((revue.titre_fnege || "").toLowerCase() === nom) return revue;
    }
    return null;
};

// Echeance de soumission du manuscrit complet : seules les dates portant
// is_full_paper_submission_deadline comptent, et parmi elles la plus tardive
// (prolongations, doublons du modele). Aucun repli sur une autre date de
// l'appel : sans drapeau, l'echeance est inconnue, pas deduite.
const echeanceSoumission = (dates) => {
    if (!Array.isArray(dates)) return null;
    let retenue = null;
    for (const d of dates) {
        if (!d || !d.is_full_paper_submission_deadline || !d.date) continue;
        const t = Date.parse(d.date);
        if (Number.isNaN(t)) continue;
        if (retenue === null || t > retenue) retenue = t;
    }
    return retenue;
};

// Ordre du classement, pas ordre alphabetique : "1*" precede "1", qui precede
// "2". Un rang absent ou inconnu ferme la liste.
const ORDRE_RANG_FNEGE = ["1*", "1", "2", "3"];
const positionRang = (rang) => {
    const i = ORDRE_RANG_FNEGE.indexOf(rang);
    return i === -1 ? ORDRE_RANG_FNEGE.length : i;
};

// UTC impose : les dates du corpus sont des instants ISO, souvent a minuit.
// Formatees dans le fuseau local, elles reculeraient d'un jour a l'ouest de
// Greenwich et l'echeance affichee ne serait plus celle de l'appel.
const formatterDate = new Intl.DateTimeFormat("fr-FR", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
});
const enFrancais = (ms) => formatterDate.format(new Date(ms));

const maintenant = Date.now();
const debut = maintenant - FENETRE_JOURS * JOUR_MS;

const recents = calls
    .filter((call) => {
        const t = Date.parse(call.pubDate);
        return !Number.isNaN(t) && t >= debut && t <= maintenant;
    })
    .map((call) => {
        const revue = trouverRevue(call);
        return {
            titre: call.title || call.metaTitle || "(sans titre)",
            // Nom d'affichage de journals.json, jamais le texte brut scrape ;
            // call.journal ne sert que si la jointure echoue.
            journal: (revue && revue.titre) || call.journal || "revue inconnue",
            rang: (revue && revue.rang_fnege_2025) || null,
            echeance: echeanceSoumission(call.dates),
        };
    })
    .sort((a, b) => {
        const ecart = positionRang(a.rang) - positionRang(b.rang);
        if (ecart !== 0) return ecart;
        // Echeance la plus proche d'abord ; les appels sans echeance connue
        // ferment leur groupe de rang au lieu de se disperser.
        return (a.echeance ?? Infinity) - (b.echeance ?? Infinity);
    });

console.log(
    `Période couverte : du ${enFrancais(debut)} au ${enFrancais(maintenant)}.`
);

if (recents.length === 0) {
    console.log("Aucun appel ajouté sur cette période.");
} else {
    const pluriel = recents.length > 1 ? "s" : "";
    console.log(`${recents.length} appel${pluriel} ajouté${pluriel}.`);
    console.log("");
    for (const appel of recents) {
        // Valeur absente explicite des deux cotes : ni rang invente pour une
        // revue hors classement, ni echeance deduite d'une autre date.
        const rang = appel.rang ? `FNEGE ${appel.rang}` : "FNEGE non classée";
        const echeance = appel.echeance
            ? `échéance ${enFrancais(appel.echeance)}`
            : "échéance non précisée";
        console.log(`- ${appel.titre} — ${appel.journal} (${rang}) — ${echeance}`);
    }
}
