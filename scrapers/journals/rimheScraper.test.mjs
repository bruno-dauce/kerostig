import test from 'node:test';
import assert from 'node:assert/strict';

import {
    scraperObject,
    decouper_blocs,
    extraire_titre,
    texte_du_bloc,
    echeance_du_bloc,
    bloc_est_ouvert,
    formater_appel,
} from './rimheScraper.mjs';

// Fragments copies de la page reelle le 2026-09-07
// (https://rimhe.com/135+appels-y-contributions.html). Les 5 blocs y sont
// separes par 4 <hr> dans un unique div.text_news.

// Bloc 0 : le chapo permanent de la page ET le seul appel ouvert. C'est le cas
// qui a decide du filtre a deux etages -- il ne porte aucune ligne
// « Echeance de soumission », seulement un calendrier.
const BLOC_OUVERT = `
<p><strong>Les appels à contributions ne sont pas limitatifs des soumissions attendues.</strong></p>
<p><strong>Appel à contributions</strong></p>
<p><strong>« Intersectionnalité et GRH »</strong></p>
<p>Alors que la directive européenne 2023/970 introduit la notion de « discrimination intersectionnelle », la RIMHE lance un numéro spécial.</p>
<p>🗓️ Calendrier &amp; Modalités de soumission</p>
<p>Octobre 2026 : Envoi de la 1ère version des textes complets.<br/>
Avril 2027 : Envoi de la 2ème version après relecture.<br/>
Juin 2027 : Acceptation finale.</p>
<p><a href="/../../../../uploaded/appel-a-publication-numero-special-intersectionnalite-et-grh.pdf">Appel à contribitions : Intersectionnalité et GRH</a></p>
`;

// Bloc 1 : ecriture habituelle de la page, ligne d'echeance explicite.
const BLOC_CLOTURE = `
<p>📍✒️ !! Appel à contributions de la Revue Interdisciplinaire Management, Homme &amp; Entreprise (RIMHE), sur le thème «La vulnérabilité : un concept pour repenser le management ? »</p>
<p>🗓 Échéance de soumission : 03 avril 2026.</p>
<p><a href="/../../../../uploaded/appel-a-contribution-vulnerabilite.pdf">Appel à contribution : Vulnérabilité</a></p>
`;

// Bloc 3 : « le marketing est mort » entre guillemets courbes a l'interieur du
// titre. Le motif ne doit retenir que les guillemets francais.
const BLOC_GUILLEMETS_COURBES = `
<p>📍✒️ !! Appel à contributions sur le thème « Réflexions sur un marketing durable » “le marketing est mort, vive le marketing”.</p>
<p>🗓 Échéance de soumission : le 15 février 2025</p>
<p><a href="/../../../../uploaded/appel-marketing-durable-2025.pdf">Appel-contribution-rimhe-marketing-durable-2025.pdf</a></p>
`;

// Reference figee : les dates ci-dessus sont reelles, un test qui compare a
// new Date() changerait de resultat avec le temps.
const LE_7_SEPTEMBRE_2026 = new Date(2026, 8, 7);

test('le module se charge et expose le contrat attendu par pageController', () => {
    assert.equal(scraperObject.abbreviation, 'rimhe');
    assert.equal(typeof scraperObject.scraper, 'function');
});

// --- Decoupe ----------------------------------------------------------------

test('la page est decoupee sur les <hr> du div.text_news', () => {
    const page = `<html><body>
        <div class="menu"><p>Presentation</p></div>
        <div class="text_news">${BLOC_OUVERT}<hr />${BLOC_CLOTURE}<hr/>${BLOC_GUILLEMETS_COURBES}</div>
    </body></html>`;

    const blocs = decouper_blocs(page);

    assert.equal(blocs.length, 3);
    assert.match(texte_du_bloc(blocs[0]), /Intersectionnalité et GRH/);
    assert.match(texte_du_bloc(blocs[1]), /vulnérabilité/);
    assert.match(texte_du_bloc(blocs[2]), /marketing durable/);
});

test('le decoupage se rabat sur le parent des <hr> si la classe change', () => {
    const page = `<html><body><div class="autre-theme">${BLOC_OUVERT}<hr />${BLOC_CLOTURE}</div></body></html>`;

    assert.equal(decouper_blocs(page).length, 2);
});

test('une page sans <hr> ne rend aucun bloc plutot qu un bloc geant', () => {
    assert.deepEqual(decouper_blocs('<html><body><div class="text_news"><p>Rien</p></div></body></html>'), []);
});

// --- Titre ------------------------------------------------------------------

test('le titre est le theme entre guillemets francais', () => {
    assert.equal(extraire_titre(BLOC_OUVERT), 'Intersectionnalité et GRH');
    assert.equal(extraire_titre(BLOC_CLOTURE), 'La vulnérabilité : un concept pour repenser le management ?');
});

test('les guillemets courbes du corps ne sont pas pris pour un theme', () => {
    assert.equal(extraire_titre(BLOC_GUILLEMETS_COURBES), 'Réflexions sur un marketing durable');
});

test('le titre ne vient pas du <strong>, qui porte aussi le chapo de la page', () => {
    // Le bloc ouvert contient cinq <strong> dont trois de chapo permanent.
    assert.notEqual(extraire_titre(BLOC_OUVERT), 'Les appels à contributions ne sont pas limitatifs des soumissions attendues.');
});

test('sans guillemets, le libelle du lien PDF sert de repli', () => {
    const bloc = '<p>Appel à contributions</p><p><a href="/../../../../uploaded/x.pdf">Appel à contribution : Insularité</a></p>';

    assert.equal(extraire_titre(bloc), 'Appel à contribution : Insularité');
});

test('un bloc sans theme ni PDF ne rend aucun titre', () => {
    assert.equal(extraire_titre('<p>Les appels à contributions ne sont pas limitatifs.</p>'), '');
});

// --- Echeance, les deux etages ----------------------------------------------

test('la ligne d echeance explicite fait foi', () => {
    const { date, explicite } = echeance_du_bloc(texte_du_bloc(BLOC_CLOTURE));

    assert.equal(explicite, true);
    assert.deepEqual(date, new Date(2026, 3, 3));
});

test('le mot Echeance est reconnu accentue comme non accentue', () => {
    assert.equal(echeance_du_bloc('Echeance de soumission : le 30 juillet 2025').explicite, true);
    assert.equal(echeance_du_bloc('Échéance de soumission : le 30 Octobre 2024').explicite, true);
});

test('sans ligne d echeance, la date la plus tardive du bloc est retenue', () => {
    // Octobre 2026, avril 2027, juin 2027 : c'est juin 2027 qui decide.
    const { date, explicite } = echeance_du_bloc(texte_du_bloc(BLOC_OUVERT));

    assert.equal(explicite, false);
    assert.equal(date.getFullYear(), 2027);
    assert.equal(date.getMonth(), 5);
});

test('un mois sans jour vaut jusqu a son dernier jour', () => {
    // Sinon « Octobre 2026 » serait deja passe le 2 octobre 2026.
    const { date } = echeance_du_bloc('Octobre 2026 : envoi des textes.');

    assert.deepEqual(date, new Date(2026, 9, 31));
});

test('un bloc sans aucune date lisible n est pas retenu', () => {
    assert.equal(echeance_du_bloc('Les appels ne sont pas limitatifs.').date, null);
    assert.equal(bloc_est_ouvert('Les appels ne sont pas limitatifs.', LE_7_SEPTEMBRE_2026), false);
});

test('le seul appel vivant de la page passe le filtre, les autres non', () => {
    // Le coeur du scraper : au 2026-09-07 la page porte 1 appel ouvert et
    // 4 clotures, et c'est l'appel ouvert qui n'a pas de ligne d'echeance.
    assert.equal(bloc_est_ouvert(texte_du_bloc(BLOC_OUVERT), LE_7_SEPTEMBRE_2026), true);
    assert.equal(bloc_est_ouvert(texte_du_bloc(BLOC_CLOTURE), LE_7_SEPTEMBRE_2026), false);
    assert.equal(bloc_est_ouvert(texte_du_bloc(BLOC_GUILLEMETS_COURBES), LE_7_SEPTEMBRE_2026), false);
});

test('une echeance explicite passee prime sur une date de calendrier future', () => {
    // Le cas que le premier etage doit trancher : appel clos dont la parution
    // reste a venir. Sans la priorite a la ligne d'echeance, il ressortirait
    // comme un appel courant.
    const bloc = 'Échéance de soumission : le 15 février 2025. Parution prévue : juin 2027.';

    assert.equal(bloc_est_ouvert(bloc, LE_7_SEPTEMBRE_2026), false);
});

// --- Mise en forme d un appel -----------------------------------------------

test('un bloc reel devient un appel complet, avec l ISSN de la revue', () => {
    const call = formater_appel(BLOC_OUVERT, 'rimhe');

    assert.equal(call.journal, 'RIMHE Revue Interdisciplinaire Management Homme(s) & Entreprise');
    assert.equal(call.abbreviation, 'rimhe');
    assert.equal(call.issn, '2260-5584');
    assert.equal(call.metaTitle, 'Intersectionnalité et GRH');
    assert.equal(call.rawContent, BLOC_OUVERT);
    // Aucun champ de travail ne doit fuiter vers dataPreparation.
    assert.deepEqual(
        Object.keys(call).sort(),
        ['abbreviation', 'issn', 'journal', 'metaTitle', 'rawContent', 'url'],
    );
});

test('les chemins relatifs tordus du site sont normalises en URL de PDF', () => {
    // Le site ecrit ses liens « /../../../../uploaded/x.pdf ».
    assert.equal(
        formater_appel(BLOC_OUVERT, 'rimhe').url,
        'https://rimhe.com/uploaded/appel-a-publication-numero-special-intersectionnalite-et-grh.pdf',
    );
});

test('sans PDF, l URL est une ancre sur la page de liste', () => {
    const bloc = '<p>Appel sur le thème « Un thème sans PDF »</p>';

    assert.equal(
        formater_appel(bloc, 'rimhe').url,
        'https://rimhe.com/135+appels-y-contributions.html#Un%20th%C3%A8me%20sans%20PDF',
    );
});

test('un bloc qui n est pas un appel est ecarte', () => {
    assert.equal(formater_appel('<p>Les appels à contributions ne sont pas limitatifs.</p>', 'rimhe'), null);
});
