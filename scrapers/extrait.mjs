// Borne d'affichage du texte d'un appel.
//
// Le texte d'un appel appartient a son editeur : kerostig en publie un extrait
// et renvoie vers l'original, jamais l'integralite (cf. /terms, « le texte
// integral des appels n'est pas reproduit »). Le prompt de llmParser.mjs
// demande desormais un resume et non une copie, mais cela ne suffit pas :
// le contentHash de diffChecker porte sur le rawContent de la source, si bien
// qu'un appel deja stocke ne repasse jamais par le modele tant que sa page
// d'origine ne bouge pas. Les 703 appels collectes avant ce changement gardent
// donc leur description verbatim dans calls.json, parfois plus de 13 000
// caracteres. La borne est appliquee ici, a l'affichage, pour couvrir cet
// existant sans re-extraction payante ni reecriture des donnees stockees.
//
// Un seul module pour les trois consommateurs (fiche appel, JSON-LD, flux
// RSS) : la promesse faite dans /terms ne doit pas dependre de la surface par
// laquelle le lecteur arrive.

// Assez pour comprendre de quoi parle l'appel et decider de suivre le lien,
// trop peu pour dispenser d'aller le lire. Vaut pour l'ensemble des
// paragraphes retenus, pas pour chacun.
export const LIMITE_EXTRAIT_CARACTERES = 1200;

// Le JSON-LD n'a pas les memes besoins : schema.org attend une description
// courte, et un moteur qui reprend le champ tel quel afficherait un pave.
export const LIMITE_RESUME_CARACTERES = 300;

const ELLIPSE = '…';

// Coupe sur une frontiere de mot pour ne pas laisser un fragment de mot en
// fin d'extrait. Le repli sur la coupe nette couvre le paragraphe sans espace
// dans la fenetre (jeton unique, langue non segmentee) : mieux vaut un extrait
// brutal qu'un extrait vide. Le seuil de la moitie evite de remonter jusqu'au
// debut du texte quand le seul espace disponible est tres en amont.
function couperSurUnMot(texte, limite) {
    const fenetre = texte.slice(0, limite);
    const dernierEspace = fenetre.lastIndexOf(' ');
    const coupe = dernierEspace > limite / 2 ? fenetre.slice(0, dernierEspace) : fenetre;
    return coupe.replace(/[\s.,;:–—-]+$/, '') + ELLIPSE;
}

// Rend { paragraphes, tronque }. tronque:true signale a l'appelant qu'il doit
// afficher le renvoi vers l'appel d'origine : sans ce drapeau, un extrait se
// lit comme un texte complet.
//
// Les paragraphes sont retenus entiers tant qu'ils tiennent dans la borne :
// couper au caractere pres donnerait des extraits qui s'arretent au milieu
// d'une phrase alors que le paragraphe suivant aurait tenu. Seul le premier
// paragraphe peut etre coupe, et seulement s'il depasse a lui seul la borne.
export function extraireDescription(paragraphes, limite = LIMITE_EXTRAIT_CARACTERES) {
    const source = Array.isArray(paragraphes)
        ? paragraphes.filter(p => typeof p === 'string' && p.trim() !== '')
        : [];
    if (source.length === 0) return { paragraphes: [], tronque: false };

    const retenus = [];
    let total = 0;
    for (const paragraphe of source) {
        if (retenus.length === 0) {
            if (paragraphe.length > limite) {
                return { paragraphes: [couperSurUnMot(paragraphe, limite)], tronque: true };
            }
            retenus.push(paragraphe);
            total = paragraphe.length;
            continue;
        }
        if (total + paragraphe.length > limite) break;
        retenus.push(paragraphe);
        total += paragraphe.length;
    }
    return { paragraphes: retenus, tronque: retenus.length < source.length };
}

// Version d'une seule traite, pour le JSON-LD et tout consommateur qui attend
// une chaine plutot qu'une liste.
export function resumerDescription(description, limite = LIMITE_RESUME_CARACTERES) {
    const paragraphes = description && description.paragraphs;
    const { paragraphes: retenus } = extraireDescription(paragraphes, limite);
    return retenus.length ? retenus.join(' ') : null;
}

// L'URL de l'appel chez son editeur, ou null quand il n'y en a pas
// d'exploitable. calls.json en compte trois au 2026-09-03 : une chaine vide
// (MIS Quarterly) et deux « mailto: » (INFORMS). Sans ce filtre, un renvoi
// « lire l'appel complet » pointerait vers la page courante ou ouvrirait un
// client de messagerie.
export function lienSourceOriginale(call) {
    const url = call && typeof call.url === 'string' ? call.url.trim() : '';
    return /^https?:\/\//i.test(url) ? url : null;
}
