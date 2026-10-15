/**
 * Reader catalog_consult — CATALOG-1 (14 Oct 2026): the palimpsest encounter catalog (C1) and the artefact layers of one consult, for scribe_catalog (the Encounter Explorer).
 *
 * CATALOG. R2 eta-lab-results, ONE exact key (ENCOUNTER_CATALOG_KEY), read through labReader(): a JSONL of C1 rows, one per consult. A line that is not JSON, not an object or has no string consult_uid is skipped
 * and counted (n_bad_lines). A later line for the same consult_uid replaces an earlier one (the ledger is append-only). The parsed index is cached in this process for 5 minutes at most; after that the object is
 * read again and, when its etag (else last-modified) is unchanged, the parsed index is reused. labReader() null, a missing object or a failing read is `catalog_unavailable`.
 *
 * LAYERS. Every layer key comes from the catalog row and is checked against REB_CONSULT_KEY before it is read (lib/sarvam-lab allows exactly that shape and nothing else under the artefact prefix);
 * a mismatch is the layer error `key_not_readable`. The contract (palimpsest READ-CONTRACT v0.1 §5) picks a track by: status ok only; newest by extras.created_at, else the object's last-modified;
 * never version "caa" for a cutter consult (selectTrack, pure). The row names ONE key per layer, so selectTrack runs over that one candidate; choosing among siblings is the catalog's job.
 *
 * CLIP. The audio key comes from the row's clip.r2_key, never built here. It must start with the consult-clips prefix (keys.ts) and hold no "..". The URL is presigned for 900 s, GET only.
 * Nothing here writes. Nothing logs a key, a URL or text: codes and counts only.
 */
import { getObjectRange, headObject, signGetUrl } from "@/lib/r2";
import { ENCOUNTER_CATALOG_KEY, labReader, REB_CONSULT_KEY } from "@/lib/sarvam-lab";
import { CONSULT_CLIPS_PREFIX, REB_PREFIX } from "@/lib/room-access/keys";
import { isRebRole, speakerRoleMap } from "@/lib/room-access/readers/reb-consult";
import { isBlindRoomDay } from "@/lib/rubrics/blind-room-days";

export type Row = Record<string, unknown>;
export const CATALOG_CACHE_MS = 5 * 60_000;
export const CLIP_URL_TTL_S = 900;
export const CATALOG_MIN_DATE = "2026-09-09";

export type Catalog = { rows: Map<string, Row>; n_bad_lines: number; generated_at: string | number | null };
type Cached = { at: number; etag: string | null; modified: string | null; catalog: Catalog };
let cache: Cached | null = null;
export function resetCatalogCacheForTests(): void {
  cache = null;
}

const genKey = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && !Number.isNaN(Date.parse(v)) ? Date.parse(v) : Number.NEGATIVE_INFINITY);

/** PURE. */
export function parseCatalog(body: string): Catalog {
  const rows = new Map<string, Row>();
  let bad = 0;
  let generated: string | number | null = null;
  for (const line of body.split("\n")) {
    if (line.trim() === "") continue;
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      bad++;
      continue;
    }
    if (!v || typeof v !== "object" || Array.isArray(v) || typeof (v as Row).consult_uid !== "string" || (v as Row).consult_uid === "") {
      bad++;
      continue;
    }
    const row = v as Row;
    rows.set(row.consult_uid as string, row);
    const g = row.generated_at;
    if ((typeof g === "string" || typeof g === "number") && (generated === null || genKey(g) > genKey(generated))) generated = g;
  }
  return { rows, n_bad_lines: bad, generated_at: generated };
}

/** The catalog, or null when it cannot be read (the caller answers catalog_unavailable). */
export async function loadCatalog(now: number = Date.now()): Promise<Catalog | null> {
  if (cache && now - cache.at < CATALOG_CACHE_MS) return cache.catalog;
  const reader = labReader();
  if (!reader) return null;
  let got: Awaited<ReturnType<typeof reader.get>>;
  try {
    got = await reader.get(ENCOUNTER_CATALOG_KEY);
  } catch {
    console.warn("[catalog]", JSON.stringify({ code: "catalog_read_failed" }));
    return null;
  }
  if (!got) return null;
  const modified = got.last_modified ?? null;
  if (cache && ((got.etag !== null && got.etag === cache.etag) || (got.etag === null && modified !== null && modified === cache.modified))) {
    cache = { ...cache, at: now };
    return cache.catalog;
  }
  cache = { at: now, etag: got.etag, modified, catalog: parseCatalog(got.body) };
  return cache.catalog;
}

// --- search helpers (pure) ------------------------------------------------------------------------------------------------------------------
export const encodeCursor = (offset: number): string => Buffer.from(`o:${offset}`, "utf8").toString("base64url");
export function decodeCursor(c: string): number | null {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(c)) return null;
  const m = /^o:(\d{1,9})$/.exec(Buffer.from(c, "base64url").toString("utf8"));
  return m ? Number(m[1]) : null;
}
const asRec = (v: unknown): Row | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : null);

/** A layer record without its r2_key; an engine-keyed map of records (audio_features shape c) loses the key of each value. */
function stripKeys(v: unknown): unknown {
  const rec = asRec(v);
  if (!rec) return v;
  const out: Row = {};
  for (const [k, x] of Object.entries(rec)) {
    if (k === "r2_key") continue;
    const inner = asRec(x);
    out[k] = inner && "r2_key" in inner ? stripKeys(inner) : x;
  }
  return out;
}

/** A search row: the C1 row with each layer reduced to {status, engine?} (its r2_key dropped), plus the names of the layers that exist. */
export function searchView(row: Row): Row {
  const layers = asRec(row.layers);
  const present: string[] = [];
  let slim: Row | undefined;
  if (layers) {
    slim = {};
    for (const [name, l] of Object.entries(layers)) {
      const rec = asRec(l);
      if (Array.isArray(l)) {
        present.push(name);
        slim[name] = l.map(stripKeys);
        continue;
      }
      if (!rec) {
        slim[name] = null;
        continue;
      }
      present.push(name);
      slim[name] = stripKeys(rec);
    }
  }
  return { ...row, ...(slim ? { layers: slim } : {}), layers_present: present };
}

// --- layers ---------------------------------------------------------------------------------------------------------------------------------
export type LayerStatus = "ok" | "absent" | "not_available" | "error";
export type Layer<T = unknown> = { status: LayerStatus; source: string[]; data: T | null; error?: string };
export const layerOk = <T>(source: string[], data: T): Layer<T> => ({ status: "ok", source, data });
export const layerAbsent = (source: string[]): Layer => ({ status: "absent", source, data: null });
export const layerNotAvailable = (source: string[]): Layer => ({ status: "not_available", source, data: null });
export const layerError = (source: string[], error: string): Layer => ({ status: "error", source, data: null, error });

export type Track = { key: string; modified: string | null; body: Row };
type Seg = Row;

/** PURE. Contract §5 steps 1-3 over candidate tracks: status ok only; not a "caa" version for a cutter consult; newest by extras.created_at, else last-modified. */
export function selectTrack(cands: Track[], source: unknown): Track | null {
  const ok = cands.filter((c) => c.body.status === "ok" && !(source === "cutter" && /caa/i.test(String(c.body.version ?? ""))));
  const when = (t: Track): number => {
    const created = asRec(t.body.extras)?.created_at;
    const a = genKey(created);
    return a !== Number.NEGATIVE_INFINITY ? a : genKey(t.modified);
  };
  let best: Track | null = null;
  for (const c of ok) if (best === null || when(c) > when(best)) best = c;
  return best;
}

type Fetched = { kind: "track"; track: Track } | { kind: "absent" } | { kind: "error"; code: string };

/** One layer key: validated against the REB consult shape, read, parsed, run through selectTrack. */
/** F1: a layer or manifest key must belong to THIS row (date, room, consult) and not to a held-out room-day. null = fine, else the layer error code. */
export function bindRefusal(key: unknown, row: Row): "key_not_readable" | "blind_room_day" | null {
  if (typeof key !== "string") return "key_not_readable";
  const m = REB_CONSULT_KEY.exec(key);
  if (!m) return "key_not_readable";
  if (m[1] !== row.ist_date || m[2] !== row.room_id || m[3] !== row.consult_uid) return "key_not_readable";
  if (isBlindRoomDay(m[1], m[2])) return "blind_room_day";
  return null;
}

async function fetchTrack(key: unknown, row: Row): Promise<Fetched> {
  const source = row.source;
  const refused = bindRefusal(key, row);
  if (refused) return { kind: "error", code: refused };
  if (typeof key !== "string") return { kind: "error", code: "key_not_readable" };
  const reader = labReader();
  if (!reader) return { kind: "error", code: "catalog_unavailable" };
  let got: Awaited<ReturnType<typeof reader.get>>;
  try {
    got = await reader.get(key);
  } catch {
    return { kind: "error", code: "read_failed" };
  }
  if (!got) return { kind: "absent" };
  let body: unknown;
  try {
    body = JSON.parse(got.body);
  } catch {
    return { kind: "error", code: "bad_json" };
  }
  const rec = asRec(body);
  if (!rec || !Array.isArray(rec.segments)) return { kind: "error", code: "bad_track" };
  const t = selectTrack([{ key, modified: got.last_modified ?? null, body: rec }], source);
  return t ? { kind: "track", track: t } : { kind: "absent" };
}

/** The key a row names for a layer: null when the layer is absent from the row; whatever it holds otherwise (fetchTrack refuses a non-string). */
const layerKey = (row: Row, name: string): unknown => {
  const l = asRec(asRec(row.layers)?.[name]);
  return l ? (l.r2_key ?? "") : null;
};
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const segs = (t: Track): Seg[] => (t.body.segments as unknown[]).filter((s): s is Seg => !!asRec(s));

// --- X1: the clock. Consult-scope segment times are EPOCH ms (manifest clock tape_utc); the answer is ms from clip start. -----------------------------
export type Manifest = { key: string; t0_ms: number; duration_ms: number | null };
export type ManifestResult = { kind: "ok"; manifest: Manifest } | { kind: "error"; code: string };

/** The consult scope's manifest.json, bound to the row. Missing, or without a finite t0_ms, is no_clock: the clock is never guessed from row.t_open. */
export async function fetchManifest(row: Row): Promise<ManifestResult> {
  const key = `${REB_PREFIX}${String(row.ist_date)}/${String(row.room_id)}/_consults/${String(row.consult_uid)}/manifest.json`;
  const refused = bindRefusal(key, row);
  if (refused) return { kind: "error", code: refused };
  const reader = labReader();
  if (!reader) return { kind: "error", code: "catalog_unavailable" };
  let got: Awaited<ReturnType<typeof reader.get>>;
  try {
    got = await reader.get(key);
  } catch {
    return { kind: "error", code: "read_failed" };
  }
  if (!got) return { kind: "error", code: "no_clock" };
  let body: unknown;
  try {
    body = JSON.parse(got.body);
  } catch {
    return { kind: "error", code: "no_clock" };
  }
  const rec = asRec(body);
  const t0 = rec ? num(rec.t0_ms) : null;
  if (!rec || t0 === null) return { kind: "error", code: "no_clock" };
  const audio = asRec(rec.audio);
  // The schema (kit/reb/schema.py REQUIRED_AUDIO_FIELDS) names duration_ms; the contract text says `duration`. Both are taken as milliseconds.
  const d = num(audio?.duration_ms) ?? num(audio?.duration);
  return { kind: "ok", manifest: { key, t0_ms: t0, duration_ms: d !== null && d > 0 ? Math.round(d) : null } };
}

/**
 * PURE. A copy of the track with every segment's t0_ms / t1_ms moved from epoch to ms from clip start, then clamped to [0, duration] (no upper bound when duration is null).
 * n_clamped counts the converted values that were moved by the clamp; n_values counts the numeric values converted (t0 and t1 separately).
 */
export function toClipClock(t: Track, t0: number, durationMs: number | null = null): { track: Track; n_clamped: number; n_values: number } {
  let n = 0;
  let total = 0;
  const rel = (v: unknown): unknown => {
    const x = num(v);
    if (x === null) return v;
    total++;
    let r = x - t0;
    if (r < 0) {
      n++;
      return 0;
    }
    if (durationMs !== null && r > durationMs) {
      n++;
      r = durationMs;
    }
    return r;
  };
  const segments = (t.body.segments as unknown[]).map((g) => {
    const r = asRec(g);
    return r ? { ...r, t0_ms: rel(r.t0_ms), t1_ms: rel(r.t1_ms) } : g;
  });
  return { track: { ...t, body: { ...t.body, segments } }, n_clamped: n, n_values: total };
}

/** C4b: more than half of a layer's converted values clamped means the times were not on the epoch clock the manifest names. */
export const clockMismatch = (c: { n_clamped: number; n_values: number }): boolean => c.n_values > 0 && c.n_clamped * 2 > c.n_values;

export type TranscriptSegment = { i: number; t0_ms: number; t1_ms: number; speaker: string | null; role: string; lang: string | null; text_native?: string | null; text_en?: string | null };
export type TranscriptData = {
  segments: TranscriptSegment[]; clock: "ms_from_clip_start"; duration_ms: number | null; n_segments: number; degraded?: string[];
  manifest_t0_ms?: number; consult_span_ms?: { t0: number | null; t1: number | null }; n_clamped?: number;
};

const overlap = (a0: number, a1: number, b0: number, b1: number): number => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
const speakerLabel = (v: unknown): string | null => (typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : null);

/** The clip length in ms: the row's clip.minutes, else t_close - t_open; null when neither is usable. */
export function clipDurationMs(row: Row): number | null {
  const m = num(asRec(row.clip)?.minutes);
  if (m !== null && m > 0) return Math.round(m * 60_000);
  const o = num(row.t_open);
  const c = num(row.t_close);
  return o !== null && c !== null && c > o ? c - o : null;
}

/** English for segment i: the translate segment at the same index when the counts match, else the one overlapping most in time; else the stt text when its lang starts "en"; else null. */
function englishFor(i: number, s: Seg, translate: Seg[] | null, sameCount: boolean): string | null {
  if (translate) {
    let hit: Seg | undefined = sameCount ? translate[i] : undefined;
    if (!hit) {
      const a0 = num(s.t0_ms) ?? 0;
      const a1 = num(s.t1_ms) ?? a0;
      let best = 0;
      for (const t of translate) {
        const o = overlap(a0, a1, num(t.t0_ms) ?? 0, num(t.t1_ms) ?? 0);
        if (o > best) {
          best = o;
          hit = t;
        }
      }
    }
    if (hit && typeof hit.text === "string") return hit.text;
  }
  return typeof s.lang === "string" && s.lang.toLowerCase().startsWith("en") && typeof s.text === "string" ? s.text : null;
}

/** Role of one stt segment: the role-track segment with the most overlap; else the track's speaker map (extras.map, else speaker->role read off its segments); else "unknown". */
function roleFor(s: Seg, roleSegs: Seg[] | null, bySpeaker: Map<string, string>): string {
  const a0 = num(s.t0_ms) ?? 0;
  const a1 = num(s.t1_ms) ?? a0;
  if (roleSegs) {
    let best = 0;
    let role: string | null = null;
    for (const g of roleSegs) {
      if (!isRebRole(g.role)) continue;
      const o = overlap(a0, a1, num(g.t0_ms) ?? 0, num(g.t1_ms) ?? 0);
      if (o > best) {
        best = o;
        role = g.role;
      }
    }
    if (role) return role;
  }
  const sp = speakerLabel(s.speaker);
  return (sp !== null && bySpeaker.get(sp)) || "unknown";
}

/** PURE. Contract §5 steps 4-5 over the three selected tracks. */
export function buildTranscript(stt: Track, translate: Track | null, role: Track | null, durationMs: number | null, includeText: boolean): TranscriptData {
  const sttSegs = segs(stt);
  const trSegs = translate ? segs(translate) : null;
  const roleSegs = role ? segs(role) : null;
  const bySpeaker = new Map<string, string>();
  if (role) {
    for (const [k, v] of speakerRoleMap(role.body.extras)) bySpeaker.set(k, v);
    for (const g of roleSegs ?? []) {
      const sp = speakerLabel(g.speaker);
      if (sp !== null && isRebRole(g.role) && !bySpeaker.has(sp)) bySpeaker.set(sp, g.role);
    }
  }
  const out: TranscriptSegment[] = sttSegs.map((s, i) => {
    const t0 = num(s.t0_ms) ?? 0;
    let t1 = num(s.t1_ms) ?? t0;
    if (durationMs !== null) t1 = Math.min(t1, durationMs);
    const seg: TranscriptSegment = {
      i,
      t0_ms: durationMs !== null ? Math.min(t0, durationMs) : t0,
      t1_ms: Math.max(t1, durationMs !== null ? Math.min(t0, durationMs) : t0),
      speaker: speakerLabel(s.speaker),
      role: roleFor(s, roleSegs, bySpeaker),
      lang: typeof s.lang === "string" ? s.lang : null,
    };
    if (includeText) {
      seg.text_native = typeof s.text === "string" ? s.text : null;
      seg.text_en = englishFor(i, s, trSegs, trSegs !== null && trSegs.length === sttSegs.length);
    }
    return seg;
  });
  return { segments: out, clock: "ms_from_clip_start", duration_ms: durationMs, n_segments: out.length };
}

export async function readTranscriptLayer(row: Row, includeText: boolean, manifest?: Promise<ManifestResult>): Promise<Layer<TranscriptData>> {
  const keys = ["stt", "translate", "role"].map((n) => layerKey(row, n));
  const source = keys.filter((k): k is string => typeof k === "string" && k !== "");
  if (keys[0] === null) return layerAbsent(source) as Layer<TranscriptData>;
  const [mf, stt, tr, ro] = await Promise.all([manifest ?? fetchManifest(row), ...keys.map((k) => (k !== null ? fetchTrack(k, row) : Promise.resolve<Fetched | null>(null)))]);
  if (stt!.kind === "error") return layerError(source, stt!.code) as Layer<TranscriptData>;
  if (stt!.kind === "absent") return layerAbsent(source) as Layer<TranscriptData>;
  if (mf.kind === "error") return layerError(source, mf.code) as Layer<TranscriptData>;
  source.push(mf.manifest.key);
  const t0 = mf.manifest.t0_ms;
  const durationMs = mf.manifest.duration_ms ?? clipDurationMs(row);
  let nClamped = 0;
  let mismatch = false;
  const degraded: string[] = [];
  const pick = (name: string, f: Fetched | null | undefined): Track | null => {
    if (!f) return null;
    if (f.kind === "track") {
      const c = toClipClock(f.track, t0, durationMs);
      if (clockMismatch(c)) {
        // W1: stt on the wrong clock fails the whole layer; a translate or role track on the wrong clock is not used, says so, and is not counted
        if (name === "stt") mismatch = true;
        else {
          degraded.push(`${name}:clock_mismatch`);
          return null;
        }
      }
      nClamped += c.n_clamped;
      return c.track;
    }
    if (f.kind === "error") degraded.push(`${name}:${f.code}`);
    return null;
  };
  const sttTrack = pick("stt", stt)!;
  if (mismatch) return layerError(source, "clock_mismatch") as Layer<TranscriptData>;
  const data = buildTranscript(sttTrack, pick("translate", tr), pick("role", ro), durationMs, includeText);
  const o = num(row.t_open);
  const c = num(row.t_close);
  data.manifest_t0_ms = t0;
  data.consult_span_ms = { t0: o !== null ? o - t0 : null, t1: c !== null ? c - t0 : null };
  data.n_clamped = nClamped;
  if (degraded.length) data.degraded = degraded;
  return layerOk(source, data);
}

export type PartRow = { part: unknown; t0_ms: number | null; t1_ms: number | null; score: unknown; confidence: unknown; source: unknown };
const PART_SOURCE = /^[A-Za-z0-9_.:-]{1,40}$/;
export async function readPartsLayer(row: Row, manifest?: Promise<ManifestResult>): Promise<Layer<PartRow[]> & { n_clamped?: number }> {
  const key = layerKey(row, "parts");
  const source = typeof key === "string" && key !== "" ? [key] : [];
  if (key === null) return layerAbsent(source) as Layer<PartRow[]>;
  const [mf, f] = await Promise.all([manifest ?? fetchManifest(row), fetchTrack(key, row)]);
  if (f.kind === "error") return layerError(source, f.code) as Layer<PartRow[]>;
  if (f.kind === "absent") return layerAbsent(source) as Layer<PartRow[]>;
  if (asRec(f.track.body.config)?.clef_mode !== "clef+jev") return layerAbsent(source) as Layer<PartRow[]>;
  if (mf.kind === "error") return layerError(source, mf.code) as Layer<PartRow[]>;
  source.push(mf.manifest.key);
  const conv = toClipClock(f.track, mf.manifest.t0_ms, mf.manifest.duration_ms ?? clipDurationMs(row));
  if (clockMismatch(conv)) return layerError(source, "clock_mismatch") as Layer<PartRow[]>;
  const track = conv.track;
  // n_clamped sits on the layer object beside `data` (data stays an array)
  return { ...layerOk(source, segs(track).map((s) => ({ part: s.part ?? null, t0_ms: num(s.t0_ms), t1_ms: num(s.t1_ms), score: s.score ?? null, confidence: s.confidence ?? null, source: typeof s.source === "string" && PART_SOURCE.test(s.source) ? s.source : null }))), n_clamped: conv.n_clamped };
}

// --- audio_features ---------------------------------------------------------------------------------------------------------------------------
const FEATURES_FILE = /^features\.(timbre-odyssey|timbre-e2v|talktime|clef)__([A-Za-z0-9._-]{1,40})__[A-Za-z0-9]{8}\.json$/;
const FEATURE_STR = /^[A-Za-z0-9_.:/-]{1,80}$/;
const FEATURE_STR_FIELDS = ["speaker", "role", "role_source", "feature", "stat", "model_id", "model_rev"] as const;
const FEATURE_NUM_FIELDS = ["value", "iqr", "n_turns", "seconds", "overlap_excluded_s", "reliability"] as const;
export const AUDIO_FEATURES_MAX_KEYS = 8;
export const AUDIO_FEATURES_MAX_ROWS = 500;
export type FeatureRow = Record<(typeof FEATURE_STR_FIELDS)[number], string | null> & Record<(typeof FEATURE_NUM_FIELDS)[number], number | null>;
export type FeatureTrack = { engine: string; version: string; rows: FeatureRow[]; n_rows_dropped: number };
export type AudioFeaturesData = { tracks: FeatureTrack[]; n_skipped: number; errors?: Record<string, number> };

/** The record(s) the catalog row names under layers.audio_features: one record, an array of records, or an engine-keyed map of records. null = the layer is not on the row. */
function audioFeatureKeys(row: Row): unknown[] | null {
  const raw = asRec(row.layers)?.audio_features;
  if (raw === undefined || raw === null) return null;
  const keyOf = (r: unknown): unknown => asRec(r)?.r2_key ?? "";
  if (Array.isArray(raw)) return raw.map(keyOf);
  const rec = asRec(raw);
  if (!rec) return [""];
  if ("r2_key" in rec) return [rec.r2_key];
  return Object.values(rec).map(keyOf);
}

const featureStr = (v: unknown): string | null => (typeof v === "string" && FEATURE_STR.test(v) ? v : null);

/** PURE. The whitelisted rows of one features track: every other field dropped, a row with no valid feature string dropped and counted. */
export function featureRows(extras: unknown): { rows: FeatureRow[]; n_rows_dropped: number } {
  const list = asRec(extras)?.features;
  if (!Array.isArray(list)) return { rows: [], n_rows_dropped: 0 };
  const rows: FeatureRow[] = [];
  let dropped = 0;
  for (const item of list) {
    const r = asRec(item);
    if (!r || featureStr(r.feature) === null || rows.length >= AUDIO_FEATURES_MAX_ROWS) {
      dropped++;
      continue;
    }
    const out: Record<string, string | number | null> = {};
    for (const k of FEATURE_STR_FIELDS) out[k] = featureStr(r[k]);
    for (const k of FEATURE_NUM_FIELDS) out[k] = num(r[k]);
    rows.push(out as FeatureRow);
  }
  return { rows, n_rows_dropped: dropped };
}

export async function readAudioFeaturesLayer(row: Row): Promise<Layer<AudioFeaturesData>> {
  const keys = audioFeatureKeys(row);
  if (keys === null || keys.length === 0) return layerAbsent([]) as Layer<AudioFeaturesData>;
  const source = keys.filter((k): k is string => typeof k === "string" && k !== "");
  if (keys.length > AUDIO_FEATURES_MAX_KEYS) return layerError([], "too_many_tracks") as Layer<AudioFeaturesData>;
  let skipped = 0;
  const reads: Array<{ engine: string; version: string; key: unknown }> = [];
  for (const k of keys) {
    const m = typeof k === "string" ? FEATURES_FILE.exec(k.slice(k.lastIndexOf("/") + 1)) : null;
    if (typeof k === "string" && k !== "" && !m) skipped++;
    else reads.push({ engine: m?.[1] ?? "", version: m?.[2] ?? "", key: k });
  }
  const got = await Promise.all(reads.map((r) => fetchTrack(r.key, row)));
  const tracks: FeatureTrack[] = [];
  const errors: Record<string, number> = {};
  let firstError: string | null = null;
  got.forEach((f, i) => {
    if (f.kind === "error") {
      errors[f.code] = (errors[f.code] ?? 0) + 1;
      firstError ??= f.code;
    } else if (f.kind === "track") tracks.push({ engine: reads[i].engine, version: reads[i].version, ...featureRows(f.track.body.extras) });
  });
  if (tracks.length === 0) return (firstError !== null ? layerError(source, firstError) : layerAbsent(source)) as Layer<AudioFeaturesData>;
  const data: AudioFeaturesData = { tracks, n_skipped: skipped, ...(firstError !== null ? { errors } : {}) };
  return layerOk(source, data);
}

// --- clip -----------------------------------------------------------------------------------------------------------------------------------
/** F1: the clip key a row names, only in the consult-clips shape of THIS row (its IST date, its consult uid) and not held out; else null. */
const CLIP_KEY = /^consult-clips\/(\d{4}-\d{2}-\d{2})\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9_]{10,60})\/consult\.flac$/;
export function clipKeyOf(row: Row): string | null {
  const k = asRec(row.clip)?.r2_key;
  if (typeof k !== "string" || !k.startsWith(CONSULT_CLIPS_PREFIX) || k.includes("..") || k.length > 512) return null;
  const m = CLIP_KEY.exec(k);
  if (!m || m[1] !== row.ist_date || m[3] !== row.consult_uid) return null;
  return k;
}

export async function presignClip(key: string, now: number = Date.now()): Promise<{ url: string; expires_at: string }> {
  const url = await signGetUrl({ key, expiresInSeconds: CLIP_URL_TTL_S });
  return { url, expires_at: new Date(now + CLIP_URL_TTL_S * 1000).toISOString() };
}

// --- clip bytes (CATALOG-7) ---------------------------------------------------------------------------------------------------------------------------
export const CLIP_CHUNK_MAX = 1_048_576;
export type ClipChunk =
  | { ok: true; bytes: Uint8Array; total_bytes: number }
  | { ok: false; error: "bad_range"; total_bytes: number }
  | { ok: false; error: "clip_not_found" | "read_failed" };

/** One byte range of the (already row-bound) clip key: no transcoding, the stored bytes. Range header is exactly bytes=offset-(offset+length-1). Never logs a key or a byte. */
export async function readClipChunk(key: string, offset: number, length: number): Promise<ClipChunk> {
  let got: Awaited<ReturnType<typeof getObjectRange>>;
  try {
    got = await getObjectRange(key, offset, offset + length - 1);
  } catch {
    return { ok: false, error: "read_failed" };
  }
  if (got === null) return { ok: false, error: "clip_not_found" };
  // F1: never trust the server to have honoured the Range. More bytes than asked for is a failure, never a chunk.
  if (!("outOfRange" in got) && got.bytes.length > length) return { ok: false, error: "read_failed" };
  const headerAbsent = !("outOfRange" in got) && got.totalBytes === null;
  let total: number | null = "outOfRange" in got ? null : got.totalBytes;
  if (total === null) {
    const h = await headObject(key); // the Content-Range header was absent, or the start was past the end
    total = h.size;
  }
  if (total === null) return { ok: false, error: "read_failed" };
  if ("outOfRange" in got || offset >= total) return { ok: false, error: "bad_range", total_bytes: total };
  // Without Content-Range the bytes must be exactly the requested slice (a Range-ignoring 200 sends the whole object, which would be labelled with an offset it does not start at).
  if (headerAbsent && got.bytes.length !== Math.min(length, total - offset)) return { ok: false, error: "read_failed" };
  return { ok: true, bytes: got.bytes, total_bytes: total };
}
