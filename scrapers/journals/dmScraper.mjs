import * as cheerio from 'cheerio';
import { matchIssn } from '../issnMatcher.mjs';

// Decisions Marketing est diffusee sur Cairn et chez EMS Editions, mais ses
// appels sont publies par l'AFM (Association Française du Marketing), qui
// edite la revue. La page decisions-marketing-dm.html est la presentation
// generale de la revue et ne contient aucun appel : les appels vivent sur la
// sous-page "Numeros Speciaux DM", d'ou cette URL.
//
// Le nom doit garder ses accents : issnMatcher retire les caracteres hors
// [a-z0-9], donc "Décisions Marketing" se normalise en "d cisions marketing"
// et "Decisions Marketing" (sans accent) ne matche PAS.
const PAGE_URL = 'https://www.afm-marketing.org/num%C3%A9ros-sp%C3%A9ciaux-dm.html';
const JOURNAL_NAME = 'Décisions Marketing';
const REQUEST_DELAY_MS = 1000;

// Confirme via le HTML reel de la page : chaque appel est une
// <section class="flex_12"> du conteneur principal, contenant exactement un
// <h2> ("Numero special DM 2027"), le theme et la date limite en gras, la
// liste des redacteurs invites, puis un ou deux liens PDF (version francaise
// et parfois anglaise). Decoupage par section plutot que par position des
// <h2> (technique du scraper SAGE) : ici le DOM fait deja le travail.
const CONTAINER_SELECTOR = 'main#page div.container.content';
const BLOCK_SELECTOR = 'section.flex_12';
const BLOCK_TITLE_SELECTOR = 'h2';
const PDF_LINK_SELECTOR = 'a[href$=".pdf"], a[href*=".pdf?"]';

// Deux blocs portent le meme <h2> "Numero special DM 2025" (millesime de
// parution, pas identifiant d'appel) : seul le theme les distingue. Sans lui
// le libelle transmis au LLM serait ambigu d'un appel a l'autre.
const THEME_PATTERN = /Th[èe]me\s*:\s*[«"“”]?\s*([^«»"“”\n]+?)\s*[«»"“”]?\s*(?=Date limite|R[ée]dacteur|$)/i;

export const scraperObject = {
    url: PAGE_URL,
    abbreviation: 'dm',
    async scraper(browser) {
        const abbreviation = this.abbreviation;

        const issn = await matchIssn(JOURNAL_NAME);
        if (!issn) {
            console.warn(`[dm] "${JOURNAL_NAME}" introuvable dans le CSV ISSN, abandon`);
            return [];
        }

        const html = await get_page_html(browser, PAGE_URL);
        if (!html) return [];

        const entries = extract_entries(html);
        console.log(`[dm] ${entries.length} appel(s) trouve(s)`);
        if (entries.length === 0) {
            console.warn(`[dm] Aucun bloc ${BLOCK_SELECTOR} avec un ${BLOCK_TITLE_SELECTOR} sur ${PAGE_URL} (structure modifiee ?)`);
        }

        // Les appels dont l'echeance est passee sont renvoyes comme les
        // autres : c'est le pipeline (llmParser + diffChecker) qui gere les
        // dates, et la page AFM garde les appels clos en ligne.
        return entries.map(entry => ({
            journal: JOURNAL_NAME,
            abbreviation,
            issn,
            metaTitle: entry.metaTitle,
            url: entry.url,
            rawContent: entry.rawContent,
        }));
    }
}

function extract_entries(html) {
    const $ = cheerio.load(html);
    const container = $(CONTAINER_SELECTOR).first();
    if (container.length === 0) {
        console.warn(`[dm] Conteneur ${CONTAINER_SELECTOR} introuvable (structure modifiee ?)`);
        return [];
    }

    const entries = [];
    container.find(BLOCK_SELECTOR).each((index, el) => {
        const block = $(el);
        const heading = block.find(BLOCK_TITLE_SELECTOR).first().text().replace(/\s+/g, ' ').trim();
        if (!heading) return;

        const text = block.text().replace(/\s+/g, ' ').trim();
        const theme = text.match(THEME_PATTERN)?.[1]?.trim();

        // Le PDF de l'appel est le seul identifiant stable par appel : les
        // titres se repetent d'un millesime a l'autre et la page n'a pas
        // d'ancre par bloc. Repli sur une ancre construite si le lien manque.
        const pdfHref = block.find(PDF_LINK_SELECTOR).first().attr('href');

        entries.push({
            metaTitle: theme ? `${heading} — ${theme}` : heading,
            url: pdfHref
                ? new URL(pdfHref, PAGE_URL).href
                : `${PAGE_URL}#${encodeURIComponent(theme || heading || String(index))}`,
            // Contenu HTML du bloc : il porte deja le theme, l'echeance, les
            // redacteurs invites et leurs affiliations, ainsi que le lien vers
            // le PDF original. Pas besoin de telecharger le PDF (contrairement
            // a la RIPME, dont les annonces ne contiennent aucune date).
            rawContent: block.html() ?? '',
        });
    });
    return entries;
}

async function get_page_html(browser, url) {
    const page = await browser.newPage();
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(REQUEST_DELAY_MS);
        return await page.content();
    } catch (error) {
        console.warn(`[dm] Erreur (timeout ou navigation) sur ${url} : ${error.message}`);
        return null;
    } finally {
        await page.close();
    }
}
