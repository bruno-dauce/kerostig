import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluerPoids, SEUIL_OCTETS, positionLienDisciplinePied, evaluerLienDiscipline } from './verifier-poids-accueil.mjs';

test('sous le seuil : ok, avec la marge', () => {
    const r = evaluerPoids(1_000_000, { seuil: 1_900_000 });
    assert.equal(r.niveau, 'ok');
    assert.match(r.message, /marge 900000/);
});

test('au seuil exact : ok', () => {
    assert.equal(evaluerPoids(1_900_000, { seuil: 1_900_000 }).niveau, 'ok');
});

// Production : jamais d'echec, un build en echec figerait le site.
test('au-dessus du seuil, hors mode strict : avertissement, pas echec', () => {
    const r = evaluerPoids(1_900_001, { seuil: 1_900_000 });
    assert.equal(r.niveau, 'avertissement');
    assert.match(r.message, /DEPASSE de 1 octets/);
});

test('au-dessus du seuil, en mode strict : echec', () => {
    assert.equal(evaluerPoids(1_900_001, { seuil: 1_900_000, strict: true }).niveau, 'echec');
});

test('le mode strict ne change rien sous le seuil', () => {
    assert.equal(evaluerPoids(1_000_000, { seuil: 1_900_000, strict: true }).niveau, 'ok');
});

test('le seuil par defaut est 1 900 000, sous la limite de Googlebot', () => {
    assert.equal(SEUIL_OCTETS, 1_900_000);
    assert.ok(SEUIL_OCTETS < 2_097_152);
});

test('le seuil de la collecte du lundi (2 097 152) tolere ce que le seuil par defaut signale', () => {
    assert.equal(evaluerPoids(2_000_000, { seuil: 2_097_152, strict: true }).niveau, 'ok');
    assert.equal(evaluerPoids(2_000_000, { strict: true }).niveau, 'echec');
});

test('position du premier lien /discipline/ : apres <footer>, en octets', () => {
    const html = '<a href="/discipline/x/">carte</a><p>é</p><footer><a href="/about/">a</a><a href="/discipline/y/">y</a></footer>';
    const attendu = Buffer.from(html).indexOf('<a href="/discipline/y/">') + '<a href="'.length;
    assert.equal(positionLienDisciplinePied(html), attendu);
});

test('pas de pied de page ou pas de lien dedans : position nulle', () => {
    assert.equal(positionLienDisciplinePied('<p>rien</p>'), null);
    assert.equal(positionLienDisciplinePied('<footer>sans lien</footer>'), null);
});

test('lien de discipline : ok au seuil, avertissement au-dessus, echec en mode strict', () => {
    assert.equal(evaluerLienDiscipline(1_900_000, { seuil: 1_900_000 }).niveau, 'ok');
    assert.equal(evaluerLienDiscipline(1_900_001, { seuil: 1_900_000 }).niveau, 'avertissement');
    assert.equal(evaluerLienDiscipline(1_900_001, { seuil: 1_900_000, strict: true }).niveau, 'echec');
});

test('aucun lien de discipline : echec dans tous les modes', () => {
    assert.equal(evaluerLienDiscipline(null).niveau, 'echec');
    assert.equal(evaluerLienDiscipline(null, { strict: true }).niveau, 'echec');
});
