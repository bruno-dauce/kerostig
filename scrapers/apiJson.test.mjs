import test from 'node:test';
import assert from 'node:assert/strict';

import { interpreterReponseApi, estFinDePagination, doitDemanderPageSuivante } from './apiJson.mjs';

const URL_FACTICE = 'https://exemple.org/wp-json/wp/v2/posts?page=1';

// --- Lecture d'une page d'API -----------------------------------------------

test('une page de resultats est rendue telle quelle', () => {
    const corps = JSON.stringify([{ link: 'https://exemple.org/a' }, { link: 'https://exemple.org/b' }]);

    assert.equal(interpreterReponseApi({ statut: 200, corps, url: URL_FACTICE }).length, 2);
});

test('un tableau vide reste un tableau vide : c est une fin de pagination, pas une panne', () => {
    assert.deepEqual(interpreterReponseApi({ statut: 200, corps: '[]', url: URL_FACTICE }), []);
});

test('un statut non-2xx leve une erreur qui nomme le statut et le code', () => {
    // Corps reel releve le 2026-09-03 sur .../special_issues_tax_subject_areas=AS
    const corps = JSON.stringify({
        code: 'rest_invalid_param',
        message: 'Invalid parameter(s): special_issues_tax_subject_areas',
        data: { status: 400 },
    });

    assert.throws(
        () => interpreterReponseApi({ statut: 400, corps, url: URL_FACTICE }),
        (erreur) => {
            assert.match(erreur.message, /400/);
            assert.match(erreur.message, /rest_invalid_param/);
            return true;
        },
    );
});

test('une reponse qui n est pas du JSON leve une erreur au lieu de rendre []', () => {
    assert.throws(
        () => interpreterReponseApi({ statut: 403, corps: '<html>Attention Required! | Cloudflare</html>', url: URL_FACTICE }),
        /403/,
    );
});

test('un objet JSON valide mais qui n est pas un tableau leve une erreur, meme en 200', () => {
    // Le cas exact qui passait inapercu dans les trois scrapers : JSON.parse
    // reussit, Array.isArray echoue, et l'ancien code rendait [].
    const corps = JSON.stringify({ code: 'rest_no_route', message: 'Aucun itineraire' });

    assert.throws(() => interpreterReponseApi({ statut: 200, corps, url: URL_FACTICE }), /rest_no_route/);
});

test('un tableau valide est accepte malgre un statut d interstitiel Cloudflare', () => {
    // page.goto rend le statut de la PREMIERE reponse. Cloudflare sert son
    // interstitiel en 403 puis remplace le document sur place : le corps final
    // est la seule autorite.
    const corps = JSON.stringify([{ link: 'https://exemple.org/a' }]);

    assert.equal(interpreterReponseApi({ statut: 403, corps, url: URL_FACTICE }).length, 1);
});

test('le prefixe de journalisation identifie le scraper appelant', () => {
    assert.throws(
        () => interpreterReponseApi({ statut: 500, corps: 'boom', url: URL_FACTICE, prefixe: '[aom]' }),
        /^Error: \[aom\] /,
    );
    // Sans prefixe fourni, un repli neutre plutot qu'un nom de scraper faux.
    assert.throws(() => interpreterReponseApi({ statut: 500, corps: 'boom', url: URL_FACTICE }), /^Error: \[api\] /);
});

// --- Fin de pagination ------------------------------------------------------

test('une page pleine appelle la page suivante', () => {
    assert.equal(doitDemanderPageSuivante(100, 100), true);
});

test('une page incomplete termine la pagination sans demander la suivante', () => {
    assert.equal(doitDemanderPageSuivante(7, 100), false);
});

test('une page vide termine la pagination', () => {
    assert.equal(doitDemanderPageSuivante(0, 100), false);
});

test('une page au-dela de la derniere est une fin de liste, pas une panne', () => {
    const erreur = new Error('[tandf] HTTP 400 sur https://exemple/page=2 (rest_post_invalid_page_number)');

    assert.equal(estFinDePagination(erreur), true);
});

test('une vraie panne n est pas prise pour une fin de liste', () => {
    assert.equal(estFinDePagination(new Error('[tandf] HTTP 400 sur ... (rest_invalid_param)')), false);
    assert.equal(estFinDePagination(new Error('[aom] HTTP 403 sur ... (reponse non JSON)')), false);
    assert.equal(estFinDePagination(new Error('net::ERR_CONNECTION_REFUSED')), false);
    assert.equal(estFinDePagination(null), false);
});
