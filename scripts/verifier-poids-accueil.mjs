// Echoue si l'accueil construit depasse la borne de poids. Googlebot ne lit que
// les 2 097 152 premiers octets (decompresses) d'un fichier HTML : au-dela, les
// derniers appels et le pied de page (donc ses liens) sont ignores. La borne est
// verifiee a chaque build, avant le deploiement.
// Usage : node scripts/verifier-poids-accueil.mjs [chemin]
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Borne : 1 900 000 octets decompresses, soit une marge de 197 152 sous les 2 097 152
// de Googlebot. L'accueil pese 1 484 848 octets a 656 cartes (2,2 Ko par carte) : la
// borne laisse la place a environ 190 cartes de plus.
export const LIMITE_OCTETS = 1_900_000;

// Position (en octets) du premier lien /discipline/ du pied de page : au-dela de la
// meme borne, Googlebot ne voit plus ces liens. Les liens des cartes et des filtres
// ne comptent pas : seul le pied de page est un acces HTML sur a toutes les pages hub.
export const LIMITE_LIEN_DISCIPLINE = LIMITE_OCTETS;

// Fonction pure, exportee pour test.
export function verifierPoids(octets, limite = LIMITE_OCTETS) {
    return {
        ok: octets <= limite,
        message: `accueil : ${octets} octets decompresses (borne ${limite}, marge ${limite - octets})`,
    };
}

// Fonction pure, exportee pour test. Retourne la position en octets du premier lien
// /discipline/ situe apres l'ouverture du pied de page, ou null s'il n'y en a pas.
export function positionLienDisciplinePied(html) {
    const tampon = Buffer.isBuffer(html) ? html : Buffer.from(html, 'utf8');
    const pied = tampon.indexOf('<footer');
    if (pied === -1) return null;
    const lien = tampon.indexOf('/discipline/', pied);
    return lien === -1 ? null : lien;
}

export function verifierLienDiscipline(position, limite = LIMITE_LIEN_DISCIPLINE) {
    if (position === null) {
        return { ok: false, message: 'pied de page : aucun lien /discipline/ trouve' };
    }
    return {
        ok: position <= limite,
        message: `pied de page : premier lien /discipline/ a l'octet ${position} (borne ${limite}, marge ${limite - position})`,
    };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const chemin = process.argv[2] ?? './public/index.html';
    const tampon = readFileSync(chemin);
    const poids = verifierPoids(tampon.length);
    const lien = verifierLienDiscipline(positionLienDisciplinePied(tampon));
    console.log(`[poids-accueil] ${poids.message}`);
    console.log(`[poids-accueil] ${lien.message}`);
    if (!poids.ok) {
        console.error("[poids-accueil] ECHEC : l'accueil depasse la borne, le deploiement est bloque.");
    }
    if (!lien.ok) {
        console.error("[poids-accueil] ECHEC : les liens de discipline du pied de page sont hors de portee de Googlebot, le deploiement est bloque.");
    }
    if (!poids.ok || !lien.ok) process.exit(1);
}
