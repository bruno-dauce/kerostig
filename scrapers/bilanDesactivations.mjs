// Bilan des appels passes d'actif a inactif entre deux etats de calls.json,
// par editeur (abbreviation du scraper). Utilise par le lancement manuel
// (scripts/lancement-manuel.mjs) pour decider s'il faut demander
// confirmation avant de pousser.

// Au-dela, un passage qui desactive autant d'appels merite un regard humain :
// le 2026-09-26, un retour incomplet du scraper Elsevier en a desactive 32,
// dont 28 toujours en ligne, sans declencher le gel de diffChecker.
export const SEUIL_CONFIRMATION = 5;

// Fonction pure, exportee pour test.
export function bilanDesactivations(avant, apres) {
    const apresParSlug = new Map(apres.map(appel => [appel.slug, appel]));
    const avantParSlug = new Map(avant.map(appel => [appel.slug, appel]));

    const parEditeur = {};
    let total = 0;
    for (const ancien of avant) {
        if (!ancien.active) continue;
        const nouveau = apresParSlug.get(ancien.slug);
        if (nouveau && nouveau.active) continue;
        parEditeur[ancien.abbreviation] = (parEditeur[ancien.abbreviation] ?? 0) + 1;
        total += 1;
    }

    let reactives = 0;
    let nouveaux = 0;
    for (const appel of apres) {
        if (!appel.active) continue;
        const ancien = avantParSlug.get(appel.slug);
        if (!ancien) nouveaux += 1;
        else if (!ancien.active) reactives += 1;
    }

    return { parEditeur, total, reactives, nouveaux };
}

// Fonction pure, exportee pour test.
export function formaterBilanDesactivations({ parEditeur, total, reactives, nouveaux }) {
    const lignes = [`[bilan] ${nouveaux} nouvel(s) appel(s) actif(s), ${reactives} reactive(s)`];
    if (total === 0) {
        lignes.push('[bilan] Aucun appel desactive.');
    } else {
        lignes.push(`[bilan] ${total} appel(s) desactive(s) :`);
        for (const [editeur, nombre] of Object.entries(parEditeur).sort((a, b) => b[1] - a[1])) {
            lignes.push(`[bilan]   ${editeur.padEnd(12)} ${nombre}`);
        }
    }
    return lignes.join('\n');
}

// Fonction pure, exportee pour test.
export function doitConfirmer({ total, codeSortie }) {
    return total > SEUIL_CONFIRMATION || codeSortie !== 0;
}
