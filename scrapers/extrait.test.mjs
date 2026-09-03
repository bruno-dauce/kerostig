import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    extraireDescription,
    resumerDescription,
    lienSourceOriginale,
    lienContactEditeurs,
    LIMITE_EXTRAIT_CARACTERES,
} from './extrait.mjs';

test('une description absente ou vide ne rend rien, et ne se declare pas tronquee', () => {
    for (const entree of [undefined, null, [], ['', '   '], 'pas un tableau']) {
        assert.deepEqual(extraireDescription(entree), { paragraphes: [], tronque: false });
    }
});

test('une description courte passe telle quelle', () => {
    const paragraphes = ['Premier paragraphe.', 'Second paragraphe.'];
    assert.deepEqual(extraireDescription(paragraphes), { paragraphes, tronque: false });
});

test('les paragraphes qui depassent la borne sont ecartes, et la troncature est signalee', () => {
    const p = 'x'.repeat(500);
    const { paragraphes, tronque } = extraireDescription([p, p, p, p]);
    assert.equal(paragraphes.length, 2);
    assert.equal(tronque, true);
    assert.ok(paragraphes.join('').length <= LIMITE_EXTRAIT_CARACTERES);
});

test('un premier paragraphe plus long que la borne est coupe sur une frontiere de mot', () => {
    const long = 'alpha beta '.repeat(200);
    const { paragraphes, tronque } = extraireDescription([long, 'suite']);
    assert.equal(tronque, true);
    assert.equal(paragraphes.length, 1);
    const extrait = paragraphes[0];
    assert.ok(extrait.length <= LIMITE_EXTRAIT_CARACTERES + 1, `longueur ${extrait.length}`);
    assert.ok(extrait.endsWith('…'));
    // Coupe sur un mot entier : pas de « alph… » en fin d'extrait.
    assert.ok(/(alpha|beta)…$/.test(extrait), extrait.slice(-20));
});

test('un paragraphe sans espace est coupe net plutot que rendu vide', () => {
    const { paragraphes, tronque } = extraireDescription(['y'.repeat(2000)]);
    assert.equal(tronque, true);
    assert.equal(paragraphes[0].length, LIMITE_EXTRAIT_CARACTERES + 1);
    assert.ok(paragraphes[0].endsWith('…'));
});

test('le dernier paragraphe retenu tient exactement dans la borne', () => {
    const { paragraphes, tronque } = extraireDescription(['a'.repeat(600), 'b'.repeat(600), 'c']);
    assert.equal(paragraphes.length, 2);
    assert.equal(tronque, true);
});

test('resumerDescription rend une chaine courte, ou null', () => {
    assert.equal(resumerDescription(null), null);
    assert.equal(resumerDescription({ paragraphs: [] }), null);
    assert.equal(resumerDescription({ paragraphs: ['Court.'] }), 'Court.');
    const resume = resumerDescription({ paragraphs: ['mot '.repeat(400)] });
    assert.ok(resume.length <= 301, `longueur ${resume.length}`);
    assert.ok(resume.endsWith('…'));
});

test('lienSourceOriginale ecarte les URL inexploitables de calls.json', () => {
    assert.equal(lienSourceOriginale({ url: 'https://example.org/cfp' }), 'https://example.org/cfp');
    assert.equal(lienSourceOriginale({ url: ' http://example.org/cfp ' }), 'http://example.org/cfp');
    assert.equal(lienSourceOriginale({ url: '' }), null);
    assert.equal(lienSourceOriginale({ url: 'mailto:eftekhar@asu.edu' }), null);
    assert.equal(lienSourceOriginale({}), null);
    assert.equal(lienSourceOriginale(null), null);
});

test('lienContactEditeurs ne retient que les mailto, et normalise l adresse', () => {
    assert.equal(
        lienContactEditeurs({ url: 'mailto:jan.fransoo@tilburguniversity.edu' }),
        'mailto:jan.fransoo@tilburguniversity.edu',
    );
    // L'espace apres les deux-points existe reellement dans calls.json.
    assert.equal(lienContactEditeurs({ url: 'mailto: eftekhar@asu.edu' }), 'mailto:eftekhar@asu.edu');
    assert.equal(lienContactEditeurs({ url: 'MAILTO:x@y.org' }), 'mailto:x@y.org');
    assert.equal(lienContactEditeurs({ url: 'mailto:' }), null);
    assert.equal(lienContactEditeurs({ url: 'https://example.org/cfp' }), null);
    assert.equal(lienContactEditeurs({ url: '' }), null);
    assert.equal(lienContactEditeurs(null), null);
});

test('les deux liens ne sont jamais non nuls ensemble', () => {
    for (const url of ['https://example.org/cfp', 'mailto:x@y.org', '', 'ftp://example.org']) {
        const call = { url };
        assert.ok(!(lienSourceOriginale(call) && lienContactEditeurs(call)), url);
    }
});
