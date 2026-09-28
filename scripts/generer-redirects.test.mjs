import test from 'node:test';
import assert from 'node:assert/strict';

import { formaterRedirects } from './generer-redirects.mjs';

test('une redirection produit deux lignes, avec et sans barre oblique finale', () => {
    const sortie = formaterRedirects([{ de: 'ancien-slug', vers: 'nouveau-slug' }]);

    assert.equal(sortie, '/call/ancien-slug /call/nouveau-slug 301\n/call/ancien-slug/ /call/nouveau-slug 301\n');
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
