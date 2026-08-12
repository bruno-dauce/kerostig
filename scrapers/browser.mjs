import { chromium } from 'patchright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Profil persistant (pas un dossier temporaire) : les cookies obtenus en
// resolvant un challenge Cloudflare (cf_clearance) survivent d'une execution
// a l'autre. Un profil recree a chaque run se presente a Cloudflare comme un
// visiteur jamais vu et se fait systematiquement re-challenger.
const PROFILE_DIR = path.join(__dirname, '..', '.browser-profile');

export async function startBrowser() {
    const userDir = path.join(PROFILE_DIR, 'userdir');
    fs.mkdirSync(path.join(userDir, 'Default'), { recursive: true });

    const preferencesPath = path.join(userDir, 'Default', 'Preferences');
    if (!fs.existsSync(preferencesPath)) {
        const defaultPreferences = {
            plugins: {
                always_open_pdf_externally: true,
            },
        }
        fs.writeFileSync(preferencesPath, JSON.stringify(defaultPreferences));
    }

    const browser = await chromium.launchPersistentContext(userDir, {
        channel: "chrome",
        headless: false,
        viewport: null,
        acceptDownloads: true,
        // agrh.fr (Squarespace) sert un certificat par defaut (*.squarespace.com)
        // au lieu d'un certificat couvrant le domaine personnalise -- erreur cote
        // hebergeur (confirme via openssl : meme certificat errone sur www et
        // non-www), pas un probleme d'URL. ignoreHTTPSErrors est une option de
        // contexte, non surchargeable par page/navigation ; comme toutes les
        // pages de tous les scrapers partagent ce contexte persistant unique,
        // impossible de la limiter au seul scraper agrh sans lui dedier un
        // contexte a part.
        ignoreHTTPSErrors: true,
    });
    return browser;
}
