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
import { signGetUrl } from "@/lib/r2";
import { ENCOUNTER_CATALOG_KEY, labReader, REB_CONSULT_KEY } from "@/lib/sarvam-lab";
import { CONSULT_CLIPS_PREFIX } from "@/lib/room-access/keys";
import { isRebRole, speakerRoleMap } from "@/lib/room-access/readers/reb-consult";

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

/** A search row: the C1 row with each layer reduced to {status, engine?} (its r2_key dropped), plus the names of the layers that exist. */
export function searchView(row: Row): Row {
  const layers = asRec(row.layers);
  const present: string[] = [];
  let slim: Row | undefined;
  if (layers) {
    slim = {};
    for (const [name, l] of Object.entries(layers)) {
      const rec = asRec(l);
      if (!rec) {
        slim[name] = null;
        continue;
      }
      present.push(name);
      const { r2_key: _k, ...rest } = rec;
      slim[name] = rest;
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
async function fetchTrack(key: unknown, source: unknown): Promise<Fetched> {
  if (typeof key !== "string" || !REB_CONSULT_KEY.test(key)) return { kind: "error", code: "key_not_readable" };
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

export type TranscriptSegment = { i: number; t0_ms: number; t1_ms: number; speaker: string | null; role: string; lang: string | null; text_native?: string | null; text_en?: string | null };
export type TranscriptData = { segments: TranscriptSegment[]; clock: "ms_from_clip_start"; duration_ms: number | null; n_segments: number; degraded?: string[] };

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

export async function readTranscriptLayer(row: Row, includeText: boolean): Promise<Layer<TranscriptData>> {
  const keys = ["stt", "translate", "role"].map((n) => layerKey(row, n));
  const source = keys.filter((k): k is string => typeof k === "string" && k !== "");
  if (keys[0] === null) return layerAbsent(source) as Layer<TranscriptData>;
  const [stt, tr, ro] = await Promise.all(keys.map((k) => (k !== null ? fetchTrack(k, row.source) : Promise.resolve<Fetched | null>(null))));
  if (stt!.kind === "error") return layerError(source, stt!.code) as Layer<TranscriptData>;
  if (stt!.kind === "absent") return layerAbsent(source) as Layer<TranscriptData>;
  const degraded: string[] = [];
  const pick = (name: string, f: Fetched | null | undefined): Track | null => {
    if (!f) return null;
    if (f.kind === "track") return f.track;
    if (f.kind === "error") degraded.push(`${name}:${f.code}`);
    return null;
  };
  const data = buildTranscript(stt!.track, pick("translate", tr), pick("role", ro), clipDurationMs(row), includeText);
  if (degraded.length) data.degraded = degraded;
  return layerOk(source, data);
}

export type PartRow = { part: unknown; t0_ms: number | null; t1_ms: number | null; score: unknown; confidence: unknown; source: unknown };
export async function readPartsLayer(row: Row): Promise<Layer<PartRow[]>> {
  const key = layerKey(row, "parts");
  const source = typeof key === "string" && key !== "" ? [key] : [];
  if (key === null) return layerAbsent(source) as Layer<PartRow[]>;
  const f = await fetchTrack(key, row.source);
  if (f.kind === "error") return layerError(source, f.code) as Layer<PartRow[]>;
  if (f.kind === "absent") return layerAbsent(source) as Layer<PartRow[]>;
  if (asRec(f.track.body.config)?.clef_mode !== "clef+jev") return layerAbsent(source) as Layer<PartRow[]>;
  return layerOk(source, segs(f.track).map((s) => ({ part: s.part ?? null, t0_ms: num(s.t0_ms), t1_ms: num(s.t1_ms), score: s.score ?? null, confidence: s.confidence ?? null, source: s.source ?? null })));
}

// --- clip -----------------------------------------------------------------------------------------------------------------------------------
/** The clip key a row names, or null when it is not a consult-clips key (or holds ".."). */
export function clipKeyOf(row: Row): string | null {
  const k = asRec(row.clip)?.r2_key;
  return typeof k === "string" && k.startsWith(CONSULT_CLIPS_PREFIX) && !k.includes("..") && k.length <= 512 ? k : null;
}

export async function presignClip(key: string, now: number = Date.now()): Promise<{ url: string; expires_at: string }> {
  const url = await signGetUrl({ key, expiresInSeconds: CLIP_URL_TTL_S });
  return { url, expires_at: new Date(now + CLIP_URL_TTL_S * 1000).toISOString() };
}
