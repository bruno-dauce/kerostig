import { DateTime } from "luxon";

export default async function (eleventyConfig) {

    // --- kerostig : jointure appels <-> revue par ISSN ---
    eleventyConfig.addFilter("appelsDeLaRevue", function (allCalls, revue) {
        if (!allCalls || !revue) return [];
        const norm = (v) => (v || "").toString().replace(/[^0-9Xx]/g, "").toUpperCase();
        const cibles = new Set([norm(revue.eissn), norm(revue.pissn), norm(revue.issn_cle)].filter(Boolean));
        return allCalls.filter((call) => {
            const actif = call.active || (!call.active && Date.now() < new Date(call.gracePeriod));
            if (!actif) return false;
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
    eleventyConfig.addFilter("revueDeLAppel", function (journals, call) {
        if (!journals || !call) return null;
        if (call.issn && journals[call.issn]) return journals[call.issn];
        return trouverRevueParNom(journals, call.journal);
    });

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

    // Echeance de soumission du manuscrit complet, a defaut la derniere date connue.
    const echeanceSoumission = (dates) => {
        if (!Array.isArray(dates) || !dates.length) return null;
        const principale = dates.find((d) => d.is_full_paper_submission_deadline);
        return (principale || dates[dates.length - 1]).date || null;
    };

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

        const periodique = {
            "@type": "Periodical",
            "@id": `${urlRevue}#periodical`,
            name: revue.titre,
            url: urlRevue,
        };
        const issns = [revue.pissn, revue.eissn].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
        if (issns.length) periodique.issn = issns;
        if (revue.editeur) periodique.publisher = { "@type": "Organization", name: revue.editeur };
        if (revue.discipline) periodique.genre = revue.discipline;
        if (revue.metriques && Array.isArray(revue.metriques.thematiques) && revue.metriques.thematiques.length) {
            periodique.about = revue.metriques.thematiques.map((t) => ({ "@type": "Thing", name: t }));
        }

        // Deux niveaux seulement : les pages /discipline/ n'existent pas encore,
        // on ne pose pas de lien vers une route absente.
        const fil = [
            { "@type": "ListItem", position: 1, name: (meta && meta.name) || "", item: `${base}/` },
            { "@type": "ListItem", position: 2, name: revue.titre, item: urlRevue },
        ];

        return {
            "@context": "https://schema.org",
            "@graph": [{ "@type": "BreadcrumbList", itemListElement: fil }, periodique],
        };
    });
    // --- fin donnees structurees ---------------------------------------------

    // Compteur d'appels actifs
    eleventyConfig.addFilter("compterAppelsActifs", function (calls) {
        if (!calls) return 0;
        return calls.filter(c => c.active || (!c.active && Date.now() < new Date(c.gracePeriod))).length;
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

    eleventyConfig.addFilter("googleCalendarDate", function (timestamp) {
        const dateTime = DateTime.fromISO(timestamp);
        return dateTime.toISODate().replace(/-/g, '');
    });

    eleventyConfig.addFilter("outlookCalendarDate", function (timestamp) {
        const dateTime = DateTime.fromISO(timestamp);
        // Outlook expects the date in 2016-02-29T19:00:00 format
        return dateTime.toISODate() + 'T00:00:00';
    });

    eleventyConfig.addFilter("isInPast", function (timestamp) {
        const dateTime = DateTime.fromISO(timestamp);
        const today = DateTime.now();
        return dateTime < today;
    });

    eleventyConfig.addFilter("isActiveCall", function (calls) {
        return calls.filter(call => call.active || (!call.active && Date.now() < new Date(call.gracePeriod)));
    });

    eleventyConfig.addShortcode("currentYear", () => `${new Date().getFullYear()}`);

    eleventyConfig.addPassthroughCopy('www/llms.txt');
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