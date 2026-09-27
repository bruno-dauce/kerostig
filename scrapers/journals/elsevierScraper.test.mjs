import test from 'node:test';
import assert from 'node:assert/strict';

import { fusionnerChargements } from './elsevierScraper.mjs';

const carte = (id, journal = 'Journal of Business Venturing') => ({
    url: `https://www.sciencedirect.com/special-issue/${id}/titre`,
    journal,
    metaTitle: `Appel ${id}`,
    deadline: null,
});

// Motif mesure le 2026-09-27 : la variante courte est un sous-ensemble strict
// de la complete, amputee au milieu de la liste et pas seulement a la fin.
const COMPLETE = [carte(1), carte(2), carte(3), carte(4), carte(5)];
const AMPUTEE = [carte(1), carte(3), carte(5)];

test('retrouve la liste complete si un seul chargement l a servie', () => {
    const { listings, complet } = fusionnerChargements([AMPUTEE, AMPUTEE, COMPLETE, AMPUTEE]);

    assert.deepEqual(listings.map(l => l.url), COMPLETE.map(l => l.url));
    assert.equal(complet, true);
});

test('garde l ordre du hub, celui du plus gros chargement', () => {
    const { listings } = fusionnerChargements([AMPUTEE, COMPLETE]);

    assert.deepEqual(listings.map(l => l.metaTitle), ['Appel 1', 'Appel 2', 'Appel 3', 'Appel 4', 'Appel 5']);
});

test('conserve un numero conjoint sous chacune de ses revues', () => {
    const conjoint = [carte(270379, 'Emerging Markets Review'), carte(270379, 'Finance Research Letters')];

    const { listings } = fusionnerChargements([conjoint, conjoint]);

    assert.deepEqual(listings.map(l => l.journal), ['Emerging Markets Review', 'Finance Research Letters']);
});

test('signale une fusion plus grande que tout chargement pris seul', () => {
    const { listings, complet, maxChargement } = fusionnerChargements([[carte(1), carte(2)], [carte(1), carte(3)]]);

    assert.equal(listings.length, 3);
    assert.equal(maxChargement, 2);
    assert.equal(complet, false);
});

test('rend une liste vide si tous les chargements ont echoue, pour que le gel joue', () => {
    const { listings, complet } = fusionnerChargements([[], [], []]);

    assert.deepEqual(listings, []);
    assert.equal(complet, true);
});

test('ignore les cartes sans URL', () => {
    const { listings } = fusionnerChargements([[{ ...carte(1), url: null }, carte(2)]]);

    assert.deepEqual(listings.map(l => l.metaTitle), ['Appel 2']);
});
