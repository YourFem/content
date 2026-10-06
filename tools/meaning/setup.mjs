/**
 * Puts the model on this machine, once: `npm run meaning:setup`.
 *
 *   1  installs the model's runtime into this folder (about 0.5 GB);
 *   2  downloads the model's files from this repository's own release (about
 *      0.6 GB) and checks each against the SHA-256 in `model.json`.
 *
 * Safe to run again: a file that is already here and has the right hash is not
 * downloaded twice, so a run that was cut off continues where it stopped.
 *
 * WHY OUR OWN RELEASE AND NOT THE MODEL'S HOME. The phone downloads these exact
 * files from this release and checks the same hashes. Vectors computed from any
 * other copy of the model — a newer export, another quantisation — would not be
 * comparable with the ones the phone computes for her question.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { missingFiles, modelFile } from './embed.mjs';
import { modelUrl, parseMeaningModel, releaseTag } from './rule.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const KB = 1024;
const MB = 1024 * KB;

const sizeOf = (bytes) =>
  bytes >= MB ? `${(bytes / MB).toFixed(0)} MB` : `${Math.max(1, Math.round(bytes / KB))} kB`;

async function sha256Of(path) {
  const hash = createHash('sha256');
  for await (const piece of createReadStream(path)) hash.update(piece);
  return hash.digest('hex');
}

/** Whether the file is here and is the one the model names. */
async function intact(model, file) {
  const at = modelFile(model, file.path);
  return existsSync(at) && statSync(at).size === file.bytes && (await sha256Of(at)) === file.sha256;
}

/** Downloads one file beside its place, checks it, and only then moves it in. */
async function download(model, file) {
  const at = modelFile(model, file.path);
  const part = `${at}.part`;
  mkdirSync(dirname(at), { recursive: true });

  const url = modelUrl(model, file.path);
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`${url}: HTTP ${response.status}`);

  const hash = createHash('sha256');
  const out = createWriteStream(part);
  let got = 0;
  let shown = 0;

  for await (const piece of response.body) {
    hash.update(piece);
    if (!out.write(piece)) await new Promise((resume) => out.once('drain', resume));
    got += piece.length;
    if (got - shown >= 50 * MB) {
      shown = got;
      console.log(`      ${(got / MB).toFixed(0)} от ${(file.bytes / MB).toFixed(0)} MB`);
    }
  }
  await new Promise((done, failed) => out.end((error) => (error ? failed(error) : done())));

  if (got !== file.bytes || hash.digest('hex') !== file.sha256) {
    rmSync(part, { force: true });
    throw new Error(`${file.path}: сваленото не е файлът на модела (хешът не съвпада)`);
  }
  renameSync(part, at);
}

async function main() {
  const model = parseMeaningModel(JSON.parse(readFileSync(join(HERE, 'model.json'), 'utf8')));
  if (!model) throw new Error('tools/meaning/model.json не се чете — пиши на Ники');

  console.log('--- 1 зависимостите на модела (около 0,5 GB, само първия път) ---');
  // One string, through the shell: on Windows `npm` is a `.cmd`, which only a shell runs.
  const installed = spawnSync('npm install --no-audit --no-fund', {
    cwd: HERE,
    stdio: 'inherit',
    shell: true,
  });
  if (installed.status !== 0) throw new Error('npm install в tools/meaning не мина');

  console.log(`\n--- 2 моделът ${model.model.id} (${releaseTag(model)}) ---`);
  for (const file of model.model.files) {
    const size = sizeOf(file.bytes);
    if (await intact(model, file)) {
      console.log(`  вече е тук: ${file.path} (${size})`);
      continue;
    }
    console.log(`  свалям:     ${file.path} (${size})`);
    await download(model, file);
    console.log(`  проверен:   ${file.path}`);
  }

  const missing = missingFiles(model);
  if (missing.length) throw new Error(`липсва ${missing[0].path}`);

  console.log(`\nГОТОВО. ${model.model.files.length} файла, всеки минава проверката по SHA-256.`);
  console.log('Оттук нататък векторите се смятат при всяко публикуване (PUBLIKUVAY.cmd).');
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`\nНЕ СТАНА: ${error.message}`);
    console.error('Пусни го още веднъж. Ако пак не стане, прати този прозорец на Ники.');
    process.exit(1);
  },
);
