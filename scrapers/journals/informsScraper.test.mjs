import test from 'node:test';
import assert from 'node:assert/strict';

import { choisirModeDecoupage } from './informsScraper.mjs';

// Les valeurs de longueur sont relevees le 2026-08-31 sur les pages reelles,
// apres retrait de la navigation laterale (.hidden-lg), du <style> et du <h1>
// de page. Sans ce retrait, les pages vides pesent encore ~500 caracteres de
// menu et la separation avec une vraie page d'appels devient beaucoup moins
// nette.

test('decoupe par titres des qu il y a des h2', () => {
    // mnsc : 6 h2, gabarit d'origine du scraper.
    assert.equal(choisirModeDecoupage({ nbH2: 6, nbH3: 0, longueurContenu: 5000 }), 'titres');
});

test('bascule sur le conteneur entier quand la page n a aucun titre', () => {
    // isre : page collee depuis Word (div.WordSection1), zero h2 et zero h3,
    // les intertitres sont des <strong>. Un seul appel sur la page, donc le
    // conteneur entier fait l'affaire sans decoupage.
    assert.equal(choisirModeDecoupage({ nbH2: 0, nbH3: 0, longueurContenu: 7112 }), 'conteneur');
});

test('ne fabrique pas d appel sur une page sans titre et sans contenu', () => {
    // opre : « There are no calls for papers at this time. », 43 caracteres.
    // Sans ce garde-fou, le repli ci-dessus en ferait un appel.
    assert.equal(choisirModeDecoupage({ nbH2: 0, nbH3: 0, longueurContenu: 43 }), 'vide');
});

test('laisse de cote les pages dont les titres sont en h3', () => {
    // inte : 3 h3, 4320 caracteres, mais ce sont des sollicitations
    // editoriales permanentes (Fifth Column, Book Reviews, Practice
    // Summaries) sans echeance ni millesime. Les remonter reviendrait a leur
    // faire inventer une date par le modele, puis a les archiver aussitot.
    // Choix delibere : on ne les prend pas, et surtout on ne les agglomere
    // pas en un appel unique via le repli conteneur.
    assert.equal(choisirModeDecoupage({ nbH2: 0, nbH3: 3, longueurContenu: 4320 }), 'vide');
});

test('laisse de cote une page vide dont le seul titre est un h3', () => {
    // mksc : un h3 « Check back for updates », 22 caracteres.
    assert.equal(choisirModeDecoupage({ nbH2: 0, nbH3: 1, longueurContenu: 22 }), 'vide');
});
