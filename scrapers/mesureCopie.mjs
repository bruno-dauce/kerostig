// Mesure le taux de copie d'une description par rapport au texte source dont
// elle est censee etre un resume : la part de ses sequences de 8 mots
// consecutifs qu'on retrouve telles quelles dans la source, texte normalise
// (minuscules, ponctuation et espaces simplifies).
//
// Sert au garde-fou de llmParser.mjs (relance si le taux depasse un seuil) et
// au controle a froid : mesure faite le 2026-09-27 sur les 227 appels actifs
// extraits depuis le correctif du prompt (2026-09-03, commit fc9899224) --
// taux maximal observe 13,3 %, tres en dessous des 30 % retenus comme seuil.
// A rejouer apres la reextraction du meme lot pour verifier que le garde-fou
// tient sa promesse.

const LONGUEUR_SEQUENCE = 8;

// Fonction pure, exportee pour test.
export function normaliserTexte(texte) {
    return (texte || '')
        .toLowerCase()
        .replace(/['’‘"“”«»]/g, ' ')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function mots(texteNormalise) {
    return texteNormalise.length ? texteNormalise.split(' ') : [];
}

function sequences(motsListe, taille = LONGUEUR_SEQUENCE) {
    const resultat = [];
    for (let i = 0; i + taille <= motsListe.length; i++) {
        resultat.push(motsListe.slice(i, i + taille).join(' '));
    }
    return resultat;
}

// Texte brut d'une description, telle que stockee dans calls.json ou telle
// que la rend le modele (meme forme : { paragraphs: [...] }).
// Fonction pure, exportee pour test.
export function descriptionEnTexte(description) {
    if (!description) return '';
    if (typeof description === 'string') return description;
    if (Array.isArray(description.paragraphs)) return description.paragraphs.join(' ');
    return '';
}

// Rend un nombre entre 0 et 1, ou null si la description a moins de
// LONGUEUR_SEQUENCE mots -- aucune sequence de 8 mots n'est alors possible, et
// rendre 0 laisserait croire a une reformulation verifiee plutot qu'a une
// mesure inapplicable.
// Fonction pure, exportee pour test.
export function tauxDeCopie(descriptionTexte, sourceTexte) {
    const motsDesc = mots(normaliserTexte(descriptionTexte));
    if (motsDesc.length < LONGUEUR_SEQUENCE) return null;

    const seqDesc = sequences(motsDesc);
    const seqSource = new Set(sequences(mots(normaliserTexte(sourceTexte))));

    const copiees = seqDesc.filter((s) => seqSource.has(s)).length;
    return copiees / seqDesc.length;
}
