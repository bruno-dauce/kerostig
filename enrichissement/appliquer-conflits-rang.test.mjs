import test from 'node:test';
import assert from 'node:assert/strict';

import { calculerMisesAJour } from './appliquer-conflits-rang.mjs';

const fusionEnConflit = {
    titres: ['A', 'B'],
    rang_retenu: null,
    rangs_affiches: ['2', '3'],
    note_publique: 'Cette revue figure deux fois dans le classement FNEGE 2025, avec les rangs 2 et 3.',
};

const fusionResolue = {
    titres: ['C', 'D'],
    rang_retenu: '4',
    note: 'Simple doublon.',
};

test('ajoute rangs_fnege_2025 et la note sur une fusion en conflit', () => {
    const journaux = { '1234-5678': { titre_fnege: 'X', rang_fnege_2025: '2' } };
    const { journaux: sortie, changements } = calculerMisesAJour(journaux, { '1234-5678': fusionEnConflit });
    assert.deepEqual(sortie['1234-5678'].rangs_fnege_2025, ['2', '3']);
    assert.equal(sortie['1234-5678'].rang_fnege_2025_note, fusionEnConflit.note_publique);
    assert.equal(changements.length, 1);
});

test('ne touche pas une revue absente de journals.json', () => {
    const journaux = {};
    const { journaux: sortie, changements } = calculerMisesAJour(journaux, { '1234-5678': fusionEnConflit });
    assert.deepEqual(sortie, {});
    assert.equal(changements.length, 0);
});

test('retire rangs_fnege_2025 et la note quand la fusion est resolue', () => {
    const journaux = {
        '1234-5678': {
            titre_fnege: 'X', rang_fnege_2025: '2',
            rangs_fnege_2025: ['2', '3'],
            rang_fnege_2025_note: 'ancienne note',
        },
    };
    const { journaux: sortie, changements } = calculerMisesAJour(journaux, { '1234-5678': fusionResolue });
    assert.equal('rangs_fnege_2025' in sortie['1234-5678'], false);
    assert.equal('rang_fnege_2025_note' in sortie['1234-5678'], false);
    assert.equal(changements.length, 1);
});

test('ne modifie rien si une fusion resolue est deja propre', () => {
    const journaux = { '1234-5678': { titre_fnege: 'X', rang_fnege_2025: '4' } };
    const { changements } = calculerMisesAJour(journaux, { '1234-5678': fusionResolue });
    assert.equal(changements.length, 0);
});

test('ne modifie pas journaux en entree', () => {
    const journaux = { '1234-5678': { titre_fnege: 'X', rang_fnege_2025: '2' } };
    calculerMisesAJour(journaux, { '1234-5678': fusionEnConflit });
    assert.equal('rangs_fnege_2025' in journaux['1234-5678'], false);
});
