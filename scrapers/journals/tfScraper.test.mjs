import test from 'node:test';
import assert from 'node:assert/strict';

import { scraperObject, extraireIdsCategories, lireChampMeta } from './tfScraper.mjs';

// La lecture des reponses d'API et les regles de pagination sont partagees
// avec aomScraper et reScraper : elles vivent dans scrapers/apiJson.mjs et y
// sont testees. Ne restent ici que les deux fonctions propres a Taylor &
// Francis, l'une et l'autre nees de la refonte de leur hub le 2026-09-03.

test('le scraper expose le contrat attendu par pageController', () => {
    assert.equal(scraperObject.abbreviation, 'tandf');
    assert.equal(typeof scraperObject.scraper, 'function');
});

// --- Categories -------------------------------------------------------------
// Les identifiants viennent de l'endpoint de taxonomie et non plus des cases a
// cocher du hub : l'API rend des Term ID entiers, seule forme qu'elle accepte.

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

// --- Champs meta ------------------------------------------------------------
// Autre effet de la refonte : les champs meta arrivent en tableau la ou ils
// etaient des chaines. Les 83 appels T&F deja stockes portent des chaines, la
// forme doit rester la meme.

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
