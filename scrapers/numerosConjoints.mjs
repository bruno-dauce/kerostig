// Detecte les numeros speciaux conjoints : un meme appel publie a l'identique
// par deux revues distinctes (meme URL, meme texte), chacune gardant sa
// propre fiche -- rang FNEGE et acces ouvert lui sont propres, il n'y a donc
// jamais fusion, seulement un renvoi croise. Calcule au build, jamais stocke :
// une nouvelle collecte n'a donc rien a mettre a jour a la main.
//
// L'ISSN seul ne suffit pas a distinguer un vrai numero conjoint d'une page
// hub/liste partagee par plusieurs appels reellement distincts (ex. INFORMS,
// une URL unique pour toutes ses revues, cf memoire hub-informs) : deux
// appels differents y auraient aussi des ISSN differents. D'ou l'exigence
// conjointe sur le texte (metaTitle), qui ne concorde que si c'est
// effectivement le meme appel des deux cotes.
import { normaliserUrl } from './url.mjs';

function normaliserTitre(texte) {
    return typeof texte === 'string' ? texte.toLowerCase().replace(/\s+/g, ' ').trim() : '';
}

// Fonction pure, exportee pour test.
export function trouverAppelConjoint(calls, call) {
    if (!Array.isArray(calls) || !call || !call.issn || !call.metaTitle) return null;
    const url = normaliserUrl(call.url);
    if (url === null) return null;
    const titre = normaliserTitre(call.metaTitle);
    if (!titre) return null;

    return calls.find((autre) =>
        autre !== call
        && autre.issn
        && autre.issn !== call.issn
        && normaliserUrl(autre.url) === url
        && normaliserTitre(autre.metaTitle) === titre
    ) ?? null;
}
