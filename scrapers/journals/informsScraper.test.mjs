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

// Reproduction fidele du filtre de lien de get_entries (page.$eval, execute
// dans le navigateur -- pas de module importable, meme motif que
// www/_includes/layouts/rang-filtering.test.mjs). Toute modification du
// selecteur ":not([href^=\"mailto:\" i])" dans informsScraper.mjs doit etre
// repercutee ici, et inversement.
//
// Cas reel du 2026-08-11 : deux appels ISR (isr-mandsom-responsible-retail-
// operations, isr-operations-management-for-developing-economies) n'avaient
// qu'une adresse de contact comme seul lien de leur extrait, devenue leur
// "url" source -- jamais une page consultable.
function premierLienNonMailto(html) {
    const hrefs = [...html.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["']/gi)].map((m) => m[1]);
    return hrefs.find((href) => !/^mailto:/i.test(href.trim())) ?? null;
}

test('un extrait dont le seul lien est un mailto ne retient aucune URL', () => {
    const extrait = `<h2>Responsible Retail Operations</h2><p>Contact <a href="mailto:jan.fransoo@tilburguniversity.edu">jan.fransoo@tilburguniversity.edu</a> for details.</p>`;

    assert.equal(premierLienNonMailto(extrait), null);
});

test('un extrait avec un lien mailto et un lien de page retient la page, pas l adresse', () => {
    const extrait = `<h2>Some CFP</h2><p>See <a href="https://pubsonline.informs.org/page/isre/calls-for-papers">details</a> or contact <a href="mailto:x@y.com">x@y.com</a>.</p>`;

    assert.equal(premierLienNonMailto(extrait), 'https://pubsonline.informs.org/page/isre/calls-for-papers');
});

test('un extrait sans aucun lien ne retient aucune URL', () => {
    const extrait = `<h2>Some CFP</h2><p>No link here, just text.</p>`;

    assert.equal(premierLienNonMailto(extrait), null);
});
