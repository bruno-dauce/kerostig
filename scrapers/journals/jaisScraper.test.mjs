import test from 'node:test';
import assert from 'node:assert/strict';

import { scraperObject, extraire_liens_appels, url_de_telechargement, detecter_type } from './jaisScraper.mjs';
import { clean } from '../dataPreparation.mjs';

// Extrait fige de https://aisel.aisnet.org/jais/specialissues.html, releve le
// 2026-10-01 : le fil d'Ariane (div.crumbs), un h2 puis un h3 (la structure qui
// a fait mourir l'ancien selecteur), les quatre appels ouverts, puis des
// numeros deja publies, qui n'ont pas le prefixe « Call for Papers: ».
const LISTING = `
<div class="crumbs" role="navigation" aria-label="Breadcrumb"><p>
  <a href="https://aisel.aisnet.org" class="ignore" >Home</a> <span aria-hidden="true">&gt;</span>
  <a href="https://aisel.aisnet.org/jais" class="ignore" >JAIS</a></p></div>
<h2>Special Issues and Editorial Curations</h2>

<h3>Special Issues</h3>
<br>
<ul>
<li><a href="https://aisel.aisnet.org/jais/JAIS-SI-proposal_DP_and_Adolesecents.docx" > Call for Papers: Growing up Online: How Digital Platforms Shape Adolescent Development</a> Submission Deadline November 01, 2027</li>
<li><a href="https://aismsc-my.sharepoint.com/:w:/g/personal/jais_eic_aisnet_org/EQWiiWyjGYxGjBHZhGySorQB0xKVkiFiu7J1BCjvE-E25w?e=Th4dEj" > Call for Papers: Contemporary Innovation in Information Infrastructures</a> Submission Deadline July 31, 2025</li>
<li><a href="https://aisel.aisnet.org/jais/SI-DigitalSustainabilityFINAL.pdf" > Call for Papers:  Digital Sustainability and Information Systems Research</a> Submission Deadline October 2, 2024</li>
<li><a href="https://www.dropbox.com/s/r0o32ru3u4i5yy5/JAISGenAISICALLFinal.pdf?dl=0" > Call for Papers:  Managing the Individual, Organizational, and Societal Challenges of Generative AI: Utopian, Dystopian, Neutropian Perspectives</a> Submission Deadline August 31, 2024</li>
<br>
<li><a href="https://aisel.aisnet.org/jais/vol26/iss3/" > Special Issue on Health Analytics and Theorizing</a> Published May 1, 2025</li>
<li><a href="https://aisel.aisnet.org/jais/SI_GenerativeAIKnowlegeWork.pdf" > Special Issue on Generative AI and Knowledge Work</a> - Published January 2024</li>
<li>
<a href="http://aisel.aisnet.org/jais/SpecialIssueBlockchain.docx" >Opportunities and Challenges of Blockchain Technology</a> - Published September 2019</li>
</ul>`;

const URL_DROPBOX = 'https://www.dropbox.com/s/r0o32ru3u4i5yy5/JAISGenAISICALLFinal.pdf?dl=0';

test('le module expose le contrat attendu par pageController', () => {
    assert.equal(scraperObject.abbreviation, 'jais');
    assert.equal(typeof scraperObject.scraper, 'function');
});

test('seuls les liens « Call for Papers: » sont retenus, pas les numeros publies', () => {
    const liens = extraire_liens_appels(LISTING);

    assert.equal(liens.length, 4);
    assert.ok(liens.every(l => l.titre.startsWith('Call for Papers:')));
    assert.ok(!liens.some(l => /Published|Health Analytics|Blockchain/.test(l.titre)));
});

test('les espaces du titre sont normalises et l\'URL est celle du site', () => {
    const liens = extraire_liens_appels(LISTING);

    assert.equal(liens[2].titre, 'Call for Papers: Digital Sustainability and Information Systems Research');
    assert.equal(liens[2].url, 'https://aisel.aisnet.org/jais/SI-DigitalSustainabilityFINAL.pdf');
});

test('l\'URL Dropbox enregistree reste celle de la fiche (dl=0)', () => {
    const dropbox = extraire_liens_appels(LISTING).find(l => l.url.includes('dropbox.com'));

    assert.equal(dropbox.url, URL_DROPBOX);
});

test('dl=1 ne sert qu\'au telechargement, sans toucher aux autres URL', () => {
    assert.equal(url_de_telechargement(URL_DROPBOX), 'https://www.dropbox.com/s/r0o32ru3u4i5yy5/JAISGenAISICALLFinal.pdf?dl=1');
    assert.equal(url_de_telechargement('https://aisel.aisnet.org/jais/SI-DigitalSustainabilityFINAL.pdf'), 'https://aisel.aisnet.org/jais/SI-DigitalSustainabilityFINAL.pdf');
    // La fonction ne doit pas muter son entree : c'est l'URL de la fiche.
    assert.equal(URL_DROPBOX.endsWith('dl=0'), true);
});

test('la fiche Dropbox heritee est reconnue : meme slug repris, pas de nouvelle fiche', async () => {
    const slugHerite = 'jais-managing-the-individual-organizational-and-societal-challenges-of-generative-ai-utopian-dystopian-neutropian-perspectives';
    const ancien = [{ slug: slugHerite, abbreviation: 'jais', issn: '1558-3457', url: URL_DROPBOX, pubDate: '2023-06-13T12:46:46.000Z' }];
    const dropbox = extraire_liens_appels(LISTING).find(l => l.url.includes('dropbox.com'));

    const [appel] = await clean([{
        journal: 'Journal of the Association for Information Systems',
        abbreviation: 'jais',
        issn: '1558-3457',
        metaTitle: dropbox.titre,
        url: dropbox.url,
        rawContent: '<p>Texte de l\'appel</p>',
    }], ancien);

    assert.equal(appel.slug, slugHerite);
});

test('detecter_type : PDF, docx, et rien pour une page HTML', () => {
    assert.equal(detecter_type(Buffer.from('%PDF-1.7 ...')), 'pdf');
    assert.equal(detecter_type(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14])), 'docx');
    // Lien SharePoint expire : un 200 en HTML, jamais le texte d'un appel.
    assert.equal(detecter_type(Buffer.from('\r\n<!DOCTYPE html><html><title>Erreur</title>')), null);
});
