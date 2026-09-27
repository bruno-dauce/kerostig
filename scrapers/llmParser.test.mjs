import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluerDescription, depassementsGardeFou } from './llmParser.mjs';

// La relance de description (garde-fou de longueur et de copie) ne fait pas
// elle-meme l'objet d'un test ici : elle appelle le modele, comme parse()
// dans son ensemble, deja hors du perimetre des tests unitaires de ce
// fichier. Seule la fonction de decision, pure, est testee.

test('le bilan des depassements part vide', () => {
    assert.deepEqual(depassementsGardeFou, []);
});

test('description courte et reformulee : aucun depassement', () => {
    const description = { paragraphs: ['Ce texte resume la source dans des mots entierement differents, sans aucune phrase reprise telle quelle.'] };
    const rawContent = 'Submit a manuscript for a special issue on an entirely unrelated set of topics using distinct wording throughout the announcement text here.';
    const evaluation = evaluerDescription(description, rawContent);
    assert.equal(evaluation.depasseLongueur, false);
    assert.equal(evaluation.depasseCopie, false);
});

test('description de plus de 1200 caracteres declenche le depassement de longueur', () => {
    const paragraphe = 'mot '.repeat(400); // 1600 caracteres
    const description = { paragraphs: [paragraphe] };
    const evaluation = evaluerDescription(description, 'une source sans rapport avec la description generee ici');
    assert.equal(evaluation.depasseLongueur, true);
    assert.equal(evaluation.longueur, paragraphe.length);
});

test('description copiee mot pour mot declenche le depassement de copie', () => {
    const texte = 'This special issue invites submissions on a wide range of topics related to sustainability across modern organizations worldwide today.';
    const description = { paragraphs: [texte] };
    const evaluation = evaluerDescription(description, texte);
    assert.equal(evaluation.depasseCopie, true);
    assert.equal(evaluation.tauxCopie, 1);
});

test('une description trop courte pour mesurer la copie ne declenche que sur la longueur', () => {
    const description = { paragraphs: ['Trop court.'] };
    const evaluation = evaluerDescription(description, 'peu importe la source ici');
    assert.equal(evaluation.tauxCopie, null);
    assert.equal(evaluation.depasseCopie, false);
    assert.equal(evaluation.depasseLongueur, false);
});
