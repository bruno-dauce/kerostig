import test from 'node:test';
import assert from 'node:assert/strict';

import {
    consommation, formaterConsommation, parseFuzzyDate, normaliserDateFloue,
    evaluerDescription, evaluerTopics, construireConsigneRelance, depassementsGardeFou,
} from './llmParser.mjs';

// Le cout d'une reextraction se lit sur le run : cumul des tokens affiche en
// fin de pipeline par pageController.

test('le cumul part de zero', () => {
    assert.deepEqual(consommation, { appels: 0, entree: 0, sortie: 0 });
});

test('le bilan de consommation donne les appels et les tokens', () => {
    assert.equal(
        formaterConsommation({ appels: 3, entree: 12000, sortie: 1500 }, 'claude-haiku-4-5-20251001'),
        '[llm] 3 appel(s) au modele claude-haiku-4-5-20251001 : 12000 tokens en entree, 1500 en sortie',
    );
    assert.match(formaterConsommation({ appels: 0, entree: 0, sortie: 0 }), /^\[llm\] 0 appel\(s\) au modele : 0 tokens/);
});

// Constate le 2026-09-27 en lisant les PDF Wiley : deux echeances devenaient
// null, et un appel clos sans echeance connue redevient actif.
//  - pdfjs coupe un nom de mois selon le crenage du PDF : « Ma rch 31, 2025 »
//    (Thunderbird International Business Review). Recolle avant chrono, qui
//    lit sinon « Sept ember 15 » comme le 1er septembre ;
//  - la source porte un jour hors calendrier : « 31 April 2026 » (Human
//    Resource Management), borne au dernier jour du mois.

const jour = d => d && d.toISOString().slice(0, 10);

test('un nom de mois coupe par pdfjs est recolle', async () => {
    assert.equal(jour(await parseFuzzyDate('Ma rch 31, 2025')), '2025-03-31');
    assert.equal(jour(await parseFuzzyDate('Sept ember 15, 2026')), '2026-09-15');
    assert.equal(normaliserDateFloue('Ma rch 31, 2025'), 'march 31, 2025');
});

test('un jour hors calendrier est borne au dernier jour du mois', async () => {
    assert.equal(jour(await parseFuzzyDate('31 April 2026')), '2026-04-30');
    assert.equal(jour(await parseFuzzyDate('April 31, 2026')), '2026-04-30');
    assert.equal(jour(await parseFuzzyDate('30 February 2027')), '2027-02-28');
    assert.equal(jour(await parseFuzzyDate('29 February 2028')), '2028-02-29', 'annee bissextile');
});

test('une date deja lue par chrono ne change pas', async () => {
    assert.equal(jour(await parseFuzzyDate('March 31, 2025')), '2025-03-31');
    assert.equal(jour(await parseFuzzyDate('End of October, 2026')), '2026-10-01');
    assert.equal(jour(await parseFuzzyDate('31 decembre 2026')), '2026-12-31', 'repli francais conserve');
});

test('une chaine sans date reste sans date', async () => {
    assert.equal(await parseFuzzyDate('To be announced'), null);
    assert.equal(await parseFuzzyDate('Anticipated publication'), null);
});

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

// Garde-fou de longueur sur les topics (100 caracteres). Cas reel :
// isr-isr-compassionate-ai, des topics de plusieurs centaines de
// caracteres, manifestement des phrases entieres copiees de la source.

test('des topics courts ne declenchent rien', () => {
    const evaluation = evaluerTopics(['Generative AI in healthcare', 'Crisis management', 'Employee well-being']);
    assert.equal(evaluation.depasseLongueur, false);
    assert.deepEqual(evaluation.tropLongs, []);
});

test('un topic de plus de 100 caracteres declenche le depassement', () => {
    const topicLong = 'Healthcare: Compassionate AI can enhance patient care by predicting adverse events and assisting decisions.';
    const evaluation = evaluerTopics(['Education', topicLong]);
    assert.equal(evaluation.depasseLongueur, true);
    assert.deepEqual(evaluation.tropLongs, [topicLong]);
});

test('une liste de topics absente ou vide ne declenche rien', () => {
    assert.equal(evaluerTopics(undefined).depasseLongueur, false);
    assert.equal(evaluerTopics([]).depasseLongueur, false);
});

// construireConsigneRelance : une seule relance doit couvrir les deux
// garde-fous a la fois, jamais deux allers-retours pour un meme appel.

test('la consigne de relance ne mentionne que les garde-fous depasses', () => {
    const rien = { depasseLongueur: false, depasseCopie: false };
    const topicsRien = { depasseLongueur: false, tropLongs: [] };
    assert.equal(construireConsigneRelance(rien, topicsRien), '');
});

test('la consigne de relance mentionne les topics quand ils depassent, sans reparler des paragraphes', () => {
    const rien = { depasseLongueur: false, depasseCopie: false };
    const topicsDepasses = { depasseLongueur: true, tropLongs: ['Un topic beaucoup trop long, copie-colle de la source, qui depasse largement la limite fixee.'] };
    const consigne = construireConsigneRelance(rien, topicsDepasses);
    assert.match(consigne, /100 characters/);
    assert.doesNotMatch(consigne, /paragraphs total/);
});

test('la consigne de relance couvre description et topics ensemble', () => {
    const descriptionDepassee = { depasseLongueur: true, depasseCopie: true };
    const topicsDepasses = { depasseLongueur: true, tropLongs: ['x'.repeat(120)] };
    const consigne = construireConsigneRelance(descriptionDepassee, topicsDepasses);
    assert.match(consigne, /verbatim phrases/);
    assert.match(consigne, /exceeds/);
    assert.match(consigne, /100 characters/);
    assert.match(consigne, /paragraphs total/);
});
