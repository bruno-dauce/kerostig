// Echoue si l'accueil construit depasse la borne de poids. Googlebot ne lit que
// les 2 097 152 premiers octets (decompresses) d'un fichier HTML : au-dela, les
// derniers appels et le pied de page (donc ses liens) sont ignores. La borne est
// verifiee a chaque build, avant le deploiement.
// Usage : node scripts/verifier-poids-accueil.mjs [chemin]
import { statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Borne : 1 900 000 octets decompresses, soit une marge de 197 152 sous les 2 097 152
// de Googlebot. L'accueil pese 1 484 848 octets a 656 cartes (2,2 Ko par carte) : la
// borne laisse la place a environ 190 cartes de plus.
export const LIMITE_OCTETS = 1_900_000;

// Fonction pure, exportee pour test.
export function verifierPoids(octets, limite = LIMITE_OCTETS) {
    return {
        ok: octets <= limite,
        message: `accueil : ${octets} octets decompresses (borne ${limite}, marge ${limite - octets})`,
    };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const chemin = process.argv[2] ?? './public/index.html';
    const { ok, message } = verifierPoids(statSync(chemin).size);
    console.log(`[poids-accueil] ${message}`);
    if (!ok) {
        console.error("[poids-accueil] ECHEC : l'accueil depasse la borne, le deploiement est bloque.");
        process.exit(1);
    }
}
