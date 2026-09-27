import test from 'node:test';
import assert from 'node:assert/strict';

import { consommation, formaterConsommation, parseFuzzyDate, normaliserDateFloue } from './llmParser.mjs';

// Le cout d'une reextraction se lit sur le run : cumul des tokens affiche en
// fin de pipeline par pageController.

test('le cumul part de zero', () => {
    assert.deepEqual(consommation, { appels: 0, entree: 0, sortie: 0 });
});

test('le bilan de consommation donne les appels et les tokens', () => {
    assert.equal(
        formaterConsommation({ appels: 3, entree: 12000, sortie: 1500 }, 'claude-haiku-4-5-20251001'),
        '[llm] 3 appel(s) au modele claude-haiku-4-5-20251001 : 12000 tokens en entree, 1500 en sortie',
    );
    assert.match(formaterConsommation({ appels: 0, entree: 0, sortie: 0 }), /^\[llm\] 0 appel\(s\) au modele : 0 tokens/);
});

// Constate le 2026-09-27 en lisant les PDF Wiley : deux echeances devenaient
// null, et un appel clos sans echeance connue redevient actif.
//  - pdfjs coupe un nom de mois selon le crenage du PDF : « Ma rch 31, 2025 »
//    (Thunderbird International Business Review). Recolle avant chrono, qui
//    lit sinon « Sept ember 15 » comme le 1er septembre ;
//  - la source porte un jour hors calendrier : « 31 April 2026 » (Human
//    Resource Management), borne au dernier jour du mois.

const jour = d => d && d.toISOString().slice(0, 10);

test('un nom de mois coupe par pdfjs est recolle', async () => {
    assert.equal(jour(await parseFuzzyDate('Ma rch 31, 2025')), '2025-03-31');
    assert.equal(jour(await parseFuzzyDate('Sept ember 15, 2026')), '2026-09-15');
    assert.equal(normaliserDateFloue('Ma rch 31, 2025'), 'march 31, 2025');
});

test('un jour hors calendrier est borne au dernier jour du mois', async () => {
    assert.equal(jour(await parseFuzzyDate('31 April 2026')), '2026-04-30');
    assert.equal(jour(await parseFuzzyDate('April 31, 2026')), '2026-04-30');
    assert.equal(jour(await parseFuzzyDate('30 February 2027')), '2027-02-28');
    assert.equal(jour(await parseFuzzyDate('29 February 2028')), '2028-02-29', 'annee bissextile');
});

test('une date deja lue par chrono ne change pas', async () => {
    assert.equal(jour(await parseFuzzyDate('March 31, 2025')), '2025-03-31');
    assert.equal(jour(await parseFuzzyDate('End of October, 2026')), '2026-10-01');
    assert.equal(jour(await parseFuzzyDate('31 decembre 2026')), '2026-12-31', 'repli francais conserve');
});

test('une chaine sans date reste sans date', async () => {
    assert.equal(await parseFuzzyDate('To be announced'), null);
    assert.equal(await parseFuzzyDate('Anticipated publication'), null);
});
