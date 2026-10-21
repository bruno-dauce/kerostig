// Echoue si une classe kc-* utilisee par le HTML du build n'a pas de regle dans le CSS
// compile. Les classes kc-* (carte d'appel) sont definies par @apply dans
// www/public/css/tailwind.css : une classe renommee d'un cote seulement, ou purgee par
// Tailwind, laisserait des cartes sans style sans qu'aucun test ne le voie.
// Usage : node scripts/verifier-classes-kc.mjs [dossier-public]
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Fonction pure, exportee pour test. Rend les classes kc-* du HTML absentes du CSS.
export function classesKcManquantes(htmls, css) {
    const utilisees = new Set();
    for (const html of htmls) {
        for (const attr of html.match(/\sclass="[^"]*"/g) ?? []) {
            for (const c of attr.slice(8, -1).split(/\s+/)) if (/^kc-[a-z0-9-]+$/.test(c)) utilisees.add(c);
        }
    }
    return [...utilisees].filter((c) => !css.includes(`.${c}`)).sort();
}

function fichiersHtml(dossier) {
    const sortie = [];
    for (const nom of readdirSync(dossier)) {
        const chemin = join(dossier, nom);
        if (statSync(chemin).isDirectory()) sortie.push(...fichiersHtml(chemin));
        else if (nom.endsWith('.html')) sortie.push(chemin);
    }
    return sortie;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const racine = process.argv[2] ?? './public';
    const css = readFileSync(join(racine, 'public/css/style.css'), 'utf8');
    const manquantes = classesKcManquantes(fichiersHtml(racine).map((f) => readFileSync(f, 'utf8')), css);
    if (manquantes.length) {
        console.error(`[classes-kc] ECHEC : classes absentes du CSS compile : ${manquantes.join(', ')}`);
        process.exit(1);
    }
    console.log('[classes-kc] toutes les classes kc-* du HTML ont une regle dans le CSS compile');
}
