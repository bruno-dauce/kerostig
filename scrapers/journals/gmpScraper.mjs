import * as cheerio from 'cheerio';
import { matchIssn } from '../issnMatcher.mjs';

// Site WordPress (theme Divi/AIRMAP). curl passe en local mais se fait
// bloquer sur le runner GitHub Actions (meme curl-impersonate) -- meme
// symptome que SAGE/Wiley (fingerprint reseau du runner CI, distinct d'un
// poste local). D'ou l'usage du navigateur (patchright).
const PAGE_URL = 'https://gmp-revue.org/numero-special';
const JOURNAL_NAME = 'Gestion et management public';

// Confirme via le HTML reel : le contenu vit dans .entry-content, avec un
// <h1>Numero special</h1> (titre de PAGE, pas d'appel) suivi de blocs
// .et_pb_text_inner. Au moment du check, la page annonce explicitement
// l'absence d'appel ("Il n'y a pas d'appel a contributions a un numero
// special pour le moment.") -- sentinelle utilisee pour renvoyer 0 appels
// proprement plutot que de mal interpreter ce texte comme un appel.
const CONTENT_SELECTOR = '.entry-content';
const NO_CALL_PATTERN = /pas\s+d.?appel\s*(à|a)\s*contributions?/i;
const HEADING_SELECTOR = 'h1, h2, h3, h4';

export const scraperObject = {
    url: PAGE_URL,
    abbreviation: 'gmp',
    async scraper(browser) {
        const abbreviation = this.abbreviation;

        const issn = await matchIssn(JOURNAL_NAME);
        if (!issn) {
            console.warn(`[gmp] "${JOURNAL_NAME}" introuvable dans le CSV ISSN, abandon`);
            return [];
        }

        const html = await get_page_html(browser);
        if (!html) return [];

        const entries = extract_entries(html);
        console.log(`[gmp] ${entries.length} appel(s) trouve(s) sur ${PAGE_URL}`);

        return entries.map((entry, index) => ({
            journal: JOURNAL_NAME,
            abbreviation,
            issn,
            metaTitle: entry.metaTitle,
            url: entries.length > 1 ? `${PAGE_URL}#${index + 1}` : PAGE_URL,
            rawContent: entry.rawContent,
        }));
    }
}

async function get_page_html(browser) {
    const page = await browser.newPage();
    try {
        await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
        return await page.content();
    } catch (error) {
        console.warn(`[gmp] Erreur (timeout ou navigation) sur ${PAGE_URL} : ${error.message}`);
        return null;
    } finally {
        await page.close();
    }
}

function extract_entries(html) {
    const $ = cheerio.load(html);
    const container = $(CONTENT_SELECTOR).first();
    if (container.length === 0) {
        console.warn(`[gmp] Conteneur ${CONTENT_SELECTOR} introuvable sur ${PAGE_URL} (structure modifiee ?)`);
        return [];
    }

    // Le <h1> est le titre de la page ("Numero special"), pas un titre
    // d'appel -- retire avant toute analyse du contenu.
    const clone = container.clone();
    clone.find('h1').first().remove();

    const text = clone.text().replace(/\s+/g, ' ').trim();
    if (text.length === 0 || NO_CALL_PATTERN.test(text)) {
        return [];
    }

    const containerHtml = clone.html() ?? '';
    const headings = clone.find(HEADING_SELECTOR).toArray();
    if (headings.length === 0) {
        // Pas de sous-titre distinct : tout le contenu restant forme un
        // seul appel (cas le plus probable pour une page a appel unique).
        return [{ metaTitle: `${JOURNAL_NAME} - numero special`, rawContent: containerHtml }];
    }

    // Meme technique de positionnement par curseur que ojsFrScraper
    // (M@n@gement) : pas d'offset natif en cheerio.
    let cursor = 0;
    const positioned = [];
    for (const h of headings) {
        const outer = $.html(h);
        const index = containerHtml.indexOf(outer, cursor);
        if (index === -1) continue;
        positioned.push({ text: $(h).text().replace(/\s+/g, ' ').trim(), index });
        cursor = index + outer.length;
    }

    const entries = [];
    for (let i = 0; i < positioned.length; i++) {
        const { text: headingText, index } = positioned[i];
        const nextIndex = positioned[i + 1]?.index ?? containerHtml.length;
        const block = containerHtml.slice(index, nextIndex);
        entries.push({ metaTitle: headingText, rawContent: block });
    }
    return entries;
}
