// Balises title et description d'une fiche appel, selon les gabarits de la
// strategie SEO (section 4) :
//   titre       : {titre de l'appel}, {revue} (call for papers)
//                 (appel clos : « (call for papers, clôturé) »)
//   description : Appel a publications de {revue}, rang FNEGE {rang}.
//                 Echeance : {date}. {acces}. Lien vers l'appel original.
//
// Avant, les 991 fiches portaient la meme phrase d'accroche, ou seul le titre
// changeait : ni la revue, ni le rang, ni l'echeance, ni « call for papers ».
// Deux appels au titre proche chez un meme editeur avaient des balises que
// rien ne distinguait.
//
// Fonctions pures : le filtre Eleventy (eleventy.config.mjs) ne fait que
// rassembler les donnees. Une donnee absente est omise de la phrase, jamais
// remplacee par une valeur par defaut.

import { DateTime } from 'luxon';

// Un titre qui dit deja « call for papers » ou « appel a... » n'a pas besoin
// qu'on le redise : la strategie demande des expressions integrees
// naturellement, jamais repetees mecaniquement (section 12).
const MENTION_APPEL = /\bcalls? for\b|\bappels? (?:à|a)(?=\s)|\bcfp\b/i;

function jourFrancais(iso) {
    if (typeof iso !== 'string' || iso === '') return null;
    const date = DateTime.fromISO(iso);
    // Meme rendu que le filtre dateOnly de la page. Une date inanalysable
    // (valeur aberrante de l'extraction) est omise plutot que ecrite en clair.
    return date.isValid ? date.setLocale('fr').toLocaleString(DateTime.DATE_FULL) : null;
}

// cloture : la strategie (section 4) demande la mention « clôturé » dans le
// titre comme dans la description d'un appel clos.
export function titreMetaAppel({ titre, nomRevue, cloture = false }) {
    const intitule = typeof titre === 'string' ? titre.trim() : '';
    const revue = typeof nomRevue === 'string' ? nomRevue.trim() : '';

    let resultat = intitule;
    // La revue figure parfois deja dans le titre de l'appel
    // (« Emerging Markets Review: Call for... ») : la redire ferait un doublon.
    if (revue && !intitule.toLowerCase().includes(revue.toLowerCase())) {
        resultat = resultat ? `${resultat}, ${revue}` : revue;
    }
    const mention = MENTION_APPEL.test(intitule);
    if (!mention) {
        const annexe = cloture ? 'call for papers, clôturé' : 'call for papers';
        resultat = resultat ? `${resultat} (${annexe})` : `Appel à publications (${annexe})`;
    } else if (cloture) {
        resultat = `${resultat} (clôturé)`;
    }
    return resultat;
}

// rangs : tableau de rangs FNEGE, en pratique un seul, deux pour une revue en
// conflit dans le classement (cf. le filtre rangsFnege).
// dansDoaj : true, false, ou null quand la donnee manque (champ dans_doaj absent).
export function descriptionMetaAppel({ nomRevue, rangs, echeance, cloture, dansDoaj, lienOriginal }) {
    const revue = typeof nomRevue === 'string' ? nomRevue.trim() : '';
    const rangsConnus = Array.isArray(rangs) ? rangs.filter((r) => typeof r === 'string' && r !== '') : [];

    let phrase = revue
        ? `Appel à publications de ${revue}`
        : 'Appel à publications en sciences de gestion et management';
    if (rangsConnus.length) phrase += `, rang FNEGE ${rangsConnus.join(' et ')}`;

    const phrases = [`${phrase}.`];

    const jour = jourFrancais(echeance);
    if (cloture) {
        phrases.push(jour ? `Appel clôturé, échéance du ${jour}.` : 'Appel clôturé.');
    } else if (jour) {
        phrases.push(`Échéance : ${jour}.`);
    }

    // Seule la presence au DOAJ est un fait etabli. Son absence ne dit pas que la
    // revue est sur abonnement (revue hybride, ou accès ouvert connu de la seule
    // base OpenAlex) : on l'ecrit comme telle, sans en deduire un modele d'acces.
    if (dansDoaj === true) phrases.push('Revue en accès ouvert (DOAJ).');
    else if (dansDoaj === false) phrases.push('Revue non référencée au DOAJ.');

    if (lienOriginal) phrases.push("Lien vers l'appel original.");

    return phrases.join(' ');
}
