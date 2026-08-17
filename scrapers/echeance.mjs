// Cloture d'un appel par son echeance de soumission.
//
// Un appel ne devient active:false que quand il DISPARAIT de sa source
// (diffChecker.integrateCalls, avec 30 jours de grace). Sur les sources de
// type archive permanente (RIPME, Decisions Marketing, Revue de
// l'Entrepreneuriat), un appel ne disparait jamais : sans ce garde-fou, une
// echeance passee depuis des mois reste affichee comme courante.
//
// Meme regle pour les deux consommateurs, avec des tolerances differentes :
// 7 jours a l'affichage (eleventy.config.mjs), 30 jours avant de basculer
// active:false en base (diffChecker.mjs).
//
// Les dates de calls.json sont des chaines ISO, datees seules ("2026-09-30")
// ou horodatees en UTC : Date.parse les lit dans les deux cas en UTC.

const JOUR_MS = 24 * 60 * 60 * 1000;

// L'echeance de soumission de l'appel, en ms epoch, ou null s'il n'en a pas.
// Plusieurs dates peuvent porter le drapeau (prolongations, erreurs du LLM) :
// on retient la plus tardive.
export function echeanceSoumission(call) {
    const dates = call && call.dates;
    if (!Array.isArray(dates)) return null;
    let derniere = null;
    for (const d of dates) {
        if (!d || !d.is_full_paper_submission_deadline || !d.date) continue;
        const t = Date.parse(d.date);
        if (Number.isNaN(t)) continue;
        if (derniere === null || t > derniere) derniere = t;
    }
    return derniere;
}

// true si l'echeance est depassee depuis plus de toleranceJours.
// Un appel sans echeance identifiee n'est jamais cloture par cette voie : sa
// fin de vie reste geree par la disparition de sa source. On ne masque pas un
// appel au seul motif que le modele n'a pas su lui extraire de date.
export function echeanceDepassee(call, toleranceJours, maintenant = Date.now()) {
    const echeance = echeanceSoumission(call);
    if (echeance === null) return false;
    return maintenant - echeance > toleranceJours * JOUR_MS;
}

// Jours entiers ecoules depuis l'echeance, null si l'appel n'en a pas. Sert
// aux messages de log du pipeline.
export function joursDepuisEcheance(call, maintenant = Date.now()) {
    const echeance = echeanceSoumission(call);
    if (echeance === null) return null;
    return Math.floor((maintenant - echeance) / JOUR_MS);
}
