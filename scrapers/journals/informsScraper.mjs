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
// Seuil pour ignorer les "faux" appels : certains h2 sont des sous-titres
// imbriques sans contenu propre (ex. "2025 PCAOB/Management Science
// Registered Reports Conference" suivi immediatement d'un <p></p> vide puis
// d'un autre h2 "Call for Registered Report Proposals" qui porte le vrai
// contenu). On ignore les tranches dont le texte ne depasse pas le titre.
const MIN_CONTENT_LENGTH_OVER_TITLE = 15;

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
        // chaque titre h2 (et le h2 suivant, ou la fin du conteneur).
        return await page.$eval(CONTENT_SELECTOR, (container, [titleSelector, minContentOverTitle]) => {
            const headings = Array.from(container.querySelectorAll(titleSelector));
            return headings.map((heading, i) => {
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
        }, [ENTRY_TITLE_SELECTOR, MIN_CONTENT_LENGTH_OVER_TITLE]);
    } catch (error) {
        console.warn(`[informs] Erreur (timeout ou navigation) sur ${pageUrl} : ${error.message}`);
        return [];
    } finally {
        await page.close();
    }
}
