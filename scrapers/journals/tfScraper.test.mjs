import test from 'node:test';
import assert from 'node:assert/strict';

import {
    interpreterReponseApi,
    extraireIdsCategories,
    estFinDePagination,
    doitDemanderPageSuivante,
    lireChampMeta,
} from './tfScraper.mjs';

const URL_FACTICE = 'https://think.taylorandfrancis.com/wp-json/wp/v2/special_issues?page=1';

// --- Lecture d'une page d'API -----------------------------------------------
// Le mode de panne a corriger : le 2026-09-03, l'API repondait 400 parce que
// le hub avait remplace ses identifiants de taxonomie numeriques par des codes
// lettres. La reponse etant du JSON valide, JSON.parse passait, et le garde
// Array.isArray la transformait en [] -- indistinguable d'une fin de
// pagination. Les 83 appels T&F sont sortis de la collecte sans un mot.

test('une page de resultats est rendue telle quelle', () => {
    const corps = JSON.stringify([{ link: 'https://exemple.org/a' }, { link: 'https://exemple.org/b' }]);

    const items = interpreterReponseApi({ statut: 200, corps, url: URL_FACTICE });

    assert.equal(items.length, 2);
});

test('un tableau vide reste un tableau vide : c est une fin de pagination, pas une panne', () => {
    const items = interpreterReponseApi({ statut: 200, corps: '[]', url: URL_FACTICE });

    assert.deepEqual(items, []);
});

test('un statut non-2xx leve une erreur qui nomme le statut', () => {
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
    // Le cas exact qui passait inapercu : JSON.parse reussit, Array.isArray
    // echoue, et l'ancien code rendait [] sans rien signaler.
    const corps = JSON.stringify({ code: 'rest_no_route', message: 'Aucun itineraire' });

    assert.throws(() => interpreterReponseApi({ statut: 200, corps, url: URL_FACTICE }), /rest_no_route/);
});

test('un tableau valide est accepte malgre un statut d interstitiel Cloudflare', () => {
    // page.goto rend le statut de la PREMIERE reponse. Cloudflare sert son
    // interstitiel en 403 puis remplace le document sur place une fois le
    // challenge resolu (cf scrapers/cloudflare.mjs) : le corps final est la
    // seule autorite. Sans cette tolerance, la correction transformerait un
    // challenge franchi en fausse panne.
    const corps = JSON.stringify([{ link: 'https://exemple.org/a' }]);

    const items = interpreterReponseApi({ statut: 403, corps, url: URL_FACTICE });

    assert.equal(items.length, 1);
});

// --- Lecture des categories -------------------------------------------------
// Les identifiants viennent desormais de l'endpoint de taxonomie et non des
// cases a cocher du hub : l'API rend des Term ID entiers, seule forme que
// l'API des numeros speciaux accepte.

test('les identifiants de categorie sont extraits de la reponse de taxonomie', () => {
    // Extrait reel de .../special_issues_tax_subject_areas?per_page=100
    const donnees = [
        { id: 1684, name: 'Area Studies', slug: 'area-studies' },
        { id: 1694, name: 'Economics, Finance, Business &amp; Industry', slug: 'economics-finance-business-industry' },
    ];

    assert.deepEqual(extraireIdsCategories(donnees), [1684, 1694]);
});

test('les entrees sans identifiant entier sont ecartees', () => {
    // « AS » est exactement ce que rendaient les cases a cocher du hub, et que
    // l'API refuse : rien de tel ne doit ressortir d'ici.
    const donnees = [{ id: 1684 }, { id: 'AS' }, { id: null }, {}, null];

    assert.deepEqual(extraireIdsCategories(donnees), [1684]);
});

test('les doublons sont ecartes', () => {
    assert.deepEqual(extraireIdsCategories([{ id: 7 }, { id: 7 }]), [7]);
});

test('une reponse de taxonomie qui n est pas un tableau leve une erreur', () => {
    assert.throws(() => extraireIdsCategories({ code: 'rest_no_route' }), /taxonomie/i);
    assert.throws(() => extraireIdsCategories(null), /taxonomie/i);
});

// --- Fin de pagination ------------------------------------------------------
// Second defaut, revele par la correction ci-dessus : la boucle demandait la
// page suivante sans condition, et WordPress repond 400
// rest_post_invalid_page_number au-dela de la derniere page. L'ancien code
// avalait cette erreur en [] et s'arretait -- la boucle ne terminait donc que
// grace au bug qu'on vient de fermer.

test('une page pleine appelle la page suivante', () => {
    assert.equal(doitDemanderPageSuivante(100, 100), true);
});

test('une page incomplete termine la pagination sans demander la suivante', () => {
    // Le cas courant : 7 appels dans une categorie, une seule page a lire.
    assert.equal(doitDemanderPageSuivante(7, 100), false);
});

test('une page vide termine la pagination', () => {
    assert.equal(doitDemanderPageSuivante(0, 100), false);
});

test('une page au-dela de la derniere est une fin de liste, pas une panne', () => {
    // Message reel produit par interpreterReponseApi le 2026-09-03.
    const erreur = new Error('[tandf] HTTP 400 sur https://exemple/page=2 (rest_post_invalid_page_number)');

    assert.equal(estFinDePagination(erreur), true);
});

test('une vraie panne n est pas prise pour une fin de liste', () => {
    assert.equal(estFinDePagination(new Error('[tandf] HTTP 400 sur ... (rest_invalid_param)')), false);
    assert.equal(estFinDePagination(new Error('[tandf] HTTP 403 sur ... (reponse non JSON)')), false);
    assert.equal(estFinDePagination(new Error('net::ERR_CONNECTION_REFUSED')), false);
    assert.equal(estFinDePagination(null), false);
});

// --- Champs meta ------------------------------------------------------------
// Troisieme changement apporte par la refonte du 2026-09-03 : les champs meta
// arrivent en tableau la ou ils etaient des chaines. Les 83 appels T&F deja
// stockes portent tous des chaines, la forme doit rester la meme.

test('un champ meta en tableau est deplie en chaine', () => {
    assert.equal(lireChampMeta(['Journal of Small Business Management']), 'Journal of Small Business Management');
});

test('un champ meta deja en chaine est rendu tel quel', () => {
    assert.equal(lireChampMeta('Management Learning'), 'Management Learning');
});

test('un champ meta vide ou absent rend null', () => {
    assert.equal(lireChampMeta([]), null);
    assert.equal(lireChampMeta(['']), null);
    assert.equal(lireChampMeta(['   ']), null);
    assert.equal(lireChampMeta(undefined), null);
    assert.equal(lireChampMeta(null), null);
    assert.equal(lireChampMeta(42), null);
});

test('les espaces de bord sont retires', () => {
    assert.equal(lireChampMeta(['  Journal of Marketing  ']), 'Journal of Marketing');
});
