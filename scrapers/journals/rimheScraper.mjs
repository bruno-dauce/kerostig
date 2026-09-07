import * as cheerio from 'cheerio';

// Page unique d'appels sur un site asso-web.com : HTML statique, pas d'API
// REST, rien a executer. On lit donc la page au navigateur puis on la decoupe,
// comme rfgScraper. Le flux RSS du site (/rss.php) a ete verifie : il ne liste
// que les 6 pages statiques du site, jamais les appels -- piste close.
// robots.txt n'interdit rien ici mais impose Crawl-delay: 30 ; ce scraper ne
// fait qu'une requete par passage.
const LISTING_URL = 'https://rimhe.com/135+appels-y-contributions.html';

// Libelle repris de journals.json, ou la fiche existe sous ce titre exact.
const JOURNAL_NAME = 'RIMHE Revue Interdisciplinaire Management Homme(s) & Entreprise';

// ISSN litteral, comme mavScraper : c'est l'issn_cle de journals.json, donc la
// cle de jointure elle-meme.
const ISSN = '2260-5584';

// Les appels ne portent ni balise semantique ni classe CSS propre : ils sont
// separes par des <hr> a l'interieur d'un seul div.text_news. Confirme sur le
// HTML reel du 2026-09-07 : 4 <hr>, donc 5 blocs.
const ZONE_SELECTOR = 'div.text_news';
const SEPARATOR_PATTERN = /<hr\b[^>]*>/i;

// Le theme de l'appel est entre guillemets francais, sur les 5 blocs de la
// page. On ne se fie pas au <strong> : le premier bloc en contient cinq, dont
// le chapo permanent de la page. Les guillemets courbes (") sont exclus a
// dessein, un bloc les utilise pour une citation interne au titre.
const THEME_PATTERN = /«\s*([^»]{3,200}?)\s*»/;
const PDF_LINK_SELECTOR = 'a[href$=".pdf"]';

const MOIS = {
    janvier: 0, fevrier: 1, mars: 2, avril: 3, mai: 4, juin: 5,
    juillet: 6, aout: 7, septembre: 8, octobre: 9, novembre: 10, decembre: 11,
};
const MOIS_MOTIF = 'janvier|f[ée]vrier|mars|avril|mai|juin|juillet|ao[ûu]t|septembre|octobre|novembre|d[ée]cembre';
const DATE_MOTIF = `(?:(\\d{1,2})\\s+)?(${MOIS_MOTIF})\\s+(\\d{4})`;
const DATE_PATTERN = new RegExp(DATE_MOTIF, 'gi');

// « Echeance de soumission : le 30 juillet 2025 » -- la borne a 60 caracteres
// evite d'attraper une date d'une autre phrase si la ligne perd sa date.
const ECHEANCE_PATTERN = new RegExp(`[ée]ch[ée]ance[^.]{0,60}?${DATE_MOTIF}`, 'i');

export const scraperObject = {
    url: LISTING_URL,
    abbreviation: 'rimhe',
    async scraper(browser) {
        const abbreviation = this.abbreviation;

        const html = await get_page_html(browser);
        if (!html) return [];

        const blocs = decouper_blocs(html);
        if (blocs.length === 0) {
            console.warn(`[rimhe] Aucun bloc trouve sur ${LISTING_URL} (le decoupage sur <hr> dans ${ZONE_SELECTOR} ne tient plus ?)`);
            return [];
        }
        console.log(`[rimhe] ${blocs.length} bloc(s) separes par <hr> sur ${LISTING_URL}`);

        const maintenant = new Date();
        const calls = [];
        let clotures = 0;
        let sansTitre = 0;
        for (const bloc of blocs) {
            const call = formater_appel(bloc, abbreviation);
            if (!call) {
                // Le premier bloc porte aussi le chapo permanent de la page :
                // le jour ou RIMHE n'aura plus d'appel ouvert, il ne restera
                // que lui, sans theme ni PDF, et il doit sortir ici.
                sansTitre++;
                continue;
            }
            if (!bloc_est_ouvert(texte_du_bloc(bloc), maintenant)) {
                clotures++;
                continue;
            }
            calls.push(call);
        }

        console.log(`[rimhe] ${calls.length} appel(s) retenu(s), ${clotures} cloture(s), ${sansTitre} bloc(s) sans theme ni PDF`);
        return calls;
    }
}

async function get_page_html(browser) {
    const page = await browser.newPage();
    try {
        await page.goto(LISTING_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
        return await page.content();
    } catch (error) {
        console.warn(`[rimhe] Erreur (timeout ou navigation) sur ${LISTING_URL} : ${error.message}`);
        return null;
    } finally {
        await page.close();
    }
}

// Rend le HTML de chaque bloc separe par un <hr>.
// Fonction pure, exportee pour test.
export function decouper_blocs(html) {
    const $ = cheerio.load(html);
    $('script, style').remove();

    // La classe du conteneur est le repere principal ; le parent du premier
    // <hr> sert de repli si le theme du site la renomme.
    let zone = $(ZONE_SELECTOR).filter((_, el) => $(el).find('hr').length > 0).first();
    if (zone.length === 0) zone = $('hr').first().parent();
    if (zone.length === 0) return [];

    const contenu = zone.html();
    if (!contenu) return [];

    return contenu
        .split(new RegExp(SEPARATOR_PATTERN.source, 'gi'))
        .map(bloc => bloc.trim())
        .filter(bloc => bloc.length > 0);
}

// Le theme entre guillemets, a defaut le libelle du lien PDF. Rend '' si le
// bloc n'est pas un appel.
// Fonction pure, exportee pour test.
export function extraire_titre(blocHtml) {
    const $ = cheerio.load(blocHtml);
    const texte = normaliser($.text());

    const theme = texte.match(THEME_PATTERN);
    if (theme) return normaliser(theme[1]);

    const lienPdf = $(PDF_LINK_SELECTOR).first();
    if (lienPdf.length > 0) {
        const libelle = normaliser(lienPdf.text());
        if (libelle) return libelle;
    }
    return '';
}

// Rend l'echeance du bloc et la facon dont elle a ete lue.
//
// Deux etages, parce que la page melange deux ecritures. Les appels clotures
// portent une ligne « Echeance de soumission : ... » ; l'appel ouvert du
// 2026-09-07, lui, n'en a pas et donne un calendrier (« Octobre 2026 : envoi
// de la 1ere version », puis avril 2027, juin 2027). Se fier a la seule ligne
// d'echeance jetterait donc le seul appel vivant de la page.
//
// Quand aucune ligne d'echeance n'est ecrite, on retient la date la PLUS
// TARDIVE du bloc : le calendrier d'un appel ouvert se termine apres sa date
// de soumission, celui d'un appel clos est entierement passe.
// Fonction pure, exportee pour test.
export function echeance_du_bloc(texte) {
    const explicite = texte.match(ECHEANCE_PATTERN);
    if (explicite) {
        const date = construire_date(explicite[1], explicite[2], explicite[3]);
        if (date) return { date, explicite: true };
    }

    let plusTardive = null;
    for (const trouve of texte.matchAll(DATE_PATTERN)) {
        const date = construire_date(trouve[1], trouve[2], trouve[3]);
        if (date && (plusTardive === null || date > plusTardive)) plusTardive = date;
    }
    return { date: plusTardive, explicite: false };
}

// Un bloc sans aucune date lisible est ecarte : cette page est une archive
// permanente et diffChecker ne repasse un appel a active:false que quand il
// DISPARAIT de sa source. Sans ce filtre, les appels morts de 2024 et 2025
// s'afficheraient comme courants a vie -- meme piege que la page d'annonces de
// la RIPME, meme parade que le MAX_AGE_MONTHS de reScraper.
// Fonction pure, exportee pour test.
export function bloc_est_ouvert(texte, maintenant = new Date()) {
    const { date } = echeance_du_bloc(texte);
    if (date === null) return false;
    return date >= maintenant;
}

// Le texte nu d'un bloc, tel que le lisent extraire_titre et le filtre de date.
// Fonction pure, exportee pour test.
export function texte_du_bloc(blocHtml) {
    return normaliser(cheerio.load(blocHtml).text());
}

// Rend l'appel au format attendu par dataPreparation, ou null si le bloc n'est
// pas un appel.
// Fonction pure, exportee pour test.
export function formater_appel(blocHtml, abbreviation) {
    const metaTitle = extraire_titre(blocHtml);
    if (!metaTitle) return null;

    const $ = cheerio.load(blocHtml);
    const href = $(PDF_LINK_SELECTOR).first().attr('href');

    return {
        journal: JOURNAL_NAME,
        abbreviation,
        issn: ISSN,
        metaTitle,
        // Le PDF est l'appel complet et porte une URL propre a chaque appel.
        // Les liens du site s'ecrivent « /../../../../uploaded/x.pdf » : new URL
        // les normalise. Sans PDF, une ancre sur la page de liste, comme afcScraper.
        url: href
            ? new URL(href, LISTING_URL).href
            : `${LISTING_URL}#${encodeURIComponent(metaTitle)}`,
        rawContent: blocHtml,
    };
}

function construire_date(jour, mois, annee) {
    const index = MOIS[deplier_accents(mois)];
    if (index === undefined) return null;

    const an = Number(annee);
    // Un mois sans jour designe le mois entier : on prend son dernier jour,
    // sinon « Octobre 2026 » serait deja passe le 2 octobre 2026 et archiverait
    // un appel encore ouvert.
    if (jour === undefined) return new Date(an, index + 1, 0);
    return new Date(an, index, Number(jour));
}

// Les seuls accents que portent les noms de mois : fevrier, decembre, aout.
function deplier_accents(mois) {
    return mois.toLowerCase().replace(/[éè]/g, 'e').replace(/û/g, 'u');
}

function normaliser(texte) {
    return texte.replace(/\s+/g, ' ').trim();
}
