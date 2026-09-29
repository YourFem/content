/**
 * Publishes the signed articles from the author's file into this repository.
 *
 *   node tools/publish.mjs <path/to/articles.json>            # show what would change, then ask
 *   node tools/publish.mjs <path/to/articles.json> --yes      # write without asking
 *   node tools/publish.mjs <path/to/articles.json> --note "…" # say WHY in the changelog
 *
 * THIS IS A GATE, NOT A SYNC. The author works in Dropbox, where drafts and
 * signed texts live side by side; this repository is public, and git keeps
 * whatever lands in it forever. So only an article with a publishable mark, a
 * named reviewer, a review date and an unexpired review crosses over, and it
 * crosses without the workshop's own fields (internal notes, file paths, pilot
 * ids). The source is only ever read.
 *
 * THREE THINGS A PLAIN COPY WOULD GET WRONG:
 *
 *   · Leaving the source is REVOKING, not deleting. A phone that was offline
 *     when the file vanished would keep it forever; a line in `revoked` reaches
 *     it the next time it looks.
 *   · A text changed WITHOUT a new signature is HELD at its signed version.
 *     Otherwise an edit made after the review would go out under the review's
 *     name. "Changed" is measured on the medical text only — title, layers and
 *     sources — so moving an article to another cluster is not mistaken for it.
 *   · WHAT changed is decided here, from the hashes, not from a hand-kept list.
 *     A forgotten line in a list would leave an article silently stale; the
 *     changelog is written from the result, and a person adds only the why.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';

export const SOURCE_SCHEMA = 'femai.articles.v1';
export const ARTICLE_SCHEMA = 'yourfem.article.v1';
export const MANIFEST_SCHEMA = 'yourfem.manifest.v1';

const LAYERS = Object.freeze(['patient', 'student', 'doctor']);

const HELD = Object.freeze({
  unsignedEdit: 'unsigned-edit',
  malformed: 'malformed',
});

const text = z.string().nullable().optional();
const Bilingual = z.looseObject({ bg: text, en: text });
const Pin = z.looseObject({ id: z.string() });

const Status = z.looseObject({
  medical_review: z.string().nullable().optional(),
  reviewer: z.string().nullable().optional(),
  reviewed_at: z.string().nullable().optional(),
  expires_at: z.string().nullable().optional(),
  publishable: z.boolean().optional(),
  languages_signed: z.array(z.string()).nullable().optional(),
});

const SourceArticle = z.looseObject({
  id: z.string().min(1),
  cluster: z.string().nullable().optional(),
  title: Bilingual,
  layers: z.partialRecord(z.enum(LAYERS), Bilingual),
  pins: z.array(Pin).optional(),
  // Ids into `pins`: which of the sources the English text rests on.
  pins_en: z.array(z.string()).optional(),
  // The chain writes a single link as a bare string; the public shape is always a list.
  see_also: z
    .union([z.string(), z.array(z.string())])
    .transform((value) => (typeof value === 'string' ? [value] : value))
    .optional(),
  source_check: z.array(z.string()).optional(),
  status: Status,
});

const Source = z.looseObject({
  schema: z.literal(SOURCE_SCHEMA),
  generated_at: z.string(),
  articles: z.array(z.unknown()),
});

const ManifestEntry = z.object({
  id: z.string(),
  path: z.string(),
  sha256: z.string(),
  bytes: z.number(),
  content_sha256: z.string(),
  reviewed_at: z.string(),
  expires_at: z.string().nullable(),
  title: Bilingual,
});

const Revoked = z.object({ id: z.string(), reviewed_at: z.string(), revoked_at: z.string() });

const Manifest = z.object({
  schema: z.literal(MANIFEST_SCHEMA),
  published_at: z.string(),
  source: z.object({ schema: z.string(), generated_at: z.string() }),
  articles: z.array(ManifestEntry),
  revoked: z.array(Revoked),
});

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const day = (date) => date.toISOString().slice(0, 10);
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Keys sorted all the way down, so a hash does not depend on the order a tool wrote them in. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

/** Whether an article may cross into the public repository today, and if not, why. */
export function gateOf(article, now) {
  const status = article?.status ?? {};

  if (status.publishable !== true) return { ok: false, reason: 'not publishable' };
  if (!status.reviewer?.trim()) return { ok: false, reason: 'no reviewer named' };
  if (!status.reviewed_at?.trim()) return { ok: false, reason: 'no review date' };

  if (status.expires_at) {
    const expires = new Date(status.expires_at).getTime();
    // Unlike the app, which shows a text with an odd date as it is, the gate
    // refuses it: publishing is the one step that cannot be taken back.
    if (!Number.isFinite(expires)) return { ok: false, reason: 'unreadable expiry' };
    if (expires < now.getTime()) return { ok: false, reason: 'review expired' };
  }

  return { ok: true };
}

/**
 * The same rule the app applies before it draws a text (`withoutInternal` in
 * `packages/data/src/articles/text.ts`): a heading the authors marked as
 * internal to the review, with every deeper heading under it.
 *
 * The app only hides such a section; here it is left out, because a public
 * repository cannot take back what it once showed. Adding it later is a publish
 * away. A text with no such heading is carried byte for byte.
 */
const INTERNAL_SECTION = /^(#{1,6})\s+.*(NOT\s+patient[- ]facing|for\s+QA\b|claims?\s*(&|and)\s*pins)/i;
const HEADING_LINE = /^(#{1,6})\s+/;

function withoutInternal(source) {
  if (typeof source !== 'string') return source;

  const lines = source.replace(/\r/g, '').split('\n');
  if (!lines.some((line) => INTERNAL_SECTION.test(line))) return source;

  const kept = [];
  let skipping = 0;
  for (const line of lines) {
    const heading = HEADING_LINE.exec(line);
    if (heading) {
      const depth = heading[1].length;
      if (INTERNAL_SECTION.test(line)) {
        skipping = depth;
        continue;
      }
      if (skipping && depth > skipping) continue;
      skipping = 0;
    } else if (skipping) {
      continue;
    }
    kept.push(line);
  }

  return kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The article as the public sees it: the text, its sources and its signature — nothing of the workshop. */
export function publicArticle(article) {
  const layers = {};
  for (const layer of LAYERS) {
    const texts = article.layers[layer];
    if (!texts) continue;
    layers[layer] = Object.fromEntries(Object.entries(texts).map(([lang, t]) => [lang, withoutInternal(t)]));
  }

  return {
    schema: ARTICLE_SCHEMA,
    id: article.id,
    cluster: article.cluster ?? null,
    title: article.title,
    layers,
    pins: article.pins ?? [],
    ...(article.pins_en ? { pins_en: article.pins_en } : {}),
    see_also: article.see_also ?? [],
    source_check: article.source_check ?? [],
    status: {
      medical_review: article.status.medical_review ?? null,
      reviewer: article.status.reviewer,
      reviewed_at: article.status.reviewed_at,
      expires_at: article.status.expires_at ?? null,
      publishable: true,
      // Carried as written, `null` included: which languages a doctor read is
      // the app's question to answer, and a guess here would answer it for it.
      languages_signed: article.status.languages_signed ?? null,
    },
  };
}

/** The hash of what a reviewer signs: the words and the sources behind them. */
function contentHash(copy) {
  const { title, layers, pins, pins_en = null } = copy;
  return sha256(JSON.stringify(canonical({ title, layers, pins, pins_en })));
}

function entryOf(copy) {
  const bytes = Buffer.from(`${JSON.stringify(copy, null, 2)}\n`, 'utf8');
  const entry = {
    id: copy.id,
    path: `articles/${copy.id}.json`,
    sha256: sha256(bytes),
    bytes: bytes.length,
    content_sha256: contentHash(copy),
    reviewed_at: copy.status.reviewed_at,
    expires_at: copy.status.expires_at,
    title: copy.title,
  };
  return { entry, bytes };
}

/**
 * What a publish would do, without touching the disk.
 *
 * `previous` is the manifest already in the repository, or `null` the first
 * time. `now` is an argument so the expiry boundary can be tested.
 */
export function plan(sourceJson, previous, now) {
  const source = Source.safeParse(sourceJson);
  if (!source.success) {
    throw new Error(`The source is not the author's article file (${SOURCE_SCHEMA}): ${z.prettifyError(source.error)}`);
  }
  const before = previous ? Manifest.parse(previous) : null;
  const beforeById = new Map((before?.articles ?? []).map((a) => [a.id, a]));

  const invalid = [];
  const candidates = new Map();

  source.data.articles.forEach((raw, index) => {
    const parsed = SourceArticle.safeParse(raw);
    if (!parsed.success) {
      // A malformed draft is the author's business; a malformed article that
      // claims a signature is a signed text we cannot read, and is named.
      if (raw?.status?.publishable === true) {
        invalid.push({ id: raw?.id ?? `#${index}`, reason: z.prettifyError(parsed.error) });
      }
      return;
    }
    if (!gateOf(parsed.data, now).ok) return;
    if (candidates.has(parsed.data.id)) {
      invalid.push({ id: parsed.data.id, reason: 'the same id appears twice' });
      return;
    }
    candidates.set(parsed.data.id, publicArticle(parsed.data));
  });

  const changes = { added: [], changed: [], unchanged: [], revoked: [], held: [], invalid };
  const entries = [];
  const writes = [];
  const removes = [];

  for (const copy of [...candidates.values()].sort(byId)) {
    const { entry, bytes } = entryOf(copy);
    const old = beforeById.get(copy.id);

    if (!old) {
      changes.added.push(copy.id);
    } else if (old.sha256 === entry.sha256) {
      changes.unchanged.push(copy.id);
      entries.push(old);
      continue;
    } else if (old.content_sha256 !== entry.content_sha256 && !(entry.reviewed_at > old.reviewed_at)) {
      changes.held.push({ id: copy.id, reason: HELD.unsignedEdit, reviewed_at: old.reviewed_at });
      entries.push(old);
      continue;
    } else {
      changes.changed.push(copy.id);
    }

    entries.push(entry);
    writes.push({ path: entry.path, bytes });
  }

  const unreadable = new Set(invalid.map((i) => i.id));
  const revokedNow = [];

  for (const old of before?.articles ?? []) {
    if (candidates.has(old.id)) continue;
    if (unreadable.has(old.id)) {
      // A published text that became unreadable is not a withdrawal by anyone.
      changes.held.push({ id: old.id, reason: HELD.malformed, reviewed_at: old.reviewed_at });
      entries.push(old);
      continue;
    }
    changes.revoked.push(old.id);
    revokedNow.push({ id: old.id, reviewed_at: old.reviewed_at, revoked_at: day(now) });
    removes.push(old.path);
  }

  const nothingToDo = !changes.added.length && !changes.changed.length && !changes.revoked.length;

  const revoked = [
    ...(before?.revoked ?? []).filter((r) => !candidates.has(r.id)),
    ...revokedNow,
  ].sort(byId);

  const manifest = nothingToDo
    ? before
    : {
        schema: MANIFEST_SCHEMA,
        published_at: now.toISOString(),
        source: { schema: SOURCE_SCHEMA, generated_at: source.data.generated_at },
        articles: entries.sort(byId),
        revoked,
      };

  const titles = new Map(
    [...(before?.articles ?? []), ...entries].map((e) => [e.id, e.title?.bg ?? e.title?.en ?? '']),
  );

  return { manifest, writes, removes, changes, nothingToDo, titles, now };
}

const HELD_WHY = Object.freeze({
  [HELD.unsignedEdit]: (h) => `the text changed after the signature of ${h.reviewed_at}; it needs a new one`,
  [HELD.malformed]: () => 'the source entry cannot be read',
});

/** One changelog entry, written from the result rather than from memory. */
export function changelogEntry(result, note) {
  const { changes, titles, manifest } = result;
  const line = (id) => `- ${id} — ${titles.get(id) ?? ''}`.trimEnd();
  const lines = [`## ${day(result.now)} · source generated ${manifest?.source.generated_at ?? '—'}`, ''];

  const section = (heading, ids) => {
    if (!ids.length) return;
    lines.push(`${heading} (${ids.length})`, ...ids.map(line), '');
  };

  section('Added', changes.added);
  section('Changed', changes.changed);
  section('Revoked', changes.revoked);

  if (changes.held.length) {
    lines.push(`Held at the signed version (${changes.held.length})`);
    lines.push(...changes.held.map((h) => `${line(h.id)} — ${HELD_WHY[h.reason](h)}`), '');
  }
  if (changes.invalid.length) {
    lines.push(`Skipped, unreadable in the source (${changes.invalid.length})`);
    lines.push(...changes.invalid.map((i) => `- ${i.id}`), '');
  }
  if (note?.trim()) lines.push(`Note: ${note.trim()}`, '');

  return `${lines.join('\n').trimEnd()}\n`;
}

const CHANGELOG_HEAD = `# Changelog

Written by \`tools/publish.mjs\` on every publish, newest first. What changed is
worked out from the hashes; a person adds only the why, with \`--note\`.
`;

function prependChangelog(root, entry) {
  const path = join(root, 'CHANGELOG.md');
  const body = existsSync(path) ? readFileSync(path, 'utf8').replace(CHANGELOG_HEAD, '').trimStart() : '';
  writeFileSync(path, `${CHANGELOG_HEAD}\n${entry}${body ? `\n${body}` : ''}`, 'utf8');
}

/** What the author sees before anything is written. In Bulgarian: it is his tool. */
function summary(result) {
  const { changes } = result;
  const out = [
    `Нови: ${changes.added.length} · Променени: ${changes.changed.length} · Оттеглени: ${changes.revoked.length} · Без промяна: ${changes.unchanged.length}`,
  ];
  for (const id of changes.revoked) out.push(`  оттегля се: ${id} — ${result.titles.get(id) ?? ''}`);
  for (const h of changes.held) {
    const why =
      h.reason === HELD.unsignedEdit
        ? `текстът е променен след подписа от ${h.reviewed_at} — трябва нов подпис`
        : 'записът в източника не се чете';
    out.push(`  ЗАДЪРЖАНА: ${h.id} — ${why}. Остава подписаната версия.`);
  }
  for (const i of changes.invalid) out.push(`  НЕ СЕ ЧЕТЕ: ${i.id}\n${i.reason}`);
  return out.join('\n');
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { yes: { type: 'boolean' }, note: { type: 'string' }, now: { type: 'string' } },
  });
  const [sourcePath] = positionals;
  if (!sourcePath) {
    console.error('Употреба: node tools/publish.mjs <път до articles.json> [--yes] [--note "защо"]');
    return 2;
  }

  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const manifestPath = join(root, 'manifest.json');
  const now = values.now ? new Date(values.now) : new Date();

  const sourceJson = JSON.parse(readFileSync(sourcePath, 'utf8'));
  const previous = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
  const result = plan(sourceJson, previous, now);

  console.log(summary(result));
  if (result.nothingToDo) {
    console.log('Нищо ново за публикуване.');
    return 0;
  }

  if (!values.yes) {
    if (!process.stdin.isTTY) {
      console.error('Не питам без терминал. Пусни отново с --yes, ако си сигурен.');
      return 1;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    // Windows' console does not always pass Cyrillic through stdin; `y` always works.
    const answer = (await rl.question('Публикувам? (д или y = да) ')).trim().toLowerCase();
    rl.close();
    if (!['д', 'да', 'y', 'yes'].includes(answer)) {
      console.log('Нищо не е записано.');
      return 0;
    }
  }

  for (const write of result.writes) {
    const target = join(root, write.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, write.bytes);
  }
  for (const path of result.removes) rmSync(join(root, path), { force: true });
  writeFileSync(manifestPath, `${JSON.stringify(result.manifest, null, 2)}\n`, 'utf8');
  prependChangelog(root, changelogEntry(result, values.note));

  console.log('Записано. Остава: git add -A, git commit и git push.');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error.message);
      process.exit(1);
    },
  );
}
