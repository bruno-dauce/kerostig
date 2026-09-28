import test from 'node:test';
import assert from 'node:assert/strict';

import { trouverAppelConjoint } from './numerosConjoints.mjs';

const appel = (surcharge = {}) => ({
    slug: 'appel-a',
    issn: '1111-1111',
    metaTitle: 'Joint Special Issue: Sujet commun',
    url: 'https://exemple.test/joint',
    ...surcharge,
});

test('trouve le jumeau : meme URL, meme texte, ISSN different', () => {
    const a = appel();
    const b = appel({ slug: 'appel-b', issn: '2222-2222' });

    assert.equal(trouverAppelConjoint([a, b], a).slug, 'appel-b');
    assert.equal(trouverAppelConjoint([a, b], b).slug, 'appel-a');
});

test('un ISSN egal n est pas un numero conjoint (c est le meme appel deux fois)', () => {
    const a = appel();
    const b = appel({ slug: 'appel-b' });

    assert.equal(trouverAppelConjoint([a, b], a), null);
});

// Cas reel : le hub INFORMS sert une seule URL a toutes ses revues. Sans
// l'exigence sur le texte, chacune de ses fiches heritees (ISSN absent, donc
// different de celui de la fiche actuelle) serait prise pour un numero
// conjoint avec les 3 autres, sujets pourtant distincts.
test('ne confond pas une page hub avec un numero conjoint : le texte doit concorder', () => {
    const actuel = appel({ slug: 'informs-generative-ai', issn: '1526-5536', metaTitle: 'Generative AI and New Methods' });
    const herite1 = appel({ slug: 'isr-compassionate-ai', issn: undefined, metaTitle: 'Compassionate AI' });
    const herite2 = appel({ slug: 'isr-disasters', issn: undefined, metaTitle: 'Unleashing IT for Disasters' });

    assert.equal(trouverAppelConjoint([actuel, herite1, herite2], actuel), null);
});

test('une URL differente n est jamais un numero conjoint, meme ISSN et titre concordants par ailleurs', () => {
    const a = appel();
    const b = appel({ slug: 'appel-b', issn: '2222-2222', url: 'https://exemple.test/autre-page' });

    assert.equal(trouverAppelConjoint([a, b], a), null);
});

test('rend null pour un appel sans ISSN ou sans metaTitle', () => {
    assert.equal(trouverAppelConjoint([appel()], { url: 'https://exemple.test/joint' }), null);
});
