import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { changelogEntry, gateOf, plan, publicArticle } from './publish.mjs';

const NOW = new Date('2026-09-30T00:00:00Z');

function signed(id, overrides = {}) {
  return {
    id,
    pilot_id: `PILOT_${id}`,
    cluster: 'PILOT_PP',
    title: { bg: `Заглавие ${id}`, en: `Title ${id}` },
    layers: { patient: { bg: `Текст ${id}`, en: `Text ${id}` } },
    pins: [{ id: 'WHO_2022', citation: 'WHO 2022', org: 'WHO', year: '2022', url: 'https://who.int', rights: 'facts', boundary: '' }],
    pins_source: 'internal',
    status_source: 'internal',
    source_check: ['needs a Bulgarian source'],
    source_file: 'C:/Users/ivan/Dropbox/draft.md',
    sha256: 'abc',
    status: {
      raw: 'internal note',
      medical_review: 'Approved for publication',
      reviewer: 'д-р Иван Иванов',
      reviewed_at: '2026-09-18',
      expires_at: '2029-09-18',
      publishable: true,
      languages_signed: ['bg', 'en'],
    },
    ...overrides,
  };
}

function draft(id) {
  const article = signed(id);
  return { ...article, status: { ...article.status, reviewer: null, reviewed_at: null, publishable: false } };
}

function source(articles, generated_at = '2026-09-29T17:30:24+00:00') {
  return { schema: 'femai.articles.v1', generated_at, count: articles.length, articles };
}

/** Runs a publish on top of the previous one, the way the CLI chains them. */
function again(previous, articles, now = NOW) {
  return plan(source(articles), previous.manifest, now);
}

test('only a signed, unexpired article is published', () => {
  const expired = signed('ART_OLD', {
    status: { ...signed('x').status, reviewed_at: '2023-01-01', expires_at: '2026-01-01' },
  });
  const nameless = signed('ART_NAMELESS', { status: { ...signed('x').status, reviewer: null } });
  const undated = signed('ART_UNDATED', { status: { ...signed('x').status, reviewed_at: '' } });

  const result = plan(source([signed('ART_A'), draft('ART_DRAFT'), expired, nameless, undated]), null, NOW);

  assert.deepEqual(
    result.manifest.articles.map((a) => a.id),
    ['ART_A'],
  );
});

test('the gate names why an article stays out', () => {
  assert.equal(gateOf(signed('A'), NOW).ok, true);
  assert.equal(gateOf(draft('B'), NOW).ok, false);
  assert.match(gateOf(draft('B'), NOW).reason, /publishable/);
});

test('an unreadable expiry keeps the article out rather than letting it through', () => {
  const odd = signed('ART_ODD', { status: { ...signed('x').status, expires_at: 'soon' } });
  assert.equal(gateOf(odd, NOW).ok, false);
});

test('the public copy drops what belongs to the author’s workshop', () => {
  const copy = publicArticle(signed('ART_A'));

  for (const key of ['pilot_id', 'pins_source', 'status_source', 'source_file', 'sha256']) {
    assert.equal(key in copy, false, `${key} leaked`);
  }
  assert.equal('raw' in copy.status, false);
  assert.equal(copy.schema, 'yourfem.article.v1');
  assert.deepEqual(copy.layers, { patient: { bg: 'Текст ART_A', en: 'Text ART_A' } });
  assert.deepEqual(copy.source_check, ['needs a Bulgarian source']);
});

test('which languages were signed travels as written, unknown included', () => {
  const unknown = signed('ART_A', { status: { ...signed('x').status, languages_signed: undefined } });
  assert.deepEqual(publicArticle(signed('ART_A')).status.languages_signed, ['bg', 'en']);
  assert.equal(publicArticle(unknown).status.languages_signed, null);
});

test('the English source list is carried as the ids it points at', () => {
  const article = signed('ART_A', { pins_en: ['WHO_2022'] });
  const result = plan(source([article]), null, NOW);

  assert.deepEqual(result.changes.invalid, []);
  assert.deepEqual(publicArticle(article).pins_en, ['WHO_2022']);
});

test('a single "see also" is published as a list of one', () => {
  const article = signed('ART_A', { see_also: 'ART_B' });
  const result = plan(source([article]), null, NOW);

  assert.deepEqual(result.changes.invalid, []);
  assert.deepEqual(JSON.parse(result.writes[0].bytes).see_also, ['ART_B']);
});

test('a section the authors headed as internal is not published, subsections and all', () => {
  const doctor = [
    '### Management',
    'Offer induction at 41+0.',
    '',
    '### Claims & pins (for QA — NOT patient-facing)',
    '- C1 → WHO_2022',
    '#### Open items',
    '- check the Bulgarian source',
    '',
    '### Follow-up',
    'Review at 42+0.',
  ].join('\n');
  const article = signed('ART_A', { layers: { doctor: { en: doctor } } });

  assert.equal(
    publicArticle(article).layers.doctor.en,
    '### Management\nOffer induction at 41+0.\n\n### Follow-up\nReview at 42+0.',
  );
});

test('a text without an internal section is published byte for byte', () => {
  const untouched = 'Line one\r\n\r\n\r\n### Heading\n  indented  ';
  const article = signed('ART_A', { layers: { patient: { bg: untouched } } });

  assert.equal(publicArticle(article).layers.patient.bg, untouched);
});

test('the manifest hash is the hash of the bytes written', () => {
  const result = plan(source([signed('ART_A')]), null, NOW);
  const [entry] = result.manifest.articles;
  const file = result.writes.find((w) => w.path === entry.path);

  assert.equal(entry.path, 'articles/ART_A.json');
  assert.equal(entry.sha256, createHash('sha256').update(file.bytes).digest('hex'));
  assert.equal(entry.bytes, file.bytes.length);
});

test('the first publish adds everything and revokes nothing', () => {
  const result = plan(source([signed('ART_A'), signed('ART_B')]), null, NOW);

  assert.deepEqual(result.changes.added, ['ART_A', 'ART_B']);
  assert.deepEqual(result.manifest.revoked, []);
  assert.equal(result.manifest.schema, 'yourfem.manifest.v1');
  assert.equal(result.manifest.source.generated_at, '2026-09-29T17:30:24+00:00');
});

test('publishing the same thing twice changes nothing', () => {
  const first = plan(source([signed('ART_A')]), null, NOW);
  const second = again(first, [signed('ART_A')], new Date('2026-10-01T00:00:00Z'));

  assert.equal(second.nothingToDo, true);
  assert.deepEqual(second.writes, []);
});

test('a text re-signed after a change is published as changed', () => {
  const first = plan(source([signed('ART_A')]), null, NOW);
  const edited = signed('ART_A', {
    layers: { patient: { bg: 'Поправен текст' } },
    status: { ...signed('x').status, reviewed_at: '2026-09-29' },
  });

  const second = again(first, [edited]);

  assert.deepEqual(second.changes.changed, ['ART_A']);
  assert.equal(second.manifest.articles[0].reviewed_at, '2026-09-29');
});

test('a text changed without a new signature is held at its signed version', () => {
  const first = plan(source([signed('ART_A')]), null, NOW);
  const edited = signed('ART_A', { layers: { patient: { bg: 'Тихо поправен текст' } } });

  const second = again(first, [edited]);

  assert.deepEqual(second.changes.held.map((h) => h.id), ['ART_A']);
  assert.deepEqual(second.changes.changed, []);
  assert.equal(second.writes.some((w) => w.path === 'articles/ART_A.json'), false);
  assert.deepEqual(second.manifest.articles, first.manifest.articles);
});

test('a change outside the medical text is not mistaken for an unsigned edit', () => {
  const first = plan(source([signed('ART_A')]), null, NOW);
  const moved = signed('ART_A', { cluster: 'ANOTHER_CLUSTER', pilot_id: 'renamed' });

  const second = again(first, [moved]);

  assert.deepEqual(second.changes.held, []);
  assert.deepEqual(second.changes.changed, ['ART_A']);
});

test('an article that leaves the source is revoked, not quietly deleted', () => {
  const first = plan(source([signed('ART_A'), signed('ART_B')]), null, NOW);
  const second = again(first, [signed('ART_A')]);

  assert.deepEqual(second.changes.revoked, ['ART_B']);
  assert.deepEqual(second.manifest.revoked, [
    { id: 'ART_B', reviewed_at: '2026-09-18', revoked_at: '2026-09-30' },
  ]);
  assert.deepEqual(second.removes, ['articles/ART_B.json']);
});

test('an article that loses its signature is revoked as well', () => {
  const first = plan(source([signed('ART_A')]), null, NOW);
  const second = again(first, [draft('ART_A')]);

  assert.deepEqual(second.changes.revoked, ['ART_A']);
  assert.deepEqual(second.manifest.articles, []);
});

test('a revoked article signed again comes back and leaves the revoked list', () => {
  const first = plan(source([signed('ART_A')]), null, NOW);
  const gone = again(first, []);
  const back = again(gone, [
    signed('ART_A', { status: { ...signed('x').status, reviewed_at: '2026-10-02' } }),
  ]);

  assert.deepEqual(back.changes.added, ['ART_A']);
  assert.deepEqual(back.manifest.revoked, []);
});

test('a source that is not the author’s article file is refused whole', () => {
  assert.throws(() => plan({ schema: 'something.else', articles: [] }, null, NOW), /femai\.articles\.v1/);
});

test('a malformed signed article is skipped and named, and the rest still go out', () => {
  const broken = { id: 'ART_BROKEN', status: { publishable: true } };
  const result = plan(source([signed('ART_A'), broken]), null, NOW);

  assert.deepEqual(result.manifest.articles.map((a) => a.id), ['ART_A']);
  assert.deepEqual(result.changes.invalid.map((i) => i.id), ['ART_BROKEN']);
});

test('the changelog says what went out, by title', () => {
  const first = plan(source([signed('ART_A')]), null, NOW);
  const entry = changelogEntry(first, 'first publish');

  assert.match(entry, /^## 2026-09-30/m);
  assert.match(entry, /Added \(1\)/);
  assert.match(entry, /ART_A — Заглавие ART_A/);
  assert.match(entry, /first publish/);
});

test('a publish carries the list of vectors through — the meaning step keeps it, not the gate', () => {
  const first = plan(source([signed('ART_A')]), null, NOW);
  const meaning = [
    {
      model: 'yo-model-12345678',
      rule: 1,
      files: [{ id: 'ART_A', path: 'meaning/yo-model-12345678-r1/ART_A.json', sha256: 'a'.repeat(64), bytes: 9 }],
    },
  ];
  const withVectors = { ...first, manifest: { ...first.manifest, meaning } };

  const second = again(withVectors, [signed('ART_A'), signed('ART_B')]);

  assert.deepEqual(second.changes.added, ['ART_B']);
  assert.deepEqual(second.manifest.meaning, meaning);
});

test('a manifest without vectors stays without the key', () => {
  const first = plan(source([signed('ART_A')]), null, NOW);
  const second = again(first, [signed('ART_A'), signed('ART_B')]);

  assert.equal('meaning' in second.manifest, false);
});
