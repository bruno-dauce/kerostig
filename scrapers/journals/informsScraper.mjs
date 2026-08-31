import { matchIssn } from '../issnMatcher.mjs';
import { waitForCloudflare } from '../cloudflare.mjs';

// Pas de hub centralise chez INFORMS : chaque revue a sa propre page statique
// d'appels a l'URL pubsonline.informs.org/page/{code}/calls-for-papers.
// Codes confirmes par recherche (inte = code herite de l'ancien nom
// "Interfaces" pour INFORMS Journal on Applied Analytics -- pas "ijaa").
const JOURNALS = [
    { code: 'mnsc', name: 'Management Science' },
    { code: 'orsc', name: 'Organization Science' },
    { code: 'isre', name: 'Information Systems Research' },
    { code: 'mksc', name: 'Marketing Science' },
    { code: 'opre', name: 'Operations Research' },
    { code: 'msom', name: 'Manufacturing & Service Operations Management' },
    { code: 'inte', name: 'INFORMS Journal on Applied Analytics' },
];

// Confirme via le HTML reel de la page mnsc : conteneur unique sur toute la
// page (aucune autre occurrence de .col-sm-9). Contenu editorial libre : h2
// titre, h4 echeance, p description, plusieurs appels separes par des <hr>,
// sans wrapper dedie par appel.
const CONTENT_SELECTOR = 'div.col-sm-9';
const ENTRY_TITLE_SELECTOR = 'h2';
// Habillage present sur les sept pages et etranger a l'appel : menu lateral
// « Quicklinks & Resources » (.hidden-lg), feuille de style inline, titre de
// page. A retirer avant de mesurer la longueur du contenu comme avant de
// livrer le HTML au modele.
const NAV_SELECTOR = '.hidden-lg, style, script, h1';
// Seuil pour ignorer les "faux" appels : certains h2 sont des sous-titres
// imbriques sans contenu propre (ex. "2025 PCAOB/Management Science
// Registered Reports Conference" suivi immediatement d'un <p></p> vide puis
// d'un autre h2 "Call for Registered Report Proposals" qui porte le vrai
// contenu). On ignore les tranches dont le texte ne depasse pas le titre.
const MIN_CONTENT_LENGTH_OVER_TITLE = 15;

// Les sept pages INFORMS n'ont pas toutes le meme gabarit (releve du
// 2026-08-31, longueurs mesurees hors navigation laterale) :
//
//   mnsc 6 h2 | orsc 2 h2 | msom 2 h2   -> decoupage par titres
//   isre 0 titre, 7112 car.             -> un seul appel, colle depuis Word
//   opre 0 titre, 43 car.               -> reellement vide
//   mksc 1 h3, 22 car.                  -> reellement vide
//   inte 3 h3, 4320 car.                -> sollicitations permanentes sans date
//
// Seuil place entre 43 et 7112 : la marge est large des deux cotes, il ne
// cherche pas a etre fin, seulement a distinguer une page qui dit « aucun
// appel » d'une page qui en porte un vrai.
const MIN_CONTENU_CONTENEUR = 200;

// Un h3 vaut refus explicite, pas repli : les pages qui titrent en h3 (inte)
// portent des sollicitations editoriales permanentes, sans echeance. Les
// agglomerer en un appel unique ferait inventer une date par le modele, et
// l'appel serait archive dans la foulee. Fonction pure, exportee pour test.
export function choisirModeDecoupage({ nbH2, nbH3, longueurContenu }) {
    if (nbH2 > 0) return 'titres';
    if (nbH3 > 0) return 'vide';
    return longueurContenu >= MIN_CONTENU_CONTENEUR ? 'conteneur' : 'vide';
}

export const scraperObject = {
    url: 'https://pubsonline.informs.org/page/mnsc/calls-for-papers',
    abbreviation: 'informs',
    async scraper(browser) {
        const abbreviation = this.abbreviation;

        const calls = [];
        for (const journal of JOURNALS) {
            const issn = await matchIssn(journal.name);
            if (!issn) {
                console.warn(`[informs] "${journal.name}" non trouve dans le CSV ISSN, verifier l'orthographe`);
                continue;
            }

            const pageUrl = `https://pubsonline.informs.org/page/${journal.code}/calls-for-papers`;
            const entries = await get_entries(browser, pageUrl);
            for (const entry of entries) {
                calls.push({
                    journal: journal.name,
                    abbreviation,
                    issn,
                    metaTitle: entry.title,
                    url: entry.url ?? pageUrl,
                    rawContent: entry.rawContent,
                });
            }
        }
        console.log(`[informs] ${calls.length} appel(s) trouve(s) sur ${JOURNALS.length} revue(s)`);

        return calls;
    }
}

async function get_entries(browser, pageUrl) {
    const page = await browser.newPage();
    try {
        await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await waitForCloudflare(page, '[informs]');

        const found = await page.waitForSelector(CONTENT_SELECTOR, { timeout: 30000 })
            .then(() => true)
            .catch(() => false);
        if (!found) {
            console.warn(`[informs] Conteneur de contenu introuvable sur ${pageUrl}`);
            return [];
        }

        // Pas de wrapper par appel : on decoupe le contenu en tranches entre
        // chaque titre h2 (et le h2 suivant, ou la fin du conteneur). Le
        // $eval se contente de mesurer et de preparer les deux formes
        // possibles ; le choix entre elles se fait dans node, ou il est
        // testable (choisirModeDecoupage).
        const mesure = await page.$eval(CONTENT_SELECTOR, (container, [titleSelector, minContentOverTitle, navSelector]) => {
            const headings = Array.from(container.querySelectorAll(titleSelector));
            const tranches = headings.map((heading, i) => {
                const stopAt = headings[i + 1] ?? null;
                const title = heading.textContent.trim();
                let html = '';
                let text = '';
                let url = null;
                let node = heading;
                while (node && node !== stopAt) {
                    html += node.outerHTML;
                    text += node.textContent;
                    if (!url) {
                        const link = node.querySelector?.('a[href]');
                        if (link) url = link.href;
                    }
                    node = node.nextElementSibling;
                }
                return { title, rawContent: html, url, hasContent: text.trim().length > title.length + minContentOverTitle };
            }).filter(entry => entry.hasContent);

            const propre = container.cloneNode(true);
            propre.querySelectorAll(navSelector).forEach(element => element.remove());

            return {
                nbH2: container.querySelectorAll('h2').length,
                nbH3: container.querySelectorAll('h3').length,
                tranches,
                conteneur: {
                    // Sur une page collee depuis Word, les intertitres sont
                    // des <strong> et le premier porte le titre de l'appel.
                    title: propre.querySelector('strong, b')?.textContent.trim() || document.title.trim(),
                    rawContent: propre.innerHTML,
                    url: null,
                },
                longueurContenu: propre.textContent.replace(/\s+/g, ' ').trim().length,
            };
        }, [ENTRY_TITLE_SELECTOR, MIN_CONTENT_LENGTH_OVER_TITLE, NAV_SELECTOR]);

        const mode = choisirModeDecoupage(mesure);
        if (mode === 'titres') return mesure.tranches;
        if (mode === 'conteneur') {
            console.log(`[informs] ${pageUrl} : aucun titre, page traitee comme un appel unique`);
            return [mesure.conteneur];
        }
        // Dit explicitement, sinon une page vide et une page bloquee laissent
        // la meme trace dans le log -- exactement ce qui a rendu le blocage
        // Cloudflare du 31 aout indiscernable d'un retrait cote editeur.
        console.log(`[informs] Aucun appel sur ${pageUrl} (page vide ou titres non reconnus)`);
        return [];
    } catch (error) {
        console.warn(`[informs] Erreur (timeout ou navigation) sur ${pageUrl} : ${error.message}`);
        return [];
    } finally {
        await page.close();
    }
}
