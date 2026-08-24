import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { integrateCalls } from './diffChecker.mjs';
import { depasseSeuilEchec, formaterResumeAlertes, publierResumeCI } from './alerteCI.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --only <noms> : ne lance que le(s) scraper(s) dont le nom de fichier
// contient l'un des <noms> (ex. --only elsevier -> elsevierScraper.mjs).
// Absent : tous les scrapers tournent, comme avant.
//
// La liste separee par des virgules sert a rejouer d'un coup un lot
// d'editeurs qu'on instruit ensemble -- les quatre bloques en CI, par
// exemple : --only emerald,sage,wiley,informs. Aucune sous-chaine unique
// ne les couvre, et quatre passages successifs relisent et reecrivent
// calls.json quatre fois.
// Fonction pure, exportee pour test.
export function analyserFiltreOnly(valeur) {
    if (!valeur) return null;
    const termes = valeur
        .toLowerCase()
        .split(',')
        .map(terme => terme.trim())
        .filter(terme => terme.length > 0);
    return termes.length > 0 ? termes : null;
}

// Fonction pure, exportee pour test.
export function filtrerParOnly(fichiers, termes) {
    return fichiers.filter(fichier =>
        termes.some(terme => fichier.toLowerCase().includes(terme))
    );
}

function getOnlyFilter() {
    const args = process.argv.slice(2);
    const index = args.indexOf('--only');
    if (index === -1) return null;
    return analyserFiltreOnly(args[index + 1]);
}

// Le repertoire journals/ est balaye pour y trouver les scrapers, mais tout
// ce qui s'y trouve n'en est pas un : un fichier de test voisin y a ete
// charge comme un scraper le 23 aout 2026, faisant tomber le run entier.
// Fonction pure, exportee pour test.
export function estFichierScraper(nom) {
    return path.extname(nom) === '.mjs' && !nom.endsWith('.test.mjs');
}

// Second garde-fou, independant du nom du fichier : un module qui n'expose
// pas de scraperObject exploitable est ecarte avec un avertissement qui le
// nomme, au lieu de lever un TypeError. Le try/catch de scrapeAll avalait
// cette erreur et sautait integrateCalls : un seul fichier mal forme suffisait
// a priver de collecte les vingt et un scrapers valides.
// Fonction pure, exportee pour test.
export function retenirModulesValides(charges) {
    return charges.filter(({ fichier, module }) => {
        if (module?.scraperObject?.abbreviation) return true;
        console.warn(`[pageController] ${fichier} ignore : aucun export scraperObject exploitable`);
        return false;
    });
}

export async function scrapeAll(browserInstance) {
    let browser;
    try {
        browser = await browserInstance;
        const folderPath = path.join(__dirname, 'journals');
        const only = getOnlyFilter();

        let files = (await fs.readdir(folderPath)).filter(estFichierScraper);
        if (only) {
            files = filtrerParOnly(files, only);
            console.log(`--only ${only.join(',')} : ${files.length} scraper(s) selectionne(s) (${files.join(', ') || 'aucun'})`);
        }

        const charges = await Promise.all(
            files.map(async file => ({
                fichier: file,
                module: await import(pathToFileURL(path.join(folderPath, file))),
            }))
        );
        const modules = retenirModulesValides(charges).map(({ module }) => module);
        const ranAbbreviations = modules.map(module => module.scraperObject.abbreviation);

        const issues = await Promise.all(
            modules.map(async module => {
                const calls = await module.scraperObject.scraper(browser);
                console.log(`Found ${calls.length} calls at ${module.scraperObject.url}`);
                return calls;
            })
        )
        .then(results => results.flat())
        .then(results => results.filter(call => call && call.rawContent));

        const alertes = await integrateCalls(issues, ranAbbreviations);

        await publierResumeCI(formaterResumeAlertes(alertes, ranAbbreviations.length));
        if (depasseSeuilEchec(alertes.length, ranAbbreviations.length)) {
            console.error(`\n[pageController] ${alertes.length} scraper(s) en alerte sur ${ranAbbreviations.length} : passage traite comme une panne.`);
            process.exitCode = 1;
        }
    }
    catch (err) {
        console.log("Could not resolve the browser instance => ", err);
        // Sans cette ligne, le passage du 23 aout 2026 a conclu en success
        // alors qu'il n'avait rien collecte du tout : l'exception etait
        // avalee ici et integrateCalls n'avait jamais tourne. Un plantage
        // avant la collecte ne produit aucune alerte, donc le seuil
        // ci-dessus ne peut pas le rattraper.
        process.exitCode = 1;
    }
    finally {
        if (browser) await browser.close()
    }
}
