// Lecture d'une API JSON paginee, et surtout : distinguer une liste vide d'un
// echec.
//
// Trois scrapers interrogent une API REST WordPress paginee -- Taylor &
// Francis, Academy of Management, Revue de l'Entrepreneuriat -- et tous trois
// portaient le meme code, recopie de l'un a l'autre :
//
//     const data = JSON.parse(document.body.innerText);
//     return Array.isArray(data) ? data : [];
//
// Une reponse d'erreur WordPress est du JSON parfaitement valide. Elle
// franchit donc le parse, echoue sur Array.isArray, et ressort en tableau
// vide -- soit exactement le signal de fin de pagination. Un echec total
// devient « plus rien a lire », en silence.
//
// Deux pannes reelles sont nees de cette confusion :
//  - Emerald, 41 appels vivants archives sans un mot ;
//  - Taylor & Francis le 2026-09-03, 83 appels sortis de la collecte apres
//    que le hub eut remplace ses identifiants de taxonomie par des codes
//    lettres : les 30 requetes repondaient 400, toutes avalees.
//
// Ces fonctions sont pures et sans dependance au navigateur : l'appelant lit
// le statut et le corps comme il l'entend, et decide seul quoi faire de
// l'erreur levee ici.

// Interprete une reponse d'API. Rend le tableau d'items, ou LEVE.
//
// Un tableau valide est accepte quel que soit le statut : page.goto rend
// celui de la PREMIERE reponse, et Cloudflare sert son interstitiel en 403
// avant de remplacer le document sur place (cf scrapers/cloudflare.mjs). Le
// corps final est donc la seule autorite ; sans cette tolerance, un challenge
// franchi passerait pour une panne.
export function interpreterReponseApi({ statut, corps, url, prefixe = '[api]' }) {
    let donnees = null;
    let lisible = true;
    try {
        donnees = JSON.parse(corps);
    } catch {
        lisible = false;
    }

    if (lisible && Array.isArray(donnees)) return donnees;

    const detail = !lisible
        ? ' (reponse non JSON)'
        : donnees && donnees.code
            ? ` (${donnees.code})`
            : ' (JSON valide mais pas un tableau)';
    const statutHorsPlage = statut != null && (statut < 200 || statut >= 300);
    throw new Error(`${prefixe} ${statutHorsPlage ? `HTTP ${statut}` : 'reponse inattendue'} sur ${url}${detail}`);
}

// WordPress refuse une page au-dela de la derniere avec ce code. Ce n'est pas
// une panne mais une fin de liste : la boucle de pagination doit s'arreter au
// lieu d'invalider la collecte. Filet derriere doitDemanderPageSuivante, qui
// evite deja de demander cette page dans le cas courant -- il reste le cas ou
// le nombre d'items est un multiple exact de la taille de page.
const CODE_PAGE_HORS_BORNES = 'rest_post_invalid_page_number';

export function estFinDePagination(erreur) {
    return Boolean(erreur && typeof erreur.message === 'string' && erreur.message.includes(CODE_PAGE_HORS_BORNES));
}

// Une page incomplete est la derniere. La demander quand meme valait un 400
// systematique en fin de chaque categorie chez Taylor & Francis, avale en []
// et pris pour une fin de pagination : la boucle ne terminait que grace au
// repli muet qu'on vient de supprimer.
export function doitDemanderPageSuivante(nombreItems, taillePage) {
    return nombreItems > 0 && nombreItems >= taillePage;
}
