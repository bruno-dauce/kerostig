import test from 'node:test';
import assert from 'node:assert/strict';

import { verifierPoids, LIMITE_OCTETS } from './verifier-poids-accueil.mjs';

test('sous la borne : ok, avec la marge', () => {
    const r = verifierPoids(1_000_000, 1_900_000);
    assert.equal(r.ok, true);
    assert.match(r.message, /marge 900000/);
});

test('a la borne exacte : ok', () => {
    assert.equal(verifierPoids(1_900_000, 1_900_000).ok, true);
});

test('un octet au-dessus : echec', () => {
    assert.equal(verifierPoids(1_900_001, 1_900_000).ok, false);
});

test('la borne par defaut est un nombre d octets', () => {
    assert.equal(typeof LIMITE_OCTETS, 'number');
});
