import { matchIssn } from '../issnMatcher.mjs';
import { waitForCloudflare } from '../cloudflare.mjs';

// Le hub authorservices.taylorandfrancis.com interroge cette API REST
// WordPress (think.taylorandfrancis.com, meme site que les pages de detail)
// directement depuis le navigateur pour peupler ses resultats. Confirme via
// l'onglet Network : le hub ne sert donc que de catalogue de categories, la
// vraie donnee vient d'ici.
const LISTING_URL = 'https://authorservices.taylorandfrancis.com/call-for-papers/';
const API_BASE = 'https://think.taylorandfrancis.com/wp-json/wp/v2/special_issues';
const API_FIELDS = [
    'link',
    'special_issues_tax_subject_areas',
    'special_issues._special_issues_journal_title',
    'special_issues._special_issues_title',
    'special_issues._special_issues_copy',
    'special_issues._special_issues_deadline',
    'special_issues._special_issues_journal_cover_image',
].join(',');
const API_PAGE_SIZE = 100;

// Categories de sujet du hub (cases a cocher), lues dynamiquement depuis la
// page plutot que codees en dur : on interroge l'API une fois par categorie
// (le format multi-valeurs du parametre special_issues_tax_subject_areas
// n'est pas confirme) et on deduplique par URL ensuite.
const CHECKBOX_SELECTOR = '.jtf__cfptool_filters--checkbox input[type="checkbox"]';

// Confirme via le HTML reel d'une page de detail (site think.taylorandfrancis.com,
// WordPress, custom post type "special_issues").
const DETAIL_CONTENT_SELECTOR = 'article';

let loggedUnexpectedShape = false;

export const scraperObject = {
    url: LISTING_URL,
    abbreviation: 'tandf',
    async scraper(browser) {
        const abbreviation = this.abbreviation;

        const subjectAreaIds = await get_subject_area_ids(browser, this.url);
        console.log(`[tandf] ${subjectAreaIds.length} categorie(s) de sujet a interroger`);

        const entriesByUrl = new Map();
        for (const subjectAreaId of subjectAreaIds) {
            const entries = await get_entries_for_subject_area(browser, subjectAreaId);
            for (const entry of entries) {
                if (entry.url) entriesByUrl.set(entry.url, entry);
            }
        }
        console.log(`[tandf] ${entriesByUrl.size} appel(s) distinct(s) trouve(s)`);

        let skippedCount = 0;
        const calls = [];
        for (const entry of entriesByUrl.values()) {
            if (!entry.journal) {
                skippedCount++;
                continue;
            }
            const issn = await matchIssn(entry.journal);
            if (!issn) {
                skippedCount++;
                continue;
            }

            const rawContent = await get_raw_content(browser, entry.url);
            if (!rawContent) continue;

            calls.push({
                journal: entry.journal,
                abbreviation,
                issn,
                metaTitle: entry.metaTitle ?? entry.journal,
                url: entry.url,
                rawContent,
            });
        }
        console.log(`[tandf] ${skippedCount} appel(s) ignore(s), revue hors perimetre FNEGE`);

        return calls;
    }
}

async function get_subject_area_ids(browser, hubUrl) {
    const page = await browser.newPage();
    await page.goto(hubUrl, { waitUntil: 'domcontentloaded' });
    await waitForCloudflare(page, '[tandf]');
    await page.waitForSelector(CHECKBOX_SELECTOR, { timeout: 30000 });
    const ids = await page.$$eval(CHECKBOX_SELECTOR, els => els.map(el => el.value).filter(Boolean));
    await page.close();
    return [...new Set(ids)];
}

async function get_entries_for_subject_area(browser, subjectAreaId) {
    const entries = [];
    let pageNumber = 1;
    while (true) {
        const items = await fetch_api_page(browser, subjectAreaId, pageNumber);
        if (items.length === 0) break;
        entries.push(...items.map(parse_entry));
        pageNumber++;
    }
    return entries;
}

async function fetch_api_page(browser, subjectAreaId, pageNumber) {
    const url = new URL(API_BASE);
    url.searchParams.set('_fields', API_FIELDS);
    url.searchParams.set('per_page', String(API_PAGE_SIZE));
    url.searchParams.set('special_issues_tax_subject_areas', subjectAreaId);
    url.searchParams.set('page', String(pageNumber));

    const page = await browser.newPage();
    await page.goto(url.href, { waitUntil: 'domcontentloaded' });
    await waitForCloudflare(page, '[tandf]');

    const items = await page.evaluate(() => {
        try {
            const data = JSON.parse(document.body.innerText);
            return Array.isArray(data) ? data : [];
        } catch {
            return [];
        }
    });

    await page.close();
    return items;
}

function parse_entry(item) {
    const journal = item?.special_issues?._special_issues_journal_title
        ?? item?._special_issues_journal_title
        ?? null;
    const metaTitle = item?.special_issues?._special_issues_title
        ?? item?._special_issues_title
        ?? null;

    if (!journal && !loggedUnexpectedShape) {
        loggedUnexpectedShape = true;
        console.warn(`[tandf] Forme de reponse API inattendue, cles recues : ${Object.keys(item ?? {}).join(', ')}`);
    }

    return { url: item?.link ?? null, journal, metaTitle };
}

async function get_raw_content(browser, url) {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await waitForCloudflare(page, '[tandf]');
    const rawContent = await page.waitForSelector(DETAIL_CONTENT_SELECTOR, { timeout: 30000 })
        .then(() => page.$eval(DETAIL_CONTENT_SELECTOR, element => element.innerHTML))
        .catch(() => null);
    await page.close();
    if (!rawContent) {
        console.warn(`[tandf] Extraction du contenu brut echouee pour ${url}`);
    }
    return rawContent;
}
