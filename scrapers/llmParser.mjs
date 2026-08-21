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
    is_full_paper_submission_deadline: z.boolean().describe("A flag that indicates whether the date is the full paper submission deadline. The most important date on a call for papers. When submissions are expressed as a window or a range -- 'submissions open from September 1 to September 30, 2026', 'between August 1 and August 31, 2027' -- ONLY the closing bound of that range may be true. The opening bound must be false: opening a submission window is not a deadline.").nullable(),
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
    dates: Date.array().describe("This is a list of important dates for the call for papers. Include ONLY dates that appear verbatim in the text provided. If the text announces no date at all, return an empty list -- an empty list is the correct answer, never a reason to supply a plausible date from memory or from the surrounding URLs. When a submission window is expressed as a range, return BOTH bounds as two separate entries, each with its own description -- never collapse a range into a single date."),
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
//
// Les espaces sont normalises en plus : le texte extrait d'un PDF par pdfjs
// colle les fragments avec des espaces surnumeraires ("August 31 , 2027"),
// ce qui empeche de retrouver la date telle que le modele l'a recopiee.
// Sans effet sur la recherche de millesimes, qui ne travaille pas sur les
// offsets.
function texteNormalise(rawContent) {
    return rawContent
        .replace(/\]\([^)]*\)/g, ']')
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/\s+/g, ' ')
        // pdfjs concatene les fragments de texte avec un espace, et coupe le
        // millesime quand le PDF applique un crenage inhabituel : "June 30,
        // 202 7" au lieu de "2027" (constate sur l'appel Theory Testing de
        // Group & Organization Management). La regex de millesime ne
        // reconnait alors plus l'annee, et une echeance legitime est
        // ecartee. Les bornes de mot encadrent le motif pour ne pas mordre
        // sur une suite de chiffres plus longue ("202 77" reste intact).
        .replace(/\b(199|200|201|202) (\d)\b/g, '$1$2');
}

function millesimesCites(rawContent) {
    return new Set(texteNormalise(rawContent).match(/\b(?:19|20)\d{2}\b/g) ?? []);
}

// Largeur de la fenetre de recherche, de part et d'autre de la date telle
// que le modele l'a recopiee. 120 caracteres couvrent une ligne de
// calendrier entiere ("Submission window open from September 1 - September
// 30, 2026") sans deborder sur le paragraphe suivant.
const FENETRE_MILLESIME = 120;

// true ou false : verdict de proximite. null : test impossible, parce que le
// modele a reformate la date au lieu de la recopier, ou ne l'a pas fournie.
// L'appelant retombe alors sur le test global.
function millesimeProche(texte, dateSource, annees) {
    if (!dateSource) return null;
    const aiguille = String(dateSource).replace(/\s+/g, ' ').trim();
    if (!aiguille) return null;
    const index = texte.indexOf(aiguille);
    if (index === -1) return null;
    const fenetre = texte.slice(
        Math.max(0, index - FENETRE_MILLESIME),
        index + aiguille.length + FENETRE_MILLESIME,
    );
    return annees.some(annee => fenetre.includes(annee));
}

// Fonction pure, exportee pour pouvoir etre rejouee sur du texte reel sans
// appel au modele (meme usage que extract_spot_calls chez sageScraper).
export function ecarterDatesNonSourcees(dates, rawContent, titre) {
    const texte = texteNormalise(rawContent);
    const millesimes = millesimesCites(rawContent);
    return dates.filter(date => {
        if (!date.date) return true; // date non interpretable, deja sans effet
        // Les deux millesimes, local et UTC : chrono date a midi les dates
        // sans heure, mais une eventuelle date a minuit un 1er janvier
        // basculerait d'une annee au passage en UTC.
        const annees = [String(date.date.getUTCFullYear()), String(date.date.getFullYear())];
        const iso = date.date.toISOString().slice(0, 10);

        const proche = millesimeProche(texte, date.dateSource, annees);
        if (proche === true) return true;
        if (proche === false) {
            console.warn(`[llm] "${titre}" : date ${iso} ecartee, l'annee ${annees[0]} n'apparait pas a moins de ${FENETRE_MILLESIME} caracteres de "${date.dateSource}" dans le texte source`);
            return false;
        }

        // Repli : date non reperable dans le texte, test global comme avant.
        if (annees.some(annee => millesimes.has(annee))) return true;
        console.warn(`[llm] "${titre}" : date ${iso} ecartee, l'annee ${annees[0]} n'apparait pas dans le texte source`);
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
        // La chaine brute du modele est conservee le temps du controle de
        // proximite : parseFuzzyDate ecrase date.date, et sans elle on ne
        // peut plus reperer la date dans le texte source.
        date.dateSource = date.date;
        date.date = await parseFuzzyDate(date.date);
        return date;
    }));
    // dateSource est retiree aussitot : elle ne doit pas atterrir dans
    // calls.json, ou elle changerait la forme des donnees et le contentHash.
    call.dates = ecarterDatesNonSourcees(call.dates, rawContent, call.metaTitle ?? call.title)
        .map(({ dateSource, ...reste }) => reste);
    call.dates.sort((a, b) => a.date - b.date);
    call.tags = await Promise.all(call.tags.map(async tag => {
        return tag.toLowerCase();
    }));
    return replierSurMetaTitle(call);
}
