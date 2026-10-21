import test from 'node:test';
import assert from 'node:assert/strict';

import { verifierPoids, LIMITE_OCTETS, positionLienDisciplinePied, verifierLienDiscipline } from './verifier-poids-accueil.mjs';

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

test('position du premier lien /discipline/ : apres <footer>, en octets', () => {
    const html = '<a href="/discipline/x/">carte</a><p>é</p><footer><a href="/about/">a</a><a href="/discipline/y/">y</a></footer>';
    const attendu = Buffer.from(html).indexOf('<a href="/discipline/y/">') + '<a href="'.length;
    assert.equal(positionLienDisciplinePied(html), attendu);
});

test('pas de pied de page ou pas de lien dedans : null, donc echec', () => {
    assert.equal(positionLienDisciplinePied('<p>rien</p>'), null);
    assert.equal(positionLienDisciplinePied('<footer>sans lien</footer>'), null);
    assert.equal(verifierLienDiscipline(null).ok, false);
});

test('lien du pied de page : ok a la borne, echec un octet au-dessus', () => {
    assert.equal(verifierLienDiscipline(1_900_000, 1_900_000).ok, true);
    assert.equal(verifierLienDiscipline(1_900_001, 1_900_000).ok, false);
});
