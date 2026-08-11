import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// curl standard expose son propre fingerprint TLS (ClientHello OpenSSL sous
// Linux, Schannel sous Windows) -- distinct de celui d'un vrai navigateur.
// Cloudflare le distingue et bloque specifiquement le fingerprint OpenSSL :
// constate sur GitHub Actions (Linux, 403 sur le hub SAGE) alors que la meme
// requete passe en local sous Windows (Schannel). curl-impersonate
// (https://github.com/lwthiker/curl-impersonate) est un fork de curl qui
// rejoue le ClientHello exact de Chrome/Firefox -- installe sur le runner
// CI (cf .github/workflows/scrape.yml) mais absent en local. On l'utilise
// donc en priorite quand il est present sur le systeme, et on retombe sur
// curl standard sinon, pour ne pas casser le fonctionnement local existant.
//
// Le nom du binaire est suffixe par version de navigateur (curl_chrome116,
// curl_ff117, ...) -- il n'existe pas d'alias generique "curl_chrome" dans
// la derniere release (v0.6.1) du projet. On essaie une liste de candidats,
// du plus recent au plus ancien.
const IMPERSONATION_CANDIDATES = ['curl_chrome116', 'curl_chrome110', 'curl_chrome107', 'curl_chrome104', 'curl_ff117'];

let resolvedBinaryPromise = null;
let loggedBinary = false;

async function isExecutable(binary) {
    try {
        await execFileAsync(binary, ['--version']);
        return true;
    } catch {
        return false;
    }
}

async function resolveCurlBinary() {
    for (const candidate of IMPERSONATION_CANDIDATES) {
        if (await isExecutable(candidate)) return candidate;
    }
    return 'curl';
}

// GET avec cookie jar fichier (gere les redirections qui posent un cookie
// de session avant de servir le vrai contenu, cf commentaires des
// scrapers appelants) et statut HTTP recupere via -w.
//
// userAgent n'est applique que sur le repli curl standard : les wrapper
// curl-impersonate fixent deja un User-Agent coherent avec le ClientHello
// TLS qu'ils rejouent (meme version de Chrome/Firefox) -- le remplacer
// casserait cette coherence sans apporter de bénéfice contre le
// fingerprinting.
export async function curlGet(url, { cookieJarPath, userAgent }) {
    if (!resolvedBinaryPromise) resolvedBinaryPromise = resolveCurlBinary();
    const binary = await resolvedBinaryPromise;

    if (!loggedBinary) {
        loggedBinary = true;
        console.log(binary === 'curl'
            ? `[curl] curl-impersonate non trouve sur ce systeme, repli sur curl standard`
            : `[curl] Utilisation de ${binary} (curl-impersonate)`);
    }

    const args = ['-s', '-L', '-c', cookieJarPath, '-b', cookieJarPath];
    if (binary === 'curl' && userAgent) {
        args.push('-A', userAgent);
    }

    const marker = '\n__HTTP_STATUS__:';
    const { stdout } = await execFileAsync(binary, [
        ...args,
        '-w', `${marker}%{http_code}`,
        url,
    ], { maxBuffer: 20 * 1024 * 1024 });

    const markerIndex = stdout.lastIndexOf(marker);
    const body = stdout.slice(0, markerIndex);
    const status = parseInt(stdout.slice(markerIndex + marker.length).trim(), 10);
    return { status, body };
}
