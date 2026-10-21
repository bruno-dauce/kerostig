// Surveille le poids de l'accueil construit. Googlebot ne lit que les 2 097 152
// premiers octets (decompresses) d'un fichier HTML : au-dela, les derniers appels et le
// pied de page (donc ses liens) sont ignores.
//
// Comportement, selon l'endroit ou le script tourne :
// - build de production (Cloudflare Pages, `npm run build`) : AVERTISSEMENT bien
//   visible des 1 900 000 octets, jamais d'echec. Un build en echec laisse la
//   version precedente en ligne : le site se figerait, sans que rien ne previenne ;
// - verifications de PR (.github/workflows/verifications.yml) : POIDS_ACCUEIL_STRICT=1
//   fait echouer le script au-dela du seuil, pour que le depassement soit vu avant
//   la fusion ;
// - apres la collecte du lundi (scrape.yml, job verifier-poids) : STRICT et
//   POIDS_ACCUEIL_LIMITE=2097152, l'echec envoie un courriel GitHub.
// POIDS_ACCUEIL_LIMITE remplace le seuil par defaut.
//
// Usage : node scripts/verifier-poids-accueil.mjs [chemin]
import { statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Seuil par defaut : 1 900 000 octets decompresses, une marge de 197 152 sous la limite de
// Googlebot. L'accueil pese environ 1 485 000 octets a 656 cartes (2,2 Ko par carte).
export const SEUIL_OCTETS = 1_900_000;

// Fonction pure, exportee pour test. Rend { niveau, message } ; niveau vaut 'ok',
// 'avertissement' ou 'echec'. Le seuil depasse donne un avertissement, ou un echec en
// mode strict.
export function evaluerPoids(octets, { seuil = SEUIL_OCTETS, strict = false } = {}) {
    const detail = `${octets} octets decompresses (seuil ${seuil}, marge ${seuil - octets})`;
    if (octets <= seuil) return { niveau: 'ok', message: `accueil : ${detail}` };
    return {
        niveau: strict ? 'echec' : 'avertissement',
        message: `accueil : ${detail} -- DEPASSE de ${octets - seuil} octets`,
    };
}

// Lit un entier positif dans l'environnement, ou rend undefined.
function entier(valeur) {
    const n = Number(valeur);
    return Number.isInteger(n) && n > 0 ? n : undefined;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const chemin = process.argv[2] ?? './public/index.html';
    const strict = process.env.POIDS_ACCUEIL_STRICT === '1';
    const seuil = entier(process.env.POIDS_ACCUEIL_LIMITE) ?? SEUIL_OCTETS;
    const { niveau, message } = evaluerPoids(statSync(chemin).size, { seuil, strict });

    if (niveau === 'ok') {
        console.log(`[poids-accueil] ${message}`);
    } else {
        const consigne = niveau === 'echec'
            ? "ECHEC : l'accueil depasse le seuil (mode strict)."
            : "AVERTISSEMENT : l'accueil approche la limite de lecture de Googlebot (2 097 152 octets). Le build continue ; alleger l'accueil avant qu'il ne la depasse.";
        const barre = '!'.repeat(78);
        console.error(`${barre}\n[poids-accueil] ${consigne}\n[poids-accueil] ${message}\n${barre}`);
        // Annotation visible dans l'interface de GitHub Actions.
        if (process.env.GITHUB_ACTIONS === 'true') {
            console.error(`::${niveau === 'echec' ? 'error' : 'warning'} title=Poids de l'accueil::${message}`);
        }
        if (niveau === 'echec') process.exit(1);
    }
}
