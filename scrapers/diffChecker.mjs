import { promises as fs } from 'fs';

import { parse } from './llmParser.mjs'
import { clean } from './dataPreparation.mjs';
import { echeanceDepassee, joursDepuisEcheance } from './echeance.mjs';

// Delai apres l'echeance de soumission au-dela duquel un appel encore actif
// est archive d'office. Plus large que la tolerance d'affichage de 7 jours
// (eleventy.config.mjs) : on masque vite, on ne touche aux donnees qu'a coup sur.
const JOURS_APRES_ECHEANCE = 30;

// Une remontee amputee de plus de la moitie est traitee comme un echec, pas
// comme un retrait. Seuil calibre sur l'historique du depot : la variation de
// routine d'un scraper d'un passage a l'autre vaut 1 a 3 appels. Les grosses
// chutes constatees (ojsfr 8->2, sage 51->42) viennent de l'archivage par
// echeance, qui opere en aval de cette detection sur resultCalls -- elles ne
// remontent donc jamais ici et ne peuvent pas declencher de faux positif.
const CHUTE_RATIO = 0.5;
// Plancher absolu, pour que les petits producteurs (AFC, DM, RE) ne soient pas
// geles sur un depart d'un ou deux appels, ou la moitie est vite atteinte.
const CHUTE_PLANCHER = 5;

// Un scraper qui alimentait la base et qui rentre brutalement bredouille a
// bien plus probablement echoue en silence (site injoignable, anti-bot, HTML
// refondu) qu'assiste au retrait simultane de tous ses appels. Des un appel
// actif au passage precedent contre zero au passage courant, on le signale et
// on gele ses appels au lieu de les archiver, la decision de vrai retrait
// restant humaine. Pas de seuil plancher sur ce cas : les petits producteurs
// (AFC, AGRH, DM, RE, SAGE) mouraient en silence tant qu'il en existait un.
// Meme traitement pour une chute brutale sans aller jusqu'a zero (motif
// 'chute') : une pagination interrompue en cours de route rendait une liste
// tronquee, et les appels manquants partaient en archive sans un mot parce que
// seul le zero exact etait surveille.
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
        .map(abbr => ({
            abbreviation: abbr,
            avant: anciensActifs.get(abbr) || 0,
            apres: nouveaux.get(abbr) || 0,
        }))
        .filter(({ avant, apres }) => {
            if (avant === 0) return false;
            if (apres === 0) return true;
            return apres < avant * CHUTE_RATIO && avant - apres >= CHUTE_PLANCHER;
        })
        .map(compte => ({ ...compte, motif: compte.apres === 0 ? 'zero' : 'chute' }));
}

// Un appel issu d'une source de type archive permanente (CUP, Decisions
// Marketing, Revue de l'Entrepreneuriat, RIPME) est re-remonte a chaque
// passage : la boucle des nouveaux le repositionne en active:true, puis
// l'archivage par echeance le rebascule aussitot en false. L'etat sur disque
// ne bouge pas d'un run a l'autre, mais le message d'archivage se repetait
// chaque fois -- 34 lignes le 2026-08-24, dont une pour un appel clos depuis
// 646 jours. A la lecture du log, cela donnait une hecatombe quotidienne la
// ou il ne se passait rien. On ne journalise donc que le premier archivage,
// celui qui change reellement l'etat. Fonction pure, exportee pour test.
export function estNouvelArchivage(ancienAppel) {
    return !ancienAppel || ancienAppel.active !== false;
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
    for (const { abbreviation, avant, apres, motif } of scrapersVides) {
        const constat = motif === 'zero'
            ? `0 appel remonte, contre ${avant} appel(s) actif(s) au passage precedent`
            : `${apres} appel(s) remontes seulement, contre ${avant} actif(s) au passage precedent`;
        console.warn(`\n[ALERTE] ${abbreviation} : ${constat}.`);
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
            // Sur un gel pour cause de chute, une partie des appels est bien
            // remontee et a deja ete reprise par la boucle des nouveaux : sans
            // ce garde, on la reinjecterait ici en double. Le cas 'zero' n'est
            // pas concerne, ses deux maps sont vides pour cette abbreviation.
            if (newHashMap.has(oldCall.contentHash) || newSlugMap.has(oldCall.slug)) continue;
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
        if (estNouvelArchivage(oldSlugMap.get(call.slug))) {
            const jours = joursDepuisEcheance(call, now.getTime());
            console.log(`[diffChecker] ${call.slug} marque inactif (echeance depassee depuis ${jours} jours)`);
        }
        return { ...call, active: false };
    });

    await fs.writeFile("./www/_data/calls.json", JSON.stringify(resultCalls, null, 2), err => {
        if (err) {
            console.error(err);
        }
    });

    // Rendu a l'appelant : pageController en fait un resume visible sur la
    // page du run, et decide s'il faut faire echouer le passage. Les alertes
    // ne vivaient jusqu'ici que dans un console.warn noye dans le log.
    return scrapersVides;
}

async function readData() {
    try {
        const data = await fs.readFile("./www/_data/calls.json", { encoding: 'utf8' });
        return await JSON.parse(data);
    } catch (err) {
        console.log(err);
    }
}
