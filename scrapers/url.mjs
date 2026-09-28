// Normalisation d'URL pour comparaison d'identite : deduplication en amont
// (dataPreparation.mjs) et detection de doublons en aval (scripts/verifier-
// doublons.mjs). Hote sans www, chemin sans slash final, sans requete ni
// ancre -- deux liens vers la meme page avec un simple parametre de tracking
// different (dgcid, etc.) doivent se reconnaitre comme identiques.
// Retourne null si l'URL est absente ou invalide : jamais une cle vide qui
// ferait collisionner par erreur des appels sans URL entre eux.
export function normaliserUrl(url) {
    if (typeof url !== 'string' || url.trim() === '') return null;
    try {
        const u = new URL(url.trim());
        const chemin = u.pathname.toLowerCase().replace(/\/+$/, '');
        return `${u.hostname.toLowerCase().replace(/^www\./, '')}${chemin}`;
    } catch {
        return null;
    }
}
