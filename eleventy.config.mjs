import { DateTime } from "luxon";

export default async function (eleventyConfig) {
    // --- hubecall : jointure appels <-> revue par ISSN ---
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
    // --- fin hubecall ---
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
        return dateTime.setLocale('en-us').toLocaleString(DateTime.DATE_FULL);
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