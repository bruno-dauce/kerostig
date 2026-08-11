// Plusieurs editeurs (Emerald, Taylor & Francis) servent un challenge
// Cloudflare ("Just a moment...") avant le vrai contenu. On attend qu'il se
// resolve (changement de titre) plutot que de se fier a domcontentloaded,
// qui se declenche deja sur la page d'interstitiel.
export async function waitForCloudflare(page, logPrefix) {
    try {
        await page.waitForFunction(
            () => !document.title.includes('Just a moment'),
            { timeout: 30000 }
        );
    } catch (error) {
        console.warn(`${logPrefix} Le challenge Cloudflare ne semble pas resolu apres 30s : ${error.message}`);
    }
}
