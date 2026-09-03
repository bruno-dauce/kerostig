import test from 'node:test';
import assert from 'node:assert/strict';

import { scraperObject, decode_html } from './reScraper.mjs';
import { interpreterReponseApi, estFinDePagination } from '../apiJson.mjs';

// reScraper portait le repli muet de fetch_api_page, recopie de aomScraper et
// tfScraper -- un commentaire du fichier le disait explicitement. Sa boucle,
// elle, avait deja le garde de page incomplete : seule l'interpretation des
// reponses etait a reprendre.

test('le module se charge et expose le contrat attendu par pageController', () => {
    // Tient le chemin d'import de ../apiJson.mjs : un chemin faux ou un export
    // manquant fait echouer le chargement, donc ce test.
    assert.equal(scraperObject.abbreviation, 're');
    assert.equal(typeof scraperObject.scraper, 'function');
});

test('une reponse d erreur de l API leve au lieu de rendre []', () => {
    const corps = JSON.stringify({ code: 'rest_invalid_param', data: { status: 400 } });

    assert.throws(
        () => interpreterReponseApi({ statut: 400, corps, url: 'https://entrepreneuriat.com/wp-json/wp/v2/posts?page=1', prefixe: '[re]' }),
        /\[re\].*400.*rest_invalid_param/,
    );
});

test('une page de posts valide reste acceptee', () => {
    const corps = JSON.stringify([{ id: 1, title: { rendered: 'Appel a contributions' } }]);

    const items = interpreterReponseApi({ statut: 200, corps, url: 'https://entrepreneuriat.com/x', prefixe: '[re]' });

    assert.equal(items.length, 1);
});

test('la page hors bornes reste une fin de liste', () => {
    // Le garde de page incomplete rend ce cas rare -- il ne survient que si le
    // nombre de posts est un multiple exact de la taille de page -- mais sans
    // ce filet il deviendrait une fausse panne maintenant que fetch_api_page
    // leve.
    const horsBornes = new Error('[re] HTTP 400 sur https://entrepreneuriat.com/... (rest_post_invalid_page_number)');

    assert.equal(estFinDePagination(horsBornes), true);
    assert.equal(estFinDePagination(new Error('[re] HTTP 500 sur ... (reponse non JSON)')), false);
});

// --- Logique propre a RE ----------------------------------------------------
// Les titres WordPress arrivent encodes : sans decodage, le filtre sur le titre
// travaillerait sur des entites plutot que sur du texte.

test('les entites HTML des titres sont decodees', () => {
    assert.equal(decode_html('Appel &agrave; contributions'), 'Appel à contributions');
    assert.equal(decode_html('L&rsquo;entrepreneuriat &#8211; enjeux'), 'L’entrepreneuriat – enjeux');
    assert.equal(decode_html('&laquo; Innovation &raquo;'), '« Innovation »');
});

test('les espaces multiples sont normalises et les bords retires', () => {
    assert.equal(decode_html('  Appel   a\n\ncontributions  '), 'Appel a contributions');
});

test('une valeur absente rend une chaine vide', () => {
    assert.equal(decode_html(''), '');
    assert.equal(decode_html(null), '');
    assert.equal(decode_html(undefined), '');
});
