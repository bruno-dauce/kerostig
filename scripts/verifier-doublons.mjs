// Repere les groupes d'appels de calls.json qui semblent etre le meme appel
// vu deux fois, sous trois criteres independants :
//   - URL normalisee identique (hote sans www, chemin, sans requete ni ancre) ;
//   - meme revue (ISSN) et meme titre normalise ;
//   - meme revue (ISSN) et meme echeance principale de soumission.
// Chaque groupe est ensuite classe : signal principal = URL normalisee +
// ISSN (fiable), jamais le champ "title" (paraphrase du LLM, qui peut varier
// entre deux extractions du meme contenu -- vu sur elsevier/jsis "india-at-
// the-intersection", meme URL et memes revues mais "title" different).
//
// Lecture seule : n'ecrit jamais dans calls.json.
//
// Usage : node scripts/verifier-doublons.mjs
import { promises as fs } from 'fs';

import { echeanceSoumission } from '../scrapers/echeance.mjs';
import { normaliserUrl } from '../scrapers/url.mjs';

// Abbreviations dont le scraper a ete supprime le 2026-08-11 (commit
// 6fb0e704c) : leurs appels ne sont plus jamais retraites, un doublon avec
// un scraper actuel n'y sera donc jamais resolu tout seul.
const ABBREVIATIONS_HERITEES = new Set([
    'misq', 'jmis', 'jsis', 'jais', 'ejis', 'isr', 'isj', 'dss', 'ijim', 'jasist', 'io', 'im', 'jit',
]);

function normaliserTitre(texte) {
    if (typeof texte !== 'string') return '';
    return texte
        .toLowerCase()
        .replace(/['’‘"“”«»]/g, ' ')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function ajouter(map, cle, call) {
    if (cle === null || cle === '') return;
    if (!map.has(cle)) map.set(cle, []);
    map.get(cle).push(call);
}

function estMixte(groupe) {
    const abbrs = new Set(groupe.map((c) => c.abbreviation));
    const aHerite = [...abbrs].some((a) => ABBREVIATIONS_HERITEES.has(a));
    const aActuel = [...abbrs].some((a) => !ABBREVIATIONS_HERITEES.has(a));
    return aHerite && aActuel;
}

async function main() {
    const calls = JSON.parse(await fs.readFile('./www/_data/calls.json', 'utf8'));

    const parUrl = new Map();
    const parTitreRevue = new Map();
    const parEcheanceRevue = new Map();

    for (const call of calls) {
        ajouter(parUrl, normaliserUrl(call.url), call);

        const titre = normaliserTitre(call.title || call.metaTitle);
        if (titre) ajouter(parTitreRevue, `${call.issn || ''}::${titre}`, call);

        const echeance = echeanceSoumission(call);
        if (echeance !== null) ajouter(parEcheanceRevue, `${call.issn || ''}::${echeance}`, call);
    }

    // Fusionne les groupes qui partagent exactement le meme ensemble de slugs,
    // quel que soit le critere qui les a reperes, pour ne pas afficher deux
    // fois la meme paire d'appels sous deux motifs differents.
    const parCleSlugs = new Map();
    function fusionner(map, motif) {
        for (const groupe of map.values()) {
            if (groupe.length < 2) continue;
            const cle = groupe.map((c) => c.slug).sort().join('|');
            if (!parCleSlugs.has(cle)) parCleSlugs.set(cle, { groupe, motifs: new Set() });
            parCleSlugs.get(cle).motifs.add(motif);
        }
    }
    fusionner(parUrl, 'URL identique');
    fusionner(parTitreRevue, 'titre + revue identiques');
    fusionner(parEcheanceRevue, 'revue + echeance identiques');

    const tousLesGroupes = [...parCleSlugs.values()];

    function classer(entree) {
        const { groupe, motifs } = entree;
        const issns = new Set(groupe.map((c) => c.issn));
        const urls = new Set(groupe.map((c) => normaliserUrl(c.url)));
        const metaTitresNorm = new Set(groupe.map((c) => normaliserTitre(c.metaTitle)));
        const mixte = estMixte(groupe);

        if (urls.size === 1) {
            if (metaTitresNorm.size > 1) {
                // Meme URL, contenus differents. Un groupe de seulement deux
                // appels reste un doublon probable dont le titre a change a
                // la source entre les deux extractions (ex. CUP "Risk
                // Sharing" -> "Risk Sharing (CLOSED)") : a verifier a la main.
                // Un groupe plus large (3+) trahit plutot une page hub/liste
                // partagee par plusieurs appels reellement distincts (ex.
                // INFORMS, une seule URL pour toutes ses revues).
                return groupe.length === 2
                    ? { categorie: 'A VERIFIER', detail: 'doublon probable, titre modifie a la source entre les deux extractions' }
                    : { categorie: 'FAUX POSITIF', detail: 'page hub/liste partagee par des appels de contenu different' };
            }
            // Meme URL, meme contenu (metaTitle) : le meme appel reel. Le nom
            // de revue (pas l'ISSN, souvent absent cote scraper herite,
            // cf issn-bogus-ecological-economics) tranche entre "meme revue"
            // (doublon a fusionner) et "revues distinctes" (numero conjoint).
            const journaux = new Set(groupe.map((c) => normaliserTitre(c.journal || '')));
            if (journaux.size === 1) {
                return mixte
                    ? { categorie: 'DOUBLON HERITE', detail: 'meme revue/URL/contenu, scraper herite + scraper actuel' }
                    : { categorie: 'DOUBLON ACTIF', detail: 'meme revue/URL/contenu, slug -2 ou variante' };
            }
            return { categorie: 'APPEL CONJOINT', detail: 'meme URL/contenu, revues differentes (special issue partagee) : pas un doublon' };
        }

        // URL differente dans le groupe : repli sur metaTitle (texte brut,
        // plus stable que "title" qui est une paraphrase LLM).
        if (issns.size === 1 && metaTitresNorm.size === 1) {
            return { categorie: 'A VERIFIER', detail: 'meme revue/metaTitle, URL differentes (deux pages pour le meme appel ?)' };
        }
        if (motifs.has('revue + echeance identiques') && motifs.size === 1) {
            return { categorie: 'FAUX POSITIF', detail: 'meme revue/echeance, contenus differents (coincidence de date)' };
        }
        return { categorie: 'A VERIFIER', detail: 'cas non classe' };
    }

    const classes = new Map();
    for (const entree of tousLesGroupes) {
        const { categorie, detail } = classer(entree);
        const cle = `${categorie} -- ${detail}`;
        if (!classes.has(cle)) classes.set(cle, []);
        classes.get(cle).push(entree);
    }

    const total = tousLesGroupes.length;
    const reels = tousLesGroupes.filter((e) => classer(e).categorie.startsWith('DOUBLON')).length;
    console.log(`Total : ${total} groupe(s) de doublons potentiels sur ${calls.length} appels`);
    console.log(`  dont ${reels} vrai(s) doublon(s) (DOUBLON HERITE ou DOUBLON ACTIF)\n`);

    for (const [cle, entrees] of [...classes.entries()].sort((a, b) => b[1].length - a[1].length)) {
        console.log(`=== ${cle} (${entrees.length}) ===`);
        for (const e of entrees) {
            for (const c of e.groupe) {
                console.log(`  [${c.abbreviation}]${ABBREVIATIONS_HERITEES.has(c.abbreviation) ? ' (herite)' : ''} ${c.active ? 'actif ' : 'archive'} | ${c.slug}`);
                console.log(`      ${c.journal} | ${c.url || '(pas d url)'}`);
            }
            console.log('');
        }
    }
}

main();
