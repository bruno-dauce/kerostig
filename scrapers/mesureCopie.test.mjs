import test from 'node:test';
import assert from 'node:assert/strict';

import { normaliserTexte, descriptionEnTexte, tauxDeCopie } from './mesureCopie.mjs';

test('normaliserTexte simplifie casse, ponctuation et espaces', () => {
    assert.equal(normaliserTexte('Hello,   World!'), 'hello world');
    assert.equal(normaliserTexte('« Guillemets »  et  \'apostrophes\''), 'guillemets et apostrophes');
    assert.equal(normaliserTexte(''), '');
});

test('descriptionEnTexte lit les deux formes stockees', () => {
    assert.equal(descriptionEnTexte({ paragraphs: ['Un paragraphe.', 'Un second.'] }), 'Un paragraphe. Un second.');
    assert.equal(descriptionEnTexte('deja une chaine'), 'deja une chaine');
    assert.equal(descriptionEnTexte(null), '');
    assert.equal(descriptionEnTexte({}), '');
});

test('rend null sous 8 mots : aucune sequence possible', () => {
    assert.equal(tauxDeCopie('Trop court pour une sequence', 'peu importe la source'), null);
    assert.equal(tauxDeCopie('', 'source'), null);
});

test('rend 1 quand la description est une copie exacte de la source', () => {
    const texte = 'This special issue invites submissions on sustainability and innovation across modern organizations worldwide.';
    assert.equal(tauxDeCopie(texte, texte), 1);
});

test('rend 0 quand aucun vocabulaire ne se recoupe', () => {
    const description = 'This summary discusses leadership dynamics within contemporary organizational structures broadly speaking here.';
    const source = 'Completely unrelated content about marine biology and oceanic temperature fluctuations across decades worldwide.';
    assert.equal(tauxDeCopie(description, source), 0);
});

test('mesure un recoupement partiel sur des sequences precises', () => {
    // 10 mots -> 3 sequences de 8 (fenetre glissante). Seule la premiere,
    // "the quick brown fox jumps over the lazy", apparait telle quelle dans
    // la source ; les deux autres divergent sur leur dernier mot.
    const description = 'the quick brown fox jumps over the lazy dog today';
    const source = 'before that, the quick brown fox jumps over the lazy something else entirely';
    const taux = tauxDeCopie(description, source);
    assert.equal(taux, 1 / 3, 'sur 3 sequences de 8 mots, une seule est retrouvee telle quelle');
});

test('ignore la casse et la ponctuation dans la comparaison', () => {
    const description = 'The Quick, Brown Fox Jumps Over The Lazy dog.';
    const source = 'the quick brown fox jumps over the lazy dog';
    assert.equal(tauxDeCopie(description, source), 1);
});
