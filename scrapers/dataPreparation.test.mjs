import test from 'node:test';
import assert from 'node:assert/strict';

import { clean } from './dataPreparation.mjs';

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
