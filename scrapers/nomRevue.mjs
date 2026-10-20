// Nom d'affichage d'une revue pour un appel : celui de journals.json, atteint
// par l'ISSN de l'appel, et le libelle du scraper (call.journal) seulement si la
// jointure echoue. Le libelle du scraper differe du nom de journals.json pour
// 92 appels sur 993 (deux-points, « & », casse, apostrophe) ; le nom d'affichage
// ne doit venir que d'une source (cf. memo d'architecture).
//
// Fonction pure, utilisee par le generateur de flux RSS (scrapers/feedgen.mjs),
// qui tourne hors d'Eleventy. Les gabarits du site, eux, disposent deja de la
// revue jointe (filtre revueDeLAppel) et lisent revue.titre.
export function nomAffichageRevue(call, journals) {
    const revue = call && call.issn && journals ? journals[call.issn] : null;
    const titre = revue && typeof revue.titre === 'string' ? revue.titre.trim() : '';
    return titre || (call && call.journal) || '';
}
