/**
 * lib/alerts/ops-sweep.ts — the standing room alerts (gating/opd4-guard S3 b, c, d). One cron run reads the roster's STATE, derives each problem against a fresh clock, and
 * queues at most one message per problem per hour (lib/alerts/ops-alert.ts dedupes in SQL). (a), the retire alert, is written where the retire happens (lib/room-install.ts).
 *
 *   recorder_off   clinic hours (lib/alerts/clinic-hours.ts) and the room's newest chunk, of ANY session, is >= 15 min old (the clock starts at the window start). It reads the
 *                  room's audio, never the install: OPD 4 had no install and a stale machine binding, and every rule that began at the install was silent.
 *   recorder_off   (consult variant, FR1-A) any hour: the room has an OPEN eta_encounter_windows row (t_close IS NULL, opened within CONSULT_WINDOW_MAX_AGE_MIN, open >= CONSULT_WINDOW_MIN_OPEN_MIN)
 *                  and max(newest chunk, t_open) is >= CONSULT_RECORDER_OFF_MINUTES old. Own dedupe key, so it can stand beside the plain rule.
 *   mic_denied     the room's live install reports mic_state 'denied'; or, with no live install, the newest retired one did. Any hour.
 *   no_machine     clinic hours and the roster room has NO live (enrolled, un-retired) install. The steward's own rule (lib/steward/rules.ts) also reads a config machine override;
 *                  this one asks only whether a recorder is installed.
 *
 * "We looked and found nothing" and "we never looked" are different: a source that cannot be read is named in `degraded` and its rule is skipped, never read as healthy or as dark.
 */
import { sql } from "@/lib/db";
import { lastChunkByRoom, openEncounterWindowsByRoom } from "@/lib/room-access/tool-reads";
import { ROOMS } from "@/lib/rooms-live/rooms";
import { CONSULT_RECORDER_OFF_MINUTES, isClinicHours, recorderOffMinutes } from "./clinic-hours";
import { queueOpsAlert, type OpsAlert } from "./ops-alert";

/** An open window older than this is a stuck/unclosed row, not a consult in progress. */
export const CONSULT_WINDOW_MAX_AGE_MIN = 90;
/** A window must have been open this long before it can page (a recorder needs a moment to start). */
export const CONSULT_WINDOW_MIN_OPEN_MIN = 3;

export type SweepInputs = {
  now_ms: number;
  /** room_id -> newest chunk time (ms) over the room's sessions of the lookback; absent = none in the lookback */
  last_chunk_ms: ReadonlyMap<string, number> | null;
  /** room_id -> the live install's mic_state (null when it reports none); absent room = no live install */
  live_installs: ReadonlyMap<string, { mic_state: string | null }> | null;
  /** room_id -> the mic_state of the room's newest RETIRED install, for rooms with no live install. Absent = the source was not read (rule skipped). */
  retired_installs?: ReadonlyMap<string, { mic_state: string | null }> | null;
  /** room_id -> slug, for the message; a room missing from it is named by its id */
  slugs?: ReadonlyMap<string, string>;
  /** FR1-A: room_id -> t_open (ms) of each room's open consult window (the OLDEST open one when several). null/absent = the source was not read (consult rule skipped). */
  open_windows?: ReadonlyMap<string, number> | null;
  /** room_id -> room.name, carried in the body beside the slug */
  names?: ReadonlyMap<string, string>;
};

/** PURE — the alerts that stand right now. A null source skips its rules (they are "degraded", not "fine"). */
export function planOpsAlerts(inp: SweepInputs): OpsAlert[] {
  const out: OpsAlert[] = [];
  const clinic = isClinicHours(inp.now_ms);
  for (const room of ROOMS) {
    const slug = inp.slugs?.get(room.room_id) ?? room.room_id;
    const room_name = inp.names?.get(room.room_id);
    if (inp.last_chunk_ms !== null) {
      const mins = recorderOffMinutes(inp.now_ms, inp.last_chunk_ms.get(room.room_id) ?? null);
      if (mins !== null) out.push({ kind: "recorder_off", room_id: room.room_id, room_slug: slug, room_name, minutes: mins });
    }
    if (inp.last_chunk_ms !== null && inp.open_windows) {
      const tOpen = inp.open_windows.get(room.room_id);
      if (tOpen !== undefined && Number.isFinite(tOpen)) {
        const openMin = Math.floor((inp.now_ms - tOpen) / 60_000);
        if (openMin >= CONSULT_WINDOW_MIN_OPEN_MIN && openMin <= CONSULT_WINDOW_MAX_AGE_MIN) {
          const since = Math.max(inp.last_chunk_ms.get(room.room_id) ?? -Infinity, tOpen);
          const quiet = Math.floor((inp.now_ms - since) / 60_000);
          if (quiet >= CONSULT_RECORDER_OFF_MINUTES) {
            out.push({ kind: "recorder_off", room_id: room.room_id, room_slug: slug, room_name, minutes: quiet, consult_open: { window_open_min: openMin } });
          }
        }
      }
    }
    if (inp.live_installs !== null) {
      const inst = inp.live_installs.get(room.room_id);
      if (!inst && clinic) out.push({ kind: "no_machine", room_id: room.room_id, room_slug: slug, room_name, minutes: null });
      if (inst && inst.mic_state === "denied") out.push({ kind: "mic_denied", room_id: room.room_id, room_slug: slug, room_name, minutes: null });
      // A4 §4: a room whose LAST install was retired while its mic was denied has no live install to read, and stays silent without this. The retired row's
      // last report still stands until a new install replaces it; the live install, once it exists, is the one that is read.
      if (!inst && inp.retired_installs?.get(room.room_id)?.mic_state === "denied") {
        out.push({ kind: "mic_denied", room_id: room.room_id, room_slug: slug, room_name, minutes: null });
      }
    }
  }
  return out;
}

export type SweepResult = { ok: boolean; planned: number; queued: number; degraded: string[] };

export async function runOpsSweep(nowMs: number = Date.now()): Promise<SweepResult> {
  const ids = ROOMS.map((r) => r.room_id);
  const degraded: string[] = [];

  let lastChunk: Map<string, number> | null = null;
  try {
    const rows = await lastChunkByRoom(ids);
    lastChunk = new Map();
    for (const r of rows) {
      const t = new Date(r.last_chunk_at as string).getTime();
      if (Number.isFinite(t)) lastChunk.set(r.room_id, t);
    }
  } catch (e) {
    degraded.push("bench_chunk");
    console.error("[ops-sweep] could not read bench_chunk:", e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200));
  }

  let installs: Map<string, { mic_state: string | null }> | null = null;
  try {
    const rows = (await sql`
      SELECT room_id, mic_state FROM room_install
       WHERE room_id = ANY(${ids}::text[]) AND retired_at IS NULL AND enrolled_at IS NOT NULL
    `) as Array<{ room_id: string; mic_state: string | null }>;
    installs = new Map(rows.map((r) => [r.room_id, { mic_state: r.mic_state ?? null }]));
  } catch (e) {
    degraded.push("room_install");
    console.error("[ops-sweep] could not read room_install:", e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200));
  }

  let retired: Map<string, { mic_state: string | null }> | null = null;
  try {
    const rows = (await sql`
      SELECT DISTINCT ON (room_id) room_id, mic_state FROM room_install
       WHERE room_id = ANY(${ids}::text[]) AND retired_at IS NOT NULL AND enrolled_at IS NOT NULL
       ORDER BY room_id, retired_at DESC
    `) as Array<{ room_id: string; mic_state: string | null }>;
    retired = new Map(rows.map((r) => [r.room_id, { mic_state: r.mic_state ?? null }]));
  } catch (e) {
    degraded.push("room_install_retired");
    console.error("[ops-sweep] could not read retired room_install:", e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200));
  }

  // FR1-A: open consult windows (t_close IS NULL, opened within 90 min). Same table and shape as lib/steward/sense.ts "eta_encounter_windows". A failed read skips only the consult rule.
  let openWindows: Map<string, number> | null = null;
  try {
    const rows = await openEncounterWindowsByRoom(ids);
    openWindows = new Map();
    for (const r of rows) {
      const t = new Date(r.t_open as string).getTime();
      if (Number.isFinite(t)) openWindows.set(r.room_id, t);
    }
  } catch (e) {
    degraded.push("encounter_windows");
    console.error("[ops-sweep] could not read eta_encounter_windows:", e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200));
  }

  let slugs: Map<string, string> | undefined;
  let names: Map<string, string> | undefined;
  try {
    const rows = (await sql`SELECT id, slug, name FROM room WHERE id = ANY(${ids}::text[])`) as Array<{ id: string; slug: string; name: string | null }>;
    slugs = new Map(rows.map((r) => [r.id, r.slug]));
    names = new Map(rows.filter((r) => r.name).map((r) => [r.id, r.name as string]));
  } catch {
    /* the id names the room */
  }

  const plan = planOpsAlerts({ now_ms: nowMs, last_chunk_ms: lastChunk, live_installs: installs, retired_installs: retired, open_windows: openWindows, slugs, names });
  let queued = 0;
  for (const a of plan) if (await queueOpsAlert(a)) queued++;
  return { ok: degraded.length === 0, planned: plan.length, queued, degraded };
}
