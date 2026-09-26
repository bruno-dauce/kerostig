import test from 'node:test';
import assert from 'node:assert/strict';

import { classerTentatives, ordonnerUrls, formaterBilan, extract_entries } from './wileyScraper.mjs';

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

// Le chemin qui a fonctionne au passage precedent est essaye en premier : une
// page chargee par revue au lieu de jusqu'a sept.

test('sans chemin memorise, l ordre des candidats est conserve', () => {
    assert.deepEqual(ordonnerUrls(['a', 'b', 'c'], undefined), ['a', 'b', 'c']);
});

test('le chemin memorise passe en tete, sans doublon', () => {
    assert.deepEqual(ordonnerUrls(['a', 'b', 'c'], 'b'), ['b', 'a', 'c']);
});

test('un chemin memorise hors des candidats est essaye quand meme', () => {
    assert.deepEqual(ordonnerUrls(['a', 'b'], 'z'), ['z', 'a', 'b']);
});

test('le bilan chiffre chaque motif et le nombre d appels', () => {
    const bilan = formaterBilan({
        total: 10, atteintes: 6, avecAppels: 4, appels: 12, requetes: 15,
        motifs: { bloque: 2, absent: 1, reseau: 1, autre: 0 },
    });
    assert.match(bilan, /Bilan sur 10 revue/);
    assert.match(bilan, /OK\s+6 \(dont 4/);
    assert.match(bilan, /bloquees\s+2/);
    assert.match(bilan, /absentes\s+1/);
    assert.match(bilan, /appels\s+12/);
});

// Constate le 2026-09-27 sur International Transactions in Operational
// Research : sous son h2 « Call for Papers », Wiley affiche un vieux module
// d'une AUTRE revue (Children & Society, 25e anniversaire, numero virtuel).
// Le seul lien de la section pointait vers la page de cette autre revue, et
// devenait un « appel » ITOR intitule « Children & Society ».

const PAGE_ITOR = 'https://onlinelibrary.wiley.com/page/journal/14753995/homepage/call_for_papers';
const sectionItor = liens => `<div class="pb-rich-text"><h2>Call for Papers</h2>${liens}</div>`;

test('un lien vers la page d une autre revue n est pas un appel', () => {
    const html = sectionItor(`<div class="moduleFragmentContainer"><h3>Children &amp; Society 25th Anniversary Issue</h3>
        <p><a href="/page/journal/10990860/homepage/children___society_25th_anniversary_issue.htm"><b><i>Children &amp; Society</i></b></a></p></div>`);
    assert.deepEqual(extract_entries(html, PAGE_ITOR, 'ITOR'), []);
});

test('un lien vers une page de la meme revue reste un appel', () => {
    const html = sectionItor(`<p><a href="/page/journal/14753995/homepage/si_logistics.htm">Special issue on logistics</a></p>`);
    const entries = extract_entries(html, PAGE_ITOR, 'ITOR');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].metaTitle, 'Special issue on logistics');
});

test('un lien hors des pages revue Wiley (PDF, site externe) reste un appel', () => {
    const html = sectionItor(`<p><a href="https://onlinelibrary.wiley.com/pb-assets/assets/14753995/CFP.pdf">CFP logistics</a></p>
        <p><a href="https://example.org/cfp">CFP external</a></p>`);
    assert.equal(extract_entries(html, PAGE_ITOR, 'ITOR').length, 2);
});
