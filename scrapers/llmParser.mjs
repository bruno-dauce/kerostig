import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import * as chrono from 'chrono-node';

const openai = new OpenAI({
    baseURL: process.env.OPENAI_BASE_URL,
    apiKey: process.env.OPENAI_API_KEY,
});

const Academic = z.object({
    name: z.string().describe("The academic's name. Do NOT include titles such as doctor (dr.) or professor (prof.) here."),
    affiliation: z.string().describe("The academic's university affiliation. Only include the university or organization here. Do NOT include departments, cities, states or countries.").nullable(),
});

const Date = z.object({
    date: z.string().describe("The date of the submission timeline event, exactly as written in the text. Never infer, complete or guess a date that is not written in the text provided."),
    description: z.string().describe("The description of the submission timeline event").nullable(),
    is_full_paper_submission_deadline: z.boolean().describe("A flag that indicates whether the date is the full paper submission deadline. The most important date on a call for papers.").nullable(),
});

const Description = z.object({
    paragraphs: z.string().array().describe("The paragraphs of the description. This is the main content of the call for papers. Do NOT include headings as paragraphs. Do NOT include topics that appear in bullet point format. Do NOT include information related to formatting and submission instructions. If there is no paragraph structure in the text provided, you can organize the text into meaningful paragraphs."),
});

const Call = z.object({
    title: z.string().describe("Title of the call for papers. Only include the actual title here. Do NOT include statements such as 'call for papers' or 'special issue' or the journal name here."),
    topics: z.string().array().describe("Topics of the call for papers. This is a list of topics that the call for papers is interested in. This is usually in bullet point format. Bullet points can also include example research questions."),
    description: Description.describe("Description of the call for papers. This is the main content of the call for papers."),
    tags: z.string().array().describe("Tags that describe the content of the call for papers. Use as few tags as possible."),
    editors: Academic.array().describe("The editors of the special issue. This is a list of academics who are responsible for the special issue."),
    associate_editors: Academic.array().describe("The associate editors or editorial review board of the special issue. This is a list of academics who are assisting the editors with the special issue."),
    dates: Date.array().describe("This is a list of important dates for the call for papers. Include ONLY dates that appear verbatim in the text provided. If the text announces no date at all, return an empty list -- an empty list is the correct answer, never a reason to supply a plausible date from memory or from the surrounding URLs."),
});

async function parseFuzzyDate(fuzzyDate) {
    // Le parseur anglais par defaut renvoie null sur des dates francaises
    // ("31 decembre 2026") -- confirme manuellement. chrono-node fournit un
    // parseur localise (chrono.fr) qui gere aussi les ordinaux ("1er juin").
    // Essaye en repli seulement, pour ne rien changer au comportement
    // existant sur les dates anglaises des autres scrapers.
    return chrono.parseDate(fuzzyDate) ?? chrono.fr.parseDate(fuzzyDate);
}

// Un rawContent absent, ou trop maigre pour porter un vrai titre (Elsevier :
// pages de detail bloquees par Cloudflare, contenu reconstruit a partir de la
// seule carte de liste), laisse le titre vide -- soit parce qu'on n'appelle
// jamais le modele, soit parce qu'il refuse a juste titre d'inventer un titre
// a partir d'un code comme "CMResponsibleScience26". Le metaTitle du scraper
// est toujours present : il sert de repli honnete. Sans lui, l'appel se
// retrouve stocke sans titre, et son contentHash le fige dans cet etat.
function replierSurMetaTitle(call) {
    if (!call.title || call.title.trim() === '') {
        call.title = call.metaTitle ?? '';
    }
    return call;
}

// Filet de securite derriere la consigne du prompt : on ne garde une date
// que si son millesime figure dans le texte transmis au modele.
//
// Constate le 2026-08-18 sur SAGE : quand l'appel se reduit a un titre et un
// lien vers un PDF (27 appels sur 65), le modele produit parfois une echeance
// plausible mais absente du texte -- il reconnait l'appel et le date de
// memoire. L'effet est silencieux et grave : ces dates etant passees,
// echeance.mjs archive l'appel des sa collecte, il n'apparait jamais sur le
// site, et le contentHash fige le resultat. Un appel sans echeance est bien
// moins genant : echeanceDepassee ne cloture jamais un appel sans date, sa
// fin de vie reste geree par la disparition de sa source.
//
// Le test porte sur l'annee et non sur la date entiere : le modele reformate
// legitimement ("31 October 2026" -> "2026-10-31"), mais il n'a aucune raison
// d'inventer un millesime absent.
//
// Les cibles de liens sont retirees avant la recherche : une URL du type
// /2025/08/18/call-for-papers-... ou un PDF nomme 2025-11-27_CFP.pdf porte
// une date de publication ou de mise en ligne, jamais l'echeance -- les
// laisser suffirait a valider une date inventee (constate sur les appels
// d'Entrepreneurship Theory and Practice).
function millesimesCites(rawContent) {
    const texte = rawContent
        .replace(/\]\([^)]*\)/g, ']')
        .replace(/https?:\/\/\S+/g, ' ');
    return new Set(texte.match(/\b(?:19|20)\d{2}\b/g) ?? []);
}

function ecarterDatesNonSourcees(dates, rawContent, titre) {
    const millesimes = millesimesCites(rawContent);
    return dates.filter(date => {
        if (!date.date) return true; // date non interpretable, deja sans effet
        // Les deux millesimes, local et UTC : chrono date a midi les dates
        // sans heure, mais une eventuelle date a minuit un 1er janvier
        // basculerait d'une annee au passage en UTC.
        const annee = String(date.date.getUTCFullYear());
        if (millesimes.has(annee) || millesimes.has(String(date.date.getFullYear()))) return true;
        console.warn(`[llm] "${titre}" : date ${date.date.toISOString().slice(0, 10)} ecartee, l'annee ${annee} n'apparait pas dans le texte source`);
        return false;
    });
}

export async function parse(call) {
    if (!call.rawContent || call.rawContent.length == 0) {
        delete call.rawContent;
        call.tags = [];
        return replierSurMetaTitle(call);
    }
    const completion = await openai.beta.chat.completions.parse({
        model: process.env.MODEL_NAME,
        messages: [
            { role: "system", content: "You are an expert parser of calls for papers for special issues of academic journals. You do NOT make up any information. You only copy information from the call directly. This applies to dates above all: some of the texts you are given are very short -- a title and a link, nothing more -- and you may recognise the call from your own knowledge. Do not use that knowledge. If a submission deadline is not written in the text in front of you, it does not exist for the purposes of this task, and the list of dates must stay empty." },
            { role: "user", content: `Parse the following call for papers:\n\n${call.rawContent}` },
        ],
        response_format: zodResponseFormat(Call, "call_parsing"),
    });

    const rawContent = call.rawContent;
    call = { ...call, ...completion.choices[0].message.parsed };
    delete call.rawContent
    call.dates = await Promise.all(call.dates.map(async date => {
        date.date = await parseFuzzyDate(date.date);
        return date;
    }));
    call.dates = ecarterDatesNonSourcees(call.dates, rawContent, call.metaTitle ?? call.title);
    call.dates.sort((a, b) => a.date - b.date);
    call.tags = await Promise.all(call.tags.map(async tag => {
        return tag.toLowerCase();
    }));
    return replierSurMetaTitle(call);
}
