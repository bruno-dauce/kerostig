import test from 'node:test';
import assert from 'node:assert/strict';

import { extraireMesure, longueurDescription, resumerRelances } from './mesurer-taux-copie.mjs';

test('longueurDescription additionne les paragraphes', () => {
    assert.equal(longueurDescription({ paragraphs: ['abc', 'de'] }), 5);
});

test('longueurDescription ignore un champ absent ou mal forme', () => {
    assert.equal(longueurDescription(undefined), 0);
    assert.equal(longueurDescription({}), 0);
    assert.equal(longueurDescription({ paragraphs: ['ok', 42, null] }), 2);
});

test('extraireMesure lit controle sans avoir besoin de rawContent', () => {
    const c = { abbreviation: 'wiley', slug: 'x', controle: { longueur: 900, tauxCopie: 0.05, relance: true } };
    const m = extraireMesure(c);
    assert.equal(m.longueur, 900);
    assert.equal(m.tauxCopie, 0.05);
    assert.equal(m.relance, true);
    assert.equal(m.statut, 'mesure');
});

test('extraireMesure repercute un tauxCopie null de controle (description trop courte)', () => {
    const c = { abbreviation: 'wiley', slug: 'x', controle: { longueur: 10, tauxCopie: null, relance: false } };
    const m = extraireMesure(c);
    assert.equal(m.statut, 'trop_court');
    assert.equal(m.relance, false);
});

test('extraireMesure retombe sur rawContent quand controle est absent', () => {
    const c = {
        abbreviation: 'wiley', slug: 'x',
        description: { paragraphs: ['This special issue invites submissions on a wide range of topics related to sustainability today.'] },
        rawContent: 'This special issue invites submissions on a wide range of topics related to sustainability today.',
    };
    const m = extraireMesure(c);
    assert.equal(m.tauxCopie, 1);
    assert.equal(m.relance, null, 'aucune information de relance sans controle');
    assert.equal(m.statut, 'mesure');
});

test('extraireMesure sans controle ni rawContent : statut sans_donnee', () => {
    const m = extraireMesure({ abbreviation: 'wiley', slug: 'x', description: { paragraphs: ['peu importe'] } });
    assert.equal(m.statut, 'sans_donnee');
    assert.equal(m.tauxCopie, null);
    assert.equal(m.relance, null);
});

test('resumerRelances compte seulement les mesures qui savent si une relance a eu lieu', () => {
    const resultats = [
        { relance: true }, { relance: false }, { relance: true }, { relance: null },
    ];
    const resume = resumerRelances(resultats);
    assert.equal(resume.connus, 3);
    assert.equal(resume.relances, 2);
});

test('resumerRelances sur un lot sans aucune info de relance', () => {
    const resume = resumerRelances([{ relance: null }, { relance: null }]);
    assert.equal(resume.connus, 0);
    assert.equal(resume.relances, 0);
});
