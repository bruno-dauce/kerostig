import test from 'node:test';
import assert from 'node:assert/strict';

import { bilanDesactivations, formaterBilanDesactivations, doitConfirmer, formaterResumeDesactivations } from './bilanDesactivations.mjs';

// Le lancement manuel (scripts/lancement-manuel.mjs) compare calls.json avant
// et apres le passage, et demande confirmation avant de pousser quand trop
// d'appels basculent en inactif : c'est la signature d'un scraper qui rentre
// a moitie vide sans declencher le gel (32 appels Elsevier le 2026-09-26).

const appel = (slug, abbreviation, active, echeance = null) => ({
    slug, abbreviation, active,
    dates: echeance ? [{ date: echeance, is_full_paper_submission_deadline: true }] : [],
});
const MAINTENANT = Date.parse('2026-09-27T12:00:00Z');

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
    const texte = formaterBilanDesactivations({
        parEditeur: { wiley: 2, sage: 7 }, total: 9, reactives: 1, nouveaux: 3,
        suspectes: { total: 0, parEditeur: {}, appels: [] },
    });
    assert.match(texte, /9 appel\(s\) desactive\(s\)/);
    assert.match(texte, /sage\s+7/);
    assert.match(texte, /wiley\s+2/);
});

test('le texte signale explicitement l absence de desactivation', () => {
    const texte = formaterBilanDesactivations({ parEditeur: {}, total: 0, reactives: 0, nouveaux: 0 });
    assert.match(texte, /aucun appel desactive/i);
});

test('confirmation exigee au-dela de 5 desactivations suspectes', () => {
    assert.equal(doitConfirmer({ suspectes: 5, codeSortie: 0 }), false);
    assert.equal(doitConfirmer({ suspectes: 6, codeSortie: 0 }), true);
});

test('confirmation exigee si le passage a echoue, meme sans desactivation', () => {
    assert.equal(doitConfirmer({ suspectes: 0, codeSortie: 1 }), true);
});

// Une desactivation est suspecte quand rien ne l'explique : l'appel quitte sa
// source alors que son echeance est future, ou qu'on ne la connait pas. Un
// appel clos qui disparait, ou que l'archivage par echeance bascule, est la
// marche normale et ne doit pas faire lever le seuil.

test('echeance future ou inconnue : desactivation suspecte', () => {
    const avant = [appel('e1', 'elsevier', true, '2027-03-31'), appel('e2', 'elsevier', true)];
    const apres = [appel('e1', 'elsevier', false, '2027-03-31'), appel('e2', 'elsevier', false)];

    const { suspectes } = bilanDesactivations(avant, apres, MAINTENANT);

    assert.equal(suspectes.total, 2);
    assert.deepEqual(suspectes.parEditeur, { elsevier: 2 });
    assert.deepEqual(suspectes.appels.map(a => [a.slug, a.echeance]), [['e1', '2027-03-31'], ['e2', null]]);
});

test('echeance passee : desactivation comptee, mais pas suspecte', () => {
    const avant = [appel('w1', 'wiley', true, '2026-08-01')];
    const apres = [appel('w1', 'wiley', false, '2026-08-01')];

    const bilan = bilanDesactivations(avant, apres, MAINTENANT);

    assert.equal(bilan.total, 1);
    assert.equal(bilan.suspectes.total, 0);
});

test('l echeance lue est celle d apres le passage, qui peut avoir ete prolongee', () => {
    const avant = [appel('t1', 'tandf', true, '2026-09-01')];
    const apres = [appel('t1', 'tandf', false, '2026-12-01')];

    assert.equal(bilanDesactivations(avant, apres, MAINTENANT).suspectes.total, 1);
});

test('un appel disparu du fichier est juge sur son echeance d avant', () => {
    const bilan = bilanDesactivations([appel('s1', 'sage', true, '2027-01-15'), appel('s2', 'sage', true, '2026-01-15')], [], MAINTENANT);

    assert.equal(bilan.total, 2);
    assert.deepEqual(bilan.suspectes.appels.map(a => a.slug), ['s1']);
});

test('le seuil de 32 appels Elsevier deux tiers clos ne compte que le tiers vivant', () => {
    const avant = [];
    const apres = [];
    for (let i = 0; i < 24; i++) { avant.push(appel(`clos${i}`, 'elsevier', true, '2026-06-30')); apres.push(appel(`clos${i}`, 'elsevier', false, '2026-06-30')); }
    for (let i = 0; i < 8; i++) { avant.push(appel(`vif${i}`, 'elsevier', true, '2027-06-30')); apres.push(appel(`vif${i}`, 'elsevier', false, '2027-06-30')); }

    const bilan = bilanDesactivations(avant, apres, MAINTENANT);

    assert.equal(bilan.total, 32);
    assert.equal(bilan.suspectes.total, 8);
    assert.equal(doitConfirmer({ suspectes: bilan.suspectes.total, codeSortie: 0 }), true);
});

test('le texte du bilan distingue les suspectes et les nomme', () => {
    const texte = formaterBilanDesactivations({
        parEditeur: { elsevier: 3 }, total: 3, reactives: 0, nouveaux: 0,
        suspectes: { total: 1, parEditeur: { elsevier: 1 }, appels: [{ slug: 'elsevier-x', abbreviation: 'elsevier', echeance: null }] },
    });
    assert.match(texte, /elsevier\s+3 \(dont 1 suspecte/);
    assert.match(texte, /elsevier-x/);
    assert.match(texte, /inconnue/);
});

test('resume CI : un tableau par editeur et la liste des suspectes', () => {
    const resume = formaterResumeDesactivations({
        parEditeur: { elsevier: 30, tandf: 2 }, total: 32, reactives: 0, nouveaux: 4,
        suspectes: {
            total: 2, parEditeur: { elsevier: 2 },
            appels: [
                { slug: 'elsevier-a', abbreviation: 'elsevier', echeance: '2027-03-31' },
                { slug: 'elsevier-b', abbreviation: 'elsevier', echeance: null },
            ],
        },
    });
    assert.match(resume, /## Desactivations suspectes : 2/);
    assert.match(resume, /\| elsevier \| 30 \| 2 \|/);
    assert.doesNotMatch(resume, /\| tandf/, 'un editeur sans suspecte reste hors du tableau');
    assert.match(resume, /elsevier-a.*2027-03-31/);
    assert.match(resume, /elsevier-b.*inconnue/);
});

test('resume CI vide quand aucune desactivation n est suspecte', () => {
    const resume = formaterResumeDesactivations({
        parEditeur: { wiley: 3 }, total: 3, reactives: 0, nouveaux: 0,
        suspectes: { total: 0, parEditeur: {}, appels: [] },
    });
    assert.equal(resume, '');
});
