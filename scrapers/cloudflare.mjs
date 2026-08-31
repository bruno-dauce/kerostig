// Plusieurs editeurs (Emerald, Taylor & Francis, SAGE) servent un challenge
// Cloudflare avant le vrai contenu. On attend qu'il se resolve plutot que de
// se fier a domcontentloaded, qui se declenche deja sur l'interstitiel.

const DELAI_CHALLENGE_MS = 30000;

// Vrai quand le document n'est PLUS l'interstitiel Cloudflare.
//
// Cette fonction s'execute DANS la page : Playwright la serialise par
// toString, elle doit donc rester autonome (aucune reference au reste du
// module). Le parametre doc n'existe que pour les tests -- appelee depuis la
// page, elle lit le vrai document.
//
// Deux criteres ont ete essayes et mesures le 2026-08-31, tous deux faux :
//
//  - le TITRE ("Just a moment..."), critere d'origine : Cloudflare traduit
//    son interstitiel selon la locale du navigateur. Sur un poste en fr-FR la
//    page s'intitule « Un instant… », le test ne voit rien et le challenge est
//    declare resolu en 55 ms sur une page qui n'a que 27 Ko et aucun contenu.
//    Le piege ne mord qu'en local, le runner CI etant en en-US -- c'est
//    pourquoi il a survecu si longtemps.
//
//  - window._cf_chl_opt, l'objet que pose l'interstitiel : il reste defini sur
//    la vraie page une fois le challenge franchi, pose cette fois par le
//    script de bot-management. Mesure sur une page SAGE chargee, complete et
//    exploitable : _cf_chl_opt toujours vrai. Faux negatif garanti.
//
// Ce qui distingue reellement les deux etats se lit dans le DOM :
//  - l'interstitiel SERVI porte la declaration inline de _cf_chl_opt (chaine
//    absente du HTML d'une page reelle, ou l'objet n'apparait qu'a
//    l'execution) ;
//  - une fois son script execute, il porte aussi un <script src> vers
//    /cdn-cgi/challenge-platform/.../chl_page/. Le script laisse sur une page
//    franchie pointe, lui, vers .../scripts/precursor/main.js : le segment
//    chl_page est le discriminant.
// Les deux sont testes, l'interstitiel etant reconnaissable avant comme apres
// execution de son script.
export function estHorsInterstitiel(doc = document) {
    if (doc.querySelector('script[src*="chl_page"]')) return false;
    if (doc.querySelector('#challenge-form, #challenge-running, #challenge-stage, #cf-challenge-running')) return false;
    for (const script of doc.querySelectorAll('script:not([src])')) {
        if ((script.textContent ?? '').includes('_cf_chl_opt')) return false;
    }
    return true;
}

// Rend true quand la page est prete a etre lue, false quand l'attente a
// expire (l'appelant reste libre de continuer : une page partielle vaut
// parfois mieux que rien).
//
// selecteurContenu est le critere FIABLE : attendre l'element qu'on veut lire
// tranche sans rien supposer de l'infrastructure d'en face. A privilegier
// partout ou l'appelant sait ce qu'il attend. Sans lui, on retombe sur la
// detection d'interstitiel ci-dessus, qui reste correcte mais ne dit rien de
// ce que la page contient.
export async function waitForCloudflare(page, logPrefix, selecteurContenu) {
    try {
        if (selecteurContenu) {
            // state: 'attached' et non le defaut 'visible' : on attend un
            // element a LIRE, pas a cliquer. Mesure sur une page revue SAGE :
            // les 9 encarts d'appels sont bien dans le DOM mais le premier est
            // masque (variante responsive), et l'attente par defaut expire au
            // bout de 30 s sur une page pourtant complete -- 63 resolutions du
            // locator a 9 elements, aucune jugee visible.
            await page.waitForSelector(selecteurContenu, { state: 'attached', timeout: DELAI_CHALLENGE_MS });
        } else {
            // Le delai va en TROISIEME argument. Passe en deuxieme, Playwright
            // le prend pour l'argument de la fonction evaluee et applique son
            // propre delai par defaut -- ce que faisait la version precedente,
            // sans consequence tant que les deux valaient 30 s.
            await page.waitForFunction(estHorsInterstitiel, undefined, { timeout: DELAI_CHALLENGE_MS });
        }
        return true;
    } catch (error) {
        const attendu = selecteurContenu ? `« ${selecteurContenu} »` : 'la fin de l\'interstitiel';
        console.warn(`${logPrefix} Challenge Cloudflare : ${attendu} toujours absent apres ${DELAI_CHALLENGE_MS / 1000} s : ${error.message}`);
        return false;
    }
}
