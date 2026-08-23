import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { depasseSeuilEchec, formaterResumeAlertes, publierResumeCI } from './alerteCI.mjs';

const alerte = (abbreviation, avant, apres = 0) => ({
    abbreviation,
    avant,
    apres,
    motif: apres === 0 ? 'zero' : 'chute',
});

test('fait echouer le passage quand plus de la moitie des scrapers sont en alerte', () => {
    assert.equal(depasseSeuilEchec(11, 21), true);
});

test('laisse passer le bruit de fond des editeurs bloques en CI', () => {
    // 9 sur 21, releve les 20 et 21 aout : sage, wiley, emerald et elsevier
    // sont bloques depuis les IP GitHub, les faire echouer chaque nuit
    // rendrait le signal inutilisable.
    assert.equal(depasseSeuilEchec(9, 21), false);
});

test('ne fait pas echouer un passage sans aucun scraper lance', () => {
    // Le run du 23 aout : scrapeAll a leve avant integrateCalls, donc zero
    // alerte. Ce cas ne doit pas etre confondu avec un passage sain, mais il
    // n'est pas du ressort du seuil -- et surtout, pas de division par zero.
    assert.equal(depasseSeuilEchec(0, 0), false);
});

test('ne resume rien quand aucune alerte ne s est declenchee', () => {
    assert.equal(formaterResumeAlertes([], 21), '');
});

test('nomme chaque scraper en alerte et son compte precedent', () => {
    const resume = formaterResumeAlertes([alerte('sage', 51), alerte('emerald', 45)], 21);

    assert.match(resume, /sage/);
    assert.match(resume, /51/);
    assert.match(resume, /emerald/);
    assert.match(resume, /45/);
});

test('distingue une chute d un scraper tombe a zero', () => {
    const resume = formaterResumeAlertes([alerte('emerald', 47, 12)], 21);

    assert.match(resume, /12/);
    assert.match(resume, /chute/i);
});

test('dit que les appels sont geles et non archives', () => {
    const resume = formaterResumeAlertes([alerte('sage', 51)], 21);

    assert.match(resume, /gel/i);
});

test('ecrit le resume dans le fichier designe par GITHUB_STEP_SUMMARY', async () => {
    const racine = await fs.mkdtemp(path.join(os.tmpdir(), 'kerostig-ci-'));
    const cible = path.join(racine, 'summary.md');
    try {
        await publierResumeCI('## Un resume', { GITHUB_STEP_SUMMARY: cible });

        assert.equal(await fs.readFile(cible, 'utf8'), '## Un resume');
    } finally {
        await fs.rm(racine, { recursive: true, force: true });
    }
});

test('ne fait rien hors CI, quand la variable n est pas definie', async () => {
    // Doit rester silencieux en local plutot que de lever.
    await publierResumeCI('## Un resume', {});
});

test('n ecrit pas un resume vide', async () => {
    const racine = await fs.mkdtemp(path.join(os.tmpdir(), 'kerostig-ci-'));
    const cible = path.join(racine, 'summary.md');
    try {
        await publierResumeCI('', { GITHUB_STEP_SUMMARY: cible });

        await assert.rejects(() => fs.readFile(cible, 'utf8'), /ENOENT/);
    } finally {
        await fs.rm(racine, { recursive: true, force: true });
    }
});
