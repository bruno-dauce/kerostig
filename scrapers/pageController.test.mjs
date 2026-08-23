import test from 'node:test';
import assert from 'node:assert/strict';

import { estFichierScraper, retenirModulesValides } from './pageController.mjs';

// Le 23 aout 2026, emeraldScraper.test.mjs pose dans scrapers/journals a ete
// charge comme un scraper : il n'exporte pas scraperObject, la lecture de son
// abbreviation a leve, et le try/catch global de scrapeAll a avale l'erreur.
// integrateCalls n'a jamais tourne, le run n'a rien collecte.
test('ecarte un fichier de test du repertoire des scrapers', () => {
    assert.equal(estFichierScraper('emeraldScraper.test.mjs'), false);
});

test('retient un vrai fichier de scraper', () => {
    assert.equal(estFichierScraper('emeraldScraper.mjs'), true);
});

test('ecarte un fichier qui n est pas un module', () => {
    assert.equal(estFichierScraper('notes.md'), false);
});

test('retient un module qui expose un scraperObject utilisable', () => {
    const charges = [{ fichier: 'emeraldScraper.mjs', module: { scraperObject: { abbreviation: 'emerald' } } }];

    assert.equal(retenirModulesValides(charges).length, 1);
});

test('ecarte un module sans scraperObject au lieu de faire echouer tout le run', () => {
    const charges = [
        { fichier: 'emeraldScraper.mjs', module: { scraperObject: { abbreviation: 'emerald' } } },
        { fichier: 'helper.mjs', module: { uneAutreFonction: () => {} } },
    ];

    const retenus = retenirModulesValides(charges);

    assert.equal(retenus.length, 1);
    assert.equal(retenus[0].fichier, 'emeraldScraper.mjs');
});

test('ecarte un scraperObject prive d abbreviation', () => {
    const charges = [{ fichier: 'casse.mjs', module: { scraperObject: { url: 'https://exemple.test' } } }];

    assert.deepEqual(retenirModulesValides(charges), []);
});
