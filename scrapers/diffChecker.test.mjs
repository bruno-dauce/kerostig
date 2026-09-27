import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { detecterScrapersVides, estNouvelArchivage, integrateCalls, trierAppels } from './diffChecker.mjs';
import { clean } from './dataPreparation.mjs';

// Fabrique d'appels : n appels actifs pour une abbreviation donnee.
const appels = (abbreviation, n, actif = true) =>
    Array.from({ length: n }, (_, i) => ({
        abbreviation,
        slug: `${abbreviation}-${i}`,
        active: actif,
    }));

// Fabrique d'appels dates : slug explicite, pubDate partagee a volonte.
const date = (slug, pubDate) => ({ slug, pubDate, active: true });

test('ordonne les appels du plus recent au plus ancien', () => {
    const trie = trierAppels([
        date('vieux', '2026-08-01T00:00:00.000Z'),
        date('recent', '2026-08-30T00:00:00.000Z'),
        date('median', '2026-08-15T00:00:00.000Z'),
    ]);

    assert.deepEqual(trie.map(c => c.slug), ['recent', 'median', 'vieux']);
});

test('departage par slug les appels de meme pubDate', () => {
    const meme = '2026-08-11T10:27:21.121Z';
    const trie = trierAppels([date('charlie', meme), date('alpha', meme), date('bravo', meme)]);

    assert.deepEqual(trie.map(c => c.slug), ['alpha', 'bravo', 'charlie']);
});

test('rend le meme ordre quel que soit l ordre d entree', () => {
    // La regression du 2026-08-31 : 644 appels sur 703 partageaient leur
    // pubDate avec au moins un autre, dont 207 a la meme milliseconde. Le tri
    // par pubDate seul est stable, donc les ex aequo gardaient l'ordre
    // d'entree -- lequel change d'un run a l'autre selon que l'appel passe par
    // la branche des nouveaux ou celle des anciens. Des blocs entiers
    // permutaient et calls.json etait reecrit en totalite.
    const meme = '2026-08-11T10:27:21.121Z';
    const autre = '2026-08-29T11:29:31.659Z';
    const appelsDates = [
        date('emerald-1', meme), date('tandf-2', meme), date('sage-3', meme),
        date('informs-4', autre), date('elsevier-5', autre), date('wiley-6', meme),
    ];

    const attendu = trierAppels(appelsDates).map(c => c.slug);
    const permutations = [
        [...appelsDates].reverse(),
        [appelsDates[3], appelsDates[0], appelsDates[5], appelsDates[2], appelsDates[4], appelsDates[1]],
        [appelsDates[2], appelsDates[4], appelsDates[1], appelsDates[5], appelsDates[0], appelsDates[3]],
    ];

    for (const permutation of permutations) {
        assert.deepEqual(trierAppels(permutation).map(c => c.slug), attendu);
    }
});

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

// La remise a zero ciblee du contentHash (prefixe "reset:", cf commit
// b8e32f760) sert a forcer une reextraction : au prochain passage ou le
// scraper retrouve l'appel, le hash prefixe ne correspond plus au hash reel
// de la page, donc integrateCalls le traite comme un contenu modifie et le
// fait repasser par le modele. Si le scraper NE retrouve PAS l'appel ce
// passage-la (page deplacee, blocage temporaire), rien ne doit se perdre :
// l'appel suit exactement le chemin d'un appel disparu ordinaire.
test('un contentHash "reset:" ne fait perdre aucune donnee quand l appel n est plus retrouve au passage suivant', async () => {
    // Deux appels actifs pour l abbreviation : si le seul appel du scraper
    // etait celui reinitialise, sa disparition ferait tomber apres a 0 et
    // detecterScrapersVides gelerait tout au lieu de le traiter comme une
    // disparition individuelle (cf motif 'zero', sans seuil plancher). Le
    // second appel, lui, est bien retrouve : le scraper n a pas echoue.
    const source = brut('tandf', 2);
    const nettoyes = await clean(source.map(c => ({ ...c })));
    const disparu = {
        ...nettoyes[0],
        active: true,
        description: { paragraphs: ['Un texte existant, jamais retrouve depuis la reinitialisation.'] },
        contentHash: `reset:${nettoyes[0].contentHash}`,
    };
    const retrouve = { ...nettoyes[1], active: true };

    const resultat = await dansUnDepotTemporaire(
        [disparu, retrouve],
        () => integrateCalls([source[1]], ['tandf'])
    );

    assert.equal(resultat.length, 2, 'aucun appel n est perdu ni duplique');
    const apresDisparition = resultat.find(c => c.slug === disparu.slug);
    assert.equal(apresDisparition.active, false, 'marque inactif faute d etre retrouve, comme n importe quel appel disparu');
    assert.ok(apresDisparition.gracePeriod, 'une periode de grace est ouverte, l affichage n est pas coupe net');
    assert.deepEqual(apresDisparition.description, disparu.description, 'la description reste intacte');
    assert.equal(apresDisparition.contentHash, disparu.contentHash, 'le hash reinitialise n est pas efface tant que l appel n est pas retrouve');
});

// Les trois tests suivants exercent integrateCalls de bout en bout sur le
// gel des scrapers vides/en chute (detecterScrapersVides). Les tests unitaires
// de detecterScrapersVides existants (plus bas dans ce fichier) verifient
// le calcul du motif ; aucun ne verifiait jusqu'ici que le resultat ECRIT par
// integrateCalls preserve bien active:true et les donnees des appels geles.
test('un scraper qui retombe a zero gele tous ses appels actifs, donnees intactes', async () => {
    const source = brut('geltest0', 3);
    const anciens = (await clean(source.map(c => ({ ...c })))).map((c, i) => ({
        ...c,
        active: true,
        description: { paragraphs: [`Description ${i}.`] },
    }));

    const resultat = await dansUnDepotTemporaire(anciens, () => integrateCalls([], ['geltest0']));

    assert.equal(resultat.length, 3, 'aucun appel perdu');
    for (const call of resultat) {
        const original = anciens.find((a) => a.slug === call.slug);
        assert.equal(call.active, true, `${call.slug} reste actif malgre le zero`);
        assert.equal(call.gracePeriod, undefined, `${call.slug} n a pas de periode de grace ouverte a tort`);
        assert.deepEqual(call.description, original.description, `${call.slug} garde sa description`);
    }
});

test('un scraper qui retrouve moins de la moitie de ses appels actifs gele les manquants', async () => {
    const source = brut('geltest1', 10);
    const anciens = (await clean(source.map(c => ({ ...c })))).map((c, i) => ({
        ...c,
        active: true,
        description: { paragraphs: [`Description ${i}.`] },
    }));
    // 2 retrouves sur 10 actifs : ratio 0.2 < CHUTE_RATIO (0.5) et chute de 8
    // >= CHUTE_PLANCHER (5) -- declenche le motif 'chute'.
    const retrouves = source.slice(0, 2).map((c) => ({ ...c }));

    const resultat = await dansUnDepotTemporaire(anciens, () => integrateCalls(retrouves, ['geltest1']));

    assert.equal(resultat.length, 10, 'aucun appel perdu');
    assert.ok(resultat.every((call) => call.active === true), 'tous restent actifs, trouves ou geles');
    assert.ok(resultat.every((call) => call.gracePeriod === undefined), 'aucune periode de grace, ce n est pas une disparition');
    for (const call of resultat) {
        const original = anciens.find((a) => a.slug === call.slug);
        assert.deepEqual(call.description, original.description, `${call.slug} garde sa description`);
    }
});

test('une perte isolee sous le plancher n est pas gelee : l appel manquant part en grace normalement', async () => {
    const source = brut('geltest2', 10);
    const anciens = (await clean(source.map(c => ({ ...c })))).map((c, i) => ({
        ...c,
        active: true,
        description: { paragraphs: [`Description ${i}.`] },
    }));
    // 9 retrouves sur 10 : chute de 1, sous CHUTE_PLANCHER (5) -- pas de gel,
    // variation normale (un appel qui clot par exemple).
    const retrouves = source.slice(0, 9).map((c) => ({ ...c }));

    const resultat = await dansUnDepotTemporaire(anciens, () => integrateCalls(retrouves, ['geltest2']));

    assert.equal(resultat.length, 10, 'aucun appel perdu');
    const manquant = resultat.find((c) => c.slug === anciens[9].slug);
    assert.equal(manquant.active, false, 'la variation normale n est pas gelee, l appel manquant part bien en inactif');
    assert.ok(manquant.gracePeriod, 'une periode de grace s ouvre normalement');
    assert.deepEqual(manquant.description, anciens[9].description, 'sa description n est pas perdue pour autant');
    const retrouvesResultats = resultat.filter((c) => c.slug !== anciens[9].slug);
    assert.ok(retrouvesResultats.every((c) => c.active === true), 'les 9 autres restent actifs');
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

// Comme brut(), mais avec un contenu propre au scraper : sans cela, clean()
// ecarte les appels de deux scrapers au meme rawContent comme doublons.
const brutPropre = (abbreviation, n) =>
    brut(abbreviation, n).map(c => ({ ...c, rawContent: `${abbreviation} : ${c.rawContent}` }));

// Un scraper peut atteindre la plupart de ses revues et en voir quelques-unes
// bloquees (challenge Cloudflare non franchi, cf wileyScraper.mjs). Le gel du
// scraper entier ne se declenche pas -- il ne manque que quelques appels --
// et ceux des revues bloquees passaient en inactif faute d'avoir ete revus.
// Un blocage ne dit rien de l'existence d'un appel : il ne doit jamais le
// desactiver.

test('les appels d une revue bloquee restent actifs, tels quels', async () => {
    const source = brutPropre('wiley', 10);
    const anciens = (await clean(source.map(c => ({ ...c })))).map(c => ({ ...c, active: true }));
    const bloque = anciens[3];
    const remontes = source.filter(c => c.issn !== bloque.issn).map(c => ({ ...c }));

    const resultat = await dansUnDepotTemporaire(anciens, () =>
        integrateCalls(remontes, ['wiley'], [{ abbreviation: 'wiley', issn: bloque.issn }]));

    const conserve = resultat.find(call => call.slug === bloque.slug);
    assert.ok(conserve, 'l appel de la revue bloquee est toujours la');
    assert.equal(conserve.active, true);
    assert.equal(conserve.gracePeriod, undefined, 'aucune periode de grace ouverte');
    assert.equal(resultat.length, 10);
});

test('un appel disparu d une revue atteinte passe toujours en inactif', async () => {
    const source = brutPropre('wiley', 10);
    const anciens = (await clean(source.map(c => ({ ...c })))).map(c => ({ ...c, active: true }));
    const disparu = anciens[5];
    const bloque = anciens[3];
    const remontes = source
        .filter(c => c.issn !== disparu.issn && c.issn !== bloque.issn)
        .map(c => ({ ...c }));

    const resultat = await dansUnDepotTemporaire(anciens, () =>
        integrateCalls(remontes, ['wiley'], [{ abbreviation: 'wiley', issn: bloque.issn }]));

    assert.equal(resultat.find(call => call.slug === disparu.slug).active, false);
    assert.equal(resultat.find(call => call.slug === bloque.slug).active, true);
});

test('un blocage signale par un scraper ne protege pas les appels d un autre', async () => {
    // Meme ISSN chez deux scrapers : la protection est propre a chaque source.
    const wiley = brutPropre('wiley', 10);
    const autre = brutPropre('autre', 10);
    const anciens = (await clean([...wiley, ...autre].map(c => ({ ...c })))).map(c => ({ ...c, active: true }));
    const issnBloque = wiley[3].issn;
    const remontes = [...wiley, ...autre]
        .filter(c => c.issn !== issnBloque)
        .map(c => ({ ...c }));

    const resultat = await dansUnDepotTemporaire(anciens, () =>
        integrateCalls(remontes, ['wiley', 'autre'], [{ abbreviation: 'wiley', issn: issnBloque }]));

    const deIssn = abbr => resultat.find(call => call.abbreviation === abbr && call.issn === issnBloque);
    assert.equal(deIssn('wiley').active, true);
    assert.equal(deIssn('autre').active, false);
});

// Les scrapers bloques en CI (Wiley, SAGE, Emerald) sont lances a la main avec
// --only. Les appels des scrapers qui n'ont pas tourne ne doivent pas bouger.
test('les appels d un scraper non lance (--only) ne sont pas desactives', async () => {
    const wiley = brutPropre('wiley', 4);
    const sage = brutPropre('sage', 4);
    const anciens = (await clean([...wiley, ...sage].map(c => ({ ...c })))).map(c => ({ ...c, active: true }));

    const resultat = await dansUnDepotTemporaire(anciens, () =>
        integrateCalls(wiley.map(c => ({ ...c })), ['wiley']));

    const deSage = resultat.filter(call => call.abbreviation === 'sage');
    assert.equal(deSage.length, 4);
    assert.ok(deSage.every(call => call.active === true && call.gracePeriod === undefined));
});

// Constate le 2026-09-27 : trois vieux appels « isj » (fork amont, scraper
// disparu) portaient le meme contentHash que les appels Wiley d'Information
// Systems Journal, une fois ceux-ci lus sur leur page de detail ou leur PDF.
// La correspondance par hash ignorait l'editeur : l'appel Wiley etait
// remplace par l'ancien appel isj (sans ISSN), et la boucle des anciens
// reinjectait en plus cet appel isj -- un exemplaire de plus a chaque run.
test('un hash identique chez un autre scraper ne remplace pas l appel', async () => {
    const wiley = brut('wiley', 1);
    const [enBase] = await clean(wiley.map(c => ({ ...c })));
    const anciens = [
        { ...enBase, active: true },
        // Meme contenu, donc meme hash, sous un autre scraper, place apres
        // pour que la collision joue dans la Map des hashes.
        { ...enBase, abbreviation: 'isj', slug: 'isj-appel-0', issn: undefined, active: false },
    ];

    const resultat = await dansUnDepotTemporaire(anciens, () => integrateCalls(wiley.map(c => ({ ...c })), ['wiley']));

    const deWiley = resultat.filter(call => call.abbreviation === 'wiley');
    assert.equal(deWiley.length, 1, 'l appel Wiley est toujours la');
    assert.equal(deWiley[0].slug, enBase.slug);
    assert.equal(deWiley[0].active, true);
    assert.equal(deWiley[0].issn, enBase.issn);
    assert.equal(resultat.filter(call => call.slug === 'isj-appel-0').length, 1, 'l appel isj n est pas duplique');
    assert.equal(resultat.length, 2);
});
