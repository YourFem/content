/**
 * Computes the vectors Yo searches by meaning, for the articles the gate published.
 *
 *   node tools/meaning.mjs index      # compute what is missing, write the files and the manifest
 *   node tools/meaning.mjs check      # no model needed: does every article have its vectors?
 *   node tools/meaning.mjs selftest   # does the model on this machine give the numbers on file?
 *
 * The app finds an article "by meaning" through one vector per passage of it.
 * Until now those were computed when the app was built, so a new article was
 * found by meaning only after an app update. Computed here, when the article is
 * published, they travel with it.
 *
 * THE TEXT NEVER WAITS FOR ITS VECTORS. This step runs after the gate and is
 * allowed to fail: without the model on this machine, or with a passage the
 * model chokes on, the articles and the withdrawals are published all the same,
 * and the output names what is still without vectors. Such an article is found
 * by its title until a later run catches up.
 *
 * ONLY WHAT CHANGED IS COMPUTED. A passage is known by the fingerprint of its
 * text; one that is already in the article's file keeps its vector, under
 * whatever place it has now. A new article is some ten passages; an edited one
 * is usually one.
 *
 * THE CUT IS THE APP'S, NOT OURS. `meaning/rule.mjs` is generated from the app's
 * own modules, and the app uses a vector only if the passage it cuts itself has
 * the fingerprint the vector was filed under. So this file decides nothing
 * about the text: it asks the rule for the passages, the model for the vectors,
 * and writes them down.
 *
 * ONE FILE PER ARTICLE, in `meaning/<model>-r<cut>/`, each listed in the
 * manifest with the SHA-256 of its bytes — so a phone fetches the vectors of the
 * one article that changed, and checks them the way it checks the text.
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  VECTORS_SCHEMA_ID,
  VECTOR_RULE,
  articlePassages,
  chunkOf,
  decodeVector,
  parseMeaningModel,
  parseVectorFile,
  releaseTag,
  textHash,
} from './meaning/rule.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const COMMAND = Object.freeze({ index: 'index', check: 'check', selftest: 'selftest' });

/** What a run ends as. `waiting` is not a failure: the text went out, some vectors did not. */
export const EXIT = Object.freeze({ done: 0, failed: 1, usage: 2, waiting: 3 });

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/**
 * Where one model's vectors live: named by the model's release and by the cut,
 * so a new model or a new cut is a new folder beside the old one, and an app
 * already on a phone keeps finding the set it was built for.
 */
export function setOf(model) {
  const tag = releaseTag(model);
  return { tag, dir: `meaning/${tag}-r${VECTOR_RULE}` };
}

/** The vectors this article's file already holds, by the fingerprint of their text. */
function reusable(raw, set, dim) {
  const kept = new Map();
  if (raw === undefined) return kept;

  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    return kept;
  }
  const file = parseVectorFile(json);
  if (!file || file.model !== set.tag || file.rule !== VECTOR_RULE || file.dim !== dim) return kept;

  for (const chunk of file.chunks) kept.set(chunk.hash, chunk);
  return kept;
}

/**
 * What a run would write, without touching the disk.
 *
 * `articles` maps an id to the article as published; `held` maps a path under
 * the set's folder to the text of the file there now. `embed` turns one text
 * into its vector, or is `null` when this machine has no model — then nothing
 * new is computed, and everything else still happens.
 */
export async function plan({ manifest, articles, held, model, embed }) {
  const set = setOf(model);
  const { dim, passage: prefix } = model.model;

  const files = [];
  const writes = [];
  const waiting = [];
  const report = { articles: 0, passages: 0, reused: 0, computed: 0, waiting };

  for (const entry of manifest.articles) {
    const article = articles.get(entry.id);
    const passages = article ? articlePassages(article) : [];
    if (passages.length === 0) continue;

    const path = `${set.dir}/${entry.id}.json`;
    const kept = reusable(held.get(path), set, dim);
    const chunks = [];
    let unanswered = 0;

    for (const text of passages) {
      const old = kept.get(textHash(text.text));
      if (old) {
        // The vector follows its text: the place and the ref are today's.
        chunks.push({ ...old, route: text.route, ref: text.ref });
        report.reused += 1;
        continue;
      }
      const vector = embed ? await embed(`${prefix}${text.text}`) : null;
      if (vector) {
        chunks.push(chunkOf(text, vector));
        report.computed += 1;
      } else {
        unanswered += 1;
      }
    }

    report.articles += 1;
    report.passages += passages.length;
    if (unanswered > 0) waiting.push({ id: entry.id, passages: unanswered });
    if (chunks.length === 0) continue;

    const file = {
      schema: VECTORS_SCHEMA_ID,
      model: set.tag,
      dim,
      rule: VECTOR_RULE,
      route: chunks[0].route,
      chunks,
    };
    if (!parseVectorFile(file)) {
      throw new Error(`${path}: the file this step built is not one the app would read`);
    }

    const bytes = Buffer.from(`${JSON.stringify(file, null, 1)}\n`, 'utf8');
    files.push({ id: entry.id, path, sha256: sha256(bytes), bytes: bytes.length });
    if (held.get(path) !== bytes.toString('utf8')) writes.push({ path, bytes });
  }

  const listed = new Set(files.map((file) => file.path));
  const removes = [...held.keys()].filter((path) => !listed.has(path)).sort();

  const next = nextManifest(manifest, set, files);
  const changed =
    writes.length > 0 || removes.length > 0 || JSON.stringify(next) !== JSON.stringify(manifest);

  return { manifest: next, writes, removes, report, changed };
}

/** The manifest with this model's set replaced, and every other set as it was. */
function nextManifest(manifest, set, files) {
  const ours = (one) => one.model === set.tag && one.rule === VECTOR_RULE;
  const before = manifest.meaning ?? [];
  const mine = { model: set.tag, rule: VECTOR_RULE, files };

  const sets = before.some(ours)
    ? before.flatMap((one) => (ours(one) ? (files.length ? [mine] : []) : [one]))
    : files.length
      ? [...before, mine]
      : before;

  if (sets.length === 0) {
    const { meaning: _dropped, ...rest } = manifest;
    return rest;
  }
  return { ...manifest, meaning: sets };
}

/** Whether every published article has the vectors of the text it has now. No model needed. */
export async function check({ manifest, articles, held, model }) {
  const result = await plan({ manifest, articles, held, model, embed: null });
  return { current: !result.changed && result.report.waiting.length === 0, waiting: result.report.waiting };
}

/* ── is this machine's model the one the vectors came from? ────────────────── */

/**
 * How alike two machines' vectors for one text must be, as a cosine. The same
 * model file gives the same direction to four decimals or better — what is left
 * is the rounding to int8 — and another export of the model does not come close.
 */
const AGREES_FROM = 0.999;

function cosine(a, b) {
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return aa > 0 && bb > 0 ? dot / Math.sqrt(aa * bb) : 0;
}

/**
 * Computes one passage again and compares it with its vector on file.
 *
 * The vectors in this repository may have been computed on another machine, and
 * the phone computes her question on a third. They are comparable only because
 * all three run one model file — so before this machine adds its own, it is
 * worth one passage to see that it gives the numbers already here. `null` when
 * nothing on file can be compared yet.
 */
export async function selftest({ manifest, articles, held, model, embed }) {
  const set = setOf(model);
  const { dim, passage: prefix } = model.model;

  for (const entry of manifest.articles) {
    const kept = reusable(held.get(`${set.dir}/${entry.id}.json`), set, dim);
    const article = articles.get(entry.id);
    const text = (article ? articlePassages(article) : []).find((one) => kept.has(textHash(one.text)));
    if (!text) continue;

    const onFile = kept.get(textHash(text.text));
    const vector = await embed(`${prefix}${text.text}`);
    if (!vector) return { ref: text.ref, cosine: 0, identical: false, agrees: false };

    const closeness = cosine(decodeVector(onFile.v, dim), vector);
    const again = chunkOf(text, vector);
    return {
      ref: text.ref,
      cosine: closeness,
      identical: again.v === onFile.v && again.s === onFile.s,
      agrees: closeness >= AGREES_FROM,
    };
  }

  return null;
}

/* ── the disk ─────────────────────────────────────────────────────────────── */

/**
 * The manifest, the articles it lists and the vector files already there.
 *
 * An article file that is not byte for byte the one the manifest lists stops
 * the run: vectors are computed for what was published, and a file edited by
 * hand since the gate ran is not that.
 */
function load(root, model) {
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  const articles = new Map();

  for (const entry of manifest.articles) {
    const bytes = readFileSync(join(root, entry.path));
    if (sha256(bytes) !== entry.sha256) {
      throw new Error(`${entry.path} (${entry.id}) is not the file the manifest lists — run the gate again`);
    }
    articles.set(entry.id, JSON.parse(bytes.toString('utf8')));
  }

  const set = setOf(model);
  const dir = join(root, set.dir);
  const held = new Map();
  if (existsSync(dir)) {
    for (const name of readdirSync(dir).filter((one) => one.endsWith('.json'))) {
      held.set(`${set.dir}/${name}`, readFileSync(join(dir, name), 'utf8'));
    }
  }

  return { manifest, articles, held };
}

/** One run on a folder: read, plan, write. The manifest is written last. */
export async function index(root, { model, embed }) {
  const result = await plan({ ...load(root, model), model, embed });
  if (!result.changed) return result;

  for (const write of result.writes) {
    const target = join(root, write.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, write.bytes);
  }
  for (const path of result.removes) rmSync(join(root, path), { force: true });

  const dir = join(root, setOf(model).dir);
  if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);

  writeFileSync(join(root, 'manifest.json'), `${JSON.stringify(result.manifest, null, 2)}\n`, 'utf8');
  return result;
}

/* ── the command ──────────────────────────────────────────────────────────── */

function ownModel() {
  const model = parseMeaningModel(JSON.parse(readFileSync(join(HERE, 'meaning', 'model.json'), 'utf8')));
  if (!model) throw new Error('tools/meaning/model.json не се чете — пиши на Ники');
  return model;
}

/**
 * The model, loaded the first time a passage needs it — so a publish with
 * nothing new to compute never loads half a gigabyte, and a machine without the
 * model still does everything else.
 */
function lazily(model, say) {
  let loading;
  let unavailable = false;

  return async (text) => {
    if (unavailable) return null;
    try {
      loading ??= import('./meaning/embed.mjs').then((module) => module.embedder(model));
      return await (await loading)(text);
    } catch (error) {
      unavailable = true;
      say(`  моделът не тръгна: ${error.message}`);
      return null;
    }
  };
}

/** What the author sees. In Bulgarian: it is his tool. */
function summary(report) {
  const out = [
    `Вектори: ${report.articles} статии · ${report.passages} откъса · нови ${report.computed} · без промяна ${report.reused}`,
  ];
  for (const one of report.waiting) out.push(`  БЕЗ ВЕКТОРИ: ${one.id} — ${one.passages} откъса чакат`);
  if (report.waiting.length) {
    out.push(
      'Текстовете са наред и се публикуват. Тези статии се намират по заглавие, докато векторите им се сметнат.',
      'Ако моделът липсва: npm run meaning:setup. Иначе прати този прозорец на Ники.',
    );
  }
  return out.join('\n');
}

async function main() {
  const [command] = process.argv.slice(2);
  const root = resolve(HERE, '..');
  const model = ownModel();

  if (command === COMMAND.check) {
    const result = await check({ ...load(root, model), model });
    for (const one of result.waiting) console.log(`  без вектори: ${one.id} — ${one.passages} откъса`);
    console.log(result.current ? 'Векторите са актуални.' : 'Векторите са остарели: npm run meaning:index');
    return result.current ? EXIT.done : EXIT.failed;
  }

  if (command === COMMAND.index) {
    const result = await index(root, { model, embed: lazily(model, console.log) });
    console.log(summary(result.report));
    if (!result.changed) console.log('Нищо ново при векторите.');
    return result.report.waiting.length ? EXIT.waiting : EXIT.done;
  }

  if (command === COMMAND.selftest) {
    const { embedder } = await import('./meaning/embed.mjs');
    const result = await selftest({ ...load(root, model), model, embed: await embedder(model) });
    if (!result) {
      console.log('Няма с какво да сравня: още няма вектори в хранилището. Първото смятане ще ги направи.');
      return EXIT.done;
    }
    const how = result.identical ? 'същият до байт' : `съвпадение ${result.cosine.toFixed(4)}`;
    console.log(`Проба с ${result.ref}: ${how}.`);
    if (result.agrees) {
      console.log('Моделът на този компютър дава числата, които вече са в хранилището.');
      return EXIT.done;
    }
    console.log('НЕ СЪВПАДА: моделът тук дава други числа. Не публикувай вектори от този компютър.');
    console.log('Прати този прозорец на Ники.');
    return EXIT.failed;
  }

  console.error('Употреба: node tools/meaning.mjs index | check | selftest');
  return EXIT.usage;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error.message);
      process.exit(EXIT.failed);
    },
  );
}
