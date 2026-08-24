import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { detecterScrapersVides, estNouvelArchivage, integrateCalls } from './diffChecker.mjs';
import { clean } from './dataPreparation.mjs';

// Fabrique d'appels : n appels actifs pour une abbreviation donnee.
const appels = (abbreviation, n, actif = true) =>
    Array.from({ length: n }, (_, i) => ({
        abbreviation,
        slug: `${abbreviation}-${i}`,
        active: actif,
    }));

test('signale une troncature muette : 47 appels au passage precedent, 12 au passage courant', () => {
    const anciens = appels('emerald', 47);
    const nouveaux = appels('emerald', 12);

    const alertes = detecterScrapersVides(nouveaux, anciens, ['emerald']);

    assert.equal(alertes.length, 1);
    assert.equal(alertes[0].abbreviation, 'emerald');
    assert.equal(alertes[0].avant, 47);
    assert.equal(alertes[0].apres, 12);
});

test('signale toujours un scraper tombe a zero', () => {
    const alertes = detecterScrapersVides([], appels('sage', 3), ['sage']);

    assert.equal(alertes.length, 1);
    assert.equal(alertes[0].motif, 'zero');
    assert.equal(alertes[0].apres, 0);
});

test('ne signale pas la variation de routine d un scraper', () => {
    // 48 -> 45, la plus forte variation ordinaire relevee dans l'historique.
    const alertes = detecterScrapersVides(appels('emerald', 45), appels('emerald', 48), ['emerald']);

    assert.deepEqual(alertes, []);
});

test('ne gele pas un petit producteur sous le plancher absolu', () => {
    // 7 -> 3 franchit le ratio (3 < 3,5) mais ne perd que 4 appels : trop peu
    // pour distinguer un echec d'un retrait normal, on laisse passer.
    const alertes = detecterScrapersVides(appels('afc', 3), appels('afc', 7), ['afc']);

    assert.deepEqual(alertes, []);
});

test('ne gele pas une baisse marquee qui reste au-dessus de la moitie', () => {
    // 20 -> 14 depasse le plancher (6 appels perdus) mais pas le ratio : une
    // fournee d'appels clotures ensemble reste une explication plausible.
    const alertes = detecterScrapersVides(appels('elsevier', 14), appels('elsevier', 20), ['elsevier']);

    assert.deepEqual(alertes, []);
});

test('ne tient pas compte des appels deja archives au passage precedent', () => {
    const anciens = [...appels('dm', 2, false), ...appels('dm', 1, true)];

    const alertes = detecterScrapersVides([], anciens, ['dm']);

    assert.equal(alertes.length, 1);
    assert.equal(alertes[0].avant, 1);
});

// Appels bruts, tels qu'un scraper les rend avant clean().
const brut = (abbreviation, n) =>
    Array.from({ length: n }, (_, i) => ({
        abbreviation,
        journal: `Revue ${i}`,
        issn: `0000-000${i}`,
        metaTitle: `Appel ${i}`,
        url: `https://exemple.test/${abbreviation}/${i}`,
        rawContent: `Contenu de l appel ${i}`,
    }));

// integrateCalls lit et ecrit ./www/_data/calls.json, relatif au repertoire
// courant. On le depayse dans un dossier temporaire le temps du test.
async function dansUnDepotTemporaire(anciens, executer) {
    const racine = await fs.mkdtemp(path.join(os.tmpdir(), 'kerostig-diff-'));
    const cwd = process.cwd();
    try {
        await fs.mkdir(path.join(racine, 'www', '_data'), { recursive: true });
        await fs.writeFile(path.join(racine, 'www', '_data', 'calls.json'), JSON.stringify(anciens, null, 2));
        process.chdir(racine);
        await executer();
        return JSON.parse(await fs.readFile(path.join(racine, 'www', '_data', 'calls.json'), 'utf8'));
    } finally {
        process.chdir(cwd);
        await fs.rm(racine, { recursive: true, force: true });
    }
}

test('rend ses alertes a l appelant, pour que la CI puisse les afficher', async () => {
    const source = brut('sage', 3);
    const anciens = (await clean(source.map(c => ({ ...c })))).map(c => ({ ...c, active: true }));

    let alertes;
    await dansUnDepotTemporaire(anciens, async () => { alertes = await integrateCalls([], ['sage']); });

    assert.equal(alertes.length, 1);
    assert.equal(alertes[0].abbreviation, 'sage');
    assert.equal(alertes[0].avant, 3);
});

test('une remontee tronquee ne duplique pas les appels conserves', async () => {
    const source = brut('emerald', 47);
    // Les anciens passent par clean() : leurs slugs et contentHash sont donc
    // exactement ceux que integrateCalls recalculera sur les memes appels.
    const anciens = (await clean(source.map(c => ({ ...c })))).map(c => ({ ...c, active: true }));
    const tronques = source.slice(0, 12).map(c => ({ ...c }));

    const resultat = await dansUnDepotTemporaire(anciens, () => integrateCalls(tronques, ['emerald']));

    const slugs = resultat.map(call => call.slug);
    assert.equal(new Set(slugs).size, slugs.length, 'aucun slug ne doit apparaitre deux fois');
    assert.equal(resultat.length, 47, 'les 47 appels sont conserves, ni perdus ni dupliques');
});

test('estNouvelArchivage distingue un premier archivage d une repetition', () => {
    assert.equal(estNouvelArchivage({ active: true }), true, 'appel encore actif : premier archivage');
    assert.equal(estNouvelArchivage(undefined), true, 'appel inconnu au passage precedent : premier archivage');
    assert.equal(estNouvelArchivage({ active: false }), false, 'deja archive : rien de nouveau');
});

// Capture les lignes de console.log le temps d'un appel.
async function journalDe(executer) {
    const lignes = [];
    const original = console.log;
    console.log = (...args) => lignes.push(args.join(' '));
    try {
        await executer();
    } finally {
        console.log = original;
    }
    return lignes;
}

// Un appel d'archive permanente, echeance largement depassee, re-remonte a
// chaque passage. Les anciens passent par clean() pour porter exactement les
// slugs et contentHash que integrateCalls recalculera.
async function appelEcheanceDepassee(actifEnBase) {
    const source = brut('dm', 1);
    const anciens = (await clean(source.map(c => ({ ...c })))).map(c => ({
        ...c,
        active: actifEnBase,
        dates: [{ date: '2024-01-01', is_full_paper_submission_deadline: true }],
    }));
    return { source, anciens };
}

test('annonce l archivage par echeance au passage ou il a lieu', async () => {
    const { source, anciens } = await appelEcheanceDepassee(true);

    let resultat;
    const lignes = await journalDe(async () => {
        resultat = await dansUnDepotTemporaire(anciens, () => integrateCalls(source, ['dm']));
    });

    assert.equal(resultat[0].active, false, 'l appel est bien archive');
    assert.equal(
        lignes.filter(l => l.includes('marque inactif')).length, 1,
        'le premier archivage est annonce une fois'
    );
});

test('ne repete pas l annonce pour un appel deja archive au passage precedent', async () => {
    const { source, anciens } = await appelEcheanceDepassee(false);

    let resultat;
    const lignes = await journalDe(async () => {
        resultat = await dansUnDepotTemporaire(anciens, () => integrateCalls(source, ['dm']));
    });

    assert.equal(resultat[0].active, false, 'l appel reste archive');
    assert.deepEqual(
        lignes.filter(l => l.includes('marque inactif')), [],
        'rien a annoncer : l etat n a pas change'
    );
});
