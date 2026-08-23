import { promises as fs } from 'fs';

// Un passage ou plus de la moitie des scrapers rentrent bredouilles n'est pas
// une mauvaise nuit, c'est une panne : reseau du runner, dependance cassee,
// changement d'infrastructure. On fait echouer le step pour que le job passe
// au rouge.
//
// Seuil calibre sur les logs CI reels : les passages des 19, 20 et 21 aout
// 2026 comptaient 7 a 9 alertes sur 21 scrapers. Une bonne partie tenait a la
// course sur le cache du CSV ISSN (apa, cup, dm, re, springer), corrigee
// depuis ; le reste (sage, wiley, emerald, elsevier) est bloque depuis les IP
// GitHub et le restera tant que les correctifs 5 et 6 ne sont pas en place.
// Descendre le seuil sous ce bruit de fond mettrait le job au rouge chaque
// nuit et le signal ne vaudrait plus rien. A resserrer une fois observe le
// niveau reel d'apres correctif.
export const SEUIL_ECHEC_RATIO = 0.5;

// Comparaison stricte : un passage sans aucun scraper lance, ni aucune alerte,
// ne doit pas etre pris pour une panne par ce seuil. Ce cas existe -- le run
// du 23 aout 2026 -- mais il releve du garde-fou sur l'exception, pas d'ici.
// Fonction pure, exportee pour test.
export function depasseSeuilEchec(nbAlertes, nbScrapers, ratio = SEUIL_ECHEC_RATIO) {
    return nbAlertes > nbScrapers * ratio;
}

// Resume Markdown affiche sur la page du run, sous le job. Chaine vide quand
// il n'y a rien a signaler : l'appelant n'ecrit alors aucun fichier.
// Fonction pure, exportee pour test.
export function formaterResumeAlertes(alertes, nbScrapers) {
    if (alertes.length === 0) return '';

    const lignes = [
        `## Scrapers en alerte : ${alertes.length} sur ${nbScrapers}`,
        '',
        '| Scraper | Avant | Apres | Motif |',
        '| --- | ---: | ---: | --- |',
    ];
    for (const { abbreviation, avant, apres, motif } of alertes) {
        const libelle = motif === 'zero' ? 'tombe a zero' : 'chute brutale';
        lignes.push(`| ${abbreviation} | ${avant} | ${apres} | ${libelle} |`);
    }
    lignes.push('');
    lignes.push("Les appels de ces scrapers sont **geles**, pas archives : aucune donnee n'est perdue.");
    lignes.push('A verifier a la main : vrai retrait de l\'editeur, ou echec silencieux du scraper ?');

    if (depasseSeuilEchec(alertes.length, nbScrapers)) {
        lignes.push('');
        lignes.push(`> Plus de la moitie des scrapers sont en alerte : le passage est traite comme une panne et le step echoue.`);
    }
    return lignes.join('\n');
}

// GITHUB_STEP_SUMMARY n'existe qu'en CI. Hors CI on ne fait rien, sans lever.
export async function publierResumeCI(resume, env = process.env) {
    if (!resume) return false;
    const cible = env.GITHUB_STEP_SUMMARY;
    if (!cible) return false;
    await fs.appendFile(cible, resume);
    return true;
}
