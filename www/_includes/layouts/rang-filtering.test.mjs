import test from 'node:test';
import assert from 'node:assert/strict';

// Reproduction fidele de match_rang() dans main.html (x-data Alpine.js) : ce
// code vit dans un attribut HTML, pas dans un module important, donc il n'y a
// pas de source unique possible sans construire un mecanisme d'injection pour
// une fonction de deux lignes. Toute modification de match_rang dans
// main.html doit etre repercutee ici, et inversement -- voir le commentaire
// jumeau dans main.html.
function matchRang(dataRang, rangSelectionne) {
    if (rangSelectionne === '') return true;
    return (dataRang || '').split(' ').includes(rangSelectionne);
}

test('un rang vide (aucun filtre) laisse tout passer', () => {
    assert.equal(matchRang('1', ''), true);
    assert.equal(matchRang('', ''), true);
});

test('une revue de rang 1* ne sort pas sous le filtre 1', () => {
    // Le piege vise ici : un simple .includes() sur la chaine brute
    // ("1*".includes("1") === true) attraperait a tort "1*" sous le
    // filtre "1". Le split sur l'espace puis Array.includes (egalite
    // stricte par element) evite cette collision de sous-chaine.
    assert.equal(matchRang('1*', '1'), false);
});

test('une revue de rang 1 sort sous le filtre 1', () => {
    assert.equal(matchRang('1', '1'), true);
});

test('une revue de rang 1* sort sous le filtre 1*', () => {
    assert.equal(matchRang('1*', '1*'), true);
});

test('IEEE (rangs 2 et 3) sort sous le filtre 2', () => {
    assert.equal(matchRang('2 3', '2'), true);
});

test('IEEE (rangs 2 et 3) sort sous le filtre 3', () => {
    assert.equal(matchRang('2 3', '3'), true);
});

test('IEEE (rangs 2 et 3) ne sort pas sous le filtre 1', () => {
    assert.equal(matchRang('2 3', '1'), false);
});

test('IEEE (rangs 2 et 3) ne sort pas sous le filtre 4', () => {
    assert.equal(matchRang('2 3', '4'), false);
});

// Reproduction fidele du coeur de recount() dans main.html : le comptage par
// puce de rang (this.counts.rang) et le total de cartes (rangTotal). A
// resynchroniser avec main.html si l'un des deux change.
function compterParRang(dataRangParCarte) {
    const rang = {};
    let rangTotal = 0;
    for (const dataRang of dataRangParCarte) {
        rangTotal++;
        for (const r of (dataRang || '').split(' ').filter(Boolean)) {
            rang[r] = (rang[r] || 0) + 1;
        }
    }
    return { rang, rangTotal };
}

test('une carte a rang unique incremente une seule puce', () => {
    const { rang, rangTotal } = compterParRang(['1', '1', '2']);
    assert.deepEqual(rang, { '1': 2, '2': 1 });
    assert.equal(rangTotal, 3);
});

test('IEEE incremente la puce 2 ET la puce 3, sans cle composite', () => {
    const { rang } = compterParRang(['2 3']);
    assert.deepEqual(rang, { '2': 1, '3': 1 });
    assert.equal('2 3' in rang, false);
});

test('IEEE ne compte qu une fois dans le total de cartes', () => {
    const { rangTotal } = compterParRang(['1', '2 3', '4']);
    assert.equal(rangTotal, 3);
});
