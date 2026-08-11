import slugify from 'slugify';
import { createHash } from 'crypto';
import TurndownService from 'turndown';
import { toText } from './issnMatcher.mjs';

export async function clean(issues) {
    // Traitement sequentiel (pas Promise.all) : generateSlug a besoin de
    // connaitre les slugs deja attribues dans ce lot pour garantir leur
    // unicite (ex. deux revues avec le meme titre d'appel -- special issue
    // conjointe entre plusieurs revues Elsevier).
    const usedSlugs = new Set();
    const results = [];
    for (let issue of issues) {
        issue = await normalizeTextFields(issue);
        issue = await cleanTitles(issue);
        issue = await generateSlug(issue, usedSlugs);
        issue = await parseHTML(issue);
        issue = await hash(issue);
        results.push(issue);
    }
    return results;
}

// Certains scrapers (API JSON, ex. Taylor & Francis) peuvent fournir ces
// champs sous forme d'objet ({ rendered: "..." }) ou null au lieu d'une
// chaine ; on les normalise ici avant tout traitement texte en aval.
async function normalizeTextFields(issue) {
    issue.metaTitle = toText(issue.metaTitle);
    issue.title = toText(issue.title);
    issue.journal = toText(issue.journal);
    return issue;
}

async function generateSlug(issue, usedSlugs) {
    const baseSlug = await slugify(issue.abbreviation + " " + issue.metaTitle, { lower: true, strict: true });
    let slug = baseSlug;
    for (let suffix = 2; usedSlugs.has(slug); suffix++) {
        slug = `${baseSlug}-${suffix}`;
    }
    usedSlugs.add(slug);
    issue.slug = slug;
    return issue;
}

async function parseHTML(issue) {
    if (!issue.rawContent || typeof issue.rawContent !== 'string') {
        return issue;
    }
    var turndownService = new TurndownService();
    issue.rawContent = turndownService.turndown(issue.rawContent);
    return issue;
}

async function hash(issue) {
    if (!issue.rawContent || issue.rawContent.trim() === '') {
        issue.contentHash = await createHash('sha256').update(issue.slug).digest('hex');
    } else {
        issue.contentHash = await createHash('sha256').update(issue.rawContent).digest('hex');
    }
    return issue;
}

async function cleanTitles(issue) {
    const patterns = [
        /DSS Special Issue on /g,
        /Call for Papers on Special Issue: /g,
        /Call for Papers \(Special Section @ ?IJIM\) Theme: /g,
        /Call for Papers:  ?Special [I|i]ssue on /g,
        /Call for Papers: /g,
        /Special Issue: /g,
        /Special Issue on /g,
        /(\- )?Short Title SI: .+/g,
        /Special Section:? /g,
        /\(PDF\)/g,
        /'/g,
        /"/g,
        /”/g,
        /“/g
    ];
    for (let pattern of patterns) {
        issue.metaTitle = issue.metaTitle.replace(pattern, '').trim();
    }
    issue.metaTitle = issue.metaTitle.replace('–', '-').trim();
    return issue;
}
