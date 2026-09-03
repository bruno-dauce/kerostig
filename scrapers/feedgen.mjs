import { Feed } from 'feed';
import fs from 'fs';
import nunjucks from 'nunjucks';
import { DateTime } from "luxon";
import slugify from 'slugify';

import { extraireDescription, lienSourceOriginale } from './extrait.mjs';

var env = nunjucks.configure('www/_includes', { autoescape: true });
env.addFilter('dateOnly', function (str) {
    const dateTime = DateTime.fromISO(str);
    return dateTime.setLocale('en-us').toLocaleString(DateTime.DATE_FULL);
});
// Meme filtre et meme borne que le site, cf scrapers/extrait.mjs : le flux
// est la surface la plus republiee du site, c'est la derniere ou l'extrait
// devrait etre plus large qu'ailleurs.
env.addFilter('extraitDescription', function (description) {
    return extraireDescription(description && description.paragraphs);
});

const meta = JSON.parse(fs.readFileSync("./www/_data/meta.json", "utf8"));
const siteUrl = meta.url.replace(/\/$/, '');
const siteName = meta.name;
const siteYear = new Date().getFullYear();

// Le copyright du flux ne peut pas se resumer a « kerostig © » : ce que le
// flux transporte, ce sont des extraits d'appels ecrits par les editeurs.
// Seules les notices -- selection, mise en forme, rattachement a la revue --
// sont de kerostig.
const COPYRIGHT = `Notices : ${siteName} © ${siteYear}. Le texte des appels appartient à leurs éditeurs.`;

// Contenu d'un article, commun aux trois flux (global, par revue, par tag).
// Le gabarit recoit le lien vers l'editeur et celui vers la fiche kerostig :
// un article de flux se lit hors du site, il doit porter ses deux renvois.
function contenuArticle(call) {
    return nunjucks.render('rss.html', {
        call,
        lienSource: lienSourceOriginale(call),
        pageKerostig: `${siteUrl}/call/${call.slug}/`,
    });
}

const rssFeed = new Feed({
    title: siteName,
    description: "le hub des appels à publications en sciences de gestion et management",
    id: `${siteUrl}/`,
    link: `${siteUrl}/`,
    language: "fr",
    image: `${siteUrl}/public/favicon/android-chrome-96x96.png`,
    favicon: `${siteUrl}/public/favicon/favicon.ico`,
    copyright: COPYRIGHT,
    date: new Date(),
    feedLinks: {
        json: `${siteUrl}/json`,
        atom: `${siteUrl}/atom`
    },
    author: {
        name: "Bruno Daucé",
        email: "bruno.dauce@univ-angers.fr",
        link: `${siteUrl}/`
    }
});

let data = fs.readFileSync("./www/_data/calls.json", "utf8");
let calls = JSON.parse(data);
calls = calls.filter(call => call.active || (!call.active && Date.now() < Date.parse(call.gracePeriod)));

for (const call of calls) {
    rssFeed.addItem({
        title: call.title ? call.title : call.metaTitle,
        id: call.slug,
        link: `${siteUrl}/call/${call.slug}/`,
        date: new Date(call.pubDate),
        // Pas de bloc author : la bibliotheque n'ecrit <author> que si name et
        // email sont tous deux fournis, et le champ email portait ici le nom
        // de la revue -- un lecteur de flux affichait donc « Management
        // Learning (ML) » comme adresse de l'auteur. La revue est nommee dans
        // le corps de l'article, avec le lien vers l'editeur.
        content: contenuArticle(call)
    });
}
fs.writeFileSync("./www/rss.xml", rssFeed.rss2());

// Group calls by journal-abbreviation
const journalGroups = {};
for (const call of calls) {
    const key = `${call.abbreviation}-${call.journal}`;
    if (!journalGroups[key]) journalGroups[key] = [];
    journalGroups[key].push(call);
}

// Generate journal folder
fs.mkdirSync('./www/journal', { recursive: true });

// Generate RSS for each journal
for (const [key, journalCalls] of Object.entries(journalGroups)) {
    const firstCall = journalCalls[0];
    const journalFeed = new Feed({
        title: `${siteName} | ${firstCall.journal}`,
        description: `Derniers appels à publications pour ${firstCall.journal}.`,
        id: `${siteUrl}/journal/${slugify(firstCall.journal, { lower: true, strict: true })}`,
        link: `${siteUrl}/journal/${slugify(firstCall.journal, { lower: true, strict: true })}/`,
        language: "fr",
        image: `${siteUrl}/public/favicon/android-chrome-96x96.png`,
        favicon: `${siteUrl}/public/favicon/favicon.ico`,
        copyright: COPYRIGHT,
        date: new Date(),
        feedLinks: {
            json: `${siteUrl}/journal/${slugify(firstCall.journal, { lower: true, strict: true })}.json`,
            atom: `${siteUrl}/journal/${slugify(firstCall.journal, { lower: true, strict: true })}.atom`
        },
        author: rssFeed.options.author
    });
    for (const call of journalCalls) {
        journalFeed.addItem({
            title: call.title ? call.title : call.metaTitle,
            id: call.slug,
            link: `${siteUrl}/call/${call.slug}/`,
            date: new Date(call.pubDate),
            content: contenuArticle(call)
        });
    }
    // Write journal RSS file using slugified journal name
    const journalSlug = slugify(firstCall.journal, { lower: true, strict: true });
    fs.writeFileSync(`./www/journal/${journalSlug}.xml`, journalFeed.rss2(), { recursive: true });
}

// Generate tag folder
fs.mkdirSync('./www/tag', { recursive: true });

// Group calls by tag
const tagGroups = {};
for (const call of calls) {
    if (Array.isArray(call.tags)) {
        for (const tag of call.tags) {
            if (!tagGroups[tag]) tagGroups[tag] = [];
            tagGroups[tag].push(call);
        }
    }
}

fs.mkdirSync('./www/journal', { recursive: true });

// Generate RSS for each tag
for (const [tag, tagCalls] of Object.entries(tagGroups)) {
    const tagFeed = new Feed({
        title: `${siteName} | Tag : ${tag}`,
        description: `Derniers appels à publications avec le tag '${tag}'.`,
        id: `${siteUrl}/tag/${slugify(tag, { lower: true, strict: true })}`,
        link: `${siteUrl}/tag/${slugify(tag, { lower: true, strict: true })}/`,
        language: "fr",
        image: `${siteUrl}/public/favicon/android-chrome-96x96.png`,
        favicon: `${siteUrl}/public/favicon/favicon.ico`,
        copyright: COPYRIGHT,
        date: new Date(),
        feedLinks: {
            json: `${siteUrl}/tag/${slugify(tag, { lower: true, strict: true })}.json`,
            atom: `${siteUrl}/tag/${slugify(tag, { lower: true, strict: true })}.atom`
        },
        author: rssFeed.options.author
    });
    for (const call of tagCalls) {
        tagFeed.addItem({
            title: call.title ? call.title : call.metaTitle,
            id: call.slug,
            link: `${siteUrl}/call/${call.slug}/`,
            date: new Date(call.pubDate),
            content: contenuArticle(call)
        });
    }
    // Write tag RSS file using slugified tag name
    const tagSlug = slugify(tag, { lower: true, strict: true });
    fs.writeFileSync(`./www/tag/${tagSlug}.xml`, tagFeed.rss2(), { recursive: true });
}
