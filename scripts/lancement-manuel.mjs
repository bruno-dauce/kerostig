// Lancement manuel des editeurs bloques en CI (Wiley, SAGE, Emerald, INFORMS), depuis
// le poste local ou le navigateur franchit Cloudflare. Voir README.md.
//
//   npm.cmd run manuel
//   npm.cmd run manuel -- --reverifier-wiley
//
// Etapes : verifications, git pull, scraping des quatre editeurs, flux RSS,
// bilan des appels desactives par editeur, commit, puis push -- apres
// confirmation si plus de 5 appels ont ete desactives ou si une etape a
// echoue. Les options supplementaires sont transmises au scraper.

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import readline from 'readline/promises';
import { fileURLToPath } from 'url';
import { bilanDesactivations, formaterBilanDesactivations, doitConfirmer, SEUIL_CONFIRMATION } from '../scrapers/bilanDesactivations.mjs';

const EDITEURS = 'wiley,sage,emerald,informs';
const OPTIONS_CONNUES = ['--reverifier-wiley'];
const CALLS_PATH = path.join('www', '_data', 'calls.json');

process.chdir(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));

function executer(commande, args, { capturer = false } = {}) {
    const resultat = spawnSync(commande, args, { stdio: capturer ? ['inherit', 'pipe', 'inherit'] : 'inherit', encoding: 'utf8' });
    if (resultat.error) throw resultat.error;
    return { code: resultat.status ?? 1, sortie: (resultat.stdout ?? '').trim() };
}

function arreter(message) {
    console.error(`\n[manuel] ARRET : ${message}`);
    process.exit(1);
}

function lireAppels() {
    return JSON.parse(fs.readFileSync(CALLS_PATH, 'utf8'));
}

async function demander(question) {
    if (!process.stdin.isTTY) return false;
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
        const reponse = await rl.question(question);
        return /^o(ui)?$/i.test(reponse.trim());
    } finally {
        rl.close();
    }
}

const optionsScraper = process.argv.slice(2);
const inconnues = optionsScraper.filter(option => !OPTIONS_CONNUES.includes(option));
if (inconnues.length) arreter(`option(s) inconnue(s) : ${inconnues.join(' ')}. Options acceptees : ${OPTIONS_CONNUES.join(', ')}`);

// 1. Etat du depot : sur main, sans modification en cours. Le commit final
// fait un git add -A ; un depot propre au depart garantit qu'il n'embarque
// que ce que le passage a produit.
const branche = executer('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { capturer: true }).sortie;
if (branche !== 'main') arreter(`branche courante « ${branche} », attendu « main ».`);
const modifications = executer('git', ['status', '--porcelain'], { capturer: true }).sortie;
if (modifications) arreter(`le depot a des modifications en cours, a committer ou ranger d'abord :\n${modifications}`);

// 2. Recuperer le passage hebdomadaire de la CI. --ff-only : jamais de fusion
// silencieuse sur calls.json.
console.log('\n[manuel] git pull');
if (executer('git', ['pull', '--ff-only', 'origin', 'main']).code !== 0) {
    arreter('git pull a echoue (historiques divergents ?). A regler a la main avant de relancer.');
}

// 3. Scraping.
const avant = lireAppels();
console.log(`\n[manuel] Scraping : ${EDITEURS}${optionsScraper.length ? ' ' + optionsScraper.join(' ') : ''}`);
const scraping = executer(process.execPath, ['--env-file', '.env', './scrapers/scraper.mjs', '--only', EDITEURS, ...optionsScraper]);
if (scraping.code !== 0) console.warn(`\n[manuel] Le scraping s'est termine en erreur (code ${scraping.code}). Les donnees produites sont conservees ; le push demandera confirmation.`);

// 4. Flux RSS.
console.log('\n[manuel] Flux RSS');
const rss = executer(process.execPath, ['./scrapers/feedgen.mjs']);
if (rss.code !== 0) console.warn(`\n[manuel] La generation des flux RSS a echoue (code ${rss.code}).`);

// 5. Bilan des desactivations.
const bilan = bilanDesactivations(avant, lireAppels());
console.log('\n' + formaterBilanDesactivations(bilan));

// 6. Commit.
executer('git', ['add', '-A']);
if (executer('git', ['diff', '--cached', '--quiet']).code === 0) {
    console.log('\n[manuel] Rien a committer : aucun changement produit par ce passage.');
    process.exit(0);
}
const horodatage = new Date().toISOString().replace('T', ' ').slice(0, 16);
if (executer('git', ['commit', '-q', '-m', `[MANUEL]: ${horodatage} UTC (${EDITEURS})`]).code !== 0) arreter('git commit a echoue.');
console.log(`\n[manuel] Commit cree : ${executer('git', ['log', '--oneline', '-1'], { capturer: true }).sortie}`);

// 7. Push, apres confirmation si le passage est suspect.
const codeSortie = scraping.code || rss.code;
if (doitConfirmer({ total: bilan.total, codeSortie })) {
    const motif = bilan.total > SEUIL_CONFIRMATION
        ? `${bilan.total} appels desactives (seuil : ${SEUIL_CONFIRMATION})`
        : 'une etape a echoue';
    const ok = await demander(`\n[manuel] Confirmation requise : ${motif}. Pousser quand meme ? (o/N) `);
    if (!ok) {
        console.log('\n[manuel] Push annule. Le commit reste local.');
        console.log('[manuel] Pour l\'annuler en gardant les fichiers modifies : git reset --soft HEAD~1');
        console.log('[manuel] Pour pousser plus tard : git push origin main');
        process.exit(0);
    }
}

console.log('\n[manuel] git push');
if (executer('git', ['push', 'origin', 'main']).code !== 0) {
    arreter('git push refuse. Si la CI a pousse entre-temps : git pull --rebase origin main, puis git push origin main.');
}
console.log('\n[manuel] Termine.');
