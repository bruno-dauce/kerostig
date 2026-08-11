import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { integrateCalls } from './diffChecker.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --only <nom> : ne lance que le(s) scraper(s) dont le nom de fichier
// contient <nom> (ex. --only elsevier -> elsevierScraper.mjs). Absent :
// tous les scrapers tournent, comme avant.
function getOnlyFilter() {
    const args = process.argv.slice(2);
    const index = args.indexOf('--only');
    if (index === -1 || !args[index + 1]) return null;
    return args[index + 1].toLowerCase();
}

export async function scrapeAll(browserInstance) {
    let browser;
    try {
        browser = await browserInstance;
        const folderPath = path.join(__dirname, 'journals');
        const only = getOnlyFilter();

        let files = (await fs.readdir(folderPath)).filter(file => path.extname(file) === '.mjs');
        if (only) {
            files = files.filter(file => file.toLowerCase().includes(only));
            console.log(`--only ${only} : ${files.length} scraper(s) selectionne(s) (${files.join(', ') || 'aucun'})`);
        }

        const modules = await Promise.all(
            files.map(file => import(pathToFileURL(path.join(folderPath, file))))
        );
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

        await integrateCalls(issues, ranAbbreviations);
    }
    catch (err) {
        console.log("Could not resolve the browser instance => ", err);
    }
    finally {
        if (browser) await browser.close()
    }
}
