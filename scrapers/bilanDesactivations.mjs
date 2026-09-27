import { echeanceSoumission } from './echeance.mjs';

// Bilan des appels passes d'actif a inactif entre deux etats de calls.json,
// par editeur (abbreviation du scraper). Utilise par le lancement manuel
// (scripts/lancement-manuel.mjs) pour decider s'il faut demander
// confirmation avant de pousser, et par la CI (pageController.mjs) pour le
// resume du run.
//
// Une desactivation est SUSPECTE quand rien ne l'explique : l'appel quitte sa
// source alors que son echeance de soumission est future, ou inconnue. Un
// appel clos qui disparait, ou que l'archivage par echeance bascule, c'est la
// marche normale. Le 2026-09-27, 24 des 26 appels Elsevier inactifs encore en
// ligne etaient simplement clos ; les 28 desactives a tort la veille, eux,
// avaient des echeances jusqu'en 2028. Ne compter que les suspectes garde le
// seuil sensible au second cas sans le faire lever sur le premier.
//
// Le delai de grace de diffChecker protege deja l'affichage (30 jours) : ce
// bilan sert a reperer la donnee fausse avant qu'elle ne soit poussee.

// Au-dela, un passage qui desactive autant d'appels vivants merite un regard
// humain : le retour incomplet du scraper Elsevier du 2026-09-26 n'avait pas
// declenche le gel de diffChecker.
export const SEUIL_CONFIRMATION = 5;

// Nombre maximal d'appels suspects detailles dans le resume CI.
const MAX_APPELS_DETAILLES = 50;

const incrementer = (compteur, cle) => { compteur[cle] = (compteur[cle] ?? 0) + 1; };

// Fonction pure, exportee pour test.
export function bilanDesactivations(avant, apres, maintenant = Date.now()) {
    const apresParSlug = new Map(apres.map(appel => [appel.slug, appel]));
    const avantParSlug = new Map(avant.map(appel => [appel.slug, appel]));

    const parEditeur = {};
    let total = 0;
    const suspectes = { total: 0, parEditeur: {}, appels: [] };
    for (const ancien of avant) {
        if (!ancien.active) continue;
        const nouveau = apresParSlug.get(ancien.slug);
        if (nouveau && nouveau.active) continue;
        incrementer(parEditeur, ancien.abbreviation);
        total += 1;

        // L'etat d'apres fait foi : le passage a pu prolonger l'echeance.
        const echeance = echeanceSoumission(nouveau ?? ancien);
        if (echeance !== null && echeance < maintenant) continue;
        incrementer(suspectes.parEditeur, ancien.abbreviation);
        suspectes.total += 1;
        suspectes.appels.push({
            slug: ancien.slug,
            abbreviation: ancien.abbreviation,
            echeance: echeance === null ? null : new Date(echeance).toISOString().slice(0, 10),
        });
    }

    let reactives = 0;
    let nouveaux = 0;
    for (const appel of apres) {
        if (!appel.active) continue;
        const ancien = avantParSlug.get(appel.slug);
        if (!ancien) nouveaux += 1;
        else if (!ancien.active) reactives += 1;
    }

    return { parEditeur, total, reactives, nouveaux, suspectes };
}

const libelleEcheance = echeance => echeance ?? 'inconnue';

// Fonction pure, exportee pour test.
export function formaterBilanDesactivations({ parEditeur, total, reactives, nouveaux, suspectes }) {
    const lignes = [`[bilan] ${nouveaux} nouvel(s) appel(s) actif(s), ${reactives} reactive(s)`];
    if (total === 0) {
        lignes.push('[bilan] Aucun appel desactive.');
        return lignes.join('\n');
    }
    lignes.push(`[bilan] ${total} appel(s) desactive(s), dont ${suspectes.total} suspect(s) (echeance future ou inconnue) :`);
    for (const [editeur, nombre] of Object.entries(parEditeur).sort((a, b) => b[1] - a[1])) {
        const nbSuspectes = suspectes.parEditeur[editeur] ?? 0;
        const detail = nbSuspectes > 0 ? ` (dont ${nbSuspectes} suspecte(s))` : '';
        lignes.push(`[bilan]   ${editeur.padEnd(12)} ${nombre}${detail}`);
    }
    for (const { slug, echeance } of suspectes.appels) {
        lignes.push(`[bilan]     suspect : ${slug} (echeance ${libelleEcheance(echeance)})`);
    }
    return lignes.join('\n');
}

// Resume Markdown pour la page du run CI (onglet Actions). Chaine vide quand
// aucune desactivation n'est suspecte : l'appelant n'ecrit alors rien.
// Fonction pure, exportee pour test.
export function formaterResumeDesactivations({ parEditeur, suspectes }) {
    if (suspectes.total === 0) return '';

    const lignes = [
        `## Desactivations suspectes : ${suspectes.total}`,
        '',
        'Appels passes inactifs alors que leur echeance est future ou inconnue. Le delai de grace les garde affiches 30 jours :',
        "a verifier sur le site de l'editeur avant sa fin.",
        '',
        '| Editeur | Desactives | Suspects |',
        '| --- | ---: | ---: |',
    ];
    for (const [editeur, nombre] of Object.entries(suspectes.parEditeur).sort((a, b) => b[1] - a[1])) {
        lignes.push(`| ${editeur} | ${parEditeur[editeur] ?? nombre} | ${nombre} |`);
    }
    lignes.push('');
    for (const { slug, abbreviation, echeance } of suspectes.appels.slice(0, MAX_APPELS_DETAILLES)) {
        lignes.push(`- \`${slug}\` (${abbreviation}, echeance ${libelleEcheance(echeance)})`);
    }
    if (suspectes.appels.length > MAX_APPELS_DETAILLES) {
        lignes.push(`- ... et ${suspectes.appels.length - MAX_APPELS_DETAILLES} autre(s)`);
    }
    lignes.push('');
    return lignes.join('\n');
}

// Seules les desactivations suspectes comptent : un passage qui archive des
// dizaines d'appels clos n'a rien d'anormal.
// Fonction pure, exportee pour test.
export function doitConfirmer({ suspectes, codeSortie }) {
    return suspectes > SEUIL_CONFIRMATION || codeSortie !== 0;
}
