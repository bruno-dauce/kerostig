import test from 'node:test';
import assert from 'node:assert/strict';

import { scraperObject, extraire_id_categorie, extraire_titre, formater_appel, decode_html } from './mavScraper.mjs';
import { interpreterReponseApi } from '../apiJson.mjs';

// Fragments releves sur l'API reelle le 2026-09-07
// (/wp-json/wp/v2/posts?categories=1218). Les deux seuls appels en ligne
// portent le meme title.rendered : c'est tout l'enjeu de extraire_titre.
const POST_MARKETING = {
    id: 12591,
    link: 'https://managementetavenir.fr/appel-a-publications-rma-cahier-special/',
    title: { rendered: 'APPEL à PUBLICATIONS &#8211; RMA &#8211; Cahier spécial' },
    content: {
        rendered: '\n<h2 class="wp-block-heading has-text-align-center"><strong>Quel marketing à l’ère de la transition écologique et sociale ?</strong></h2>\n\n\n\n<p class="has-text-align-center wp-block-paragraph"><em>Date limite d’envoi des manuscrits : 10 mars 2026</em></p>\n',
    },
};

const POST_ENTREPRISE_FAMILIALE = {
    id: 10283,
    link: 'https://managementetavenir.fr/appel-a-contributions-rma-sante-et-environnement-n12/',
    title: { rendered: 'APPEL à PUBLICATIONS &#8211; RMA &#8211; Cahier spécial' },
    content: {
        // Double <strong> imbrique et entite &rsquo; : la forme reelle du site.
        // Les <h2> de petits cercles servent de separateurs de section plus bas
        // dans la page, d'ou le garde sur les intertitres decoratifs.
        rendered: '\n<h2 class="wp-block-heading has-text-align-center"><strong><strong>L&rsquo;entreprise familiale : un modèle organisationnel dans un contexte de crises et de transitions ?</strong></strong></h2>\n\n\n\n<p class="has-text-align-center wp-block-paragraph"><em>Date limite de soumission des articles : le </em><strong><em>31 mars 2026</em></strong></p>\n\n\n\n<h2 class="wp-block-heading has-text-align-center">°°°°°°°°°°°</h2>\n\n\n\n<h2 class="wp-block-heading">Soumission</h2>\n',
    },
};

test('le module se charge et expose le contrat attendu par pageController', () => {
    // Tient le chemin d'import de ../apiJson.mjs : un chemin faux ou un export
    // manquant fait echouer le chargement, donc ce test.
    assert.equal(scraperObject.abbreviation, 'mav');
    assert.equal(typeof scraperObject.scraper, 'function');
});

test('une reponse d erreur de l API leve au lieu de rendre []', () => {
    // Forme reelle d'une erreur WordPress : du JSON valide, qui franchit le
    // parse et ressortait en tableau vide -- soit le signal de fin de liste.
    const corps = JSON.stringify({ code: 'rest_invalid_param', data: { status: 400 } });

    assert.throws(
        () => interpreterReponseApi({ statut: 400, corps, url: 'https://managementetavenir.fr/wp-json/wp/v2/posts', prefixe: '[mav]' }),
        /\[mav\].*400.*rest_invalid_param/,
    );
});

test('une page de posts valide reste acceptee', () => {
    const corps = JSON.stringify([POST_MARKETING]);

    const items = interpreterReponseApi({ statut: 200, corps, url: 'https://managementetavenir.fr/x', prefixe: '[mav]' });

    assert.equal(items.length, 1);
    assert.equal(items[0].id, 12591);
});

// --- Resolution de la categorie ---------------------------------------------
// Sans identifiant, la requete de posts partirait sans filtre et ramenerait
// tout le blog : ces trois cas doivent se distinguer nettement.

test('l identifiant est lu dans la reponse reelle de categorie', () => {
    const donnees = [{ id: 1218, slug: 'appels-a-publications' }];

    assert.equal(extraire_id_categorie(donnees), 1218);
});

test('un slug inconnu rend null et non un identifiant par defaut', () => {
    assert.equal(extraire_id_categorie([]), null);
    assert.equal(extraire_id_categorie([{ slug: 'appels-a-publications' }]), null);
});

test('une reponse qui n est pas un tableau leve', () => {
    assert.throws(
        () => extraire_id_categorie({ code: 'rest_forbidden' }),
        /\[mav\].*tableau/,
    );
});

// --- Titre ------------------------------------------------------------------
// Les deux appels partagent le meme title.rendered ("APPEL a PUBLICATIONS -
// RMA - Cahier special"). Utilise tel quel, il donnerait deux fiches
// indistinguables et deux slugs en collision.

test('le titre vient du premier intertitre du corps, pas du titre WordPress', () => {
    assert.equal(
        extraire_titre(POST_MARKETING),
        'Quel marketing à l’ère de la transition écologique et sociale ?',
    );
});

test('les balises imbriquees et les entites du titre sont resolues', () => {
    assert.equal(
        extraire_titre(POST_ENTREPRISE_FAMILIALE),
        'L’entreprise familiale : un modèle organisationnel dans un contexte de crises et de transitions ?',
    );
});

test('deux posts au meme titre WordPress rendent bien deux titres distincts', () => {
    // La regression que ce scraper doit empecher.
    assert.equal(POST_MARKETING.title.rendered, POST_ENTREPRISE_FAMILIALE.title.rendered);
    assert.notEqual(extraire_titre(POST_MARKETING), extraire_titre(POST_ENTREPRISE_FAMILIALE));
});

test('un intertitre purement decoratif n est pas pris pour un titre', () => {
    // Le site separe ses sections par des <h2> de petits cercles. Ils
    // apparaissent apres le vrai titre dans les deux appels en ligne, mais rien
    // ne garantit cet ordre sur un appel a venir.
    const post = {
        title: { rendered: 'APPEL à PUBLICATIONS' },
        content: { rendered: '<h2>°°°°°°°°°°°</h2><h2>Un vrai titre d’appel</h2>' },
    };

    assert.equal(extraire_titre(post), 'Un vrai titre d’appel');
});

test('sans aucun intertitre, le titre WordPress sert de repli', () => {
    const post = {
        title: { rendered: 'APPEL à PUBLICATIONS &#8211; RMA' },
        content: { rendered: '<p>Un appel sans intertitre.</p>' },
    };

    assert.equal(extraire_titre(post), 'APPEL à PUBLICATIONS – RMA');
});

// --- Mise en forme d un appel -----------------------------------------------

test('un post reel devient un appel complet, avec l ISSN de la revue', () => {
    const call = formater_appel(POST_MARKETING, 'mav');

    assert.deepEqual(
        { journal: call.journal, abbreviation: call.abbreviation, issn: call.issn, metaTitle: call.metaTitle, url: call.url },
        {
            journal: 'Management & Avenir',
            abbreviation: 'mav',
            issn: '1969-6574',
            metaTitle: 'Quel marketing à l’ère de la transition écologique et sociale ?',
            url: 'https://managementetavenir.fr/appel-a-publications-rma-cahier-special/',
        },
    );
    // Le texte integral part au LLM tel quel : c'est content.rendered, pas un extrait.
    assert.equal(call.rawContent, POST_MARKETING.content.rendered);
});

test('un post sans contenu exploitable est ecarte plutot que publie vide', () => {
    assert.equal(formater_appel({ ...POST_MARKETING, content: { rendered: '' } }, 'mav'), null);
    assert.equal(formater_appel({ ...POST_MARKETING, content: { rendered: '   ' } }, 'mav'), null);
    assert.equal(formater_appel({ id: 1, link: 'https://managementetavenir.fr/x/' }, 'mav'), null);
});

test('un post sans lien retombe sur l URL par identifiant', () => {
    const call = formater_appel({ ...POST_MARKETING, link: undefined }, 'mav');

    assert.equal(call.url, 'https://managementetavenir.fr/?p=12591');
});

// --- Decodage ---------------------------------------------------------------

test('les entites HTML sont decodees et les espaces normalises', () => {
    assert.equal(decode_html('Appel &agrave; publications'), 'Appel à publications');
    assert.equal(decode_html('RMA &#8211; Cahier sp&eacute;cial'), 'RMA – Cahier spécial');
    assert.equal(decode_html('  Appel   a\n\npublications  '), 'Appel a publications');
});

test('une valeur absente rend une chaine vide', () => {
    assert.equal(decode_html(''), '');
    assert.equal(decode_html(null), '');
    assert.equal(decode_html(undefined), '');
});
