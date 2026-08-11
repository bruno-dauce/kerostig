import { promises as fs } from 'fs';

import { parse } from './llmParser.mjs'
import { clean } from './dataPreparation.mjs';

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
