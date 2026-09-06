import { startBrowser } from './browser.mjs';
import { scrapeAll } from './pageController.mjs';
import { genererCorrespondance } from './genererCorrespondance.mjs';

// La table de correspondance ISSN n'est plus versionnee : on la derive de
// www/_data/journals.json avant toute collecte. C'est ici et pas dans un hook
// npm "prescrape" parce que le workflow CI appelle ce fichier directement
// (node ./scrapers/scraper.mjs), sans passer par npm : un hook ne se
// declencherait jamais sur le runner.
//
// La generation precede l'ouverture du navigateur : si journals.json manque ou
// est illisible, on echoue tout de suite, sans avoir lance Chromium.
await genererCorrespondance();

//Start the browser and create a browser instance
let browserInstance = startBrowser();

// Pass the browser instance to the scraper controller
scrapeAll(browserInstance)
