import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';

import { clean, estMetaTitreGenerique, slugUnique } from './dataPreparation.mjs';
import { normaliserUrl } from './url.mjs';

const appel = (surcharge = {}) => ({
    abbreviation: 'sage',
    journal: 'Family Business Review',
    issn: '1741-6248',
    metaTitle: 'Modern Family Firms',
    url: 'https://journals.sagepub.com/pb-assets/PDF/FBR_SI_Modern.pdf',
    rawContent: '<p>Appel a contributions pour un numero special.</p>',
    ...surcharge,
});

// Cas reel du 23 aout 2026 : SAGE a rendu le meme appel deux fois dans un
// meme run, sous deux liens PDF differents. La deduplication par URL laissait
// passer les deux, et integrateCalls les resolvait ensuite vers la meme entree
// ancienne via oldHashMap, qu'il poussait deux fois.
test('ne garde qu une entree quand le meme contenu arrive sous deux URL', async () => {
    const resultat = await clean([
        appel(),
        appel({ url: 'https://journals.sagepub.com/pb-assets/PDF/FBR_SI_Modern-1726822568447.pdf' }),
    ]);

    assert.equal(resultat.length, 1);
    assert.equal(resultat[0].url, 'https://journals.sagepub.com/pb-assets/PDF/FBR_SI_Modern.pdf');
});

test('garde l entree au slug de base, pas celle au suffixe', async () => {
    const resultat = await clean([
        appel(),
        appel({ url: 'https://journals.sagepub.com/autre.pdf' }),
    ]);

    assert.equal(resultat[0].slug, 'sage-modern-family-firms');
});

test('garde deux appels de contenus differents', async () => {
    const resultat = await clean([
        appel(),
        appel({
            url: 'https://journals.sagepub.com/pb-assets/PDF/ETP_startup.pdf',
            metaTitle: 'The Startup Workforce',
            rawContent: '<p>Un tout autre appel, sur un tout autre sujet.</p>',
        }),
    ]);

    assert.equal(resultat.length, 2);
});

test('garde deux appels sans contenu brut mais de titres differents', async () => {
    // hash() retombe sur le slug quand rawContent est vide : deux appels
    // distincts ne doivent pas se confondre par ce biais.
    const resultat = await clean([
        appel({ rawContent: '', metaTitle: 'Premier appel' }),
        appel({ rawContent: '', metaTitle: 'Second appel', url: 'https://exemple.test/2' }),
    ]);

    assert.equal(resultat.length, 2);
});

test('dedoublonne toujours par URL', async () => {
    const resultat = await clean([
        appel(),
        appel({ rawContent: '<p>Contenu different, mais meme URL.</p>' }),
    ]);

    assert.equal(resultat.length, 1);
});

test('garde un numero special conjoint (meme abreviation et URL, ISSN differents)', async () => {
    // elsevierScraper.mjs : un numero special conjoint est scrape comme deux
    // appels distincts (une carte par revue), meme URL, meme abreviation.
    // rawContent distinct (comme le placeholder Elsevier, qui embarque le nom
    // de la revue) : sinon la deduplication par contentHash les confondrait.
    const resultat = await clean([
        appel({ issn: '1741-6248', journal: 'Finance Research Letters', url: 'https://exemple.test/conjoint', rawContent: '<p>Finance Research Letters</p>' }),
        appel({ issn: '0304-405X', journal: 'Emerging Markets Review', url: 'https://exemple.test/conjoint', rawContent: '<p>Emerging Markets Review</p>' }),
    ]);

    assert.equal(resultat.length, 2);
});

// Bug constate sur calls.json : elsevier-pathways-for-eco-industrial-
// transformations... et elsevier-how-government-policy-shapes.... Une
// collision de slug homonyme (deux appels au meme titre dans le meme run)
// assigne arbitrairement le suffixe -2 selon l'ordre d'arrivee. Si l'un des
// deux homonymes n'est pas scrape lors d'un run ulterieur (hub instable,
// pagination partielle), l'autre recalcule alors son slug de BASE (plus de
// collision ce jour-la) au lieu de retrouver le sien -- orphelinant son
// identite historique et creant un doublon frais au prochain passage.
test('un appel deja connu retrouve son propre slug meme si son homonyme du jour de la collision ne revient pas', async () => {
    const homonyme = (surcharge) => appel({
        issn: '1873-508X',
        journal: 'Technovation',
        metaTitle: 'How Government Policy Shapes Business Incubation',
        ...surcharge,
    });

    // Run 1 : les deux revues homonymes arrivent ensemble (cas reel observe).
    // rawContent distinct : deux appels reels, meme titre, mais pas le meme
    // contenu -- sinon la dedoublonnage par contentHash les confondrait.
    const run1 = await clean([
        homonyme({ url: 'https://exemple.test/appel-a', rawContent: '<p>Contenu A</p>' }),
        homonyme({ url: 'https://exemple.test/appel-b', rawContent: '<p>Contenu B</p>' }),
    ]);
    assert.equal(run1[0].slug, 'sage-how-government-policy-shapes-business-incubation');
    assert.equal(run1[1].slug, 'sage-how-government-policy-shapes-business-incubation-2');

    const calls = run1.map((issue, i) => ({
        ...issue,
        abbreviation: 'sage',
        active: true,
        pubDate: new Date(2026, 0, i + 1).toISOString(),
    }));

    // Run 2 : seule la revue qui avait recu le suffixe -2 est re-scrapee.
    const run2 = await clean([homonyme({ url: 'https://exemple.test/appel-b' })], calls);

    assert.equal(run2[0].slug, 'sage-how-government-policy-shapes-business-incubation-2');
});

// Cas reel : CUP republie sa page "Risk Sharing" avec un statut affiche en
// suffixe ("(CLOSED)") une fois l'appel clos. Le statut n'est pas une partie
// de l'identite de l'appel : sans ce retrait, la reextraction du 2026-09-13
// a produit un second slug (cup-risk-sharing-closed), fusionne le 2026-09-28
// avec l'original (cup-risk-sharing).
test('un marqueur de cloture en suffixe du titre ne change pas le slug de base', async () => {
    const resultat = await clean([
        appel({ abbreviation: 'cup', issn: '1783-1350', journal: 'Astin Bulletin', metaTitle: 'Risk Sharing (CLOSED)', url: 'https://exemple.test/risk-sharing' }),
    ]);

    assert.equal(resultat[0].slug, 'cup-risk-sharing');
    // Le champ affiche, lui, garde le statut : seul le calcul du slug l ignore.
    assert.equal(resultat[0].metaTitle, 'Risk Sharing (CLOSED)');
});

test('un mot legitime ne portant pas de marqueur de cloture n est pas ampute', async () => {
    const resultat = await clean([appel({ metaTitle: 'Closed Innovation Strategies' })]);

    assert.equal(resultat[0].slug, 'sage-closed-innovation-strategies');
});

test('la carte d identite rattache un futur appel "(CLOSED)" a la fiche existante', async () => {
    // Simule l etat post-fusion : une seule fiche pour cup-risk-sharing.
    const ancien = [{
        abbreviation: 'cup', issn: '1783-1350', journal: 'Astin Bulletin',
        url: 'https://exemple.test/risk-sharing', slug: 'cup-risk-sharing',
        pubDate: '2026-08-18T00:00:00.000Z',
    }];

    const resultat = await clean([
        appel({ abbreviation: 'cup', issn: '1783-1350', journal: 'Astin Bulletin', metaTitle: 'Risk Sharing (CLOSED)', url: 'https://exemple.test/risk-sharing' }),
    ], ancien);

    assert.equal(resultat[0].slug, 'cup-risk-sharing');
});

test('estMetaTitreGenerique reconnait un texte de source sans contenu propre', () => {
    assert.equal(estMetaTitreGenerique('Call for papers'), true);
    assert.equal(estMetaTitreGenerique('CALL FOR PAPERS'), true);
    assert.equal(estMetaTitreGenerique('CFP'), true);
    assert.equal(estMetaTitreGenerique('Imaginer la post-croissance'), false);
    assert.equal(estMetaTitreGenerique('Call for papers on AI in Healthcare'), false, 'un vrai titre qui commence pareil n est pas generique');
    assert.equal(estMetaTitreGenerique(undefined), false);
});

test('slugUnique ignore lui aussi les marqueurs de cloture', async () => {
    const usedSlugs = new Set();
    assert.equal(await slugUnique('cup', 'Risk Sharing (CLOSED)', usedSlugs), 'cup-risk-sharing');
});

test('rejoue chaque appel de calls.json en isolation : aucun slug ne change', async () => {
    const calls = JSON.parse(await fs.readFile('./www/_data/calls.json', 'utf8'));

    // Meme cle d'identite que construireIdentiteSlugs (dataPreparation.mjs).
    // Un appel seul sur sa cle doit retrouver EXACTEMENT son slug actuel :
    // c'est la garantie demandee (aucun slug existant ne bouge). Un appel qui
    // partage sa cle avec un autre est un doublon deja present dans
    // calls.json (abreviation+ISSN+URL identiques) : la priorite 1 du
    // 2026-09-28 les recense pour fusion manuelle (redirection), et il est
    // normal -- souhaitable meme -- que le rejeu les fasse converger vers un
    // seul slug plutot que de figer leur incoherence. On verifie seulement
    // qu'il converge vers l'UN des slugs du groupe, jamais un troisieme.
    const parIdentite = new Map();
    for (const call of calls) {
        const url = normaliserUrl(call.url);
        if (url === null || !call.issn || !call.abbreviation) continue;
        const cle = `${call.abbreviation}|${call.issn}|${url}`;
        if (!parIdentite.has(cle)) parIdentite.set(cle, []);
        parIdentite.get(cle).push(call);
    }

    let verifiesSansAmbiguite = 0;
    let groupesAmbigus = 0;
    for (const groupe of parIdentite.values()) {
        const slugsConnus = new Set(groupe.map(c => c.slug));
        for (const call of groupe) {
            const issue = {
                abbreviation: call.abbreviation,
                journal: call.journal,
                issn: call.issn,
                metaTitle: call.metaTitle,
                url: call.url,
                rawContent: '',
            };
            const [rejoue] = await clean([issue], calls);
            if (groupe.length === 1) {
                assert.equal(rejoue.slug, call.slug, `slug change pour ${call.url} (${call.abbreviation})`);
                verifiesSansAmbiguite++;
            } else {
                assert.ok(slugsConnus.has(rejoue.slug), `slug inedit pour ${call.url} (${call.abbreviation}) : ${rejoue.slug}`);
            }
        }
        if (groupe.length > 1) groupesAmbigus++;
    }

    assert.ok(verifiesSansAmbiguite > 850, `attendu bien plus de 850 appels sans ambiguite, obtenu ${verifiesSansAmbiguite}`);
    // Les 13 doublons actifs identifies le 2026-09-28 sont fusionnes (PR B) :
    // seul reste le groupe isr-* (3 fiches heritees, ISSN d'Information
    // Systems Research attribue le 2026-09-28 pour les relier a leur revue),
    // qui partagent desormais abreviation+ISSN+URL entre elles sans etre des
    // doublons -- ce sont 3 sujets distincts sur la page hub generique
    // d'INFORMS. Inoffensif : le scraper isr ne tourne plus, cette identite
    // n'est donc plus jamais consultee en production. Une hausse au-dela de 1
    // signale un nouveau doublon a instruire, pas seulement un chiffre a
    // mettre a jour ici.
    assert.equal(groupesAmbigus, 1, `nombre de groupes en doublon inattendu : ${groupesAmbigus}`);
});
