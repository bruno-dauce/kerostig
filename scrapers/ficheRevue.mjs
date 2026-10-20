// Logique d'une fiche revue : description de la page et revues voisines.
//
// Fonctions pures, le filtre Eleventy (eleventy.config.mjs) ne fait que
// rassembler les donnees. Une donnee absente est omise de la phrase, jamais
// remplacee par une valeur par defaut.

// Description d'une fiche revue, d'apres le gabarit de la strategie SEO
// (section 4) :
//   {revue} en {discipline}. Rang FNEGE 2025 : {rang}. {acces et APC}.
//   Depot HAL : {politique}. Calls for papers ouverts et archives.
//
// La section 4 de la strategie (v2) repartit les deux expressions cles : le
// titre de la page porte « appels à publications », cette description « call
// for papers ».
//
// Avant, la phrase etait la meme pour les 885 fiches (« accès ouvert et dépôt
// en archive ouverte »), sans dire ce que la revue offrait reellement.
//
// estOa : true, false, ou null quand ni OpenAlex ni DOAJ ne connaissent la
//   revue. null n'est pas « sur abonnement » : la phrase est omise.
// apc : { gratuit, montant, devise } ou null, comme dans acces_ouvert.apc.
// depotHal : true, false, ou null. Le champ vient d'Open Policy Finder
//   (depot_hal_possible) : Mir@bel ne publie aucune politique de depot par son
//   API, il ne peut donc pas l'alimenter. null (revue absente d'OPF, ou
//   politique sans detail exploitable) omet la phrase.
export function descriptionMetaRevue({ titre, discipline, rangs, estOa, apc, depotHal, nbAppelsOuverts, nbAppelsArchives }) {
    const nom = typeof titre === 'string' ? titre.trim() : '';
    const rangsConnus = Array.isArray(rangs) ? rangs.filter((r) => typeof r === 'string' && r !== '') : [];

    const phrases = [discipline ? `${nom} en ${discipline}.` : `${nom}.`];

    if (rangsConnus.length) phrases.push(`Rang FNEGE 2025 : ${rangsConnus.join(' et ')}.`);

    const apcPayant = apc && !apc.gratuit && apc.montant != null && apc.devise
        ? `APC ${apc.montant} ${apc.devise}`
        : null;
    if (estOa === true) {
        if (apc && apc.gratuit) phrases.push('Accès ouvert, sans frais de publication.');
        else if (apcPayant) phrases.push(`Accès ouvert, ${apcPayant}.`);
        else phrases.push('Accès ouvert.');
    } else if (estOa === false) {
        phrases.push(apcPayant ? `Sur abonnement, option hybride avec ${apcPayant}.` : 'Sur abonnement.');
    }

    if (depotHal === true) phrases.push('Dépôt HAL : possible.');
    else if (depotHal === false) phrases.push('Dépôt HAL : sous conditions.');

    // Le libelle suit ce que la fiche montre reellement : « ouverts et archives »
    // n'est pas ecrit pour une revue qui n'a ni l'un ni l'autre.
    if (nbAppelsOuverts > 0 && nbAppelsArchives > 0) phrases.push('Calls for papers ouverts et archivés.');
    else if (nbAppelsOuverts > 0) phrases.push('Calls for papers ouverts.');
    else if (nbAppelsArchives > 0) phrases.push('Calls for papers archivés.');
    else phrases.push('Calls for papers : aucun appel collecté pour le moment.');

    return phrases.join(' ');
}

// Les revues voisines d'une revue dans la liste de sa discipline (triee par
// rang puis par titre, cf revuesDeLaDiscipline) : une fenetre de `taille`
// revues autour d'elle, elle-meme exclue.
//
// Une fenetre glissante plutot que « les N premieres de la discipline » : la
// voisinage change d'une fiche a l'autre, donc chaque revue recoit des liens
// entrants depuis d'autres fiches, et pas seulement les premieres de la liste.
// Comme la liste est triee par rang, les voisines sont en grande partie du meme
// rang.
export function revuesVoisines(revuesTriees, slug, taille = 8) {
    if (!Array.isArray(revuesTriees)) return [];
    const i = revuesTriees.findIndex((r) => r.slug === slug);
    if (i === -1) return [];
    if (revuesTriees.length - 1 <= taille) return revuesTriees.filter((r) => r.slug !== slug);

    const fenetre = taille + 1;
    const debut = Math.min(Math.max(i - Math.floor(taille / 2), 0), revuesTriees.length - fenetre);
    return revuesTriees.slice(debut, debut + fenetre).filter((r) => r.slug !== slug);
}
