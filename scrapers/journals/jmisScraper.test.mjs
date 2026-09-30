import test from 'node:test';
import assert from 'node:assert/strict';

import { scraperObject, extraire_liens_appels, est_pdf } from './jmisScraper.mjs';
import { clean } from '../dataPreparation.mjs';

// Extrait fige de https://www.jmis-web.org/cfp, releve le 2026-10-01. Le titre
// du site est lui aussi un <h3> (lien vers « / ») : il ne doit pas etre pris
// pour un appel. Le dernier <h3> est ajoute pour le cas d'un titre sans lien.
const PAGE = `
<div class="container">
<h3><em><a href="/">Journal of Management Information Systems</a></em></h3>
<div class="margin-bottom-15"><h2>Calls for Papers</h2></div>

<h3>Special Issue: Agentic Organizations: Designing, Governing, and Managing AI Agents <a href="/cfps/JMIS_CfP_Agentic_Organizations.pdf">(PDF)</a></h3>

<h3>Special Issue: Generative AI as Driver of Change in Media <a href="/cfps/JMIS_CfP_AI_and_Media.pdf">(PDF)</a></h3>

<h3>Special Section: Critical National Infrastructure <a href="/cfps/JMIS_CFP_CNI_Special_Section.pdf">(PDF)</a></h3>

<h3>Special Issue: Annonce sans lien</h3>
</div>`;

test('le module expose le contrat attendu par pageController', () => {
    assert.equal(scraperObject.abbreviation, 'jmis');
    assert.equal(typeof scraperObject.scraper, 'function');
});

test('les trois h3 a lien PDF sont retenus, dans l\'ordre de la page', () => {
    const liens = extraire_liens_appels(PAGE);

    assert.equal(liens.length, 3);
    assert.deepEqual(liens.map(l => l.url), [
        'https://www.jmis-web.org/cfps/JMIS_CfP_Agentic_Organizations.pdf',
        'https://www.jmis-web.org/cfps/JMIS_CfP_AI_and_Media.pdf',
        'https://www.jmis-web.org/cfps/JMIS_CFP_CNI_Special_Section.pdf',
    ]);
});

test('le titre est celui du h3, sans le lien « (PDF) »', () => {
    const liens = extraire_liens_appels(PAGE);

    assert.equal(liens[0].titre, 'Special Issue: Agentic Organizations: Designing, Governing, and Managing AI Agents');
    assert.ok(liens.every(l => !l.titre.includes('(PDF)')));
});

test('le titre du site (h3 vers « / ») n\'est pas un appel', () => {
    const liens = extraire_liens_appels(PAGE);

    assert.ok(!liens.some(l => /Journal of Management Information Systems/.test(l.titre)));
    assert.ok(!liens.some(l => l.url === 'https://www.jmis-web.org/'));
});

test('un h3 sans lien est ignore, sans lever', () => {
    const liens = extraire_liens_appels(PAGE);

    assert.ok(!liens.some(l => /sans lien/.test(l.titre)));
});

test('une page sans appel rend une liste vide', () => {
    assert.deepEqual(extraire_liens_appels('<html><body><h2>Calls for Papers</h2></body></html>'), []);
});

test('est_pdf distingue un PDF d\'une page HTML servie en 200', () => {
    assert.equal(est_pdf(Buffer.from('%PDF-1.7 ...')), true);
    assert.equal(est_pdf(Buffer.from('<!doctype html><title>404</title>')), false);
});

test('une fiche heritee est reconnue : meme slug repris, pas de nouvelle fiche', async () => {
    const slugHerite = 'jmis-generative-ai-as-driver-of-change-in-media';
    const url = 'https://www.jmis-web.org/cfps/JMIS_CfP_AI_and_Media.pdf';
    const ancien = [{ slug: slugHerite, abbreviation: 'jmis', issn: '1557-928X', url, pubDate: '2025-12-01T00:00:00.000Z' }];
    const lien = extraire_liens_appels(PAGE).find(l => l.url === url);

    const [appel] = await clean([{
        journal: 'Journal of Management Information Systems',
        abbreviation: 'jmis',
        issn: '1557-928X',
        metaTitle: lien.titre,
        url: lien.url,
        rawContent: '<p>Texte de l\'appel</p>',
    }], ancien);

    assert.equal(appel.slug, slugHerite);
});
