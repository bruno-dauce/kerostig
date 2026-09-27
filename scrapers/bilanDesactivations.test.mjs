import test from 'node:test';
import assert from 'node:assert/strict';

import { bilanDesactivations, formaterBilanDesactivations, doitConfirmer } from './bilanDesactivations.mjs';

// Le lancement manuel (scripts/lancement-manuel.mjs) compare calls.json avant
// et apres le passage, et demande confirmation avant de pousser quand trop
// d'appels basculent en inactif : c'est la signature d'un scraper qui rentre
// a moitie vide sans declencher le gel (32 appels Elsevier le 2026-09-26).

const appel = (slug, abbreviation, active) => ({ slug, abbreviation, active });

test('compte par editeur les appels passes d actif a inactif', () => {
    const avant = [appel('w1', 'wiley', true), appel('w2', 'wiley', true), appel('s1', 'sage', true), appel('e1', 'emerald', false)];
    const apres = [appel('w1', 'wiley', false), appel('w2', 'wiley', false), appel('s1', 'sage', false), appel('e1', 'emerald', false)];

    const bilan = bilanDesactivations(avant, apres);

    assert.deepEqual(bilan.parEditeur, { wiley: 2, sage: 1 });
    assert.equal(bilan.total, 3);
});

test('un appel deja inactif avant ne compte pas', () => {
    const bilan = bilanDesactivations([appel('e1', 'emerald', false)], [appel('e1', 'emerald', false)]);
    assert.equal(bilan.total, 0);
});

test('un appel actif qui disparait du fichier compte comme desactive', () => {
    const bilan = bilanDesactivations([appel('w1', 'wiley', true)], []);
    assert.deepEqual(bilan.parEditeur, { wiley: 1 });
});

test('nouveaux et reactives sont comptes a part', () => {
    const avant = [appel('w1', 'wiley', false)];
    const apres = [appel('w1', 'wiley', true), appel('w2', 'wiley', true), appel('w3', 'wiley', false)];

    const bilan = bilanDesactivations(avant, apres);

    assert.equal(bilan.reactives, 1);
    assert.equal(bilan.nouveaux, 1, 'seul un nouvel appel actif compte');
    assert.equal(bilan.total, 0);
});

test('le texte du bilan nomme chaque editeur touche', () => {
    const texte = formaterBilanDesactivations({ parEditeur: { wiley: 2, sage: 7 }, total: 9, reactives: 1, nouveaux: 3 });
    assert.match(texte, /9 appel\(s\) desactive\(s\)/);
    assert.match(texte, /sage\s+7/);
    assert.match(texte, /wiley\s+2/);
});

test('le texte signale explicitement l absence de desactivation', () => {
    const texte = formaterBilanDesactivations({ parEditeur: {}, total: 0, reactives: 0, nouveaux: 0 });
    assert.match(texte, /aucun appel desactive/i);
});

test('confirmation exigee au-dela de 5 appels desactives', () => {
    assert.equal(doitConfirmer({ total: 5, codeSortie: 0 }), false);
    assert.equal(doitConfirmer({ total: 6, codeSortie: 0 }), true);
});

test('confirmation exigee si le passage a echoue, meme sans desactivation', () => {
    assert.equal(doitConfirmer({ total: 0, codeSortie: 1 }), true);
});
