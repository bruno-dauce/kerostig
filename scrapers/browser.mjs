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
        // Sous Linux, Chrome chiffre les valeurs de cookies avec la cle du
        // trousseau de session (gnome-keyring, kwallet) quand il en trouve
        // un, et avec une cle de repli fixe sinon. Un jar ecrit avec la cle
        // d'un trousseau est illisible au run suivant, qui a un autre
        // trousseau : le cache du profil (cf .github/workflows/scrape.yml)
        // restaurerait des cf_clearance indechiffrables. On force donc le
        // mode de repli, seul deterministe d'un run a l'autre. Sans effet
        // sous Windows et macOS, qui utilisent DPAPI/Keychain et ignorent
        // ce commutateur -- verifie en local, Emerald charge a l'identique.
        args: ['--password-store=basic'],
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
