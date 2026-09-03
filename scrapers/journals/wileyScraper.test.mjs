import test from 'node:test';
import assert from 'node:assert/strict';

import { classerTentatives } from './wileyScraper.mjs';

// Le compteur de fin de run rangeait tout echec sous « aucun des chemins
// d'URL essayes n'a repondu ». Verifie le 2026-09-03 sur quatre revues
// portant des appels actifs, c'etait faux : les chemins repondaient 403 ou
// 302, et leurs pages existent bien -- un navigateur y obtient 200 et plus de
// 100 Ko, aux memes URL. Un blocage rapporte comme une absence envoie le
// diagnostic suivant chercher des chemins d'URL au lieu du client HTTP.

test('un 403 est un blocage, pas une absence', () => {
    assert.equal(classerTentatives([{ statut: 403 }]), 'bloque');
});

test('une redirection est un blocage : chez Wiley elle mene au challenge', () => {
    assert.equal(classerTentatives([{ statut: 302 }]), 'bloque');
    assert.equal(classerTentatives([{ statut: 301 }]), 'bloque');
});

test('un corps de challenge suffit, quel que soit le statut', () => {
    assert.equal(classerTentatives([{ statut: 200, challenge: true }]), 'bloque');
});

test('le blocage l emporte sur les autres motifs', () => {
    // Une revue bloquee peut aussi bien avoir une page qu'aucune : on n'en
    // sait rien, et c'est le blocage qu'il faut signaler.
    assert.equal(classerTentatives([{ statut: 404 }, { statut: 403 }, { statut: 404 }]), 'bloque');
    assert.equal(classerTentatives([{ erreur: 'timeout' }, { statut: 403 }]), 'bloque');
});

test('des 404 sur tous les chemins signalent une page reellement absente', () => {
    assert.equal(classerTentatives([{ statut: 404 }, { statut: 404 }, { statut: 404 }]), 'absent');
});

test('une erreur reseau sans blocage est son propre motif', () => {
    assert.equal(classerTentatives([{ erreur: 'ETIMEDOUT' }, { statut: 404 }]), 'reseau');
});

test('un statut inattendu ne se fait pas passer pour une absence', () => {
    // Un 500 chez l'editeur n'est ni une page manquante ni un blocage : le
    // ranger dans « absent » ferait croire a une revue sans appels.
    assert.equal(classerTentatives([{ statut: 500 }, { statut: 404 }]), 'autre');
});

test('une liste vide de tentatives ne prétend rien', () => {
    assert.equal(classerTentatives([]), 'autre');
});
