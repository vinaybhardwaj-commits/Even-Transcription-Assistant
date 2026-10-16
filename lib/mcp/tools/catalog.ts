/**
 * lib/mcp/tools/catalog.ts — scribe_catalog: the read tool for the Encounter Explorer (CATALOG-1, 14 Oct 2026).
 *
 * One tool, `action` picks the work, all READ scope: search | get | clip_audio_url. The catalog is palimpsest's C1 ledger (R2, one exact key); the layers of a consult are palimpsest's artefacts read by the
 * keys on the catalog row. Internal admins only, history from 2026-09-09, NO PHI removal: `get` with include_text=true returns transcript text. A room-restricted token never reaches this tool
 * (default deny, registry.ts). Nothing here writes; the presigned clip URL is in the answer only, never in an audit row or a log line.
 * Details: docs/operator-mcp/TOOL-NOTES.md and scribe_help.
 */
import { freescriptRead } from "./freescript";
import { istDateOf } from "@/lib/sarvam-lab";
import { listJevDecisions } from "@/lib/room-access/tool-reads";
import { listResults } from "@/lib/rubrics/store";
import { isBlindRoomDay } from "@/lib/rubrics/blind-room-days";
import { fetchManifest, clipKeyOf, clipAbsent, sealReasonOf, CLIP_CHUNK_MAX, readClipChunk, decodeCursor, encodeCursor, layerAbsent, layerError, layerNotAvailable, layerOk, loadCatalog, presignClip, readAudioFeaturesLayer, readPartsLayer, readTranscriptLayer, searchView, CATALOG_MIN_DATE, type Layer, type Row } from "@/lib/room-access/readers/catalog-consult";
import { consultsByIdentity, hasAnyIdentity, IDENTITY_CHUNK, IDENTITY_ID, identityFor, identityView, pulseUrl, type IdentityRow } from "@/lib/room-access/readers/catalog-identity";
import { c4For, c4View, type C4Row } from "@/lib/room-access/readers/catalog-c4";
import { ADMIN_ACTOR_PREFIX } from "../auth";
import { argBool, argInt, argStr, failSafe, ToolScopeError, type McpTool, type ToolArgs, type ToolContext } from "../registry";
import { AmbiguousRoomError, resolveRoom } from "./brain";

export const CATALOG_ACTIONS = ["search", "get", "clip_audio_url", "clip_audio_chunk", "explorer_link"] as const;
export const CATALOG_LIMIT_DEFAULT = 50;
export const CATALOG_LIMIT_MAX = 200;
export const CATALOG_MAX_SPAN_DAYS = 92;
export const CATALOG_DEFAULT_DAYS = 30;
export const CATALOG_HAS_RX_MAX_DAYS = 31;
const UID = /^[A-Za-z0-9_-]{6,64}$/;
const DOCTOR = /^[A-Za-z0-9_.:@-]{1,64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

const HELP = [
  "Read-only; touches no room. Times UTC; from/to are IST dates. Encounter Explorer catalog (palimpsest C1) of consults since 2026-09-09. Internal admins only; NO PHI removal: include_text=true returns transcript text; include_identity=true and the prescription_uid / individual_uid filters need the admin scope; they return names, ids and the Pulse link (rx.prescription only with include_text too).",
  "action=search {doctor_uid?, room?, from?, to? (span <= 92 days, clamped to 2026-09-09), source? cutter|caa, limit<=200 (default 50), cursor?}: newest first, layers without keys plus layers_present, next_cursor, total_matched, n_bad_lines, n_blind_excluded. Filters has_prescription (alias has_rx), prescription_uid, individual_uid join encounter_catalog (identity_rows says how many consults had a row; an empty table returns no rows, never a false has_prescription=false). include_identity=true adds identity per row. Admin callers also get catalog_c4 per row: {jev, clef_affect, presence} (ids, tokens, scores and UTC ms from migration 0169; null when unset).",
  "action=get {consult_uid, include_text?, include_identity?}: the full row and layers {transcript, parts, audio_features (timbre/talktime/clef rows), freescript, rubric, jev, identity, cdmss, rx}; each is {status: ok|absent|not_available|error, source: [track paths with cfg8 | table], data}. One layer failing never fails the call. Admin callers also get layers.catalog_c4 (the same {jev, clef_affect, presence}). For admin callers, layers.jev falls back to catalog_c4.jev (source encounter_catalog.jev (C4)) when jev_decision has no rows.",
  "action=clip_audio_url {consult_uid}: presigned GET of the clip, 900 s, {url, expires_at, bytes, minutes, audio_sha256, cut_signature_sha256}; audio_sha256 is the hash of the FLAC bytes (null when absent), cut_signature_sha256 hashes the cut metadata, not the audio. The URL is never audited or logged.",
  "action=clip_audio_chunk {consult_uid, offset?, length? <= 1 MiB}: the stored FLAC bytes as base64, {offset, length, total_bytes, content_type, base64, done, audio_sha256 (FLAC bytes hash, null when absent), cut_signature_sha256 (cut metadata, not the audio)}; bad_range past the end.",
  "A consult with no clip key answers no_clip {sealed: the row's stored seal reason token, or null} on clip_audio_url and clip_audio_chunk; bad_clip_key is a key that fails the allowlist or the row binding.",
  "action=explorer_link {consult_uid} | {doctor_uid, date (IST, clamped to 2026-09-09)} | {individual_uid}: admin only (admin_required otherwise); {url, kind} deep link into the Encounter Explorer (SCRIBE_EXPLORER_URL); reads nothing and does not check the id exists.",
  "Held-out room-days are refused blind_room_day on get, clip_audio_url and clip_audio_chunk and left out of search.",
].join(" ");

const badArgs = (detail: string) => ({ ok: false, error: "bad_args", detail });
const realDate = (s: string | null): s is string => !!s && DATE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const shift = (d: string, days: number): string => new Date(Date.parse(`${d}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const rowRoom = (r: Row): string => (typeof r.room_id === "string" ? r.room_id : "");
const rowDay = (r: Row): string => (typeof r.ist_date === "string" ? r.ist_date.slice(0, 10) : "");
const blind = (r: Row): boolean => isBlindRoomDay(rowDay(r), rowRoom(r));
const tOpen = (r: Row): number => (typeof r.t_open === "number" && Number.isFinite(r.t_open) ? r.t_open : Number.NEGATIVE_INFINITY);

async function search(args: ToolArgs, isAdmin = false): Promise<Row> {
  // V3: has_rx is an alias of has_prescription
  const rawHas = args.has_prescription !== undefined && args.has_prescription !== null && args.has_prescription !== "" ? args.has_prescription : args.has_rx;
  let hasPresc: boolean | null = null;
  if (rawHas !== undefined && rawHas !== null && rawHas !== "") {
    if (rawHas === true || rawHas === "true") hasPresc = true;
    else if (rawHas === false || rawHas === "false") hasPresc = false;
    else return badArgs("has_prescription is a boolean");
  }
  const idFilter = (k: string): string | null | "bad" => {
    const v = args[k];
    if (v === undefined || v === null || v === "") return null;
    return typeof v === "string" && IDENTITY_ID.test(v) ? v : "bad";
  };
  const prescUid = idFilter("prescription_uid");
  const indivUid = idFilter("individual_uid");
  if (prescUid === "bad" || indivUid === "bad") return badArgs("prescription_uid and individual_uid match [A-Za-z0-9_.:@-]{1,128}");
  const includeIdentity = argBool(args, "include_identity");
  const doctor = args.doctor_uid === undefined || args.doctor_uid === null || args.doctor_uid === "" ? null : argStr(args, "doctor_uid", 64);
  if (args.doctor_uid !== undefined && args.doctor_uid !== null && args.doctor_uid !== "" && (!doctor || !DOCTOR.test(doctor))) return badArgs("doctor_uid malformed");
  const source = args.source === undefined || args.source === null || args.source === "" ? null : argStr(args, "source", 16);
  if (args.source !== undefined && args.source !== null && args.source !== "" && source !== "cutter" && source !== "caa") return badArgs("source is cutter or caa");
  let from = args.from === undefined || args.from === null || args.from === "" ? null : argStr(args, "from", 10);
  let to = args.to === undefined || args.to === null || args.to === "" ? null : argStr(args, "to", 10);
  if ((args.from !== undefined && args.from !== null && args.from !== "" && !realDate(from)) || (args.to !== undefined && args.to !== null && args.to !== "" && !realDate(to))) return badArgs("from and to are IST dates YYYY-MM-DD");
  let clamped = false;
  if (from && from < CATALOG_MIN_DATE) {
    from = CATALOG_MIN_DATE;
    clamped = true;
  }
  if (to && to < CATALOG_MIN_DATE) {
    to = CATALOG_MIN_DATE;
    clamped = true;
  }
  const today = istDateOf(Date.now());
  if (to && to > today) {
    to = today;
    clamped = true;
  }
  let defaultWindow = false;
  if (!from && !to) {
    to = today;
    from = shift(today, -(CATALOG_DEFAULT_DAYS - 1));
    if (from < CATALOG_MIN_DATE) from = CATALOG_MIN_DATE;
    defaultWindow = true;
  } else if (from && !to) {
    to = shift(from, CATALOG_MAX_SPAN_DAYS - 1);
    if (to > today) to = today;
  } else if (to && !from) {
    from = shift(to, -(CATALOG_MAX_SPAN_DAYS - 1));
    if (from < CATALOG_MIN_DATE) from = CATALOG_MIN_DATE;
  }
  if (from! > to!) return badArgs("from is after to");
  if (hasPresc !== null && (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS > CATALOG_HAS_RX_MAX_DAYS - 1) return badArgs("has_prescription spans at most 31 days");
  if ((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS > CATALOG_MAX_SPAN_DAYS - 1) return badArgs(`from..to is at most ${CATALOG_MAX_SPAN_DAYS} days`);
  const limit = argInt(args, "limit", CATALOG_LIMIT_DEFAULT, 1, CATALOG_LIMIT_MAX);
  let offset = 0;
  if (args.cursor !== undefined && args.cursor !== null && args.cursor !== "") {
    const c = typeof args.cursor === "string" ? decodeCursor(args.cursor) : null;
    if (c === null) return badArgs("cursor is the previous next_cursor");
    offset = c;
  }
  let roomIds: Set<string> | null = null;
  if (argStr(args, "room", 128)) {
    try {
      const room = await resolveRoom(args);
      if (!room) return { ok: false, error: "unknown_room" };
      roomIds = new Set([room.id, room.slug]);
    } catch (e) {
      if (e instanceof AmbiguousRoomError) return { ok: false, error: "ambiguous_room", matches: e.matches.map((m) => ({ id: m.id, slug: m.slug, name: m.name })) };
      throw e;
    }
  }
  const cat = await loadCatalog();
  if (!cat) return { ok: false, error: "catalog_unavailable" };
  let nBlind = 0;
  const matched: Row[] = [];
  for (const r of cat.rows.values()) {
    const day = rowDay(r);
    if (day < CATALOG_MIN_DATE) continue;
    if (from && day < from) continue;
    if (to && day > to) continue;
    if (doctor && r.doctor_uid !== doctor) continue;
    if (source && r.source !== source) continue;
    if (roomIds && !roomIds.has(rowRoom(r))) continue;
    if (blind(r)) {
      nBlind++;
      continue;
    }
    matched.push(r);
  }
  matched.sort((a, b) => tOpen(b) - tOpen(a) || String(a.consult_uid).localeCompare(String(b.consult_uid)));
  // C5: the id filters run in SQL (bounded by the window) and are intersected with the R2 candidates; has_prescription (window <= 31 days) still joins the candidates in chunks of 500;
  // the identity of the returned page is joined last. A plain search joins only the page.
  let candidates = matched;
  const joined = new Map<string, IdentityRow>();
  let identityRows: number | null = null;
  let identityErr = false;
  const join = async (rows: Row[]): Promise<boolean> => {
    for (let i = 0; i < rows.length; i += IDENTITY_CHUNK) {
      const got = await identityFor(rows.slice(i, i + IDENTITY_CHUNK).map((r) => String(r.consult_uid)));
      if (got.status === "error") return false;
      for (const [k, v] of got.rows) joined.set(k, v);
    }
    return true;
  };
  if (prescUid !== null || indivUid !== null) {
    const m = await consultsByIdentity({ individualUid: indivUid, prescriptionUid: prescUid, from: from!, to: to! });
    if (m.status === "too_many_matches") return { ok: false, error: "too_many_matches" };
    if (m.status === "error") return { ok: false, error: "identity_unavailable" };
    candidates = candidates.filter((r) => m.uids.has(String(r.consult_uid)));
  }
  if (hasPresc !== null) {
    // an empty table must never read as "no prescription": a consult with no joined row never matches has_prescription=false either
    if (!(await join(candidates))) return { ok: false, error: "identity_unavailable" };
    candidates = candidates.filter((r) => joined.get(String(r.consult_uid))?.has_prescription === hasPresc);
  }
  const page = candidates.slice(offset, offset + limit);
  const end = offset + page.length;
  const need = page.filter((r) => !joined.has(String(r.consult_uid)));
  const filtering = hasPresc !== null || prescUid !== null || indivUid !== null;
  if (need.length > 0 || filtering) {
    const ok = await join(need);
    if (!ok && (filtering || includeIdentity)) return { ok: false, error: "identity_unavailable" };
    if (!ok) identityErr = true;
  }
  if (!identityErr) identityRows = joined.size;
  // 23N-2: jev, clef_affect and presence (migration 0169) of the returned page, to admin callers only (ids, tokens and numbers); a read failure is c4_error, never the call's failure
  let c4: Map<string, C4Row> | null = null;
  let c4Err = false;
  if (isAdmin && page.length > 0) {
    const got = await c4For(page.map((r) => String(r.consult_uid)));
    if (got.status === "ok") c4 = got.rows;
    else c4Err = true;
  }
  const view = (r: Row): Row => {
    const j = joined.get(String(r.consult_uid));
    return { ...searchView(r), has_prescription: j ? j.has_prescription : null, ...(includeIdentity ? { identity: j ? identityView(j) : null } : {}), ...(c4 ? { catalog_c4: c4View(c4.get(String(r.consult_uid))) } : {}) };
  };
  return {
    ok: true,
    ...(clamped ? { clamped: true } : {}),
    ...(defaultWindow ? { default_window: true } : {}),
    rows: page.map(view),
    next_cursor: end < candidates.length ? encodeCursor(end) : null,
    total_matched: candidates.length,
    identity_rows: identityRows,
    ...(identityErr ? { identity_error: true } : {}),
    ...(c4Err ? { c4_error: true } : {}),
    n_blind_excluded: nBlind,
    catalog_generated_at: cat.generated_at,
    n_bad_lines: cat.n_bad_lines,
  };
}

const code = (e: unknown): string => {
  const c = (e as { code?: unknown })?.code;
  return typeof c === "string" && /^[0-9A-Z]{5}$/.test(c) ? `db_error:${c}` : "read_failed";
};
/** One layer's failure is that layer's `error`, never the call's. */
async function guard(source: string[], fn: () => Promise<Layer>): Promise<Layer> {
  try {
    return await fn();
  } catch (e) {
    return layerError(source, code(e));
  }
}

const VERDICT = /^[a-z][a-z0-9_]{0,31}$/;
/** F2: a rubric score with only numbers and booleans: no free text can ride along. */
function plainScore(score: unknown): Row | null {
  if (!score || typeof score !== "object" || Array.isArray(score)) return null;
  const out: Row = {};
  for (const [k, v] of Object.entries(score as Row)) if (typeof v === "number" || typeof v === "boolean") out[k] = v;
  return out;
}

async function freescriptLayer(uid: string, includeText: boolean): Promise<Layer> {
  const source = ["freescript_latest"];
  const out = await freescriptRead({ consult_uid: uid, limit: 1 });
  if (out.ok !== true) return layerError(source, typeof out.error === "string" ? out.error.slice(0, 40) : "read_failed");
  const rows = out.rows as Row[];
  const r = rows[0];
  if (!r) return layerAbsent(source);
  return layerOk(source, { artifact_id: r.run_id, state: r.state, validator_status: r.validator, ...(includeText ? { artifact: r.artifact } : {}) });
}

async function rubricLayer(uid: string): Promise<Layer> {
  const source = ["rubric_result (unit_kind=consult, unit_key=consult_uid)"];
  const rows = await listResults({ unit_kind: "consult", unit_key: uid, limit: 100 });
  if (rows.length === 0) return layerAbsent(source);
  return layerOk(
    source,
    rows.map((r) => {
      const score = plainScore(r.score);
      return { rubric_id: r.rubric_id, version: r.version, run_id: r.run_id, status: r.status, score, verdict: typeof (r.score as Row | null)?.verdict === "string" && VERDICT.test((r.score as Row).verdict as string) ? ((r.score as Row).verdict as string) : null, created_at: r.created_at };
    }),
  );
}

async function jevLayer(uid: string): Promise<Layer> {
  const source = ["jev_decision (subject_type=consult)"];
  const rows = (await listJevDecisions<Row>({ subjectType: "consult", subjectId: uid, questionId: null, promptVersion: null, limit: 200 })).rows;
  if (rows.length === 0) return layerAbsent(source);
  return layerOk(
    source,
    rows.map((r) => ({ question_id: r.question_id, question_set_id: r.question_set_id ?? null, prompt_version: r.prompt_version, mode: r.mode ?? null, answer: r.answer, probabilities: r.probabilities ?? null, calibrated_p: r.calibrated_p ?? null, mock: r.mock ?? null, created_at: r.created_at })),
  );
}

/** V2: the identity and rx layers from ONE encounter_catalog read. Names and ids only behind include_identity; the stored prescription only behind include_identity AND include_text. */
async function identityLayers(uid: string, includeIdentity: boolean, includeText: boolean): Promise<{ identity: Layer; rx: Layer }> {
  const source = ["encounter_catalog"];
  const withRx = includeIdentity && includeText;
  const got = await identityFor([uid], { withPrescription: withRx });
  if (got.status === "error") return { identity: layerError(source, got.code), rx: layerError(source, got.code) };
  const r = got.rows.get(uid);
  const anyId = r ? hasAnyIdentity(r) : false;
  const identity: Layer = !r || !anyId
    ? { ...layerAbsent(source), data: includeIdentity ? null : { present: false } }
    : layerOk(source, includeIdentity ? identityView(r) : { present: true });
  const rxPresent = !!r && (r.prescription_uid !== null || r.has_prescription);
  // The order lists prescription_uid and pulse_url (which carries individual_uid) in rx.data; the identity rule says no uids without include_identity. Withheld (null) without the flag: FLAG in the report.
  const rx: Layer = !r || !rxPresent
    ? layerAbsent(source)
    : layerOk(source, {
        prescription_uid: includeIdentity ? r.prescription_uid : null, presc_state: r.presc_state, has_prescription: r.has_prescription,
        pulse_url: includeIdentity ? pulseUrl(r.prescription_uid, r.individual_uid) : null,
        ...(withRx ? { prescription: r.prescription ?? null } : {}),
      });
  return { identity, rx };
}

/** 23N-2: the jev, clef_affect and presence columns of ONE consult (admin callers only): ids, tokens and numbers. A consult with no catalog row, or none of the three set, is absent. */
async function c4Layer(uid: string): Promise<Layer> {
  const source = ["encounter_catalog"];
  const got = await c4For([uid]);
  if (got.status === "error") return layerError(source, got.code);
  const r = got.rows.get(uid);
  if (!r || (r.jev === null && r.clef_affect === null && r.presence === null)) return layerAbsent(source);
  return layerOk(source, c4View(r));
}

/**
 * CATALOG-12: for admin callers, layers.jev falls back to the C4 jev column (encounter_catalog.jev, as stored) when jev_decision has NO rows. jev_decision rows win (no merge);
 * a jev_decision read error stays an error; a C4 layer that is absent or an error leaves jev as it was. Non-admin callers never get it (the C4 columns are admin-only).
 */
function jevWithC4Fallback(jev: Layer, c4layer: Layer | null, isAdmin: boolean): Layer {
  if (!isAdmin || jev.status !== "absent" || !c4layer || c4layer.status !== "ok") return jev;
  const sets = (c4layer.data as { jev?: unknown } | null)?.jev ?? null;
  if (sets === null) return jev;
  return layerOk(["encounter_catalog.jev (C4)"], { origin: "catalog_c4", sets });
}

async function get(args: ToolArgs, isAdmin = false): Promise<Row> {
  const uid = argStr(args, "consult_uid", 64);
  if (!uid || !UID.test(uid)) return badArgs("consult_uid must match [A-Za-z0-9_-]{6,64}");
  const includeText = argBool(args, "include_text");
  const includeIdentity = argBool(args, "include_identity");
  const cat = await loadCatalog();
  if (!cat) return { ok: false, error: "catalog_unavailable" };
  const row = cat.rows.get(uid);
  if (!row) return { ok: false, error: "not_found" };
  if (blind(row)) return { ok: false, error: "blind_room_day" };
  const mf = fetchManifest(row); // C4c: one manifest read shared by transcript and parts
  const [transcript, parts, audioFeatures, freescript, rubric, jev, idl] = await Promise.all([
    guard([], () => readTranscriptLayer(row, includeText, mf)),
    guard([], () => readPartsLayer(row, mf)),
    guard([], () => readAudioFeaturesLayer(row)),
    guard(["freescript_latest"], () => freescriptLayer(uid, includeText)),
    guard(["rubric_result"], () => rubricLayer(uid)),
    guard(["jev_decision"], () => jevLayer(uid)),
    identityLayers(uid, includeIdentity, includeText).catch(() => ({ identity: layerError(["encounter_catalog"], "read_failed"), rx: layerError(["encounter_catalog"], "read_failed") })),
  ]);
  const c4layer = isAdmin ? await guard(["encounter_catalog"], () => c4Layer(uid)) : null;
  return {
    ok: true,
    row,
    layers: { transcript, parts, audio_features: audioFeatures, freescript, rubric, jev: jevWithC4Fallback(jev, c4layer, isAdmin), identity: idl.identity, cdmss: layerNotAvailable(["consult-audit S5 (pending)"]), rx: idl.rx, ...(c4layer ? { catalog_c4: c4layer } : {}) },
  };
}

/** An optional integer argument in [min, max]; a missing one is the default; anything else (fraction, string with junk, out of range) is null. */
function intArg(args: ToolArgs, key: string, def: number, min: number, max: number): number | null {
  const v = args[key];
  if (v === undefined || v === null || v === "") return def;
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,10}$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

/** A 64-char lowercase hex string, else null (a CAA clip has no audio_sha256). */
const hex64 = (v: unknown): string | null => (typeof v === "string" && /^[0-9a-f]{64}$/.test(v) ? v : null);

async function clipAudioChunk(args: ToolArgs): Promise<Row> {
  const uid = argStr(args, "consult_uid", 64);
  if (!uid || !UID.test(uid)) return badArgs("consult_uid must match [A-Za-z0-9_-]{6,64}");
  const offset = intArg(args, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
  if (offset === null) return badArgs("offset is an integer >= 0");
  const length = intArg(args, "length", CLIP_CHUNK_MAX, 1, CLIP_CHUNK_MAX);
  if (length === null) return badArgs(`length is an integer 1..${CLIP_CHUNK_MAX}`);
  const cat = await loadCatalog();
  if (!cat) return { ok: false, error: "catalog_unavailable" };
  const row = cat.rows.get(uid);
  if (!row) return { ok: false, error: "not_found" };
  if (blind(row)) return { ok: false, error: "blind_room_day" };
  if (clipAbsent(row)) return { ok: false, error: "no_clip", sealed: sealReasonOf(row) };
  const key = clipKeyOf(row);
  if (!key) return { ok: false, error: "bad_clip_key" };
  const got = await readClipChunk(key, offset, length);
  if (!got.ok) return got.error === "bad_range" ? { ok: false, error: "bad_range", total_bytes: got.total_bytes } : { ok: false, error: got.error };
  const clip = (row.clip ?? {}) as Row;
  return {
    ok: true, consult_uid: uid, offset, length: got.bytes.length, total_bytes: got.total_bytes, content_type: "audio/flac",
    base64: Buffer.from(got.bytes).toString("base64"), done: offset + got.bytes.length >= got.total_bytes, audio_sha256: hex64(clip.audio_sha256), cut_signature_sha256: hex64(clip.signature_sha256),
  };
}

async function clipAudioUrl(args: ToolArgs): Promise<Row> {
  const uid = argStr(args, "consult_uid", 64);
  if (!uid || !UID.test(uid)) return badArgs("consult_uid must match [A-Za-z0-9_-]{6,64}");
  const cat = await loadCatalog();
  if (!cat) return { ok: false, error: "catalog_unavailable" };
  const row = cat.rows.get(uid);
  if (!row) return { ok: false, error: "not_found" };
  if (blind(row)) return { ok: false, error: "blind_room_day" };
  if (clipAbsent(row)) return { ok: false, error: "no_clip", sealed: sealReasonOf(row) };
  const key = clipKeyOf(row);
  if (!key) return { ok: false, error: "bad_clip_key" };
  let signed: { url: string; expires_at: string };
  try {
    signed = await presignClip(key);
  } catch {
    return { ok: false, error: "presign_failed" };
  }
  const clip = (row.clip ?? {}) as Row;
  return { ok: true, url: signed.url, expires_at: signed.expires_at, bytes: clip.bytes ?? null, minutes: clip.minutes ?? null, audio_sha256: hex64(clip.audio_sha256), cut_signature_sha256: hex64(clip.signature_sha256) };
}

const EXPLORER_BASE = /^https:\/\/claude\.ai\/[A-Za-z0-9/_-]{1,200}$/;
const EXPLORER_ARGS = new Set(["action", "consult_uid", "doctor_uid", "date", "individual_uid"]);

/** CATALOG-13: a deep link into the Explorer, ADMIN ONLY for every form. No database, no R2, no catalog read: the ids are validated for shape only (the Explorer checks they exist). */
function explorerLink(args: ToolArgs, isAdmin: boolean): Row {
  const given = Object.keys(args).filter((k) => args[k] !== undefined && args[k] !== null);
  const stray = given.filter((k) => !EXPLORER_ARGS.has(k));
  if (stray.length > 0) return badArgs("explorer_link takes consult_uid, or doctor_uid and date, or individual_uid");
  const has = (k: string) => given.includes(k);
  const consult = has("consult_uid"), doctor = has("doctor_uid") || has("date"), patient = has("individual_uid");
  if ([consult, doctor, patient].filter(Boolean).length !== 1) return badArgs("give exactly one of consult_uid | doctor_uid and date | individual_uid");
  let fragment: string;
  let kind: string;
  if (consult) {
    const uid = argStr(args, "consult_uid", 64);
    if (!uid || !UID.test(uid)) return badArgs("consult_uid must match [A-Za-z0-9_-]{6,64}");
    fragment = `consult=${uid}`; kind = "consult";
  } else if (doctor) {
    const d = argStr(args, "doctor_uid", 64), date = argStr(args, "date", 10);
    if (!d || !DOCTOR.test(d) || !date) return badArgs("doctor_uid and date (IST YYYY-MM-DD) are both required");
    if (!realDate(date)) return badArgs("date must be a real IST date YYYY-MM-DD");
    fragment = `doctor=${encodeURIComponent(d)}&date=${date < CATALOG_MIN_DATE ? CATALOG_MIN_DATE : date}`; kind = "doctor_day";
  } else {
    const ind = argStr(args, "individual_uid", 64);
    if (!ind || !UID.test(ind)) return badArgs("individual_uid must match [A-Za-z0-9_-]{6,64}");
    fragment = `patient=${ind}`; kind = "patient";
  }
  if (!isAdmin) return { ok: false, error: "admin_required" }; // the whole action is admin-only (FIX2), checked right after the arguments
  const base = process.env.SCRIBE_EXPLORER_URL ?? "";
  if (!EXPLORER_BASE.test(base)) return { ok: false, error: "explorer_url_not_configured" };
  return { ok: true, url: `${base}#${fragment}`, kind };
}

export const catalogTool: McpTool = {
  name: "scribe_catalog",
  description: HELP,
  scope: "read",
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: [...CATALOG_ACTIONS] },
      consult_uid: { type: "string", description: "get, clip_audio_url" },
      include_text: { type: "boolean", description: "get: transcript and artifact text; default false" },
      doctor_uid: { type: "string" },
      room: { type: "string", description: "id, slug or name" },
      from: { type: "string", description: "IST YYYY-MM-DD" },
      to: { type: "string", description: "IST YYYY-MM-DD, span <= 92 days" },
      source: { type: "string", enum: ["cutter", "caa"] },
      limit: { type: "integer", minimum: 1, maximum: CATALOG_LIMIT_MAX, default: CATALOG_LIMIT_DEFAULT },
      cursor: { type: "string", description: "previous next_cursor" },
      offset: { type: "integer", minimum: 0, description: "clip_audio_chunk byte offset" },
      length: { type: "integer", minimum: 1, maximum: CLIP_CHUNK_MAX, description: "clip_audio_chunk bytes" },
      include_identity: { type: "boolean", description: "names, ids, Pulse link; default false" },
      has_prescription: { type: "boolean" },
      prescription_uid: { type: "string" },
      individual_uid: { type: "string" },
      date: { type: "string", description: "explorer_link: IST YYYY-MM-DD" },
    },
    required: ["action"],
    additionalProperties: false,
  },
  handler: async (args: ToolArgs, ctx: ToolContext) => {
    const action = argStr(args, "action", 32);
    if (!action || !(CATALOG_ACTIONS as readonly string[]).includes(action)) return { ok: false, error: "unknown_action", allowed: [...CATALOG_ACTIONS] };
    // C2: names, ids and the Pulse link need the admin scope AND an "admin:" actor (as scribe_admin's writes do), checked before anything is read. has_prescription stays read scope.
    const present = (k: string) => args[k] !== undefined && args[k] !== null && args[k] !== "" && args[k] !== false;
    if (action === "explorer_link") {
      // no scope throw here: a non-admin gets a plain admin_required answer (after bad_args); nothing below (catalog, sql, R2) is touched
      return failSafe({ ok: false, error: "catalog_unavailable" }, async () => explorerLink(args, ctx.scopes.has("admin") && ctx.actor.replace(/^mcp:/, "").startsWith(ADMIN_ACTOR_PREFIX)));
    }
    if ((action === "get" || action === "search") && (argBool(args, "include_identity") || present("prescription_uid") || present("individual_uid"))) {
      if (!ctx.scopes.has("admin") || !ctx.actor.replace(/^mcp:/, "").startsWith(ADMIN_ACTOR_PREFIX)) throw new ToolScopeError("admin", { action });
    }
    const isAdmin = ctx.scopes.has("admin") && ctx.actor.replace(/^mcp:/, "").startsWith(ADMIN_ACTOR_PREFIX);      // 23N-2: the C4 columns go to admin callers only
    return failSafe({ ok: false, error: "catalog_unavailable" }, async () => (action === "search" ? search(args, isAdmin) : action === "get" ? get(args, isAdmin) : action === "clip_audio_chunk" ? clipAudioChunk(args) : clipAudioUrl(args)));
  },
};

export const CATALOG_TOOLS: McpTool[] = [catalogTool];
