import test from 'node:test';
import assert from 'node:assert/strict';

import { scraperObject, extraire_liens_appels, extraire_contenu_appel } from './misqScraper.mjs';

// Extrait fige de https://misq.umn.edu/pages/special_issues, releve le
// 2026-10-01 : les appels a venir sont des .forthcoming-item au titre en h2
// (l'ancien selecteur visait un h3 et ne trouvait plus rien), suivis des
// numeros deja publies.
const LISTING = `
<section class="section">
<h1>Forthcoming Special Issues</h1>
<div class="forthcoming-item">
<h2>Registered Reports</h2>
<p><a href="/DocumentLibrary/InfoDocs/CFP_SI_RegisteredReports.pdf">Call for Papers</a></p>
<p>Submission Deadline: September 1, 2023</p>
</div>
<div class="forthcoming-item">
<h2><a href="https://misq.umn.edu/pages/call_for_papers_institutional_press_">The Institutional Press in the Digital Age</a></h2>
<p><a href="/DocumentLibrary/InfoDocs/CFP_SI_FourthEstate.pdf">Call for Papers</a></p>
<p>Submission Deadline: December 1, 2024</p>
</div>
<div class="forthcoming-item">
<h2><a href="https://misq.umn.edu/pages/call_for_papers_ai_ia">AI-IA Nexus</a></h2>
<p>Submission Deadline: October 31, 2025</p>
</div>
<div class="forthcoming-item">
<h2><a href="https://misq.umn.edu/pages/call_for_papers_ethics_and_regulations">Ethics, Regulation, and Policy</a></h2>
<p>Submission Deadline: November 13, 2026</p>
</div>
</section>
<section class="section">
<h1>Previous Special Issues</h1>
<div class="grid"><div class="item">
<div class="title"><a href="https://misq.umn.edu/misq/issue/48/4">Digital Technologies and Social Justice</a></div>
</div></div>
</section>`;

// Page de detail : le contenu de l'appel est dans div.container, entre un
// en-tete de site et un pied de page qui ne doivent pas atteindre le modele.
const DETAIL = `
<html><body>
<header><nav>Home About MISQ Issues Submit Subscribe</nav></header>
<div id="mainContent">
<div class="container">
<h1>Call for Papers: Special Issue on AI-IA Nexus</h1>
<p>Submission Deadline October 31, 2025</p>
<h3>Special Issue Editors</h3><p>Rui Chen, Iowa State University</p>
</div>
</div>
<footer><h3 class="footer-links-header">Policies</h3> Sharing Unavailable</footer>
</body></html>`;

test('le module expose le contrat attendu par pageController', () => {
    assert.equal(scraperObject.abbreviation, 'misq');
    assert.equal(typeof scraperObject.scraper, 'function');
});

test('les appels a venir lies par leur h2 sont retenus, dans l\'ordre de la page', () => {
    const liens = extraire_liens_appels(LISTING);

    assert.deepEqual(liens.map(l => l.titre), [
        'The Institutional Press in the Digital Age',
        'AI-IA Nexus',
        'Ethics, Regulation, and Policy',
    ]);
    assert.equal(liens[0].url, 'https://misq.umn.edu/pages/call_for_papers_institutional_press_');
});

test('une entree sans h2 a (Registered Reports) est ignoree, pas son PDF', () => {
    const liens = extraire_liens_appels(LISTING);

    assert.ok(!liens.some(l => /Registered/.test(l.titre)));
    assert.ok(!liens.some(l => l.url.endsWith('.pdf')));
});

test('les numeros deja publies ne sont pas des appels', () => {
    const liens = extraire_liens_appels(LISTING);

    assert.ok(!liens.some(l => l.url.includes('/misq/issue/')));
});

test('une page liste sans .forthcoming-item ne rend rien', () => {
    assert.deepEqual(extraire_liens_appels('<html><body><h1>Just a moment...</h1></body></html>'), []);
});

test('le contenu de l\'appel est div.container, sans en-tete ni pied de page', () => {
    const contenu = extraire_contenu_appel(DETAIL);

    assert.match(contenu, /Call for Papers: Special Issue on AI-IA Nexus/);
    assert.match(contenu, /Special Issue Editors/);
    assert.doesNotMatch(contenu, /Subscribe|Sharing Unavailable/);
});

test('une page sans div.container rend null, jamais une page entiere', () => {
    assert.equal(extraire_contenu_appel('<html><body><h1>Not Found</h1></body></html>'), null);
});
