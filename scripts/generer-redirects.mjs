// Genere public/_redirects (Cloudflare Pages) a partir de la table versionnee
// enrichissement/redirections.json. Redirections permanentes (301) : les
// anciennes fiches fusionnees ne reviendront pas.
//
// Chaque entree ecrit deux lignes, avec et sans barre oblique finale : le
// reglage "trailing slash" du projet Cloudflare Pages n'est pas verifiable
// depuis ce depot, on couvre les deux formes plutot que d'en dependre.
//
// A executer apres le build Eleventy (qui cree public/) : cf le script
// "build" de package.json.
// Usage : node scripts/generer-redirects.mjs
import { promises as fs } from 'fs';

const SOURCE = './enrichissement/redirections.json';
const SORTIE = './public/_redirects';

// Fonction pure, exportee pour test.
export function formaterRedirects(redirections) {
    const lignes = [];
    for (const { de, vers } of redirections) {
        lignes.push(`/call/${de} /call/${vers} 301`);
        lignes.push(`/call/${de}/ /call/${vers} 301`);
    }
    return lignes.join('\n') + (lignes.length ? '\n' : '');
}

async function main() {
    const { redirections } = JSON.parse(await fs.readFile(SOURCE, 'utf8'));
    await fs.writeFile(SORTIE, formaterRedirects(redirections));
    console.log(`[redirects] ${redirections.length} redirection(s) ecrite(s) dans ${SORTIE}`);
}

main();
