import test from 'node:test';
import assert from 'node:assert/strict';

import { formaterRedirects } from './generer-redirects.mjs';

test('une redirection produit deux lignes, avec et sans barre oblique finale', () => {
    const sortie = formaterRedirects([{ de: 'ancien-slug', vers: 'nouveau-slug' }]);

    assert.equal(sortie, '/call/ancien-slug /call/nouveau-slug/ 301\n/call/ancien-slug/ /call/nouveau-slug/ 301\n');
});

// Une cible sans barre finale subit un 308 vers la forme avec barre : deux sauts.
test('la cible porte la barre oblique finale, un seul saut', () => {
    const lignes = formaterRedirects([{ de: 'a', vers: 'b' }]).split('\n').filter(Boolean);

    assert.ok(lignes.every((l) => l.split(' ')[1].endsWith('/')));
});

test('plusieurs redirections s enchainent dans l ordre de la table', () => {
    const sortie = formaterRedirects([
        { de: 'a', vers: 'b' },
        { de: 'c', vers: 'd' },
    ]);

    assert.equal(sortie.split('\n').filter(Boolean).length, 4);
});

test('une table vide rend une chaine vide', () => {
    assert.equal(formaterRedirects([]), '');
});
