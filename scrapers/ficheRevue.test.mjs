import test from 'node:test';
import assert from 'node:assert/strict';

import { descriptionMetaRevue, revuesVoisines } from './ficheRevue.mjs';

const base = { titre: 'Technovation', discipline: 'Innovation', rangs: ['2'], nbAppelsOuverts: 0, nbAppelsArchives: 0 };

test('description complète : revue en accès ouvert avec APC, dépôt HAL possible, appels ouverts et archivés', () => {
    assert.equal(
        descriptionMetaRevue({
            ...base,
            estOa: true,
            apc: { gratuit: false, montant: 2000, devise: 'EUR' },
            depotHal: true,
            nbAppelsOuverts: 3,
            nbAppelsArchives: 2,
        }),
        'Technovation en Innovation. Rang FNEGE 2025 : 2. Accès ouvert, APC 2000 EUR. Dépôt HAL : possible. Calls for papers ouverts et archivés.'
    );
});

test('le libellé des appels suit ce que la fiche montre', () => {
    assert.match(descriptionMetaRevue({ ...base, nbAppelsOuverts: 1 }), /Calls for papers ouverts\.$/);
    assert.match(descriptionMetaRevue({ ...base, nbAppelsArchives: 4 }), /Calls for papers archivés\.$/);
    assert.match(descriptionMetaRevue(base), /Calls for papers : aucun appel collecté pour le moment\.$/);
});

// Cas réel : revue absente d'OpenAlex et de DOAJ (10 sur 885), absente d'Open
// Policy Finder. Ni statut d'accès, ni dépôt, ni rang inventé.
test('les données absentes sont omises, jamais inventées', () => {
    assert.equal(
        descriptionMetaRevue({ titre: 'Revue X', rangs: [], estOa: null, apc: null, depotHal: null }),
        'Revue X. Calls for papers : aucun appel collecté pour le moment.'
    );
});

test('accès : sans frais, sur abonnement, hybride', () => {
    assert.match(descriptionMetaRevue({ ...base, estOa: true, apc: { gratuit: true } }), /Accès ouvert, sans frais de publication\./);
    assert.match(descriptionMetaRevue({ ...base, estOa: false }), /Sur abonnement\./);
    assert.match(
        descriptionMetaRevue({ ...base, estOa: false, apc: { gratuit: false, montant: 3000, devise: 'USD' } }),
        /Sur abonnement, option hybride avec APC 3000 USD\./
    );
});

test('un APC sans montant ou sans devise n est pas écrit à moitié', () => {
    assert.match(descriptionMetaRevue({ ...base, estOa: true, apc: { gratuit: false, montant: null, devise: 'EUR' } }), /Accès ouvert\./);
    assert.doesNotMatch(descriptionMetaRevue({ ...base, estOa: true, apc: { gratuit: false, montant: 100 } }), /APC/);
});

test('dépôt HAL : sous conditions quand Open Policy Finder dit non, omis quand il ne dit rien', () => {
    assert.match(descriptionMetaRevue({ ...base, depotHal: false }), /Dépôt HAL : sous conditions\./);
    assert.doesNotMatch(descriptionMetaRevue({ ...base, depotHal: null }), /HAL/);
});

test('revue en conflit de classement : deux rangs', () => {
    assert.match(descriptionMetaRevue({ ...base, rangs: ['2', '3'] }), /Rang FNEGE 2025 : 2 et 3\./);
});

const liste = (n) => Array.from({ length: n }, (_, i) => ({ slug: `r${i}` }));

test('voisines : fenêtre centrée sur la revue, elle-même exclue', () => {
    const v = revuesVoisines(liste(30), 'r15');
    assert.deepEqual(v.map((r) => r.slug), ['r11', 'r12', 'r13', 'r14', 'r16', 'r17', 'r18', 'r19']);
});

test('voisines : en début et en fin de liste, la fenêtre reste pleine', () => {
    assert.deepEqual(revuesVoisines(liste(30), 'r0').map((r) => r.slug), ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8']);
    assert.deepEqual(revuesVoisines(liste(30), 'r29').map((r) => r.slug), ['r21', 'r22', 'r23', 'r24', 'r25', 'r26', 'r27', 'r28']);
});

test('voisines : discipline plus petite que la fenêtre, toutes les autres revues', () => {
    assert.deepEqual(revuesVoisines(liste(5), 'r2').map((r) => r.slug), ['r0', 'r1', 'r3', 'r4']);
});

test('voisines : revue inconnue ou liste invalide, rien', () => {
    assert.deepEqual(revuesVoisines(liste(10), 'absente'), []);
    assert.deepEqual(revuesVoisines(null, 'r0'), []);
});

test('voisines : chaque revue reçoit au moins un lien entrant', () => {
    const l = liste(40);
    const recues = new Set();
    for (const r of l) for (const v of revuesVoisines(l, r.slug)) recues.add(v.slug);
    assert.equal(recues.size, 40);
});
