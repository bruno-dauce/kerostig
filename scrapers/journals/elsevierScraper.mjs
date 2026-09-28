import { matchIssn } from '../issnMatcher.mjs';
import { waitForCloudflare } from '../cloudflare.mjs';

// Hub centralise (equivalent Emerald), trouve par l'utilisateur.
const LISTING_URL = 'https://www.sciencedirect.com/browse/calls-for-papers';

// Confirme via le HTML reel du hub. Pas de pagination par URL (pas de
// parametre ?page=, pas de "Load more") : tout est servi en une fois, rendu
// cote serveur.
const LISTING_CARD_SELECTOR = 'li.js-publication';
const LISTING_TITLE_SELECTOR = 'a.js-publication-title';
const LISTING_JOURNAL_SELECTOR = '.publication-text a';

// Le hub n'est pas stable d'une requete a l'autre. Mesure le 2026-09-27 sur 22
// chargements : ScienceDirect sert au hasard une liste complete (2902 cartes,
// 7 fois sur 22) ou l'une de plusieurs listes amputees (2420, 2273, 2180),
// toutes sous-ensembles stricts de la complete. Les absentes sont reparties
// sur toute la liste et appel par appel, pas revue par revue. Le texte
// « Browse N calls for papers » suit la variante servie : il ne dit rien de
// la completude.
//
// Un run tombe sur une variante courte perdait ainsi plusieurs dizaines
// d'appels du perimetre, passes inactifs en silence : le 2026-09-26, 32 appels
// desactives dont 28 toujours en ligne. La perte (~15 %) reste sous le seuil
// de gel de detecterScrapersVides.
//
// On charge donc le hub plusieurs fois et on fusionne. Deux protections se
// cumulent : la variante complete sort environ une fois sur trois, et les
// variantes amputees se recouvrent mal entre elles (les trois reunies
// couvraient deja 2809 appels sur 2820). Six chargements suffisent a
// reconstituer la liste, ou a n'en perdre que quelques cartes au pire.
const NB_CHARGEMENTS = 6;
const PAUSE_ENTRE_CHARGEMENTS_MS = 15000;

// Fusionne les cartes de plusieurs chargements du hub. Fonction pure, exportee
// pour test.
//
// Cle = URL + ISSN (issn_cle), et non l'URL seule : un meme numero special
// conjoint apparait sous plusieurs revues avec la meme URL (ex. 270379,
// Emerging Markets Review et Finance Research Letters), et chaque carte donne
// un appel. L'ISSN plutot que le texte brut de la revue (repli si l'ISSN n'a
// pas ete resolu, ex. revue hors perimetre FNEGE) : conformement a la regle
// de jointure du projet, et parce que deux chargements du hub peuvent rendre
// le nom d'une meme revue avec de legeres variations (espace, esperluette),
// ce qui ferait passer un seul appel pour deux cartes distinctes.
//
// Le plus gros chargement sert de base, dans son ordre : l'ordre des appels
// decide des suffixes -2 des slugs homonymes (dataPreparation.generateSlug),
// il doit rester celui du hub. Les cartes vues ailleurs seulement sont
// ajoutees a la suite. Pour chaque carte, la premiere occurrence fait foi.
//
// complet vaut false quand la fusion depasse le plus gros chargement : aucun
// chargement n'etait alors complet a lui seul, et la liste reconstituee par
// union peut encore manquer quelques cartes.
export function fusionnerChargements(chargements) {
    const tailles = chargements.map(c => c.length);
    const maxChargement = Math.max(0, ...tailles);
    const ordonnes = [...chargements].sort((a, b) => b.length - a.length);
    const cle = l => `${l.url}|${l.issn ?? l.journal}`;
    const vues = new Set();
    const listings = [];
    for (const chargement of ordonnes) {
        for (const listing of chargement) {
            if (!listing.url) continue;
            const k = cle(listing);
            if (vues.has(k)) continue;
            vues.add(k);
            listings.push(listing);
        }
    }
    return { listings, tailles, maxChargement, complet: listings.length <= maxChargement };
}

export const scraperObject = {
    url: LISTING_URL,
    abbreviation: 'elsevier',
    async scraper(browser) {
        const abbreviation = this.abbreviation;

        const chargements = [];
        for (let i = 1; i <= NB_CHARGEMENTS; i++) {
            const { listings: cartes, annonce } = await get_listings(browser, LISTING_URL);
            console.log(`[elsevier] chargement ${i}/${NB_CHARGEMENTS} : ${cartes.length} carte(s), total annonce ${annonce ?? 'absent'}`);
            // ISSN resolu des ce chargement, avant la fusion : c'est lui qui
            // sert de cle (issn_cle), pas le texte brut de la revue.
            const avecIssn = await Promise.all(cartes.map(async carte => ({
                ...carte,
                issn: carte.journal ? await matchIssn(carte.journal) : null,
            })));
            chargements.push(avecIssn);
            if (i < NB_CHARGEMENTS) await new Promise(ok => setTimeout(ok, PAUSE_ENTRE_CHARGEMENTS_MS));
        }
        const { listings, maxChargement, complet } = fusionnerChargements(chargements);
        console.log(`[elsevier] ${listings.length} carte(s) apres fusion de ${NB_CHARGEMENTS} chargements (le plus gros : ${maxChargement})`);
        if (!complet) {
            console.warn(`[elsevier] Aucun chargement complet a lui seul : liste reconstituee par union, quelques cartes peuvent encore manquer`);
        }

        // Les pages de detail /special-issue/{id} sont bloquees par Cloudflare
        // de facon systematique (contrairement au hub lui-meme). On ne les
        // visite plus pour l'instant : seules les donnees de la carte de liste
        // (titre, revue, echeance si affichee) sont utilisees. rawContent est
        // reconstruit a partir de ca, a enrichir plus tard si l'acces au
        // detail est debloque.
        let skippedCount = 0;
        const calls = [];
        for (const listing of listings) {
            if (!listing.metaTitle || !listing.journal || !listing.url) continue;
            if (!listing.issn) {
                skippedCount++;
                continue;
            }

            calls.push({
                journal: listing.journal,
                abbreviation,
                issn: listing.issn,
                metaTitle: listing.metaTitle,
                url: listing.url,
                rawContent: build_placeholder_content(listing),
            });
        }
        console.log(`[elsevier] ${skippedCount} appel(s) ignore(s), revue hors perimetre FNEGE`);

        return calls;
    }
}

function build_placeholder_content(listing) {
    const parts = [
        `<h2>${escape_html(listing.metaTitle)}</h2>`,
        `<p>${escape_html(listing.journal)}</p>`,
    ];
    if (listing.deadline) {
        parts.push(`<p>Submission deadline: ${escape_html(listing.deadline)}</p>`);
    }
    return parts.join('');
}

function escape_html(text) {
    return (text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function get_listings(browser, pageUrl) {
    const page = await browser.newPage();
    try {
        await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await waitForCloudflare(page, '[elsevier]');

        // ScienceDirect est une SPA React : le contenu se peuple apres le
        // chargement initial, d'ou waitForSelector plutot qu'un $$eval immediat.
        const found = await page.waitForSelector(LISTING_CARD_SELECTOR, { timeout: 30000 })
            .then(() => true)
            .catch(() => false);
        if (!found) {
            console.warn(`[elsevier] Aucune carte trouvee sur ${pageUrl} (blocage, ou selecteurs a revoir)`);
            return { listings: [], annonce: null };
        }

        const annonce = await page.evaluate(() => (document.body.innerText.match(/Browse (\d+) calls for papers/) || [])[1] ?? null);
        const listings = await page.$$eval(LISTING_CARD_SELECTOR, (items, selectors) => items.map(item => {
            const titleLink = item.querySelector(selectors.title);
            const deadlineBlock = Array.from(item.querySelectorAll('div.text-s'))
                .find(el => el.textContent.includes('Submission deadline'));
            return {
                metaTitle: titleLink?.textContent.trim() ?? '',
                journal: item.querySelector(selectors.journal)?.textContent.trim() ?? '',
                url: titleLink?.href ?? null,
                deadline: deadlineBlock?.querySelector('strong')?.textContent.trim() ?? null,
            };
        }), { title: LISTING_TITLE_SELECTOR, journal: LISTING_JOURNAL_SELECTOR });
        return { listings, annonce };
    } catch (error) {
        console.warn(`[elsevier] Erreur (timeout ou navigation) sur ${pageUrl} : ${error.message}`);
        return { listings: [], annonce: null };
    } finally {
        await page.close();
    }
}
