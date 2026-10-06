/**
 * The model, on this machine: one text in, its vector out.
 *
 * NOTHING IS FETCHED HERE. The files are the ones `setup.mjs` downloaded and
 * checked against the hashes in `model.json`; remote models are switched off in
 * the library itself, so a missing file is an error with a name, never a quiet
 * download of some other export of the model. The vectors must come from the
 * very file the phone runs — two exports of one model do not give comparable
 * numbers.
 *
 * In this folder, not beside `meaning.mjs`: the library and its runtime are
 * half a gigabyte, installed here by `setup.mjs` and nowhere else. The gate
 * and its tests never load them.
 */

import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Where the model files live. Kept out of git: see `.gitignore`. */
export const MODEL_DIR = join(HERE, '.model');

export function modelFile(model, path) {
  return join(MODEL_DIR, ...model.model.id.split('/'), ...path.split('/'));
}

/** The files that are not here, or not the size the model says. */
export function missingFiles(model) {
  return model.model.files.filter((file) => {
    const at = modelFile(model, file.path);
    return !existsSync(at) || statSync(at).size !== file.bytes;
  });
}

export async function embedder(model) {
  const missing = missingFiles(model);
  if (missing.length) {
    throw new Error(`моделът не е на този компютър (липсва ${missing[0].path}) — npm run meaning:setup`);
  }

  let library;
  try {
    library = await import('@huggingface/transformers');
  } catch {
    throw new Error('зависимостите на модела не са инсталирани — npm run meaning:setup');
  }

  library.env.allowRemoteModels = false;
  library.env.allowLocalModels = true;
  library.env.localModelPath = MODEL_DIR;

  const extract = await library.pipeline('feature-extraction', model.model.id, {
    dtype: model.model.dtype,
  });

  return async (text) =>
    Array.from((await extract([text], { pooling: model.model.pooling, normalize: true })).data);
}
