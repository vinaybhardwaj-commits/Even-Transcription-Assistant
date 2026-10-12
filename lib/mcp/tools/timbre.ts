/**
 * lib/mcp/tools/timbre.ts — scribe_timbre (Timbre T-15, Architecture #85): stored Timbre v1 patient-voice affect, read-only.
 *
 * Reads the 0155 tables (#78) through the APP connection (@/lib/db), never @/lib/brain/db / brain_svc (#56: brain_svc has no
 * SELECT on app-owned tables, and a 42501 there was once masked as a tool error). Errors are `db_error:<sqlstate>`.
 * Listed for EVERY profile (Vinay's ruling, 11 Oct 2026: no lab-only gate). Read scope. No writes.
 *
 * Exactly one selector: encounter_id | room + date | doctor_uid8 + date_from/date_to (<= 92 days). Anything else is bad_args.
 *
 * RAW vs CALIBRATED (test 10 ruling, 11 Oct): both are returned. RAW is the default for trends and aggregates (it keeps the
 * ranking information); CALIBRATED is a display-only 1-5 scale (isotonic calibration collapses scores and lowered valence
 * Spearman 0.51 -> 0.39-0.46). Aggregates are computed on raw window scores; calibrated medians ride along labelled display-only.
 *
 * Never returned: audio, presigned links, R2 keys, transcript text, patient identifiers, clinician names. doctor_uid8 is a
 * pseudonymous calibration cell; doctor aggregates are research cells and are NEVER a ranking: there is no sort-by-score,
 * top/bottom or percentile option, and rows come back in time order. Missing patient voice is `scorable:false` with a reason,
 * never "neutral" and never 0. Held-out room-days (BLIND_ROOM_DAYS) are refused (`blind_room_day`) or withheld and counted,
 * never named.
 */
import { sql } from "@/lib/db";
import { isBlindRoomDay } from "@/lib/rubrics/blind-room-days";
import { argBool, argInt, argStr, type McpTool, type ToolArgs } from "../registry";

type Row = Record<string, unknown>;

export const TIMBRE_MAX_RANGE_DAYS = 92;
export const TIMBRE_MIN_CELL_SCORABLE = 5;
export const TIMBRE_LIMIT_DEFAULT = 100;
export const TIMBRE_LIMIT_MAX = 500;

export const TIMBRE_CAVEATS = [
  "Valence agreement with clinician labels is only about Spearman 0.50-0.58 (pooled 0.50, batch 2 0.58).",
  "Arousal is Odyssey WavLM-dim (audEERING MSP-dim only as a fallback); valence is Clef-omni (Cloudflare Workers AI).",
  "Test 11 (pre-registered) found Timbre does NOT predict surgery booking: never use it as an uptake or conversion predictor.",
  "Missing voiceprints mean unscorable windows; % scorable is part of every answer. Unscorable is never neutral.",
  "Raw scores are the default for trends and aggregates; calibrated values are a display-only 1-5 scale (test 10: calibration lowers ranking).",
  "doctor_uid8 aggregates are research cells, never a ranking; cells under 5 scorable windows are withheld.",
] as const;

export const TIMBRE_SCALE_NOTE =
  "raw = default for trends/aggregates (arousal model units; valence Clef 1-5 expected value); calibrated = display-only 1-5.";

const HELP = [
  "READS stored Timbre v1 patient-voice affect (tables affect_window / affect_consult_latest, migration 0155). Pass EXACTLY ONE selector:",
  "encounter_id (a doctor-PWA encounter id / consult_uid; windows included by default),",
  "room + date (room slug or id, IST YYYY-MM-DD: every consult in that room-day plus a room-day cell),",
  "or doctor_uid8 + date_from + date_to (IST dates, at most 92 days: that calibration cell's consults plus monthly cells).",
  "Optional include_windows, limit (default 100, max 500). Per window: t_start/t_end (UTC) and offsets, scorable, reason, arousal_raw, valence_raw,",
  "arousal_calibrated, valence_calibrated (display-only 1-5), calibration levels, arousal_model, purity, pure_patient_s.",
  "Per consult: n windows, % scorable, raw medians (default) and calibrated medians (display-only), open/mid/close trajectory, reason counts, run id, pipeline version, git sha, calibration map ids.",
  "Rows are in time order; there is no sort-by-score option. Never returns audio, links, R2 keys, text, patient identifiers or names. Times UTC.",
  "CAVEATS: " + TIMBRE_CAVEATS.join(" "),
].join(" ");

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UID8 = /^[A-Za-z0-9]{8}$/;
const ENC = /^[A-Za-z0-9_@:.\-]{4,128}$/;
const ROOM = /^[A-Za-z0-9_.\- ]{1,96}$/;

const realDate = (s: string | null): s is string => !!s && DATE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const n = (v: unknown): number | null => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
const iso = (ms: unknown): string | null => (n(ms) === null ? null : new Date(Number(n(ms))).toISOString());
const dayOf = (v: unknown): string => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? "").slice(0, 10));
const REASONS = ["no_voiceprint", "no_patient", "low_purity", "short_pure_speech", "low_patient_cosine", "overlap", "too_short", "attender_speaks_for_patient", "model_error"] as const;

type Selector =
  | { kind: "encounter"; encounterId: string }
  | { kind: "room_day"; room: string; date: string }
  | { kind: "doctor"; doctor: string; from: string; to: string };

export function parseSelector(args: ToolArgs): { ok: true; sel: Selector } | { ok: false; error: string; detail: string } {
  const has = (k: string) => args[k] !== undefined && args[k] !== null && args[k] !== "";
  const picked = [has("encounter_id"), has("room") || has("date"), has("doctor_uid8") || has("date_from") || has("date_to")].filter(Boolean).length;
  if (picked !== 1) return { ok: false, error: "bad_args", detail: "pass exactly one selector: encounter_id | room+date | doctor_uid8+date_from+date_to" };
  if (has("encounter_id")) {
    const e = argStr(args, "encounter_id", 128);
    if (!e || !ENC.test(e)) return { ok: false, error: "bad_args", detail: "encounter_id malformed" };
    return { ok: true, sel: { kind: "encounter", encounterId: e } };
  }
  if (has("room") || has("date")) {
    const room = argStr(args, "room", 96);
    const date = argStr(args, "date", 10);
    if (!room || !ROOM.test(room) || !realDate(date)) return { ok: false, error: "bad_args", detail: "room and date (IST YYYY-MM-DD) are both required" };
    return { ok: true, sel: { kind: "room_day", room, date } };
  }
  const doctor = argStr(args, "doctor_uid8", 8);
  const from = argStr(args, "date_from", 10);
  const to = argStr(args, "date_to", 10);
  if (!doctor || !UID8.test(doctor) || !realDate(from) || !realDate(to)) return { ok: false, error: "bad_args", detail: "doctor_uid8 (8 chars) with date_from and date_to (IST YYYY-MM-DD)" };
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  if (days < 0 || days > TIMBRE_MAX_RANGE_DAYS - 1) return { ok: false, error: "bad_args", detail: `date range must be 1-${TIMBRE_MAX_RANGE_DAYS} days` };
  return { ok: true, sel: { kind: "doctor", doctor, from, to } };
}

const CONSULT_COLS = `run_id, consult_uid, cut_version, encounter_consult_key, room_id, room_slug, ist_date, doctor_uid8, n_windows, n_scorable, scorable_pct,
  arousal_raw_median, valence_raw_median, arousal_median, valence_median,
  arousal_raw_open, arousal_raw_mid, arousal_raw_close, valence_raw_open, valence_raw_mid, valence_raw_close,
  arousal_open, arousal_mid, arousal_close, valence_open, valence_mid, valence_close,
  n_no_voiceprint, n_no_patient, n_low_purity, n_short_pure_speech, n_low_patient_cosine, n_overlap, n_too_short,
  n_attender_speaks_for_patient, n_model_error, pipeline_version, git_sha, calibration_arousal_id, calibration_valence_id, text_lane_on`;

/** The consult shape returned. A 0-scorable consult has null medians and trajectory by construction (CHECK in 0155). */
export function consultView(r: Row): Row {
  const reasons: Row = {};
  for (const k of REASONS) reasons[k] = n(r[`n_${k}`]) ?? 0;
  const scorable = n(r.n_scorable) ?? 0;
  return {
    consult_uid: r.consult_uid,
    cut_version: r.cut_version,
    encounter_consult_key: r.encounter_consult_key ?? null,
    room_slug: r.room_slug ?? null,
    room_id: r.room_id ?? null,
    ist_date: dayOf(r.ist_date),
    doctor_uid8: r.doctor_uid8 ?? null,
    n_windows: n(r.n_windows) ?? 0,
    n_scorable: scorable,
    scorable_pct: n(r.scorable_pct),
    status: scorable > 0 ? "scored" : "unscorable",
    raw: {
      arousal_median: n(r.arousal_raw_median),
      valence_median: n(r.valence_raw_median),
      trajectory: {
        arousal: { open: n(r.arousal_raw_open), mid: n(r.arousal_raw_mid), close: n(r.arousal_raw_close) },
        valence: { open: n(r.valence_raw_open), mid: n(r.valence_raw_mid), close: n(r.valence_raw_close) },
      },
    },
    calibrated_display_only: {
      arousal_median: n(r.arousal_median),
      valence_median: n(r.valence_median),
      trajectory: {
        arousal: { open: n(r.arousal_open), mid: n(r.arousal_mid), close: n(r.arousal_close) },
        valence: { open: n(r.valence_open), mid: n(r.valence_mid), close: n(r.valence_close) },
      },
    },
    unscorable_reasons: reasons,
    run: {
      run_id: n(r.run_id),
      pipeline_version: r.pipeline_version ?? null,
      git_sha: r.git_sha ?? null,
      calibration_map_ids: { arousal: n(r.calibration_arousal_id), valence: n(r.calibration_valence_id) },
    },
  };
}

/** The window shape returned: unscorable windows carry a reason and null scores, never "neutral". */
export function windowView(r: Row, textLaneOn: boolean): Row {
  const scorable = r.scorable === true || r.scorable === "t" || r.scorable === "true";
  const out: Row = {
    t_start: iso(r.abs_start_ms),
    t_end: iso(r.abs_end_ms),
    offset_start_s: n(r.start_ms) === null ? null : Number(r.start_ms) / 1000,
    offset_end_s: n(r.end_ms) === null ? null : Number(r.end_ms) / 1000,
    scorable,
    reason: scorable ? null : (r.unscorable_reason ?? "model_error"),
    arousal_raw: scorable ? n(r.arousal_raw) : null,
    valence_raw: scorable ? n(r.valence_raw) : null,
    arousal_calibrated: scorable ? n(r.arousal_calibrated) : null,
    valence_calibrated: scorable ? n(r.valence_calibrated) : null,
    arousal_calibration_level: scorable ? (r.arousal_calibration_level ?? null) : null,
    valence_calibration_level: scorable ? (r.valence_calibration_level ?? null) : null,
    arousal_model: scorable ? (r.arousal_model ?? null) : null,
    purity: n(r.purity),
    pure_patient_s: n(r.pure_patient_s),
  };
  if (textLaneOn && r.text_status != null) out.text_lane_secondary = { valence: n(r.text_valence), arousal: n(r.text_arousal), status: r.text_status };
  return out;
}

/** A cell: withheld (counted, scores null) under TIMBRE_MIN_CELL_SCORABLE scorable windows. Raw first; calibrated labelled display-only. */
export function cellView(r: Row, key: Row): Row {
  const scorable = n(r.n_scorable) ?? 0;
  const nw = n(r.n_windows) ?? 0;
  const withheld = scorable < TIMBRE_MIN_CELL_SCORABLE;
  return {
    ...key,
    n_consults: n(r.n_consults) ?? 0,
    n_windows: nw,
    n_scorable: scorable,
    scorable_pct: nw ? Math.round((10000 * scorable) / nw) / 100 : null,
    withheld,
    raw: withheld ? null : { arousal_median: n(r.arousal_raw_median), valence_median: n(r.valence_raw_median) },
    calibrated_display_only: withheld ? null : { arousal_median: n(r.arousal_cal_median), valence_median: n(r.valence_cal_median) },
  };
}

const sqlState = (e: unknown): string => {
  const code = (e as { code?: unknown })?.code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : "unknown";
};

async function readWindows(runId: number, consultUid: string, cutVersion: string, textLaneOn: boolean, limit: number): Promise<Row[]> {
  const rows = (await sql`
    SELECT start_ms, end_ms, abs_start_ms, abs_end_ms, scorable, unscorable_reason, arousal_raw, valence_raw, arousal_calibrated,
           valence_calibrated, arousal_calibration_level, valence_calibration_level, arousal_model, purity, pure_patient_s,
           text_valence, text_arousal, text_status
      FROM affect_window
     WHERE run_id = ${runId} AND consult_uid = ${consultUid} AND cut_version = ${cutVersion}
     ORDER BY start_ms, window_key
     LIMIT ${limit}`) as Row[];
  return rows.map((r) => windowView(r, textLaneOn));
}

const CELL_SQL = `count(DISTINCT (l.consult_uid, l.cut_version))::int AS n_consults, count(w.window_key)::int AS n_windows,
  (count(w.window_key) FILTER (WHERE w.scorable))::int AS n_scorable,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY w.arousal_raw) FILTER (WHERE w.scorable) AS arousal_raw_median,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY w.valence_raw) FILTER (WHERE w.scorable) AS valence_raw_median,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY w.arousal_calibrated) FILTER (WHERE w.scorable) AS arousal_cal_median,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY w.valence_calibrated) FILTER (WHERE w.scorable) AS valence_cal_median`;

const base = () => ({ ok: true, caveats: [...TIMBRE_CAVEATS], scale_note: TIMBRE_SCALE_NOTE, times: "UTC" });

export async function timbreRead(args: ToolArgs): Promise<Row> {
  const p = parseSelector(args);
  if (!p.ok) return { ok: false, error: p.error, detail: p.detail };
  const sel = p.sel;
  const limit = argInt(args, "limit", TIMBRE_LIMIT_DEFAULT, 1, TIMBRE_LIMIT_MAX);
  const includeWindows = args.include_windows === undefined ? sel.kind === "encounter" : argBool(args, "include_windows");
  try {
    let consults: Row[];
    if (sel.kind === "encounter") {
      consults = (await sql(
        `SELECT ${CONSULT_COLS} FROM affect_consult_latest
          WHERE consult_uid = $1 OR encounter_consult_key = $1 OR split_part(encounter_consult_key, '@', 1) = $1
          ORDER BY ist_date, consult_uid, cut_version LIMIT $2`,
        [sel.encounterId, limit],
      )) as Row[];
    } else if (sel.kind === "room_day") {
      consults = (await sql(
        `SELECT ${CONSULT_COLS} FROM affect_consult_latest
          WHERE (room_slug = $1 OR room_id = $1) AND ist_date = $2::date
          ORDER BY consult_uid, cut_version LIMIT $3`,
        [sel.room, sel.date, limit],
      )) as Row[];
    } else {
      consults = (await sql(
        `SELECT ${CONSULT_COLS} FROM affect_consult_latest
          WHERE doctor_uid8 = $1 AND ist_date BETWEEN $2::date AND $3::date
          ORDER BY ist_date, consult_uid, cut_version LIMIT $4`,
        [sel.doctor, sel.from, sel.to, limit],
      )) as Row[];
    }
    const blind = consults.filter((c) => isBlindRoomDay(dayOf(c.ist_date), typeof c.room_id === "string" ? c.room_id : null));
    if (blind.length && sel.kind !== "doctor") return { ok: false, error: "blind_room_day" };
    const visible = consults.filter((c) => !blind.includes(c));
    const out: Row = { ...base(), selector: sel.kind, consults: [] as Row[], withheld_blind_consults: blind.length };
    const list: Row[] = [];
    for (const c of visible) {
      const view = consultView(c);
      if (includeWindows) view.windows = await readWindows(Number(c.run_id), String(c.consult_uid), String(c.cut_version), c.text_lane_on === true, TIMBRE_LIMIT_MAX);
      list.push(view);
    }
    out.consults = list;
    out.n_consults = list.length;
    out.truncated = consults.length >= limit;
    if (sel.kind === "room_day") {
      const cells = (await sql(
        `SELECT ${CELL_SQL} FROM affect_consult_latest l
           JOIN affect_window w ON w.run_id = l.run_id AND w.consult_uid = l.consult_uid AND w.cut_version = l.cut_version
          WHERE (l.room_slug = $1 OR l.room_id = $1) AND l.ist_date = $2::date`,
        [sel.room, sel.date],
      )) as Row[];
      out.aggregate = cellView(cells[0] ?? {}, { room: sel.room, ist_date: sel.date });
    } else if (sel.kind === "doctor") {
      const cells = (await sql(
        `SELECT to_char(date_trunc('month', l.ist_date), 'YYYY-MM') AS month, ${CELL_SQL}
           FROM affect_consult_latest l
           JOIN affect_window w ON w.run_id = l.run_id AND w.consult_uid = l.consult_uid AND w.cut_version = l.cut_version
          WHERE l.doctor_uid8 = $1 AND l.ist_date BETWEEN $2::date AND $3::date
          GROUP BY 1 ORDER BY 1`,
        [sel.doctor, sel.from, sel.to],
      )) as Row[];
      out.aggregates_monthly = cells.map((r) => cellView(r, { doctor_uid8: sel.doctor, month: r.month }));
      out.aggregate_note = "research cell for one pseudonymous calibration cell; never a ranking or a comparison across doctors";
    }
    if (blind.length) out.aggregate_note = `${out.aggregate_note ?? ""} held-out room-days are excluded from consults; monthly cells may include them only as counts`.trim();
    return out;
  } catch (e) {
    return { ok: false, error: `db_error:${sqlState(e)}` };
  }
}

export const timbreTool: McpTool = {
  name: "scribe_timbre",
  description: HELP,
  scope: "read",
  inputSchema: {
    type: "object",
    properties: {
      encounter_id: { type: "string", description: "doctor-PWA encounter id / consult_uid (selector 1)" },
      room: { type: "string", description: "room slug or id, with date (selector 2)" },
      date: { type: "string", description: "IST date YYYY-MM-DD, with room" },
      doctor_uid8: { type: "string", description: "pseudonymous calibration cell, with date_from/date_to (selector 3; never a ranking)" },
      date_from: { type: "string", description: "IST date YYYY-MM-DD" },
      date_to: { type: "string", description: "IST date YYYY-MM-DD; range at most 92 days" },
      include_windows: { type: "boolean", description: "per-window rows (default true for encounter_id, false otherwise)" },
      limit: { type: "number", description: "max consults (default 100, max 500)" },
    },
    additionalProperties: false,
  },
  handler: async (args: ToolArgs) => timbreRead(args),
};

export const TIMBRE_TOOLS: readonly McpTool[] = [timbreTool];
