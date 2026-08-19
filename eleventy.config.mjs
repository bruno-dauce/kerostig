import { readFileSync } from "node:fs";

import { DateTime } from "luxon";

import { echeanceDepassee } from "./scrapers/echeance.mjs";

// Les 17 disciplines du classement FNEGE. Table editoriale : elle porte le nom
// d'affichage et le slug de la route /discipline/, que journals.json ne fournit
// pas (son champ discipline est un libelle brut, parfois sans apostrophe --
// "Systemes d information"). La jointure se fait donc toujours sur le code.
const disciplines = JSON.parse(
    readFileSync(new URL("./www/_data/disciplines.json", import.meta.url), "utf8")
);
const disciplineDuCode = (code) => disciplines.find((d) => d.code === code) || null;

// Marge apres l'echeance avant de masquer un appel : couvre les decalages de
// fuseau horaire et les prolongations que la source n'a pas encore publiees.
const TOLERANCE_ECHEANCE_JOURS = 7;

// Un appel est affiche s'il est actif (ou encore dans son delai de grace)
// ET si son echeance de soumission n'est pas passee. Le drapeau active seul
// ne suffit pas : sur les sources de type archive permanente, un appel ne
// disparait jamais et resterait affiche comme courant indefiniment.
// Un appel sans echeance identifiee reste juge sur active seul (cf echeance.mjs).
const appelAffichable = (call) =>
    (call.active || Date.now() < new Date(call.gracePeriod)) &&
    !echeanceDepassee(call, TOLERANCE_ECHEANCE_JOURS);

// Echeance de soumission du manuscrit complet, en chaine ISO, ou null.
// Meme regle que echeanceSoumission dans scrapers/echeance.mjs, qui rend la
// meme date en ms epoch : seules les dates portant le drapeau comptent, et
// parmi elles la plus tardive (prolongations, doublons du modele).
//
// Aucun repli sur dates[dates.length - 1] : un appel dont le modele n'a
// identifie aucune date de soumission est un appel sans echeance connue, pas
// un appel qui expire a sa derniere date connue -- laquelle est souvent une
// notification d'acceptation, une ouverture de fenetre de soumission ou une
// date de publication. Ce repli faisait diverger les deux fonctions homonymes
// et posait un expires JSON-LD que la page elle-meme contredisait.
const echeanceSoumission = (dates) => {
    if (!Array.isArray(dates)) return null;
    let retenue = null;
    let retenueMs = null;
    for (const d of dates) {
        if (!d || !d.is_full_paper_submission_deadline || !d.date) continue;
        const t = Date.parse(d.date);
        if (Number.isNaN(t)) continue;
        if (retenueMs === null || t > retenueMs) {
            retenueMs = t;
            retenue = d.date;
        }
    }
    return retenue;
};

export default async function (eleventyConfig) {

    // --- kerostig : jointure appels <-> revue par ISSN ---
    eleventyConfig.addFilter("appelsDeLaRevue", function (allCalls, revue) {
        if (!allCalls || !revue) return [];
        const norm = (v) => (v || "").toString().replace(/[^0-9Xx]/g, "").toUpperCase();
        const cibles = new Set([norm(revue.eissn), norm(revue.pissn), norm(revue.issn_cle)].filter(Boolean));
        return allCalls.filter((call) => {
            if (!appelAffichable(call)) return false;
            const issnAppel = norm(call.issn);
            return issnAppel && cibles.has(issnAppel);
        });
    });

    eleventyConfig.addFilter("echeancePrincipale", function (dates) {
        if (!dates) return null;
        return dates.find((d) => d.is_full_paper_submission_deadline) || null;
    });

    // Recherche de revue par nom de journal (fallback quand l'ISSN n'est pas encore sur l'appel)
    const trouverRevueParNom = (journals, journalName) => {
        if (!journals || !journalName) return null;
        const nom = journalName.trim().toLowerCase();
        for (const revue of Object.values(journals)) {
            if ((revue.titre || "").toLowerCase() === nom) return revue;
            if ((revue.titre_fnege || "").toLowerCase() === nom) return revue;
        }
        return null;
    };
    eleventyConfig.addFilter("revueParNom", trouverRevueParNom);

    // Jointure appel -> revue : par ISSN (clé directe de journals.json), avec repli sur le nom
    const trouverRevueDeLAppel = (journals, call) => {
        if (!journals || !call) return null;
        if (call.issn && journals[call.issn]) return journals[call.issn];
        return trouverRevueParNom(journals, call.journal);
    };
    eleventyConfig.addFilter("revueDeLAppel", trouverRevueDeLAppel);

    // --- kerostig : pages hub par discipline FNEGE ---------------------------
    // Ces deux filtres alimentent /discipline/:slug. La discipline d'un appel
    // n'est jamais lue dans ses tags (extraits par le modele, systeme distinct) :
    // elle vient de la revue, atteinte par ISSN, qui porte le code FNEGE.

    eleventyConfig.addFilter("disciplineDuCode", disciplineDuCode);

    // Ordre du classement, pas ordre alphabetique : "1*" precede "1", qui precede
    // "2". Un rang inconnu ferme la liste plutot que de la ouvrir.
    const ORDRE_RANG_FNEGE = ["1*", "1", "2", "3"];
    const positionRang = (rang) => {
        const i = ORDRE_RANG_FNEGE.indexOf(rang);
        return i === -1 ? ORDRE_RANG_FNEGE.length : i;
    };

    eleventyConfig.addFilter("revuesDeLaDiscipline", function (journals, code) {
        if (!journals || !code) return [];
        return Object.values(journals)
            .filter((revue) => revue.discipline_code === code)
            .sort((a, b) => {
                const ecart = positionRang(a.rang_fnege_2025) - positionRang(b.rang_fnege_2025);
                if (ecart !== 0) return ecart;
                // localeCompare fr : sans lui les titres accentues partiraient apres le Z.
                return (a.titre || "").localeCompare(b.titre || "", "fr", { sensitivity: "base" });
            });
    });

    eleventyConfig.addFilter("appelsDeLaDiscipline", function (allCalls, journals, code) {
        if (!allCalls || !journals || !code) return [];
        return allCalls
            .filter((call) => {
                if (!appelAffichable(call)) return false;
                const revue = trouverRevueDeLAppel(journals, call);
                return revue ? revue.discipline_code === code : false;
            })
            .sort((a, b) => {
                // Echeance la plus proche d'abord ; les appels sans date exploitable
                // ferment la liste au lieu de se disperser au hasard (NaN).
                const ta = Date.parse(echeanceSoumission(a.dates) || "");
                const tb = Date.parse(echeanceSoumission(b.dates) || "");
                const va = isNaN(ta) ? Infinity : ta;
                const vb = isNaN(tb) ? Infinity : tb;
                if (va === vb) return 0;
                return va - vb;
            });
    });
    // --- fin pages discipline -------------------------------------------------

    // Revues effectivement couvertes par un scraper actif (scrapers/journals/*.mjs).
    // Correspondance directe entre editeur et scraper : Elsevier, Wiley, SAGE,
    // Taylor & Francis, Emerald, Springer (3 libelles pour le meme editeur cote
    // OpenAlex), INFORMS, Academy of Management. Routledge (marque du groupe
    // Taylor & Francis) est inclus a part : le hub authorservices.taylorandfrancis.com
    // interroge par nom de revue, pas par editeur, donc les revues Routledge y sont
    // atteignables au meme titre que les revues Taylor & Francis (verifie manuellement :
    // 4 des 8 revues Routledge du perimetre y avaient un appel actif au moment du controle).
    const EDITEURS_COUVERTS = new Set([
        "Elsevier BV",
        "Wiley",
        "SAGE Publishing",
        "Taylor & Francis",
        "Routledge",
        "Emerald Publishing Limited",
        "Springer Science+Business Media",
        "Springer Nature",
        "Springer Nature (Netherlands)",
        "Institute for Operations Research and the Management Sciences",
        "Academy of Management",
    ]);

    // Revues francophones couvertes par un scraper dedie a la revue (pas a
    // l'editeur, cf ojsFrScraper.mjs / miScraper.mjs / rfgScraper.mjs /
    // riirScraper.mjs / gmpScraper.mjs / agrhScraper.mjs / afcScraper.mjs) :
    // M@n@gement, Management international et SIM n'ont pas d'editeur
    // renseigne dans journals.json, et Revue francaise de gestion est certes
    // la seule revue Lavoisier du perimetre actuel, mais son scraper cible
    // sa page precisement -- pas un hub Lavoisier. Ne pas ajouter "Lavoisier
    // publishing" a EDITEURS_COUVERTS, qui couvrirait a tort toute future
    // revue Lavoisier ajoutee au perimetre sans scraper dedie. Meme logique
    // pour Relations industrielles (editeur "Érudit") et GRH (editeur
    // "De Boeck") : le scraper cible leur site propre, pas un hub editeur.
    const ISSN_COUVERTS = new Set([
        "1286-4692", // M@n@gement
        "2271-7188", // Systèmes d'information & management
        "1918-9222", // Management international
        "1777-5663", // Revue française de gestion
        "1703-8138", // Relations industrielles
        "2116-8865", // Gestion et management public
        "2295-9149", // GRH (@GRH)
        "2313-514X", // Comptabilité - Contrôle - Audit
        "2261-5512", // Finance Contrôle Stratégie (ojsFrScraper, OpenEdition)
        "1918-9699", // Revue internationale P.M.E. (ojsFrScraper, OJS autonome)
        "2269-8469", // Décisions Marketing (dmScraper, site de l'AFM)
        "1630-7542", // Revue de l'Entrepreneuriat (reScraper, API WordPress de l'AEI)

        // Cambridge (cupScraper) : les 7 revues Cambridge du périmètre sont
        // couvertes, mais "Cambridge University Press" n'est volontairement pas
        // ajouté à EDITEURS_COUVERTS -- le scraper porte une liste de slugs en
        // dur (le slug CUP ne se déduit pas du nom FNEGE), donc une future revue
        // Cambridge ajoutée au périmètre serait comptée sans être scrapée.
        "1756-6916", // Journal of Financial and Quantitative Analysis
        "2153-3326", // Business Ethics Quarterly
        "2044-768X", // The Business History Review
        "1783-1350", // Astin Bulletin
        "1467-2235", // Enterprise & Society
        "1930-2975", // Judgment and Decision Making
        "1740-8784", // Management and Organization Review

        // Oxford (oupScraper) : 1 seule des 13 revues Oxford du périmètre.
        // academic.oup.com répond 403 sur toutes ses pages d'appels, y compris
        // en local, donc aucune revue qui y est hébergée n'est couverte -- ne pas
        // les recompter ici sans avoir rouvert une voie d'accès. Review of
        // Finance fait exception : ses appels sont publiés sur revfin.org, hors
        // academic.oup.com.
        "1573-692X", // Review of Finance (revfin.org, ex-European Finance Review)

        // American Accounting Association (aaaScraper) : les 6 revues AAA du
        // périmètre sont couvertes par le hub aaahq.org/Research/Calls-for-Submissions.
        // "American Accounting Association" n'est volontairement pas ajouté à
        // EDITEURS_COUVERTS -- le hub mélange les appels de toutes les revues AAA
        // (dont plusieurs hors périmètre) et le scraper filtre sur une liste de
        // 6 noms en dur, donc une future revue AAA ajoutée au périmètre serait
        // comptée sans être scrapée.
        "1558-7967", // The Accounting Review
        "1558-7975", // Accounting Horizons
        "1558-7991", // Auditing: A Journal of Practice & Theory
        "1558-8009", // Behavioral Research in Accounting
        "1558-8025", // Journal of International Accounting Research
        "1558-8033", // Journal of Management Accounting Research

        // American Psychological Association (apaScraper) : 4 des revues APA du
        // périmètre, chacune via sa page /pubs/journals/{slug}/calls-for-papers.
        // "American Psychological Association" n'est volontairement pas ajouté à
        // EDITEURS_COUVERTS -- le scraper porte une liste de slugs APA en dur (un
        // code à 3 lettres indéduisible du nom FNEGE), donc une future revue APA
        // ajoutée au périmètre serait comptée sans être scrapée.
        "1939-1854", // Journal of Applied Psychology
        "1939-1307", // Journal of Occupational Health Psychology
        "1939-1315", // Journal of Personality and Social Psychology
        "1930-7802", // Group Dynamics: Theory, Research and Practice
    ]);
    eleventyConfig.addFilter("revuesCouvertesParScraper", function (journals) {
        if (!journals) return [];
        return Object.values(journals).filter((revue) =>
            EDITEURS_COUVERTS.has((revue.editeur || "").trim()) || ISSN_COUVERTS.has((revue.issn_cle || "").trim())
        );
    });

    // Revues francophones identifiees manuellement (perimetre plus large que
    // ISSN_COUVERTS ci-dessus : inclut aussi les revues francophones sans
    // scraper dedie, ex. celles accessibles seulement via Cairn). Sert au
    // filtre "Revues francophones" de la barre laterale -- liste transmise
    // telle quelle au template pour un filtrage cote client (Alpine.js), cf
    // data-issn sur chaque carte d'appel dans call-card.html.
    const ISSN_REVUES_FRANCOPHONES = [
        "2313-514X", // Comptabilité - Contrôle - Audit
        "2269-8469", // Décisions Marketing
        "2101-0145", // Finance
        "2261-5512", // Finance Contrôle Stratégie
        "2406-4734", // Gestion 2000
        "2116-8865", // Gestion et management public
        "2295-9149", // GRH (@GRH)
        "1965-0256", // Innovations
        "1286-4692", // M@n@gement
        "1918-9222", // Management international
        "2271-2836", // Recherches en Sciences de Gestion
        "1703-8138", // Relations industrielles
        "2271-2186", // Revue de gestion des ressources humaines
        "1630-7542", // Revue de l'Entrepreneuriat
        "2105-3022", // Revue de l'organisation responsable
        "1777-5663", // Revue française de gestion
        "1918-9699", // Revue internationale P.M.E.
        "2271-7188", // Systèmes d'information & management
        "2051-2821", // Recherche et Applications en Marketing (RAM)
    ];
    eleventyConfig.addGlobalData("issnRevuesFrancophones", () => ISSN_REVUES_FRANCOPHONES);

    // Serialisation JSON pour injecter des donnees Eleventy dans un bloc
    // x-data Alpine.js cote client (ex. issnRevuesFrancophones ci-dessus).
    eleventyConfig.addFilter("json", function (value) {
        return JSON.stringify(value);
    });

    // --- Donnees structurees schema.org -------------------------------------
    // Les blocs JSON-LD sont assembles ici, en JavaScript, et non a coups de
    // virgules conditionnelles dans un gabarit : c'est ce montage manuel qui
    // produisait du JSON invalide des qu'un tableau etait vide ou qu'un texte
    // scrape contenait un guillemet.

    const AUDIENCE_KEROSTIG = "Sciences de gestion et management";

    const racine = (meta) => (meta && meta.url ? String(meta.url) : "").replace(/\/+$/, "");

    // Serialisation pour un bloc <script type="application/ld+json">.
    // JSON.stringify echappe le contenu ; on neutralise ensuite < > & pour
    // qu'aucune chaine scrapee ne puisse fermer le script, et pour que
    // l'auto-echappement de Nunjucks n'ait plus rien a transformer (les
    // gabarits appliquent | safe apres ce filtre).
    eleventyConfig.addFilter("jsonld", function (value) {
        return JSON.stringify(value ?? "", null, 2)
            .replace(/</g, "\\u003c")
            .replace(/>/g, "\\u003e")
            .replace(/&/g, "\\u0026");
    });

    // Graphe d'une fiche appel : fil d'Ariane + l'appel + une entree par echeance.
    eleventyConfig.addFilter("schemaAppel", function (call, revue, meta) {
        if (!call) return {};
        const base = racine(meta);
        const urlAppel = `${base}/call/${call.slug}/`;
        const titre = call.title || call.metaTitle || "";
        const nomRevue = (revue && revue.titre) || call.journal || "";
        const dates = (Array.isArray(call.dates) ? call.dates : []).filter((d) => d && d.date);

        // Le niveau revue n'est pose que si la fiche revue existe vraiment :
        // le slug vient de journals.json, jamais du nom de revue scrape.
        const fil = [{ "@type": "ListItem", position: 1, name: (meta && meta.name) || "", item: `${base}/` }];
        if (revue && revue.slug) {
            fil.push({ "@type": "ListItem", position: fil.length + 1, name: nomRevue, item: `${base}/journal/${revue.slug}/` });
        }
        fil.push({ "@type": "ListItem", position: fil.length + 1, name: titre, item: urlAppel });

        const evenements = dates.map((d, i) => ({
            "@type": "Event",
            "@id": `${urlAppel}#event${i + 1}`,
            name: d.description || "Échéance",
            startDate: d.date,
            eventAttendanceMode: "https://schema.org/OnlineEventAttendanceMode",
            eventStatus: "https://schema.org/EventScheduled",
            about: { "@id": `${urlAppel}#cfp` },
        }));

        const appel = {
            "@type": "CreativeWork",
            "@id": `${urlAppel}#cfp`,
            mainEntityOfPage: urlAppel,
            name: `Appel à publications : ${titre}`,
            headline: titre,
            url: urlAppel,
            // Le texte de l'appel (titre, description, sujets) est repris tel
            // quel de l'editeur, donc en anglais, meme si la page est en francais.
            inLanguage: "en",
            isAccessibleForFree: true,
            audience: { "@type": "Audience", audienceType: AUDIENCE_KEROSTIG },
        };

        const resume = call.description && call.description.paragraphs && call.description.paragraphs[0];
        if (resume) appel.description = resume;
        if (call.url) appel.sameAs = call.url;
        if (nomRevue) appel.alternateName = `Numéro spécial - ${nomRevue}`;
        if (Array.isArray(call.tags) && call.tags.length) appel.keywords = call.tags;
        // Champs reels de calls.json : pubDate (camelCase) et le tableau dates.
        if (call.pubDate) {
            appel.datePublished = call.pubDate;
            appel.dateModified = call.pubDate;
        }
        const echeance = echeanceSoumission(dates);
        if (echeance) appel.expires = echeance;
        if (nomRevue) {
            appel.publisher = { "@type": "Organization", name: nomRevue };
            appel.isPartOf = revue && revue.slug
                ? { "@id": `${base}/journal/${revue.slug}/#periodical` }
                : { "@type": "Periodical", name: nomRevue };
        }
        const editeurs = (call.editors || []).filter((e) => e && e.name);
        if (editeurs.length) {
            appel.editor = editeurs.map((e) => ({ "@type": "Person", name: e.name }));
        }
        if (call.url) {
            appel.potentialAction = {
                "@type": "ApplyAction",
                name: "Soumettre un manuscrit",
                target: {
                    "@type": "EntryPoint",
                    urlTemplate: call.url,
                    actionPlatform: [
                        "https://schema.org/DesktopWebPlatform",
                        "https://schema.org/MobileWebPlatform",
                    ],
                },
            };
        }
        if (evenements.length) appel.subjectOf = evenements.map((e) => ({ "@id": e["@id"] }));

        return {
            "@context": "https://schema.org",
            "@graph": [{ "@type": "BreadcrumbList", itemListElement: fil }, appel, ...evenements],
        };
    });

    // Graphe d'une fiche revue : fil d'Ariane + la revue en Periodical de plein droit.
    eleventyConfig.addFilter("schemaRevue", function (revue, meta) {
        if (!revue) return {};
        const base = racine(meta);
        const urlRevue = `${base}/journal/${revue.slug}/`;

        // Nom propre de la discipline, a preferer partout au champ revue.discipline,
        // libelle brut de journals.json parfois ampute de son apostrophe
        // ("Systemes d information"). Repli sur le brut si le code est inconnu.
        const disc = disciplineDuCode(revue.discipline_code);
        const nomDiscipline = disc ? disc.nom : revue.discipline;

        const periodique = {
            "@type": "Periodical",
            "@id": `${urlRevue}#periodical`,
            name: revue.titre,
            url: urlRevue,
        };
        const issns = [revue.pissn, revue.eissn].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
        if (issns.length) periodique.issn = issns;
        if (revue.editeur) periodique.publisher = { "@type": "Organization", name: revue.editeur };
        if (nomDiscipline) periodique.genre = nomDiscipline;
        if (revue.metriques && Array.isArray(revue.metriques.thematiques) && revue.metriques.thematiques.length) {
            periodique.about = revue.metriques.thematiques.map((t) => ({ "@type": "Thing", name: t }));
        }

        // Le niveau discipline n'est pose que si le code FNEGE de la revue
        // correspond a une page /discipline/ reellement generee.
        const fil = [{ "@type": "ListItem", position: 1, name: (meta && meta.name) || "", item: `${base}/` }];
        if (disc) {
            fil.push({ "@type": "ListItem", position: fil.length + 1, name: disc.nom, item: `${base}/discipline/${disc.slug}/` });
        }
        fil.push({ "@type": "ListItem", position: fil.length + 1, name: revue.titre, item: urlRevue });

        return {
            "@context": "https://schema.org",
            "@graph": [{ "@type": "BreadcrumbList", itemListElement: fil }, periodique],
        };
    });

    // Fil d'Ariane d'une page hub discipline : Accueil > Discipline.
    eleventyConfig.addFilter("schemaDiscipline", function (discipline, meta) {
        if (!discipline) return {};
        const base = racine(meta);
        const fil = [
            { "@type": "ListItem", position: 1, name: (meta && meta.name) || "", item: `${base}/` },
            { "@type": "ListItem", position: 2, name: discipline.nom, item: `${base}/discipline/${discipline.slug}/` },
        ];
        return {
            "@context": "https://schema.org",
            "@graph": [{ "@type": "BreadcrumbList", itemListElement: fil }],
        };
    });
    // --- fin donnees structurees ---------------------------------------------

    // Compteur d'appels actifs
    eleventyConfig.addFilter("compterAppelsActifs", function (calls) {
        if (!calls) return 0;
        return calls.filter(appelAffichable).length;
    });
    // --- fin kerostig ---

    eleventyConfig.addFilter("urlEncode", function (str) {
        return encodeURIComponent(str);
    });

    eleventyConfig.addFilter("relativeTime", function (timestamp) {
        const dateTime = DateTime.fromISO(timestamp);
        return dateTime.toRelative();
    });

    eleventyConfig.addFilter("addDay", function (timestamp) {
        const dateTime = DateTime.fromISO(timestamp);
        return dateTime.plus({ days: 1 }).toISODate();
    });

    eleventyConfig.addFilter("dateOnly", function (timestamp) {
        const dateTime = DateTime.fromISO(timestamp);
        return dateTime.setLocale('fr').toLocaleString(DateTime.DATE_FULL);
    });

    // toISODate() rend null des que la chaine n'est pas analysable. Les dates
    // viennent de l'extraction par le modele : une seule valeur aberrante ("TBD",
    // "2026-13-01", un mois ecrit en lettres) ne doit pas faire tomber tout le
    // build sur une TypeError. Ces deux filtres rendent donc null, ce que Nunjucks
    // ecrit comme une chaine vide : le lien d'agenda est vide, la page passe.
    eleventyConfig.addFilter("googleCalendarDate", function (timestamp) {
        const jour = DateTime.fromISO(timestamp).toISODate();
        return jour ? jour.replace(/-/g, '') : null;
    });

    eleventyConfig.addFilter("outlookCalendarDate", function (timestamp) {
        // Outlook expects the date in 2016-02-29T19:00:00 format
        const jour = DateTime.fromISO(timestamp).toISODate();
        return jour ? jour + 'T00:00:00' : null;
    });

    eleventyConfig.addFilter("isInPast", function (timestamp) {
        const dateTime = DateTime.fromISO(timestamp);
        const today = DateTime.now();
        return dateTime < today;
    });

    eleventyConfig.addFilter("isActiveCall", function (calls) {
        return calls.filter(appelAffichable);
    });

    // Un appel clos garde sa page (call-pages.njk pagine sur tous les appels,
    // les URLs restent valides), mais elle porte un bandeau d'archive.
    eleventyConfig.addFilter("estAppelCloture", function (call) {
        if (!call) return false;
        return !appelAffichable(call);
    });

    eleventyConfig.addShortcode("currentYear", () => `${new Date().getFullYear()}`);

    eleventyConfig.addPassthroughCopy('www/rss.xml');
    eleventyConfig.addPassthroughCopy('www/journal/*.xml');
    eleventyConfig.addPassthroughCopy('www/tag/*.xml');
    eleventyConfig.addPassthroughCopy('www/public/favicon');
    eleventyConfig.addPassthroughCopy({
        './node_modules/alpinejs/dist/cdn.min.js': './public/js/alpine.min.js',
    });
}

export const config = {
    htmlTemplateEngine: "njk",
    dir: {
        input: "www",
        includes: "_includes",
        data: "_data",
        output: "public"
    },
}