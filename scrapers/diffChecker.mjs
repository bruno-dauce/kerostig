import { promises as fs } from 'fs';

import { parse } from './llmParser.mjs'
import { clean } from './dataPreparation.mjs';
import { echeanceDepassee, joursDepuisEcheance } from './echeance.mjs';

// Delai apres l'echeance de soumission au-dela duquel un appel encore actif
// est archive d'office. Plus large que la tolerance d'affichage de 7 jours
// (eleventy.config.mjs) : on masque vite, on ne touche aux donnees qu'a coup sur.
const JOURS_APRES_ECHEANCE = 30;

// Un scraper qui alimentait la base et qui rentre brutalement bredouille a
// bien plus probablement echoue en silence (site injoignable, anti-bot, HTML
// refondu) qu'assiste au retrait simultane de tous ses appels. Des un appel
// actif au passage precedent contre zero au passage courant, on le signale et
// on gele ses appels au lieu de les archiver, la decision de vrai retrait
// restant humaine. Pas de seuil plancher : les petits producteurs (AFC, AGRH,
// DM, RE, SAGE) mouraient en silence tant qu'il en existait un.
// Le comptage cote ancien ne retient que les appels actifs : un scraper dont
// tous les appels sont deja archives n'a plus rien a perdre, il n'alerte donc
// qu'une fois, au passage ou il tombe.
// Fonction pure, exportee pour pouvoir etre testee isolement.
export function detecterScrapersVides(newCalls, oldCalls, ranAbbreviations) {
    if (!ranAbbreviations) return [];
    const compter = (calls) => {
        const total = new Map();
        for (const call of calls) {
            total.set(call.abbreviation, (total.get(call.abbreviation) || 0) + 1);
        }
        return total;
    };
    const nouveaux = compter(newCalls);
    const anciensActifs = compter(oldCalls.filter(call => call.active));
    return ranAbbreviations
        .filter(abbr => (nouveaux.get(abbr) || 0) === 0 && (anciensActifs.get(abbr) || 0) > 0)
        .map(abbr => ({ abbreviation: abbr, avant: anciensActifs.get(abbr) }));
}

// ranAbbreviations : abbreviations des scrapers effectivement lances ce run
// (cf pageController.mjs / --only). Un ancien appel dont l'abbreviation
// n'est pas dans cette liste vient d'un scraper qui n'a pas tourne cette
// fois -- on ne le touche pas (ni active:false, ni gracePeriod), sinon
// --only marque a tort tous les appels des autres scrapers comme disparus.
// null = comportement d'origine (tous les scrapers consideres comme lances).
export async function integrateCalls(newCalls, ranAbbreviations = null) {
    const now = new Date();
    let oldCalls = await readData();
    newCalls = await clean(newCalls);

    const scrapersVides = detecterScrapersVides(newCalls, oldCalls, ranAbbreviations);
    for (const { abbreviation, avant } of scrapersVides) {
        console.warn(`\n[ALERTE] ${abbreviation} : 0 appel remonte, contre ${avant} appel(s) actif(s) au passage precedent.`);
        console.warn(`[ALERTE] Ses ${avant} appel(s) actif(s) sont conserves tels quels, aucun n'est bascule en inactif.`);
        console.warn(`[ALERTE] A verifier a la main : vrai retrait de l'editeur, ou echec silencieux du scraper ?\n`);
    }
    // Le pipeline continue : on gele ces appels, on ne bloque pas le passage.
    const abbreviationsGelees = new Set(scrapersVides.map(s => s.abbreviation));

    const oldHashMap = new Map(oldCalls.map(call => [call.contentHash, call]));
    const oldSlugMap = new Map(oldCalls.map(call => [call.slug, call]));
    const newHashMap = new Map(newCalls.map(call => [call.contentHash, call]));
    const newSlugMap = new Map(newCalls.map(call => [call.slug, call]));

    let resultCalls = [];

    // Process new calls
    for (let newCall of newCalls) {
        if (oldHashMap.has(newCall.contentHash)) {
            // If hash exists, add existing call as is
            resultCalls.push({
                ...oldHashMap.get(newCall.contentHash),
                active: true // Ensure it's marked as active
            });
        } else {
            // Enrich call with unstructured data parsing
            newCall = await parse(newCall);
            
            if (oldSlugMap.has(newCall.slug)) {
                // If slug exists but hash is different, update the existing call
                resultCalls.push({
                    ...oldSlugMap.get(newCall.slug),
                    ...newCall,
                    active: true // Ensure it's marked as active
                });
            } else {
                // Completely new call
                resultCalls.push({
                    ...newCall,
                    active: true, // Ensure new calls are marked as active
                    pubDate: now
                });
            }
        }
    }

    // Handle existing calls that are no longer present in new calls
    for (const oldCall of oldCalls) {
        if (ranAbbreviations && !ranAbbreviations.includes(oldCall.abbreviation)) {
            // Scraper de cet appel non lance ce run (--only) : on le laisse tel quel.
            resultCalls.push(oldCall);
            continue;
        }
        if (abbreviationsGelees.has(oldCall.abbreviation)) {
            // Scraper lance mais rentre bredouille alors qu'il etait fourni :
            // meme traitement, on preserve l'existant en attendant l'arbitrage.
            resultCalls.push(oldCall);
            continue;
        }
        if (!newHashMap.has(oldCall.contentHash) &&
            !newSlugMap.has(oldCall.slug)) {
            // Call is not in new data, add it with active set to false
            resultCalls.push({
                ...oldCall,
                active: false,
                gracePeriod: oldCall.gracePeriod ? oldCall.gracePeriod : (new Date(new Date(now).setDate(now.getDate() + 30))).toISOString()
            });
        }
    }

    resultCalls.sort((a, b) => {
        return new Date(b.pubDate) - new Date(a.pubDate);
    });

    resultCalls = resultCalls.map(call => {
        if (call.active) {
            delete call.gracePeriod;
        }
        return call;
    });

    // Archivage par echeance depassee. Filet de securite pour les sources de
    // type archive permanente (RIPME, Decisions Marketing, Revue de
    // l'Entrepreneuriat), ou un appel ne disparait jamais et n'est donc jamais
    // rattrape par la logique de disparition ci-dessus. Les deux mecanismes
    // sont complementaires : celui-ci ne touche qu'aux appels dont l'echeance
    // de soumission est identifiee, l'autre couvre tous les autres cas.
    // S'applique volontairement a tous les appels, y compris ceux des scrapers
    // non lances ce run (--only) : une echeance passee ne depend pas de la source.
    // Pas de gracePeriod ici, l'appel est deja clos depuis un mois.
    resultCalls = resultCalls.map(call => {
        if (!call.active) return call;
        if (!echeanceDepassee(call, JOURS_APRES_ECHEANCE, now.getTime())) return call;
        const jours = joursDepuisEcheance(call, now.getTime());
        console.log(`[diffChecker] ${call.slug} marque inactif (echeance depassee depuis ${jours} jours)`);
        return { ...call, active: false };
    });

    await fs.writeFile("./www/_data/calls.json", JSON.stringify(resultCalls, null, 2), err => {
        if (err) {
            console.error(err);
        }
    });
}

async function readData() {
    try {
        const data = await fs.readFile("./www/_data/calls.json", { encoding: 'utf8' });
        return await JSON.parse(data);
    } catch (err) {
        console.log(err);
    }
}
