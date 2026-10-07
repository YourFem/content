/**
 * GENERATED — DO NOT EDIT. Written by `npm run content:rule` in the YourFem app
 * repository, from the modules the app itself runs.
 *
 * It is the app's rule for cutting an article into the passages Yo searches by
 * meaning, with the fingerprint and the chunk it expects back. A vector is used
 * only if its passage, cut and fingerprinted on the phone, is the one it was
 * computed from — so an edit here does not change what the app does; it only
 * makes every vector computed afterwards one the app refuses, silently.
 */

// packages/data/src/articles/terms.ts
var ARTICLE_ROUTE = "article/";
var VECTOR_RULE = 1;
var ARTICLE_LAYER = Object.freeze({
  patient: "patient",
  student: "student",
  doctor: "doctor"
});
var ARTICLE_LAYERS = Object.freeze(Object.values(ARTICLE_LAYER));
var ARTICLE_LANGS = Object.freeze(["bg", "en"]);
var UNRECORDED_SIGNATURE = Object.freeze(["bg"]);
function signedInLanguage(status, lang) {
  return (status.languages_signed ?? UNRECORDED_SIGNATURE).includes(lang);
}

// packages/data/src/articles/passages.ts
var MEANING_LAYER = ARTICLE_LAYER.patient;
var MEANING_LANG = "bg";
var PASSAGE = Object.freeze({ min: 120, max: 600 });
function plain(line) {
  return line.replace(/^\s*#{1,6}\s+/, "").replace(/^\s*>\s?/, "").replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/(\*\*|__)(.+?)\1/g, "$2").replace(/(^|[^\p{L}\d])[*_](\S(?:.*?\S)?)[*_](?=$|[^\p{L}\d])/gu, "$1$2").replace(/\*\*|__/g, "").replace(/\[([^\]]*)\]/g, "$1").replace(/\s*\|\s*/g, " ").replace(/^[\s:-]*$/, "").trim();
}
function plainBlock(block) {
  return block.split("\n").map(plain).filter((line) => line !== "").join("\n");
}
var HEADING = /^\s*#{1,6}\s/;
function passagesOf(markdown, sizes = PASSAGE) {
  const out = [];
  for (const section of markdown.split(/\n(?=#{1,6}\s)/)) {
    const lines = section.split("\n");
    const heading = HEADING.test(lines[0] ?? "") ? plain(lines.shift() ?? "") : "";
    const paragraphs = lines.join("\n").split(/\n\s*\n/).map(plainBlock).filter((paragraph) => paragraph !== "");
    const packed = [];
    for (const paragraph of paragraphs) {
      const last = packed.at(-1);
      const fits = last !== void 0 && last.length + 1 + paragraph.length <= sizes.max;
      if (last !== void 0 && (fits || last.length < sizes.min)) {
        packed[packed.length - 1] = `${last}
${paragraph}`;
      } else {
        packed.push(paragraph);
      }
    }
    const tail = packed.at(-1);
    if (packed.length > 1 && tail !== void 0 && tail.length < sizes.min) {
      packed.pop();
      packed[packed.length - 1] = `${packed.at(-1)}
${tail}`;
    }
    for (const passage of packed) out.push(heading ? `${heading}
${passage}` : passage);
  }
  return out;
}
function articlePassages(article) {
  if (!signedInLanguage(article.status, MEANING_LANG)) return [];
  const route = `${ARTICLE_ROUTE}${article.id}`;
  const body = article.layers[MEANING_LAYER]?.[MEANING_LANG] ?? "";
  const title = article.title.bg ?? "";
  return passagesOf(body).map((passage, at) => ({
    ref: `${route}/${MEANING_LAYER}/${at}`,
    route,
    text: `${title}

${passage}`
  }));
}

// packages/core/src/yo/meaning.ts
import { z } from "zod";
var MEANING_SCHEMA_ID = "yourfem/yo-meaning@1";
var POOLING = Object.freeze({ mean: "mean", cls: "cls" });
var HASH = /^[0-9a-f]{8}$/;
var ChunkSchema = z.object({
  /** Where Yo leads: a route the app has, e.g. `week/24`. */
  route: z.string().min(1),
  /** Which text the vector was computed from, e.g. `week/24/care_this_week/0`. */
  ref: z.string().min(1),
  /** `textHash` of that text when the vector was computed. */
  hash: z.string().regex(HASH),
  /** The vector, int8, base64. */
  v: z.string().min(1),
  /** What one int8 step is worth. Scoring does not need it; decoding does. */
  s: z.number().positive().finite()
});
var MODEL_PATH = /^(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;
var FileSchema = z.object({
  path: z.string().regex(MODEL_PATH),
  bytes: z.int().positive(),
  /** The app checks every downloaded file against this before using it. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/)
});
function modelAsset(path) {
  return path.slice(path.lastIndexOf("/") + 1);
}
var FilesSchema = z.array(FileSchema).min(1).refine((files) => new Set(files.map((f) => modelAsset(f.path))).size === files.length, {
  message: "two files would share one release asset name"
});
var MeaningIndexSchema = z.object({
  schema: z.literal(MEANING_SCHEMA_ID),
  model: z.object({
    id: z.string().min(1),
    dtype: z.string().min(1),
    pooling: z.enum(POOLING),
    dim: z.int().positive(),
    /** What goes before a question. e5 wants `query: `, bge-m3 wants nothing. */
    query: z.string(),
    /** What went before each text when the index was built. */
    passage: z.string(),
    /**
     * The files that make up the model, as she downloads them. Not shipped in
     * the APK: Yo searches by meaning only after she asks for them.
     */
    files: FilesSchema,
    /**
     * Where releases live, ending in `/`. HTTPS only: the hashes make a swapped
     * file useless, but the address she is told about should be the one used.
     */
    source: z.url({ protocol: /^https$/ }).endsWith("/")
  }),
  /**
   * The lowest similarity that still counts as a place worth offering. It is
   * a property of the MODEL — cosines from two models are not comparable — so it
   * travels with the vectors rather than living in a constant here.
   */
  floor: z.number().min(-1).max(1),
  chunks: z.array(ChunkSchema)
});
var MeaningModelSchema = MeaningIndexSchema.pick({ schema: true, model: true });
function parseMeaningModel(raw) {
  const parsed = MeaningModelSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
function releaseTag(index) {
  const lines = [...index.model.files].sort((a, b) => a.path.localeCompare(b.path)).map((file) => `${file.path}:${file.sha256}`).join("\n");
  return `yo-model-${textHash(lines)}`;
}
function modelUrl(index, path, source) {
  return `${source ?? index.model.source}${releaseTag(index)}/${modelAsset(path)}`;
}
var FNV_OFFSET = 2166136261;
var FNV_PRIME = 16777619;
function textHash(text) {
  let hash = FNV_OFFSET;
  const flat = text.normalize("NFC").trim();
  for (let i = 0; i < flat.length; i += 1) {
    hash ^= flat.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
var INT8_MAX = 127;
function encodeVector(vector) {
  let peak = 0;
  for (let i = 0; i < vector.length; i += 1) peak = Math.max(peak, Math.abs(vector[i] ?? 0));
  const s = peak > 0 ? peak / INT8_MAX : 1;
  let binary = "";
  for (let i = 0; i < vector.length; i += 1) {
    const q = Math.max(-INT8_MAX, Math.min(INT8_MAX, Math.round((vector[i] ?? 0) / s)));
    binary += String.fromCharCode(q & 255);
  }
  return { v: btoa(binary), s };
}
function decodeVector(v, dim) {
  let binary;
  try {
    binary = atob(v);
  } catch {
    return null;
  }
  if (binary.length !== dim) return null;
  const out = new Int8Array(dim);
  for (let i = 0; i < dim; i += 1) out[i] = binary.charCodeAt(i) << 24 >> 24;
  return out;
}
var SCALE_DIGITS = 8;
function chunkOf(text, vector) {
  const { v, s } = encodeVector(vector);
  return {
    route: text.route,
    ref: text.ref,
    hash: textHash(text.text),
    v,
    s: Number(s.toFixed(SCALE_DIGITS))
  };
}
var VECTORS_SCHEMA_ID = "yourfem/yo-vectors@1";
var VectorFileSchema = z.object({
  schema: z.literal(VECTORS_SCHEMA_ID),
  /** `releaseTag` of the model the vectors came from. */
  model: z.string().min(1),
  dim: z.int().positive(),
  /** Which cut of a text into passages the refs count by. */
  rule: z.int().positive(),
  /** The place every chunk leads to. */
  route: z.string().min(1),
  chunks: z.array(ChunkSchema)
}).refine(
  (file) => file.chunks.every(
    (chunk) => chunk.route === file.route && chunk.ref.startsWith(`${file.route}/`)
  ),
  { message: "a chunk leads somewhere other than the file\u2019s place" }
).refine((file) => file.chunks.every((chunk) => decodeVector(chunk.v, file.dim) !== null), {
  message: "a vector is not as long as the file says"
});
function parseVectorFile(raw) {
  const parsed = VectorFileSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
var VECTOR_REFUSAL = Object.freeze({
  missing: "missing",
  changed: "changed",
  unreadable: "unreadable",
  otherModel: "other-model",
  otherPlace: "other-place"
});
export {
  VECTORS_SCHEMA_ID,
  VECTOR_RULE,
  articlePassages,
  chunkOf,
  decodeVector,
  modelUrl,
  parseMeaningModel,
  parseVectorFile,
  releaseTag,
  textHash
};
