import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { check, index, plan, selftest, setOf } from './meaning.mjs';
import { VECTOR_RULE, articlePassages, parseVectorFile, textHash } from './meaning/rule.mjs';

/**
 * The vectors Yo searches by meaning, computed when an article is published.
 *
 * No model runs here: `embed` is a stand-in that turns a text into four numbers
 * and counts how often it is asked. What is held is everything around the
 * model — which passages get a vector, which are computed again, what is
 * written and what the manifest says afterwards.
 */

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

const MODEL = {
  schema: 'yourfem/yo-meaning@1',
  model: {
    id: 'test/model',
    dtype: 'q8',
    pooling: 'cls',
    dim: 4,
    query: '',
    passage: 'passage: ',
    files: [{ path: 'config.json', bytes: 2, sha256: 'a'.repeat(64) }],
    source: 'https://example.org/releases/download/',
  },
};

const SET = setOf(MODEL);

const LONG = 'Това е абзац, достатъчно дълъг, за да стои сам: сто и двайсет знака са прагът, под който абзац се лепи за съседа си. ';

function article(id, body, overrides = {}) {
  return {
    schema: 'yourfem.article.v1',
    id,
    cluster: null,
    title: { bg: `Заглавие ${id}`, en: `Title ${id}` },
    layers: { patient: { bg: body, en: 'English.' }, doctor: { bg: 'За лекаря.' } },
    pins: [],
    see_also: [],
    source_check: [],
    status: {
      medical_review: 'Approved',
      reviewer: 'д-р Иван Иванов',
      reviewed_at: '2026-09-18',
      expires_at: '2029-09-18',
      publishable: true,
      languages_signed: ['bg'],
    },
    ...overrides,
  };
}

/** A manifest and its articles, the way the gate leaves them. */
function published(list, extra = {}) {
  const articles = new Map(list.map((a) => [a.id, a]));
  const manifest = {
    schema: 'yourfem.manifest.v1',
    published_at: '2026-09-29T21:08:35.751Z',
    source: { schema: 'femai.articles.v1', generated_at: '2026-09-29T17:30:24+00:00' },
    articles: list.map((a) => ({ id: a.id, path: `articles/${a.id}.json` })),
    revoked: [],
    ...extra,
  };
  return { manifest, articles };
}

/** Four numbers from a text, and a count of how often it was asked. */
function counting() {
  const asked = [];
  const embed = async (text) => {
    asked.push(text);
    const h = Number.parseInt(textHash(text), 16);
    return [1 + (h & 0xff), 1 + ((h >> 8) & 0xff), 1 + ((h >> 16) & 0xff), 1 + ((h >> 24) & 0xff)];
  };
  return { embed, asked };
}

/** The vector files a plan wrote, as the next run finds them on disk. */
const heldAfter = (result, before = new Map()) => {
  const held = new Map(before);
  for (const path of result.removes) held.delete(path);
  for (const write of result.writes) held.set(write.path, write.bytes.toString('utf8'));
  return held;
};

const TWO = `## Едно\n\n${LONG}първи.\n\n## Две\n\n${LONG}втори.`;

test('every passage of a published article gets a vector, in a file of its own', async () => {
  const { manifest, articles } = published([article('ART_A', TWO)]);
  const { embed, asked } = counting();

  const result = await plan({ manifest, articles, held: new Map(), model: MODEL, embed });

  assert.equal(result.writes.length, 1);
  assert.equal(result.writes[0].path, `${SET.dir}/ART_A.json`);

  const file = parseVectorFile(JSON.parse(result.writes[0].bytes.toString('utf8')));
  const passages = articlePassages(articles.get('ART_A'));
  assert.equal(passages.length, 2);
  assert.deepEqual(
    file.chunks.map((c) => [c.ref, c.hash]),
    passages.map((p) => [p.ref, textHash(p.text)]),
  );
  assert.equal(file.model, SET.tag);
  assert.equal(file.rule, VECTOR_RULE);
  assert.equal(file.route, 'article/ART_A');
  // The model sees the text the way the index says it must be given.
  assert.deepEqual(asked, passages.map((p) => `passage: ${p.text}`));
});

test('the manifest lists each file with the hash of its bytes, under the model and the cut', async () => {
  const { manifest, articles } = published([article('ART_A', TWO), article('ART_B', TWO)]);

  const result = await plan({ manifest, articles, held: new Map(), model: MODEL, embed: counting().embed });

  assert.deepEqual(result.manifest.meaning, [
    {
      model: SET.tag,
      rule: VECTOR_RULE,
      files: result.writes.map((w) => ({
        id: w.path.slice(SET.dir.length + 1, -'.json'.length),
        path: w.path,
        sha256: sha256(w.bytes),
        bytes: w.bytes.length,
      })),
    },
  ]);
  assert.deepEqual(result.manifest.articles, manifest.articles);
  assert.equal(result.changed, true);
});

test('nothing is computed again, or written, for a text that has not changed', async () => {
  const { manifest, articles } = published([article('ART_A', TWO)]);
  const first = await plan({ manifest, articles, held: new Map(), model: MODEL, embed: counting().embed });
  const { embed, asked } = counting();

  const second = await plan({
    manifest: first.manifest,
    articles,
    held: heldAfter(first),
    model: MODEL,
    embed,
  });

  assert.equal(asked.length, 0);
  assert.deepEqual(second.writes, []);
  assert.equal(second.changed, false);
  assert.deepEqual(second.report, { articles: 1, passages: 2, reused: 2, computed: 0, waiting: [] });
});

test('after an edit only the new passage is computed, and the old vectors follow their texts', async () => {
  const before = published([article('ART_A', TWO)]);
  const first = await plan({ ...before, held: new Map(), model: MODEL, embed: counting().embed });
  const oldChunks = JSON.parse(first.writes[0].bytes.toString('utf8')).chunks;

  // A new section at the top moves every passage one place down.
  const after = published([article('ART_A', `## Ново\n\n${LONG}нов.\n\n${TWO}`)]);
  const { embed, asked } = counting();
  const second = await plan({
    manifest: first.manifest,
    articles: after.articles,
    held: heldAfter(first),
    model: MODEL,
    embed,
  });

  assert.equal(asked.length, 1);
  const chunks = JSON.parse(second.writes[0].bytes.toString('utf8')).chunks;
  assert.deepEqual(chunks.map((c) => c.ref), [
    'article/ART_A/patient/0',
    'article/ART_A/patient/1',
    'article/ART_A/patient/2',
  ]);
  assert.deepEqual(
    chunks.slice(1).map((c) => [c.hash, c.v, c.s]),
    oldChunks.map((c) => [c.hash, c.v, c.s]),
  );
  assert.deepEqual(second.report, { articles: 1, passages: 3, reused: 2, computed: 1, waiting: [] });
});

test('an article that left the manifest takes its vectors with it', async () => {
  const both = published([article('ART_A', TWO), article('ART_B', TWO)]);
  const first = await plan({ ...both, held: new Map(), model: MODEL, embed: counting().embed });

  const one = published([article('ART_A', TWO)], { meaning: first.manifest.meaning });
  const second = await plan({ ...one, held: heldAfter(first), model: MODEL, embed: counting().embed });

  assert.deepEqual(second.removes, [`${SET.dir}/ART_B.json`]);
  assert.deepEqual(second.manifest.meaning[0].files.map((f) => f.id), ['ART_A']);
  assert.equal(second.changed, true);
});

test('an article nobody signed in Bulgarian gets no vectors', async () => {
  const english = article('ART_EN', TWO);
  english.status.languages_signed = ['en'];
  const { manifest, articles } = published([english]);
  const { embed, asked } = counting();

  const result = await plan({ manifest, articles, held: new Map(), model: MODEL, embed });

  assert.equal(asked.length, 0);
  assert.deepEqual(result.writes, []);
  assert.equal(result.manifest.meaning, undefined);
  assert.equal(result.changed, false);
});

test('without a model it keeps what it can reuse and names what waits — the text does not', async () => {
  const before = published([article('ART_A', TWO)]);
  const first = await plan({ ...before, held: new Map(), model: MODEL, embed: counting().embed });

  const after = published([article('ART_A', `## Ново\n\n${LONG}нов.\n\n${TWO}`), article('ART_B', TWO)]);
  const second = await plan({
    manifest: { ...after.manifest, meaning: first.manifest.meaning },
    articles: after.articles,
    held: heldAfter(first),
    model: MODEL,
    embed: null,
  });

  // The two old passages keep their vectors, under the refs they have now.
  const chunks = JSON.parse(second.writes[0].bytes.toString('utf8')).chunks;
  assert.deepEqual(chunks.map((c) => c.ref), ['article/ART_A/patient/1', 'article/ART_A/patient/2']);
  // ART_B has nothing to reuse: no file, and no entry that would promise one.
  assert.deepEqual(second.manifest.meaning[0].files.map((f) => f.id), ['ART_A']);
  assert.deepEqual(second.report.waiting, [
    { id: 'ART_A', passages: 1 },
    { id: 'ART_B', passages: 2 },
  ]);
});

test('a passage the model fails on waits, and the rest of the article does not', async () => {
  const { manifest, articles } = published([article('ART_A', TWO)]);
  const embed = async (text) => (text.includes('втори') ? null : [1, 2, 3, 4]);

  const result = await plan({ manifest, articles, held: new Map(), model: MODEL, embed });

  assert.equal(JSON.parse(result.writes[0].bytes.toString('utf8')).chunks.length, 1);
  assert.deepEqual(result.report.waiting, [{ id: 'ART_A', passages: 1 }]);
});

test('vectors kept for another model, or another cut, are not reused and not touched', async () => {
  const { manifest, articles } = published([article('ART_A', TWO)]);
  const first = await plan({ manifest, articles, held: new Map(), model: MODEL, embed: counting().embed });

  const otherSet = { model: 'yo-model-ffffffff', rule: VECTOR_RULE, files: [{ id: 'ART_A', path: 'meaning/yo-model-ffffffff-r1/ART_A.json', sha256: 'f'.repeat(64), bytes: 9 }] };
  const stale = JSON.parse(first.writes[0].bytes.toString('utf8'));
  const held = new Map([[`${SET.dir}/ART_A.json`, JSON.stringify({ ...stale, model: 'yo-model-ffffffff' })]]);
  const { embed, asked } = counting();

  const second = await plan({
    manifest: { ...manifest, meaning: [otherSet] },
    articles,
    held,
    model: MODEL,
    embed,
  });

  assert.equal(asked.length, 2);
  assert.deepEqual(second.manifest.meaning[0], otherSet);
  assert.equal(second.manifest.meaning[1].model, SET.tag);
});

test('check: current after an index, stale once a text changes or a file is gone', async () => {
  const before = published([article('ART_A', TWO)]);
  const first = await plan({ ...before, held: new Map(), model: MODEL, embed: counting().embed });
  const held = heldAfter(first);

  assert.deepEqual(await check({ manifest: first.manifest, articles: before.articles, held, model: MODEL }), {
    current: true,
    waiting: [],
  });

  const edited = published([article('ART_A', `${TWO}\n\n## Три\n\n${LONG}трети.`)]);
  const afterEdit = await check({ manifest: first.manifest, articles: edited.articles, held, model: MODEL });
  assert.equal(afterEdit.current, false);
  assert.deepEqual(afterEdit.waiting, [{ id: 'ART_A', passages: 1 }]);

  const gone = await check({ manifest: first.manifest, articles: before.articles, held: new Map(), model: MODEL });
  assert.equal(gone.current, false);
});

/* ── on a real folder ─────────────────────────────────────────────────────── */

function repo(list) {
  const root = mkdtempSync(join(tmpdir(), 'yourfem-meaning-'));
  const entries = list.map((a) => {
    const bytes = Buffer.from(`${JSON.stringify(a, null, 2)}\n`, 'utf8');
    const path = `articles/${a.id}.json`;
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), bytes);
    return { id: a.id, path, sha256: sha256(bytes), bytes: bytes.length };
  });
  const manifest = { ...published(list).manifest, articles: entries };
  writeFileSync(join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return root;
}

const readJson = (root, path) => JSON.parse(readFileSync(join(root, path), 'utf8'));

test('index writes the files and the manifest, and a second run touches nothing', async (t) => {
  const root = repo([article('ART_A', TWO), article('ART_B', TWO)]);
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const first = await index(root, { model: MODEL, embed: counting().embed });

  assert.equal(first.changed, true);
  const listed = readJson(root, 'manifest.json').meaning[0].files;
  assert.deepEqual(listed.map((f) => f.id), ['ART_A', 'ART_B']);
  for (const file of listed) {
    assert.equal(sha256(readFileSync(join(root, file.path))), file.sha256);
  }

  const manifestBytes = readFileSync(join(root, 'manifest.json'), 'utf8');
  const { embed, asked } = counting();
  const second = await index(root, { model: MODEL, embed });

  assert.equal(second.changed, false);
  assert.equal(asked.length, 0);
  assert.equal(readFileSync(join(root, 'manifest.json'), 'utf8'), manifestBytes);
});

test('index removes the vectors of an article the gate has withdrawn', async (t) => {
  const root = repo([article('ART_A', TWO), article('ART_B', TWO)]);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await index(root, { model: MODEL, embed: counting().embed });

  // The gate withdraws ART_B: its file goes, and the manifest stops listing it.
  const manifest = readJson(root, 'manifest.json');
  manifest.articles = manifest.articles.filter((entry) => entry.id !== 'ART_B');
  writeFileSync(join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  rmSync(join(root, 'articles/ART_B.json'));

  await index(root, { model: MODEL, embed: counting().embed });

  assert.equal(existsSync(join(root, `${SET.dir}/ART_B.json`)), false);
  assert.deepEqual(readJson(root, 'manifest.json').meaning[0].files.map((f) => f.id), ['ART_A']);
});

test('index refuses an article file that is not the one the manifest lists', async (t) => {
  const root = repo([article('ART_A', TWO)]);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'articles/ART_A.json'), '{"id":"ART_A","edited":"by hand"}\n', 'utf8');

  await assert.rejects(index(root, { model: MODEL, embed: counting().embed }), /ART_A/);
  assert.equal(existsSync(join(root, SET.dir)), false);
});

/* ── does this machine give the numbers on file? ──────────────────────────── */

test('selftest: a model that gives the numbers on file agrees, to the byte', async () => {
  const { manifest, articles } = published([article('ART_A', TWO)]);
  const { embed } = counting();
  const first = await plan({ manifest, articles, held: new Map(), model: MODEL, embed });

  const result = await selftest({ manifest: first.manifest, articles, held: heldAfter(first), model: MODEL, embed });

  assert.equal(result.ref, 'article/ART_A/patient/0');
  assert.equal(result.identical, true);
  assert.ok(result.cosine > 0.9999);
  assert.equal(result.agrees, true);
});

test('selftest: a model that gives other numbers is caught', async () => {
  const { manifest, articles } = published([article('ART_A', TWO)]);
  const first = await plan({ manifest, articles, held: new Map(), model: MODEL, embed: counting().embed });

  const other = async () => [4, -3, 2, -1];
  const result = await selftest({ manifest: first.manifest, articles, held: heldAfter(first), model: MODEL, embed: other });

  assert.equal(result.identical, false);
  assert.equal(result.agrees, false);
});

test('selftest: with no vectors on file there is nothing to compare', async () => {
  const { manifest, articles } = published([article('ART_A', TWO)]);

  assert.equal(await selftest({ manifest, articles, held: new Map(), model: MODEL, embed: counting().embed }), null);
});
