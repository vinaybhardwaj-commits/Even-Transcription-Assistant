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
import { clipKeyOf, decodeCursor, encodeCursor, layerAbsent, layerError, layerNotAvailable, layerOk, loadCatalog, presignClip, readPartsLayer, readTranscriptLayer, searchView, CATALOG_MIN_DATE, type Layer, type Row } from "@/lib/room-access/readers/catalog-consult";
import { argBool, argInt, argStr, failSafe, type McpTool, type ToolArgs } from "../registry";
import { AmbiguousRoomError, resolveRoom } from "./brain";

export const CATALOG_ACTIONS = ["search", "get", "clip_audio_url"] as const;
export const CATALOG_LIMIT_DEFAULT = 50;
export const CATALOG_LIMIT_MAX = 200;
export const CATALOG_MAX_SPAN_DAYS = 92;
export const CATALOG_DEFAULT_DAYS = 30;
const UID = /^[A-Za-z0-9_-]{6,64}$/;
const DOCTOR = /^[A-Za-z0-9_.:@-]{1,64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

const HELP = [
  "Read-only; touches no room. Times UTC; from/to are IST dates. Encounter Explorer catalog (palimpsest C1) of consults since 2026-09-09. Internal admins only; NO PHI removal: include_text=true returns transcript text.",
  "action=search {doctor_uid?, room?, from?, to? (span <= 92 days, clamped to 2026-09-09), source? cutter|caa, limit<=200 (default 50), cursor?}: newest first, layers without keys plus layers_present, next_cursor, total_matched, n_bad_lines, n_blind_excluded. has_rx arrives with catalog C2.",
  "action=get {consult_uid, include_text?}: the full row and layers {transcript, parts, freescript, rubric, jev, cdmss, rx}; each is {status: ok|absent|not_available|error, source: [track paths with cfg8 | table], data}. One layer failing never fails the call.",
  "action=clip_audio_url {consult_uid}: presigned GET of the clip, 900 s, {url, expires_at, bytes, minutes, signature_sha256}. The URL is never audited or logged.",
  "Held-out room-days are refused blind_room_day on get and clip_audio_url and left out of search.",
].join(" ");

const badArgs = (detail: string) => ({ ok: false, error: "bad_args", detail });
const realDate = (s: string | null): s is string => !!s && DATE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const shift = (d: string, days: number): string => new Date(Date.parse(`${d}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const rowRoom = (r: Row): string => (typeof r.room_id === "string" ? r.room_id : "");
const rowDay = (r: Row): string => (typeof r.ist_date === "string" ? r.ist_date.slice(0, 10) : "");
const blind = (r: Row): boolean => isBlindRoomDay(rowDay(r), rowRoom(r));
const tOpen = (r: Row): number => (typeof r.t_open === "number" && Number.isFinite(r.t_open) ? r.t_open : Number.NEGATIVE_INFINITY);

async function search(args: ToolArgs): Promise<Row> {
  if ("has_rx" in args) return badArgs("has_rx arrives with catalog C2");
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
  const page = matched.slice(offset, offset + limit);
  const end = offset + page.length;
  return {
    ok: true,
    ...(clamped ? { clamped: true } : {}),
    ...(defaultWindow ? { default_window: true } : {}),
    rows: page.map(searchView),
    next_cursor: end < matched.length ? encodeCursor(end) : null,
    total_matched: matched.length,
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

async function get(args: ToolArgs): Promise<Row> {
  const uid = argStr(args, "consult_uid", 64);
  if (!uid || !UID.test(uid)) return badArgs("consult_uid must match [A-Za-z0-9_-]{6,64}");
  const includeText = argBool(args, "include_text");
  const cat = await loadCatalog();
  if (!cat) return { ok: false, error: "catalog_unavailable" };
  const row = cat.rows.get(uid);
  if (!row) return { ok: false, error: "not_found" };
  if (blind(row)) return { ok: false, error: "blind_room_day" };
  const [transcript, parts, freescript, rubric, jev] = await Promise.all([
    guard([], () => readTranscriptLayer(row, includeText)),
    guard([], () => readPartsLayer(row)),
    guard(["freescript_latest"], () => freescriptLayer(uid, includeText)),
    guard(["rubric_result"], () => rubricLayer(uid)),
    guard(["jev_decision"], () => jevLayer(uid)),
  ]);
  return {
    ok: true,
    row,
    layers: { transcript, parts, freescript, rubric, jev, cdmss: layerNotAvailable(["consult-audit S5 (pending)"]), rx: layerNotAvailable(["catalog C2 (pending)"]) },
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
  const key = clipKeyOf(row);
  if (!key) return { ok: false, error: "bad_clip_key" };
  let signed: { url: string; expires_at: string };
  try {
    signed = await presignClip(key);
  } catch {
    return { ok: false, error: "presign_failed" };
  }
  const clip = (row.clip ?? {}) as Row;
  return { ok: true, url: signed.url, expires_at: signed.expires_at, bytes: clip.bytes ?? null, minutes: clip.minutes ?? null, signature_sha256: clip.signature_sha256 ?? null };
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
    },
    required: ["action"],
    additionalProperties: false,
  },
  handler: async (args: ToolArgs) => {
    const action = argStr(args, "action", 32);
    if (!action || !(CATALOG_ACTIONS as readonly string[]).includes(action)) return { ok: false, error: "unknown_action", allowed: [...CATALOG_ACTIONS] };
    return failSafe({ ok: false, error: "catalog_unavailable" }, async () => (action === "search" ? search(args) : action === "get" ? get(args) : clipAudioUrl(args)));
  },
};

export const CATALOG_TOOLS: McpTool[] = [catalogTool];
