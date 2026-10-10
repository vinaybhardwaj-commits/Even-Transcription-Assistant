/**
 * lib/diarize-nemotron/lab.ts — PURE: everything the Nemotron LAB lane (nemotron_lab_run, migration 0143) accepts or emits.
 *
 * LAB ONLY. Nothing here is read by production diarization; the rows it validates land in nemotron_lab_item and nowhere else.
 *
 * THE ALLOW-LIST IS THE SECURITY BOUNDARY. A lab job names audio (window ids, two R2 prefixes, session spans) and a closed set of
 * knobs. There is no free-form string that reaches a shell, a path, a model name or a URL: every override is an enum, a bounded
 * number or a bounded list of enum-tagged objects, and an unknown key is a REFUSAL, never dropped. The post-processing "YAML" is
 * a strict flat subset (key: number) parsed here and stored as JSON, so the worker never receives YAML.
 *
 * PROBABILITY FILES ("NLP1"): gzip( "NLP1" | u32le header length | header JSON | payload ). Stdlib on both sides (the worker's
 * Python gzip/struct, this file's zlib), so a round trip needs no numpy. dtype "u8" is a probability quantised to 0..255 (error
 * at most 1/510); "f16" is IEEE half floats (embeddings). Row-major: frame-major for probabilities, speaker-major for embeddings.
 */
import { gunzipSync, gzipSync } from "node:zlib";
import { parseFlag } from "@/lib/flags";
import { configHash } from "./validate";
import { LAB_KEY_PREFIX } from "./lab-keys";
import { BENCH_PREFIX, CLIPS_PREFIX } from "@/lib/room-access/keys";

export const NEMOTRON_LAB_ENABLED_ENV = "NEMOTRON_LAB_ENABLED";
/** The lab lane's own switch (strict: a typo throws, never reads as off). Off = no lab job queues and the lab routes answer 404. */
export const nemotronLabEnabled = (env: Record<string, string | undefined> = process.env): boolean => parseFlag(NEMOTRON_LAB_ENABLED_ENV, env);

export const LAB_PRESETS = ["offline_30.4s", "latency_10s", "latency_1.04s"] as const;
export type LabPreset = (typeof LAB_PRESETS)[number];
/** Accepted but flaky on the box: latency_10s crashed 1 run in 3 in the refuter's smoke (a torch inductor launcher error). No retry loop; the job result says so. */
export const LAB_EXPERIMENTAL_PRESETS: readonly LabPreset[] = ["latency_10s"];
/** PURE: the caveats that travel with a spec into the job's progress and result. */
export const labSpecNotes = (spec: { preset: LabPreset }): string[] => (LAB_EXPERIMENTAL_PRESETS.includes(spec.preset) ? [`preset_${spec.preset}_experimental`] : []);
export const LAB_EMBEDDERS = ["ecapa", "titanet"] as const;
export type LabEmbedder = (typeof LAB_EMBEDDERS)[number];

/** Post-processing keys the worker passes to NeMo's PostProcessingParams, each with its inclusive range. */
export const LAB_PP_RANGES: Readonly<Record<string, readonly [number, number]>> = {
  onset: [0, 1],
  offset: [0, 1],
  pad_onset: [0, 5],
  pad_offset: [0, 5],
  min_duration_on: [0, 10],
  min_duration_off: [0, 10],
};

export const LAB_MAX_ITEMS = 10;
export const LAB_MAX_FRONTEND_OPS = 6;
export const LAB_MAX_YAML_CHARS = 2000;
/** R2 prefixes a lab job may name directly. Only room audio the app itself wrote; no encounters, no consult clips. */
export const LAB_INPUT_KEY_PREFIXES = [BENCH_PREFIX, CLIPS_PREFIX] as const;
export const LAB_ITEM_MAX_ATTEMPTS = 3;
/** A lab run that no worker finished inside this is failed by its job (lab_timeout). */
export const LAB_DEADLINE_HOURS = 24;

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const INPUT_KEY_RE = /^[A-Za-z0-9._-]{1,120}(\/[A-Za-z0-9._-]{1,120}){1,5}$/; // the prefix (and its slash) is checked against LAB_INPUT_KEY_PREFIXES; this is the rest
const SHA_RE = /^[0-9a-f]{64}$/;
const CODE_RE = /^[a-z0-9_]{1,64}$/;
const LABEL_RE = /^spk\d{1,2}$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);

export class LabArgsError extends Error {}

// ---------------------------------------------------------------------------------------------------------------
// Front-end chain: a bounded list of {op, ...numbers}. The worker turns it into one ffmpeg -af string from NUMBERS ONLY.
// ---------------------------------------------------------------------------------------------------------------

export type FrontendOp =
  | { op: "highpass"; hz: number }
  | { op: "lowpass"; hz: number }
  | { op: "gain"; db: number }
  | { op: "loudnorm" }
  | { op: "afftdn"; nr: number };

function num(v: unknown, lo: number, hi: number, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi) throw new LabArgsError(`${what} must be a number in ${lo}..${hi}`);
  return v;
}

function parseOp(raw: unknown): FrontendOp {
  if (!isObj(raw) || typeof raw.op !== "string") throw new LabArgsError("a frontend step must be an object with an op");
  const allowed = (extra: string[]) => {
    for (const k of Object.keys(raw)) if (k !== "op" && !extra.includes(k)) throw new LabArgsError(`frontend ${raw.op}: unknown key ${k.slice(0, 20)}`);
  };
  switch (raw.op) {
    case "highpass":
      allowed(["hz"]);
      return { op: "highpass", hz: num(raw.hz, 20, 1000, "highpass.hz") };
    case "lowpass":
      allowed(["hz"]);
      return { op: "lowpass", hz: num(raw.hz, 2000, 7900, "lowpass.hz") };
    case "gain":
      allowed(["db"]);
      return { op: "gain", db: num(raw.db, -30, 30, "gain.db") };
    case "loudnorm":
      allowed([]);
      return { op: "loudnorm" };
    case "afftdn":
      allowed(["nr"]);
      return { op: "afftdn", nr: num(raw.nr, 0.01, 40, "afftdn.nr") };
    default:
      throw new LabArgsError(`frontend op not allowed: ${raw.op.slice(0, 20)}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Post-processing: a strict flat YAML subset, or an object, both reduced to {key: number}.
// ---------------------------------------------------------------------------------------------------------------

/**
 * PURE — `key: number` lines only. Comments (#), blank lines, and ONE optional `postprocessing:` header with indented children
 * are accepted. Anything else (anchors, tags, flow collections, block scalars, strings, nesting, duplicate keys) is refused.
 */
export function parsePostprocessingYaml(text: string): Record<string, number> {
  if (text.length > LAB_MAX_YAML_CHARS) throw new LabArgsError("postprocessing YAML too long");
  if (/[\t\u0000-\u0008\u000b-\u001f]/.test(text)) throw new LabArgsError("postprocessing YAML has a control or tab character");
  const out: Record<string, number> = {};
  let sawHeader = false;
  let n = 0;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/#.*$/, "").replace(/\s+$/, "");
    if (line.trim() === "") continue;
    if (++n > 12) throw new LabArgsError("postprocessing YAML has too many lines");
    const m = /^(\s*)([a-z_]{1,24}):\s*(.*)$/.exec(line);
    if (!m) throw new LabArgsError("postprocessing YAML: only `key: number` lines are allowed");
    const indent = m[1]!.length;
    const key = m[2]!;
    const value = m[3]!;
    if (value === "") {
      if (key !== "postprocessing" || indent !== 0 || sawHeader || Object.keys(out).length > 0) throw new LabArgsError("postprocessing YAML: only one leading `postprocessing:` header is allowed");
      sawHeader = true;
      continue;
    }
    if ((indent > 0) !== sawHeader) throw new LabArgsError("postprocessing YAML: indentation must match the header");
    if (!/^-?\d+(\.\d+)?$/.test(value)) throw new LabArgsError("postprocessing YAML: values must be plain numbers");
    if (key in out) throw new LabArgsError("postprocessing YAML: duplicate key");
    out[key] = Number(value);
  }
  return out;
}

function checkPostprocessing(obj: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(obj).sort()) {
    const range = LAB_PP_RANGES[k];
    if (!range) throw new LabArgsError(`postprocessing key not allowed: ${k.slice(0, 24)}`);
    out[k] = num(obj[k], range[0], range[1], `postprocessing.${k}`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The spec
// ---------------------------------------------------------------------------------------------------------------

export type LabSpec = {
  preset: LabPreset;
  postprocessing: Record<string, number>;
  frontend: FrontendOp[];
  max_speakers: number | null;
  min_speech_ms: number | null;
  return_probs: boolean;
  return_embeddings: LabEmbedder | null;
};

const SPEC_KEYS = ["preset", "postprocessing", "postprocessing_yaml", "frontend", "max_speakers", "min_speech_ms", "return_probs", "return_embeddings"];

/** PURE — a lab spec from the caller's overrides. Every field is present in the result; an unknown key throws LabArgsError. */
export function parseLabSpec(raw: unknown): LabSpec {
  const o = raw === undefined || raw === null ? {} : raw;
  if (!isObj(o)) throw new LabArgsError("overrides must be an object");
  for (const k of Object.keys(o)) if (!SPEC_KEYS.includes(k)) throw new LabArgsError(`override not allowed: ${k.slice(0, 24)}`);

  const preset = o.preset === undefined ? "offline_30.4s" : o.preset;
  if (typeof preset !== "string" || !(LAB_PRESETS as readonly string[]).includes(preset)) throw new LabArgsError(`preset must be one of ${LAB_PRESETS.join(", ")}`);

  if (o.postprocessing !== undefined && o.postprocessing_yaml !== undefined) throw new LabArgsError("give postprocessing or postprocessing_yaml, not both");
  let pp: Record<string, number> = {};
  if (o.postprocessing_yaml !== undefined) {
    if (typeof o.postprocessing_yaml !== "string") throw new LabArgsError("postprocessing_yaml must be a string");
    pp = checkPostprocessing(parsePostprocessingYaml(o.postprocessing_yaml));
  } else if (o.postprocessing !== undefined) {
    if (!isObj(o.postprocessing)) throw new LabArgsError("postprocessing must be an object");
    pp = checkPostprocessing(o.postprocessing);
  }

  let frontend: FrontendOp[] = [];
  if (o.frontend !== undefined) {
    if (!Array.isArray(o.frontend) || o.frontend.length > LAB_MAX_FRONTEND_OPS) throw new LabArgsError(`frontend must be a list of at most ${LAB_MAX_FRONTEND_OPS} steps`);
    frontend = o.frontend.map(parseOp);
  }

  let maxSpeakers: number | null = null;
  if (o.max_speakers !== undefined && o.max_speakers !== null) {
    if (!isInt(o.max_speakers) || o.max_speakers < 1 || o.max_speakers > 8) throw new LabArgsError("max_speakers must be an integer 1..8");
    maxSpeakers = o.max_speakers;
  }
  let minSpeech: number | null = null;
  if (o.min_speech_ms !== undefined && o.min_speech_ms !== null) {
    if (!isInt(o.min_speech_ms) || o.min_speech_ms < 0 || o.min_speech_ms > 600_000) throw new LabArgsError("min_speech_ms must be an integer 0..600000");
    minSpeech = o.min_speech_ms;
  }
  if (o.return_probs !== undefined && typeof o.return_probs !== "boolean") throw new LabArgsError("return_probs must be a boolean");
  let emb: LabEmbedder | null = null;
  if (o.return_embeddings !== undefined && o.return_embeddings !== null && o.return_embeddings !== false) {
    if (typeof o.return_embeddings !== "string" || !(LAB_EMBEDDERS as readonly string[]).includes(o.return_embeddings)) throw new LabArgsError(`return_embeddings must be one of ${LAB_EMBEDDERS.join(", ")}`);
    emb = o.return_embeddings as LabEmbedder;
  }
  return {
    preset: preset as LabPreset,
    postprocessing: pp,
    frontend,
    max_speakers: maxSpeakers,
    min_speech_ms: minSpeech,
    return_probs: o.return_probs === true,
    return_embeddings: emb,
  };
}

/** PURE — the spec's identity, computed by the SERVER only (the worker echoes it; floats stay out of the cross-language hash). */
export const specHash = (spec: LabSpec): string => configHash(spec as unknown as Record<string, unknown>);

// ---------------------------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------------------------

export type LabInput =
  | { kind: "window"; window_id: string }
  | { kind: "r2_key"; r2_key: string }
  | { kind: "span"; session_id: string; start_ms: number; end_ms: number; source: "primary" | "backup" };

const SPAN_KEYS = ["session_id", "start", "end", "source"];
export const LAB_SPAN_MAX_MS = 30 * 60 * 1000;

const asMsStrict = (v: unknown, what: string): number => {
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return v;
  if (typeof v === "string" && v.trim()) {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  throw new LabArgsError(`${what} must be epoch ms or an ISO time`);
};

/** PURE — the three input forms of a lab job, flattened and bounded. At least one item; at most LAB_MAX_ITEMS in all. */
export function parseLabInputs(raw: Record<string, unknown>): LabInput[] {
  for (const k of Object.keys(raw)) if (!(LAB_INPUT_FIELDS as readonly string[]).includes(k) && k !== "overrides") throw new LabArgsError(`argument not allowed: ${k.slice(0, 24)}`);
  const out: LabInput[] = [];
  if (raw.windows !== undefined) {
    if (!Array.isArray(raw.windows)) throw new LabArgsError("windows must be a list of window ids");
    for (const w of raw.windows) {
      if (typeof w !== "string" || !ID_RE.test(w)) throw new LabArgsError("a window id is 1-64 of A-Z a-z 0-9 _ -");
      out.push({ kind: "window", window_id: w });
    }
  }
  if (raw.r2_keys !== undefined) {
    if (!Array.isArray(raw.r2_keys)) throw new LabArgsError("r2_keys must be a list");
    for (const k of raw.r2_keys) {
      if (typeof k !== "string" || k.includes("..") || !(LAB_INPUT_KEY_PREFIXES as readonly string[]).some((p) => k.startsWith(p)) || !INPUT_KEY_RE.test(k.slice(k.indexOf("/") + 1))) {
        throw new LabArgsError(`an r2 key must be under ${LAB_INPUT_KEY_PREFIXES.join(" or ")} with plain path segments`);
      }
      out.push({ kind: "r2_key", r2_key: k });
    }
  }
  if (raw.spans !== undefined) {
    if (!Array.isArray(raw.spans)) throw new LabArgsError("spans must be a list");
    for (const s of raw.spans) {
      if (!isObj(s) || typeof s.session_id !== "string" || !ID_RE.test(s.session_id)) throw new LabArgsError("a span needs a session_id");
      for (const k of Object.keys(s)) if (!SPAN_KEYS.includes(k)) throw new LabArgsError(`span key not allowed: ${k.slice(0, 24)}`);
      if (s.source !== undefined && s.source !== "primary" && s.source !== "backup") throw new LabArgsError("span source must be primary or backup");
      const start = asMsStrict(s.start, "span start");
      const end = asMsStrict(s.end, "span end");
      if (end <= start) throw new LabArgsError("span end must be after start");
      if (end - start > LAB_SPAN_MAX_MS) throw new LabArgsError("a span is at most 30 minutes");
      out.push({ kind: "span", session_id: s.session_id, start_ms: start, end_ms: end, source: s.source === "backup" ? "backup" : "primary" });
    }
  }
  if (out.length === 0) throw new LabArgsError("name at least one of windows, r2_keys, spans");
  if (out.length > LAB_MAX_ITEMS) throw new LabArgsError(`at most ${LAB_MAX_ITEMS} inputs per job`);
  return out;
}

export const LAB_INPUT_FIELDS = ["windows", "r2_keys", "spans"] as const;

/** PURE — the whole args object of the job: inputs + overrides, normalised. */
export function parseLabArgs(raw: unknown): { inputs: LabInput[]; spec: LabSpec } {
  if (!isObj(raw)) throw new LabArgsError("args must be an object");
  const allowed = [...LAB_INPUT_FIELDS, "overrides"];
  for (const k of Object.keys(raw)) if (!allowed.includes(k)) throw new LabArgsError(`argument not allowed: ${k.slice(0, 24)}`);
  return { inputs: parseLabInputs(raw), spec: parseLabSpec(raw.overrides) };
}

// ---------------------------------------------------------------------------------------------------------------
// R2 keys the SERVER makes for a worker's uploads (the worker never chooses a key).
// ---------------------------------------------------------------------------------------------------------------

export { LAB_KEY_PREFIX, PROBS_KEY_PREFIX, labProbsKey, labEmbeddingsKey, windowProbsKey } from "./lab-keys";

// ---------------------------------------------------------------------------------------------------------------
// Lab ingest body: closed shape.
// ---------------------------------------------------------------------------------------------------------------

export type LabIngestBody = {
  run_id: string;
  idx: number;
  worker_id: string;
  status: "ok" | "empty" | "failed";
  error_code: string | null;
  model: string;
  model_rev: string;
  config: Record<string, number | string | boolean>;
  spec_hash: string;
  audio_ms: number;
  clip_sha256: string | null;
  turns: Array<[number, number, string]>;
  probs_r2_key: string | null;
  embeddings_r2_key: string | null;
  embeddings_dims: number | null;
  infer_s: number | null;
  /** Optional: the turns are kept but the embeddings could not be made (embedder_unavailable). */
  embed_error?: string | null;
};

const LAB_INGEST_KEYS = [
  "run_id", "idx", "worker_id", "status", "error_code", "model", "model_rev", "config", "spec_hash", "audio_ms", "clip_sha256", "turns",
  "probs_r2_key", "embeddings_r2_key", "embeddings_dims", "infer_s",
] as const;
const LAB_OPTIONAL_KEYS = ["embed_error"] as const;

export type LabIngestCheck = { ok: true; body: LabIngestBody; derived: { speaker_count: number; turn_count: number; speech_ms: number; overlap_ms: number } } | { ok: false; error: string };

function overlapAndSpeech(turns: Array<[number, number, string]>): { speech_ms: number; overlap_ms: number } {
  const edges: Array<[number, number]> = [];
  for (const [s, e] of turns) edges.push([s, 1], [e, -1]);
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let depth = 0;
  let prev = 0;
  let speech = 0;
  let overlap = 0;
  for (const [t, d] of edges) {
    if (depth >= 1) speech += t - prev;
    if (depth >= 2) overlap += t - prev;
    depth += d;
    prev = t;
  }
  return { speech_ms: speech, overlap_ms: overlap };
}

/** PURE — a lab ingest body, or the first reason it is refused. Keys (probs/embeddings) are checked against the server's own keys by the route. */
export function checkLabIngest(raw: unknown): LabIngestCheck {
  if (!isObj(raw)) return { ok: false, error: "bad_body" };
  for (const k of Object.keys(raw)) if (!(LAB_INGEST_KEYS as readonly string[]).includes(k) && !(LAB_OPTIONAL_KEYS as readonly string[]).includes(k)) return { ok: false, error: "unknown_field" };
  for (const k of LAB_INGEST_KEYS) if (!(k in raw)) return { ok: false, error: `missing_${k}` };
  const b = raw as Record<(typeof LAB_INGEST_KEYS)[number], unknown>;
  if (typeof b.run_id !== "string" || !ID_RE.test(b.run_id)) return { ok: false, error: "bad_run_id" };
  if (!isInt(b.idx) || b.idx < 0 || b.idx >= LAB_MAX_ITEMS) return { ok: false, error: "bad_idx" };
  if (typeof b.worker_id !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(b.worker_id)) return { ok: false, error: "bad_worker_id" };
  if (b.status !== "ok" && b.status !== "empty" && b.status !== "failed") return { ok: false, error: "bad_status" };
  const status = b.status;
  if (status === "failed") {
    if (typeof b.error_code !== "string" || !CODE_RE.test(b.error_code)) return { ok: false, error: "bad_error_code" };
  } else if (b.error_code !== null) return { ok: false, error: "error_code_without_failure" };
  if (typeof b.model !== "string" || !/^[A-Za-z0-9._\/-]{1,128}$/.test(b.model)) return { ok: false, error: "bad_model" };
  if (typeof b.model_rev !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(b.model_rev)) return { ok: false, error: "bad_model_rev" };
  if (!isObj(b.config) || Object.keys(b.config).length === 0 || Object.keys(b.config).length > 32) return { ok: false, error: "bad_config" };
  for (const [k, v] of Object.entries(b.config)) {
    if (!/^[a-z0-9_]{1,40}$/.test(k)) return { ok: false, error: "bad_config" };
    if (!(isInt(v) || typeof v === "boolean" || (typeof v === "string" && /^[\x20-\x7e]{0,64}$/.test(v)))) return { ok: false, error: "bad_config" };
  }
  if (typeof b.spec_hash !== "string" || !SHA_RE.test(b.spec_hash)) return { ok: false, error: "bad_spec_hash" };
  if (!isInt(b.audio_ms) || b.audio_ms < 0 || b.audio_ms > 4 * 3600 * 1000) return { ok: false, error: "bad_audio_ms" };
  if (status !== "failed" && b.audio_ms === 0) return { ok: false, error: "bad_audio_ms" };
  if (b.clip_sha256 !== null && (typeof b.clip_sha256 !== "string" || !SHA_RE.test(b.clip_sha256))) return { ok: false, error: "bad_clip_sha256" };
  if (status !== "failed" && b.clip_sha256 === null) return { ok: false, error: "missing_clip_sha256" };

  if (!Array.isArray(b.turns) || b.turns.length > 5000) return { ok: false, error: "bad_turns" };
  const turns: Array<[number, number, string]> = [];
  const labels = new Set<string>();
  let last: [number, number, string] | null = null;
  for (const t of b.turns) {
    if (!Array.isArray(t) || t.length !== 3 || !isInt(t[0]) || !isInt(t[1]) || typeof t[2] !== "string") return { ok: false, error: "bad_turn" };
    if (!LABEL_RE.test(t[2])) return { ok: false, error: "bad_speaker_label" };
    if (!(t[0] >= 0 && t[0] < t[1] && t[1] <= b.audio_ms)) return { ok: false, error: "turn_out_of_range" };
    if (last && (t[0] < last[0] || (t[0] === last[0] && t[1] < last[1]))) return { ok: false, error: "turns_not_sorted" };
    last = [t[0], t[1], t[2]];
    labels.add(t[2]);
    turns.push(last);
  }
  if (labels.size > 8) return { ok: false, error: "too_many_speakers" };
  if (status === "ok" && turns.length === 0) return { ok: false, error: "ok_without_turns" };
  if (status !== "ok" && turns.length > 0) return { ok: false, error: `turns_with_${status}` };

  const keyOk = (v: unknown) => v === null || (typeof v === "string" && v.startsWith(LAB_KEY_PREFIX) && /^[A-Za-z0-9._\/-]{1,200}$/.test(v) && !v.includes(".."));
  if (!keyOk(b.probs_r2_key)) return { ok: false, error: "bad_probs_r2_key" };
  if (!keyOk(b.embeddings_r2_key)) return { ok: false, error: "bad_embeddings_r2_key" };
  if (b.embeddings_dims !== null && (!isInt(b.embeddings_dims) || b.embeddings_dims < 1 || b.embeddings_dims > 4096)) return { ok: false, error: "bad_embeddings_dims" };
  if ((b.embeddings_r2_key === null) !== (b.embeddings_dims === null)) return { ok: false, error: "embeddings_dims_mismatch" };
  if (b.infer_s !== null && (typeof b.infer_s !== "number" || !Number.isFinite(b.infer_s) || b.infer_s < 0 || b.infer_s > 86_400)) return { ok: false, error: "bad_infer_s" };
  if (status === "failed" && (b.probs_r2_key !== null || b.embeddings_r2_key !== null)) return { ok: false, error: "files_with_failure" };

  const embedError = (raw as Record<string, unknown>).embed_error;
  if (embedError !== undefined && embedError !== null && (typeof embedError !== "string" || !CODE_RE.test(embedError) || status === "failed")) return { ok: false, error: "bad_embed_error" };
  const so = overlapAndSpeech(turns);
  return {
    ok: true,
    body: {
      run_id: b.run_id, idx: b.idx, worker_id: b.worker_id, status, error_code: b.error_code as string | null, model: b.model, model_rev: b.model_rev,
      config: b.config as LabIngestBody["config"], spec_hash: b.spec_hash, audio_ms: b.audio_ms, clip_sha256: b.clip_sha256 as string | null, turns,
      probs_r2_key: b.probs_r2_key as string | null, embeddings_r2_key: b.embeddings_r2_key as string | null,
      embeddings_dims: b.embeddings_dims as number | null, infer_s: b.infer_s as number | null,
      embed_error: typeof embedError === "string" ? embedError : null,
    },
    derived: { speaker_count: labels.size, turn_count: turns.length, speech_ms: so.speech_ms, overlap_ms: so.overlap_ms },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The NLP1 container.
// ---------------------------------------------------------------------------------------------------------------

export const NLP_MAGIC = "NLP1";
export type NlpHeader = { dtype: "u8" | "f16"; rows: number; cols: number; frame_ms?: number; scale?: number; [k: string]: unknown };

function toHalf(x: number): number {
  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);
  f32[0] = x;
  const b = u32[0]!;
  const sign = (b >>> 16) & 0x8000;
  const exp = ((b >>> 23) & 0xff) - 127 + 15;
  const mant = b & 0x7fffff;
  if (exp <= 0) {
    if (exp < -10) return sign;
    return sign | ((mant | 0x800000) >> (1 - exp + 13));
  }
  if (exp >= 31) return sign | 0x7c00;
  return sign | (exp << 10) | (mant >> 13);
}

function fromHalf(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >> 10) & 0x1f;
  const mant = h & 0x3ff;
  if (exp === 0) return sign * 2 ** -14 * (mant / 1024);
  if (exp === 31) return mant ? NaN : sign * Infinity;
  return sign * 2 ** (exp - 15) * (1 + mant / 1024);
}

/** Encode a rows x cols matrix. Probabilities (0..1) go as u8; embeddings as f16. Used by tests and any TS-side producer. */
export function encodeNlp(rows: number[][], dtype: "u8" | "f16", extra: Record<string, unknown> = {}): Buffer {
  const r = rows.length;
  const c = r ? rows[0]!.length : 0;
  const header: NlpHeader = { dtype, rows: r, cols: c, ...(dtype === "u8" ? { scale: 255 } : {}), ...extra };
  const bytes = dtype === "u8" ? 1 : 2;
  const payload = Buffer.alloc(r * c * bytes);
  let o = 0;
  for (const row of rows) {
    if (row.length !== c) throw new Error("ragged matrix");
    for (const v of row) {
      if (dtype === "u8") payload.writeUInt8(Math.max(0, Math.min(255, Math.round(v * 255))), o++);
      else {
        payload.writeUInt16LE(toHalf(v), o);
        o += 2;
      }
    }
  }
  const head = Buffer.from(JSON.stringify(header), "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(head.length, 0);
  return gzipSync(Buffer.concat([Buffer.from(NLP_MAGIC, "ascii"), len, head, payload]), { level: 9 });
}

/** Decode a file from encodeNlp or the worker's packer. Throws on anything malformed (a lab file is data, never trusted). */
export function decodeNlp(buf: Uint8Array): { header: NlpHeader; rows: number[][] } {
  const raw = gunzipSync(Buffer.from(buf), { maxOutputLength: 64 * 1024 * 1024 });
  if (raw.length < 8 || raw.subarray(0, 4).toString("ascii") !== NLP_MAGIC) throw new Error("not an NLP1 file");
  const hlen = raw.readUInt32LE(4);
  if (hlen > 65536 || 8 + hlen > raw.length) throw new Error("bad NLP1 header");
  const header = JSON.parse(raw.subarray(8, 8 + hlen).toString("utf8")) as NlpHeader;
  if ((header.dtype !== "u8" && header.dtype !== "f16") || !isInt(header.rows) || !isInt(header.cols) || header.rows < 0 || header.cols < 0) throw new Error("bad NLP1 header");
  const bytes = header.dtype === "u8" ? 1 : 2;
  const payload = raw.subarray(8 + hlen);
  if (payload.length !== header.rows * header.cols * bytes) throw new Error("NLP1 payload size mismatch");
  const rows: number[][] = [];
  let o = 0;
  for (let i = 0; i < header.rows; i++) {
    const row: number[] = [];
    for (let j = 0; j < header.cols; j++) {
      if (header.dtype === "u8") row.push(payload.readUInt8(o++) / 255);
      else {
        row.push(fromHalf(payload.readUInt16LE(o)));
        o += 2;
      }
    }
    rows.push(row);
  }
  return { header, rows };
}

/**
 * PURE — the stored size of one 15-minute window's probabilities, as the arithmetic stands: 80 ms frames x 8 speaker columns (the model emits 8, measured on the box) x 1 byte (u8),
 * before gzip. Gzip only shrinks it (sparse near-0/near-1 probabilities compress well); the report gives the measured figure.
 */
export function probsRawBytes(audioMs: number, speakers = 8, frameMs = 80): number {
  return Math.ceil(audioMs / frameMs) * speakers;
}
