import test from 'node:test';
import assert from 'node:assert/strict';

import { lireTotalAnnonce, evaluerCollecte } from './emeraldScraper.mjs';

// Chaines relevees sur le site le 2026-08-23, element .sr-statistics.
test('lit le total annonce sur une page de liste pleine', () => {
    assert.equal(lireTotalAnnonce('1-6 of 209'), 209);
});

test('lit le total annonce sur la page vide qui suit la derniere', () => {
    assert.equal(lireTotalAnnonce('589-209 of 209'), 209);
});

test('ne lit aucun total quand le compteur est absent', () => {
    assert.equal(lireTotalAnnonce(''), null);
    assert.equal(lireTotalAnnonce(null), null);
});

test('tient une collecte complete pour valide', () => {
    const bilan = evaluerCollecte({ cartesCollectees: 209, totalAnnonce: 209, echec: false });

    assert.equal(bilan.complet, true);
});

test('rejette la collecte des qu une page a echoue', () => {
    const bilan = evaluerCollecte({ cartesCollectees: 42, totalAnnonce: 209, echec: true });

    assert.equal(bilan.complet, false);
    assert.match(bilan.motif, /echec/i);
});

test('rejette une collecte tronquee sous le total annonce', () => {
    const bilan = evaluerCollecte({ cartesCollectees: 42, totalAnnonce: 209, echec: false });

    assert.equal(bilan.complet, false);
    assert.match(bilan.motif, /42/);
    assert.match(bilan.motif, /209/);
});

test('tolere un total annonce illisible plutot que de tout jeter', () => {
    // Le compteur est un filet, pas une condition : s'il disparait du gabarit,
    // une collecte sans echec de page reste exploitable.
    const bilan = evaluerCollecte({ cartesCollectees: 209, totalAnnonce: null, echec: false });

    assert.equal(bilan.complet, true);
});

test('accepte une collecte au-dessus du total annonce', () => {
    // Un appel publie pendant la pagination decale le compteur lu en page 1.
    const bilan = evaluerCollecte({ cartesCollectees: 210, totalAnnonce: 209, echec: false });

    assert.equal(bilan.complet, true);
});
