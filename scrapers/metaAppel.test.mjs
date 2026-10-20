import test from 'node:test';
import assert from 'node:assert/strict';

import { titreMetaAppel, descriptionMetaAppel } from './metaAppel.mjs';

test('titre : appel, revue et « call for papers »', () => {
    assert.equal(
        titreMetaAppel({ titre: 'Platform thinking', nomRevue: 'Technovation' }),
        'Platform thinking, Technovation (call for papers)'
    );
});

// Cas reel : elsevier-call-for-african-research-proposals.
test('titre : la revue deja presente dans le titre n est pas redite', () => {
    assert.equal(
        titreMetaAppel({ titre: 'Emerging Markets Review: Call for African Research Proposals', nomRevue: 'Emerging Markets Review' }),
        'Emerging Markets Review: Call for African Research Proposals'
    );
});

test('titre : « call for papers » deja dit par le titre n est pas repete', () => {
    assert.equal(
        titreMetaAppel({ titre: 'Joint Special Issue Call for Papers - LLMs for tourism', nomRevue: 'Annals of Tourism Research' }),
        'Joint Special Issue Call for Papers - LLMs for tourism, Annals of Tourism Research'
    );
    assert.equal(
        titreMetaAppel({ titre: 'Appel à contributions : travail et organisation', nomRevue: 'Management international' }),
        'Appel à contributions : travail et organisation, Management international'
    );
});

test('titre : sans revue ni titre, une valeur toujours exploitable', () => {
    assert.equal(titreMetaAppel({ titre: 'Sujet', nomRevue: '' }), 'Sujet (call for papers)');
    assert.equal(titreMetaAppel({ titre: '', nomRevue: 'Technovation' }), 'Technovation (call for papers)');
    assert.equal(titreMetaAppel({}), 'Appel à publications (call for papers)');
});

test('titre : un appel clos porte la mention « clôturé »', () => {
    assert.equal(
        titreMetaAppel({ titre: 'Platform thinking', nomRevue: 'Technovation', cloture: true }),
        'Platform thinking, Technovation (call for papers, clôturé)'
    );
    // Le titre dit deja « call for » : seule la mention de cloture s'ajoute.
    assert.equal(
        titreMetaAppel({ titre: 'Emerging Markets Review: Call for African Research Proposals', nomRevue: 'Emerging Markets Review', cloture: true }),
        'Emerging Markets Review: Call for African Research Proposals (clôturé)'
    );
    assert.equal(titreMetaAppel({ cloture: true }), 'Appel à publications (call for papers, clôturé)');
});

test('description complete', () => {
    assert.equal(
        descriptionMetaAppel({
            nomRevue: 'Technovation',
            rangs: ['2'],
            echeance: '2026-11-30T11:00:00.000Z',
            cloture: false,
            dansDoaj: false,
            lienOriginal: true,
        }),
        "Appel à publications de Technovation, rang FNEGE 2. Échéance : 30 novembre 2026. Revue non référencée au DOAJ. Lien vers l'appel original."
    );
});

test('description : revue en conflit de classement, deux rangs', () => {
    const d = descriptionMetaAppel({ nomRevue: 'Revue X', rangs: ['2', '3'] });
    assert.match(d, /^Appel à publications de Revue X, rang FNEGE 2 et 3\./);
});

test('description : appel clos', () => {
    assert.match(
        descriptionMetaAppel({ nomRevue: 'Revue X', rangs: ['3'], echeance: '2025-01-31T00:00:00.000Z', cloture: true }),
        /Appel clôturé, échéance du 31 janvier 2025\./
    );
    assert.match(descriptionMetaAppel({ nomRevue: 'Revue X', cloture: true }), /Appel clôturé\./);
});

// Une donnee absente est omise, jamais inventee : pas d'echeance, pas de
// statut d'acces, pas de lien, pas de rang.
test('description : les donnees absentes sont omises', () => {
    assert.equal(
        descriptionMetaAppel({ nomRevue: 'Revue X', rangs: [], echeance: null, dansDoaj: null, lienOriginal: false }),
        'Appel à publications de Revue X.'
    );
    assert.equal(
        descriptionMetaAppel({}),
        'Appel à publications en sciences de gestion et management.'
    );
});

test('description : une date inanalysable est omise, pas ecrite en clair', () => {
    const d = descriptionMetaAppel({ nomRevue: 'Revue X', echeance: 'TBD' });
    assert.equal(d, 'Appel à publications de Revue X.');
});

test('description : accès ouvert', () => {
    assert.match(descriptionMetaAppel({ nomRevue: 'Revue X', dansDoaj: true }), /Revue en accès ouvert \(DOAJ\)\./);
    assert.match(descriptionMetaAppel({ nomRevue: 'Revue X', dansDoaj: false }), /Revue non référencée au DOAJ\./);
    assert.doesNotMatch(descriptionMetaAppel({ nomRevue: 'Revue X', dansDoaj: false }), /abonnement/);
});
