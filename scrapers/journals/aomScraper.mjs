import { matchIssn } from '../issnMatcher.mjs';
import { waitForCloudflare } from '../cloudflare.mjs';

// journals.aom.org/callforsubmissions (essaye en premier) s'est avere etre
// une page morte, maintenue a la main, dont le contenu le plus recent date
// de ~2017-2021 (AMJ y affiche litteralement "More to come..."). Les appels
// actuels vivent en fait sur aom.org (site principal, differente plateforme,
// pas de mur Cloudflare) sous forme d'evenements categorises.
const API_BASE = 'https://aom.org/wp-json/wp/v2/tribe_events';
const API_PAGE_SIZE = 100;

// Categories confirmees via /wp-json/wp/v2/tribe_events_cat. Le parametre
// accepte une liste separee par des virgules (confirme empiriquement).
const CATEGORY_IDS = '172,174,175'; // Call for Submissions, Call for Papers, Call for Special Issue Papers

// Pas de champ dedie "revue" dans l'API : le titre commence par l'abreviation
// de la revue (ex. "AMP Call for Special Issue Papers: ..."). On detecte
// l'abreviation puis on resout le nom complet avant de passer par
// issnMatcher, comme pour les autres scrapers.
const JOURNAL_ABBREVIATIONS = {
    AMJ: 'Academy of Management Journal',
    AMR: 'Academy of Management Review',
    AMLE: 'Academy of Management Learning and Education',
    AMP: 'Academy of Management Perspectives',
    AMD: 'Academy of Management Discoveries',
};

export const scraperObject = {
    url: 'https://aom.org/event-calendar/',
    abbreviation: 'aom',
    async scraper(browser) {
        const abbreviation = this.abbreviation;

        const entries = await get_entries(browser);
        const entriesByLink = new Map(entries.filter(e => e.link).map(e => [e.link, e]));
        console.log(`[aom] ${entriesByLink.size} appel(s) distinct(s) trouve(s)`);

        let skippedCount = 0;
        const calls = [];
        for (const entry of entriesByLink.values()) {
            const journalName = detect_journal(entry.title);
            if (!journalName || !entry.rawContent) {
                skippedCount++;
                continue;
            }
            const issn = await matchIssn(journalName);
            if (!issn) {
                skippedCount++;
                continue;
            }
            calls.push({
                journal: journalName,
                abbreviation,
                issn,
                metaTitle: entry.title,
                url: entry.link,
                rawContent: entry.rawContent,
            });
        }
        console.log(`[aom] ${skippedCount} appel(s) ignore(s), revue hors perimetre FNEGE ou non identifiee dans le titre`);

        return calls;
    }
}

function detect_journal(title) {
    if (!title) return null;
    const abbreviation = Object.keys(JOURNAL_ABBREVIATIONS).find(abbr =>
        new RegExp(`\\b${abbr}\\b`, 'i').test(title)
    );
    return abbreviation ? JOURNAL_ABBREVIATIONS[abbreviation] : null;
}

async function get_entries(browser) {
    const entries = [];
    let pageNumber = 1;
    while (true) {
        const items = await fetch_api_page(browser, pageNumber);
        if (items.length === 0) break;
        entries.push(...items.map(parse_entry));
        pageNumber++;
    }
    return entries;
}

async function fetch_api_page(browser, pageNumber) {
    const url = new URL(API_BASE);
    url.searchParams.set('tribe_events_cat', CATEGORY_IDS);
    url.searchParams.set('per_page', String(API_PAGE_SIZE));
    url.searchParams.set('page', String(pageNumber));

    const page = await browser.newPage();
    try {
        await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await waitForCloudflare(page, '[aom]');

        return await page.evaluate(() => {
            try {
                const data = JSON.parse(document.body.innerText);
                return Array.isArray(data) ? data : [];
            } catch {
                return [];
            }
        });
    } catch (error) {
        console.warn(`[aom] Echec de l'appel API ${url.href} : ${error.message}`);
        return [];
    } finally {
        await page.close();
    }
}

function parse_entry(item) {
    return {
        link: item?.link ?? null,
        title: item?.title?.rendered ?? null,
        rawContent: item?.content?.rendered ?? null,
    };
}
