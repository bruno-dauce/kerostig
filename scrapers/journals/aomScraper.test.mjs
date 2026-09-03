import test from 'node:test';
import assert from 'node:assert/strict';

import { scraperObject, detect_journal } from './aomScraper.mjs';
import { interpreterReponseApi, estFinDePagination, doitDemanderPageSuivante } from '../apiJson.mjs';

// aomScraper portait le meme code que tfScraper avant correction : le repli
// muet de fetch_api_page (Array.isArray ? data : []) et une boucle qui
// demandait la page suivante sans condition. L'API est un WordPress
// (tribe_events, plugin The Events Calendar), donc exactement la meme forme de
// reponse et le meme rest_post_invalid_page_number en fin de pagination.

test('le module se charge et expose le contrat attendu par pageController', () => {
    // Ce test tient surtout le chemin d'import de ../apiJson.mjs : un chemin
    // faux ou un export manquant fait echouer le chargement du module, donc ce
    // test, avant qu'un passage de scraping ne le decouvre en production.
    assert.equal(scraperObject.abbreviation, 'aom');
    assert.equal(typeof scraperObject.scraper, 'function');
});

test('une reponse d erreur de l API AOM leve au lieu de rendre []', () => {
    // Forme reelle d'une erreur WordPress. C'est le cas qui ressortait en
    // tableau vide et faisait passer une panne pour une fin de pagination.
    const corps = JSON.stringify({ code: 'rest_invalid_param', data: { status: 400 } });

    assert.throws(
        () => interpreterReponseApi({ statut: 400, corps, url: 'https://aom.org/wp-json/wp/v2/tribe_events?page=1', prefixe: '[aom]' }),
        /\[aom\].*400.*rest_invalid_param/,
    );
});

test('une page pleine d evenements appelle la page suivante, une page partielle non', () => {
    // API_PAGE_SIZE vaut 100 dans le scraper.
    assert.equal(doitDemanderPageSuivante(100, 100), true);
    assert.equal(doitDemanderPageSuivante(23, 100), false);
    assert.equal(doitDemanderPageSuivante(0, 100), false);
});

test('la page qui suit la derniere est une fin de liste et non une panne', () => {
    const horsBornes = new Error('[aom] HTTP 400 sur https://aom.org/... (rest_post_invalid_page_number)');
    const vraiePanne = new Error('[aom] HTTP 403 sur https://aom.org/... (reponse non JSON)');

    assert.equal(estFinDePagination(horsBornes), true);
    assert.equal(estFinDePagination(vraiePanne), false);
});

// --- Logique propre a AOM ---------------------------------------------------
// Pas de champ revue dans l'API : la revue se lit dans l'abreviation qui ouvre
// le titre de l'evenement.

test('la revue est deduite de l abreviation du titre', () => {
    assert.equal(detect_journal('AMP Call for Special Issue Papers: Grand Challenges'), 'Academy of Management Perspectives');
    assert.equal(detect_journal('AMLE Call for Papers'), 'Academy of Management Learning and Education');
});

test('la detection est insensible a la casse', () => {
    assert.equal(detect_journal('amj call for papers'), 'Academy of Management Journal');
});

test('un titre sans abreviation connue ne resout aucune revue', () => {
    assert.equal(detect_journal('Annual Meeting registration opens'), null);
    assert.equal(detect_journal(''), null);
    assert.equal(detect_journal(null), null);
});

test('l abreviation doit etre un mot entier', () => {
    // Sans la borne de mot, "AMD" mordrait sur des mots quelconques.
    assert.equal(detect_journal('WEBINAR: AMDG programme'), null);
});
