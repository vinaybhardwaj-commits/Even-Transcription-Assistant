/**
 * lib/spine/config.ts — spine_config modes. A missing, malformed or unknown value means OFF.
 * Keys: `kill_switch` (true => everything off), `ingest` (S1 signal ingest), `producers` (SPINE-P1 encounter-shadow cron), `merge` (SPINE-P2 writer), `jobs` (the queue), `mode.<stage>` (per stage). Value: "off"|"shadow"|"live" or {"mode": ...}.
 * S6 per-room scoping: `mode.<stage>` may also be {"mode": "live"|"shadow", "rooms": [room_id, ...]} (the RECOMMENDED form for "live": the plain string "live" means every room).
 * THE ROOM RULE (roomMode, the one place the enqueuer and the claim route both use). For an encounter in room R, with the stage's declared mode M and room list L (absent = all rooms):
 *   no "rooms" key            -> M for every room (today's meaning; "live" and {"mode":"live"} stay valid).
 *   M = live,   R in L        -> live;   R not in L (or room unknown) -> shadow (the next lower mode).
 *   M = shadow, R in L        -> shadow; R not in L (or room unknown) -> off.
 *   "rooms" present but not an array of non-empty strings (malformed, null, a string) -> L is EMPTY: no room is live. Never "all rooms".
 * The jobs cap (jobs=shadow turns live into shadow; jobs=off turns everything off), kill_switch and the paid-stage ban apply on top, unchanged.
 * ingest alone is read from a jsonb that the driver may hand back as text; kill_switch is never decoded (a string there is malformed, i.e. killed).
 */
import { sql } from "@/lib/db";

export type Mode = "off" | "shadow" | "live";
export type IngestMode = Mode;

/** Paid stages stay off until V rules on D4/D5/D9: never claimable, whatever the config says. */
export const PAID_STAGES: readonly string[] = ["sarvam", "gapfill", "role", "llm-roles", "parts"];
/** Every stage the queue knows; an unknown stage is never claimed. */
export const KNOWN_STAGES: readonly string[] = ["recut", "acoustics", "nemotron", "sarvam", "gapfill", "role", "llm-roles", "parts", "collector", "freescript", "transcript_final"];
/** Stages the SERVER runs itself (the spine cron, S7a). The box runner is never handed one: /api/spine/claim filters them out. */
export const SERVER_STAGES: readonly string[] = ["transcript_final"];

export function parseMode(v: unknown): Mode {
  const m = v && typeof v === "object" && !Array.isArray(v) ? (v as { mode?: unknown }).mode : v;
  return m === "shadow" || m === "live" ? m : "off";
}

/** A kill_switch row that is not exactly `false` / `{"on": false}` counts as KILLED (malformed fails toward killed). An absent row is not a kill (jobs still defaults off). */
export function isKilled(v: unknown): boolean {
  const x = v && typeof v === "object" && !Array.isArray(v) ? (v as { on?: unknown }).on : v;
  return x !== false;
}

const val = (v: unknown): unknown => { if (typeof v === "string") { try { return JSON.parse(v); } catch { return v; } } return v; };   // the driver may hand a jsonb back as text (ingest only)

/** S1 gate. spine_config has no seed rows. Pure: ingest mode from the config rows; kill_switch rules as isKilled, a missing or malformed ingest value means off. */
export function parseIngestMode(rows: ReadonlyArray<{ key: string; value: unknown }>): IngestMode {
  const m = new Map(rows.map((r) => [r.key, r.key === "ingest" ? val(r.value) : r.value] as const));
  if (m.has("kill_switch") && isKilled(m.get("kill_switch"))) return "off";
  return parseMode(m.get("ingest"));
}

/** SPINE-P1 gate (the producer cron). Same rules as parseIngestMode, key `producers`: kill_switch as isKilled, a missing or malformed value means off. */
export function parseProducersMode(rows: ReadonlyArray<{ key: string; value: unknown }>): Mode {
  const m = new Map(rows.map((r) => [r.key, r.key === "producers" ? val(r.value) : r.value] as const));
  if (m.has("kill_switch") && isKilled(m.get("kill_switch"))) return "off";
  return parseMode(m.get("producers"));
}

/** SPINE-P2 gate (the merge writer). Same rules, key `merge`: kill_switch as isKilled, a missing or malformed value means off. */
export function parseMergeMode(rows: ReadonlyArray<{ key: string; value: unknown }>): Mode {
  const m = new Map(rows.map((r) => [r.key, r.key === "merge" ? val(r.value) : r.value] as const));
  if (m.has("kill_switch") && isKilled(m.get("kill_switch"))) return "off";
  return parseMode(m.get("merge"));
}

/** The rooms a stage is scoped to: null = every room (no "rooms" key); a list (possibly empty) = those rooms only. A "rooms" key that is not an array of non-empty strings is the EMPTY list (fail closed). */
export type RoomScope = readonly string[] | null;

export function parseRoomScope(v: unknown): RoomScope {
  if (!v || typeof v !== "object" || Array.isArray(v) || !Object.prototype.hasOwnProperty.call(v, "rooms")) return null;
  const r = (v as { rooms?: unknown }).rooms;
  if (!Array.isArray(r) || !r.every((x) => typeof x === "string" && x.length > 0)) return [];
  return [...new Set(r as string[])];
}

const inRooms = (scope: readonly string[], roomId: string | null | undefined): boolean => roomId != null && scope.includes(roomId);

/** THE ROOM RULE (see the header). Pure: the declared mode of a stage for one encounter's room, before the jobs cap. */
export function roomMode(mode: Mode, scope: RoomScope, roomId: string | null | undefined): Mode {
  if (mode === "off" || scope === null) return mode;
  if (inRooms(scope, roomId)) return mode;
  return mode === "live" ? "shadow" : "off";
}

/** roomMode under the jobs cap: jobs=off => off; jobs=shadow turns live into shadow. */
export function effectiveRoomMode(jobs: Mode, mode: Mode, scope: RoomScope, roomId: string | null | undefined): Mode {
  if (jobs === "off") return "off";
  const m = roomMode(mode, scope, roomId);
  return jobs === "shadow" && m === "live" ? "shadow" : m;
}

/** What one claim may take for one stage: every room (`all`), the listed rooms, or (negate) every room NOT listed. */
export type ClaimRule = { stage: string; all: boolean; rooms: string[]; negate: boolean };

/** Does a claim rule let a job of an encounter in `roomId` through? The SQL in jobs.claimJobs is the same test. */
export function ruleAllows(r: ClaimRule, roomId: string | null | undefined): boolean {
  return r.all || inRooms(r.rooms, roomId) !== r.negate;
}

/**
 * The claim side of the room rule, for stages already known (KNOWN, not paid, not breaker-open is the caller's job).
 * live claim: needs jobs=live; takes the stage's jobs for rooms whose roomMode is live. would_run (non-live) claim: takes rooms whose roomMode is shadow,
 * for a stage DECLARED shadow (its listed rooms) or declared live with a room list (its unlisted rooms). A stage declared live with no list is never taken by a would_run claim (as before).
 */
export function claimRules(want: "live" | "shadow", jobs: Mode, modes: Readonly<Record<string, Mode>>, scopes: Readonly<Record<string, RoomScope>>, stages: readonly string[]): ClaimRule[] {
  const out: ClaimRule[] = [];
  if (jobs === "off" || (want === "live" && jobs !== "live")) return out;
  for (const stage of stages) {
    const m = modes[stage] ?? "off";
    const sc = scopes[stage] ?? null;
    if (m === "off") continue;
    if (want === "live") { if (m === "live") out.push({ stage, all: sc === null, rooms: [...(sc ?? [])], negate: false }); continue; }
    if (m === "shadow") out.push({ stage, all: sc === null, rooms: [...(sc ?? [])], negate: false });
    else if (m === "live" && sc !== null) out.push({ stage, all: false, rooms: [...sc], negate: true });
  }
  return out;
}

export type Modes = { jobs: Mode; stages: Record<string, Mode>; scopes: Record<string, RoomScope> };

/** Pure: modes (and room scopes) for `stages` from the config rows. */
export function modesFrom(rows: Array<{ key: string; value: unknown }>, stages: readonly string[]): Modes {
  const by = new Map(rows.map((r) => [r.key, r.value]));
  if (by.has("kill_switch") && isKilled(by.get("kill_switch"))) return { jobs: "off", stages: Object.fromEntries(stages.map((s) => [s, "off" as Mode])), scopes: Object.fromEntries(stages.map((s) => [s, null])) };
  const jobs = parseMode(by.get("jobs"));
  const out: Record<string, Mode> = {};
  const scopes: Record<string, RoomScope> = {};
  for (const s of stages) {
    out[s] = jobs === "off" || PAID_STAGES.includes(s) || !KNOWN_STAGES.includes(s) ? "off" : parseMode(by.get(`mode.${s}`));
    scopes[s] = out[s] === "off" ? null : parseRoomScope(by.get(`mode.${s}`));
  }
  return { jobs, stages: out, scopes };
}

/** The declared mode of one stage for the room of one encounter (spine_config only: no jobs cap, as readMode). Used by the report route. */
export async function readRoomMode(stage: string, encounterId: string): Promise<Mode> {
  const rows = (await sql`SELECT value FROM spine_config WHERE key = ${`mode.${stage}`}::text`) as Array<{ value: unknown }>;
  const v = rows[0]?.value;
  const mode = parseMode(v);
  const scope = parseRoomScope(v);
  if (mode === "off" || scope === null) return mode;
  const e = (await sql`SELECT room_id FROM spine_encounter WHERE encounter_id = ${encounterId}::text LIMIT 1`) as Array<{ room_id: string | null }>;
  return roomMode(mode, scope, e[0]?.room_id ?? null);
}

export async function readModes(stages: readonly string[] = KNOWN_STAGES): Promise<Modes> {
  const keys = ["kill_switch", "jobs", "dead_alert", ...stages.map((s) => `mode.${s}`)];
  const rows = (await sql`SELECT key, value FROM spine_config WHERE key = ANY(${keys}::text[])`) as Array<{ key: string; value: unknown }>;
  return modesFrom(rows, stages);
}

export async function readMode(key: string): Promise<Mode> {
  const rows = (await sql`SELECT value FROM spine_config WHERE key = ${key}::text`) as Array<{ value: unknown }>;
  return parseMode(rows[0]?.value);
}
