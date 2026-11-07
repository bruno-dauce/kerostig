import test from 'node:test';
import assert from 'node:assert/strict';

import {
    lireTotalAnnonce,
    evaluerCollecte,
    issnDesContenusManques,
    messageAlerteContenusManques,
} from './emeraldScraper.mjs';

const appel = (journal, issn, rawContent) => ({ journal, issn, rawContent });

test('bloque l ISSN des revues dont le contenu est illisible, sans doublon', () => {
    const calls = [
        appel('Revue A', '1111-1111', null),
        appel('Revue A', '1111-1111', ''),
        appel('Revue B', '2222-2222', '<p>ok</p>'),
        appel('Revue C', '3333-3333', null),
    ];

    assert.deepEqual(issnDesContenusManques(calls), ['1111-1111', '3333-3333']);
});

test('ignore proprement un appel illisible sans ISSN', () => {
    const calls = [
        appel('Revue X', undefined, null),
        appel('Revue Y', '', null),
        appel('Revue Z', null, null),
        appel('Revue A', '1111-1111', null),
    ];

    assert.deepEqual(issnDesContenusManques(calls), ['1111-1111']);
    const message = messageAlerteContenusManques(calls);
    assert.match(message, /1 appel\(s\) preserves/);
    assert.doesNotMatch(message, /Revue X|Revue Y|Revue Z/);
});

test('ne bloque rien et ne plante pas sans appel ni sans echec', () => {
    assert.deepEqual(issnDesContenusManques([]), []);
    assert.deepEqual(issnDesContenusManques([appel('Revue B', '2222-2222', '<p>ok</p>')]), []);
    assert.equal(messageAlerteContenusManques([]), null);
    assert.equal(messageAlerteContenusManques([appel('Revue B', '2222-2222', '<p>ok</p>')]), null);
});

test('l alerte commence par [ALERTE] et donne le nombre d appels et les revues', () => {
    const calls = [
        appel('Revue A', '1111-1111', null),
        appel('Revue A', '1111-1111', null),
        appel('Revue C', '3333-3333', null),
    ];

    const message = messageAlerteContenusManques(calls);

    assert.ok(message.startsWith('[ALERTE]'));
    assert.match(message, /3 appel\(s\) preserves/);
    assert.match(message, /2 revue\(s\)/);
    assert.match(message, /Revue A \(1111-1111\)/);
    assert.match(message, /Revue C \(3333-3333\)/);
});

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
