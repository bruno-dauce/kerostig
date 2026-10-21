import test from 'node:test';
import assert from 'node:assert/strict';

import { classesKcManquantes } from './verifier-classes-kc.mjs';

const css = '.kc-card{border:1px}.kc-tag:hover{opacity:1}';

test('toutes les classes kc-* sont definies : rien de manquant', () => {
    const html = '<div class="kc-card"><a class="kc-tag text-xs">x</a></div>';
    assert.deepEqual(classesKcManquantes([html], css), []);
});

test('une classe kc-* absente du CSS est rendue, une seule fois, triee', () => {
    const html = '<p class="kc-zeta"></p><p class="kc-alpha kc-card"></p><p class="kc-zeta"></p>';
    assert.deepEqual(classesKcManquantes([html], css), ['kc-alpha', 'kc-zeta']);
});

test('les classes qui ne commencent pas par kc- sont ignorees', () => {
    assert.deepEqual(classesKcManquantes(['<p class="badge no-kc-here"></p>'], css), []);
});

test('plusieurs pages : l union des classes est verifiee', () => {
    assert.deepEqual(classesKcManquantes(['<i class="kc-card"></i>', '<i class="kc-nouveau"></i>'], css), ['kc-nouveau']);
});

test('aucun HTML, rien de manquant', () => {
    assert.deepEqual(classesKcManquantes([], css), []);
});
