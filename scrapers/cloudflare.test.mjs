import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';
import { estHorsInterstitiel, waitForCloudflare } from './cloudflare.mjs';

// estHorsInterstitiel s'execute normalement DANS la page et lit le vrai
// document. Ici on lui passe un document de substitution reduit aux deux
// methodes qu'il utilise, alimente par du HTML reel (releve sur
// journals.sagepub.com le 2026-08-31).
function docDeHtml(html) {
    const $ = cheerio.load(html);
    return {
        querySelector: (selecteur) => ($(selecteur).first().length > 0 ? {} : null),
        querySelectorAll: (selecteur) => $(selecteur).toArray()
            .map(el => ({ textContent: $(el).text() })),
    };
}

// Extrait reel de l'interstitiel tel qu'il est SERVI (avant execution du
// script) : le marqueur est la declaration inline de _cf_chl_opt, le tag
// <script src> n'existe pas encore.
const INTERSTITIEL_SERVI = `<!DOCTYPE html><html lang="en-US"><head>
<title>Just a moment...</title>
<meta name="robots" content="noindex,nofollow"><meta http-equiv="refresh" content="360"></head>
<body><div class="main-wrapper" role="main"><div class="main-content"></div></div>
<script nonce="FkKNjj5d8Vh9sq7zrZVpLY">(function(){window._cf_chl_opt = {cFPWv: 'b', cRay: 'a33c4c65c9f6d140'};
var a = document.createElement('script');a.nonce = 'FkKNjj5d8Vh9sq7zrZVpLY';
a.src = '/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1?ray=a33c4c65c9f6d140';
document.getElementsByTagName('head')[0].appendChild(a);}());</script></body></html>`;

// Le meme interstitiel une fois le script execute : le tag est dans le DOM.
const INTERSTITIEL_APRES_SCRIPT = `<!DOCTYPE html><html lang="en-US"><head>
<title>Just a moment...</title>
<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1?ray=a33c4c65c9f6d140"></script>
</head><body><div class="main-wrapper" role="main"></div></body></html>`;

// Extrait reel d'une page SAGE une fois le challenge franchi : Cloudflare y
// laisse un script de bot-management, dont le chemin ne contient PAS
// chl_page, et aucune trace de _cf_chl_opt dans le HTML.
const PAGE_REELLE = `<!DOCTYPE html><html lang="en"><head>
<title>Business &amp; Society: Sage Journals</title>
<script src="/cdn-cgi/challenge-platform/scripts/precursor/main.js"></script>
<script>window.dataLayer = window.dataLayer || [];</script></head>
<body><div class="marketing-spot"><div class="marketing-spot__title">Call for papers</div></div></body></html>`;

test('estHorsInterstitiel reconnait l\'interstitiel tel qu\'il est servi', () => {
    assert.equal(estHorsInterstitiel(docDeHtml(INTERSTITIEL_SERVI)), false);
});

test('estHorsInterstitiel reconnait l\'interstitiel apres injection du script', () => {
    assert.equal(estHorsInterstitiel(docDeHtml(INTERSTITIEL_APRES_SCRIPT)), false);
});

// Le piege qui a fait passer le challenge pour resolu le 2026-08-31 : Chrome
// en locale fr-FR recoit l'interstitiel traduit. Aucun test sur le titre, donc
// aucune langue a maintenir.
test('estHorsInterstitiel ne depend pas de la langue de l\'interstitiel', () => {
    const enFrancais = INTERSTITIEL_SERVI.replace('Just a moment...', 'Un instant…');
    const enAllemand = INTERSTITIEL_SERVI.replace('Just a moment...', 'Einen Moment…');
    assert.equal(estHorsInterstitiel(docDeHtml(enFrancais)), false);
    assert.equal(estHorsInterstitiel(docDeHtml(enAllemand)), false);
});

// L'autre faux critere teste le 2026-08-31 : window._cf_chl_opt reste defini
// sur la vraie page. Le script de bot-management qui le pose ne doit donc pas
// etre confondu avec celui de l'interstitiel.
test('estHorsInterstitiel accepte une page reelle malgre son script Cloudflare', () => {
    assert.equal(estHorsInterstitiel(docDeHtml(PAGE_REELLE)), true);
});

test('estHorsInterstitiel accepte une page sans Cloudflare', () => {
    assert.equal(estHorsInterstitiel(docDeHtml('<html><body><h1>Appels</h1></body></html>')), true);
});

// Variante historique du challenge (page "Checking your browser"), conservee
// par prudence : elle n'a pas de _cf_chl_opt mais un formulaire identifiable.
test('estHorsInterstitiel reconnait la variante a formulaire', () => {
    const html = '<html><body><form id="challenge-form" action="/cdn-cgi/l/chk_jschl"></form></body></html>';
    assert.equal(estHorsInterstitiel(docDeHtml(html)), false);
});

function pageFactice({ selecteurTrouve = true, fonctionResolue = true } = {}) {
    const appels = { waitForSelector: [], waitForFunction: [] };
    return {
        appels,
        async waitForSelector(selecteur, options) {
            appels.waitForSelector.push({ selecteur, options });
            if (!selecteurTrouve) throw new Error('Timeout 30000ms exceeded.');
            return {};
        },
        async waitForFunction(fn, arg, options) {
            appels.waitForFunction.push({ fn, arg, options });
            if (!fonctionResolue) throw new Error('Timeout 30000ms exceeded.');
            return {};
        },
    };
}

test('waitForCloudflare attend le selecteur de contenu quand il est fourni', async () => {
    const page = pageFactice();
    const pret = await waitForCloudflare(page, '[test]', 'div.marketing-spot');

    assert.equal(pret, true);
    assert.equal(page.appels.waitForSelector.length, 1);
    assert.equal(page.appels.waitForSelector[0].selecteur, 'div.marketing-spot');
    assert.equal(page.appels.waitForFunction.length, 0);
});

// Un element present mais masque est lisible : c'est le cas des encarts
// d'appels SAGE, dont le premier est cache par la variante responsive. Avec
// l'etat 'visible' par defaut, l'attente expire sur une page complete.
test('waitForCloudflare attend la presence dans le DOM, pas la visibilite', async () => {
    const page = pageFactice();
    await waitForCloudflare(page, '[test]', 'div.marketing-spot');

    assert.equal(page.appels.waitForSelector[0].options.state, 'attached');
});

test('waitForCloudflare rend false quand le contenu n\'apparait pas', async () => {
    const page = pageFactice({ selecteurTrouve: false });
    assert.equal(await waitForCloudflare(page, '[test]', 'div.marketing-spot'), false);
});

test('waitForCloudflare retombe sur la detection d\'interstitiel sans selecteur', async () => {
    const page = pageFactice();
    const pret = await waitForCloudflare(page, '[test]');

    assert.equal(pret, true);
    assert.equal(page.appels.waitForSelector.length, 0);
    assert.equal(page.appels.waitForFunction.length, 1);
    // Le timeout doit arriver en TROISIEME argument : passe en deuxieme,
    // Playwright le prend pour l'argument de la fonction evaluee et applique
    // son propre delai par defaut.
    assert.equal(page.appels.waitForFunction[0].options.timeout, 30000);
});

test('waitForCloudflare rend false quand le challenge ne se resout pas', async () => {
    const page = pageFactice({ fonctionResolue: false });
    assert.equal(await waitForCloudflare(page, '[test]'), false);
});
