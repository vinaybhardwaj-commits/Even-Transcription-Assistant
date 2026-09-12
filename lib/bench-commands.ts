/**
 * lib/bench-commands.ts — Bench command bus + listener (Operator MCP S2, PRD §8; migration 0044).
 *
 * Every bench_command / bench_listener query in the app lives HERE (routes + MCP tools call
 * these), so the lifecycle is unit-testable with a mocked `sql` and the SQL can be listed
 * verbatim. Migration 0044 has NOT run anywhere at build time — every string is INFERRED
 * against db/migrations/0044_bench_command.sql.
 *
 * Runtime guard (belt and braces): any query failing with undefined_table (42P01) is thrown
 * as BusError("bus_not_migrated"); any other DB failure as BusError("bus_down"). Callers
 * turn these into 503 (routes, D10 — never an empty 200) or `error` fields (tools).
 *
 * D4 last-poll-wins: the newest poll owns the room. A polling tab whose stored tab_id
 * differs and whose stored last_poll_at is newer than THIS tab's previous poll is superseded
 * (it does not upsert; it should stop polling).
 */

import { sql } from "@/lib/db";
import { customAlphabet } from "nanoid";
import { z } from "zod";
import { parseMicLevels, type MicLevels } from "@/lib/bench-levels";
import { applyInstallPoll, INPUT_DEVICE_UID_MAX, type InstallPollFields } from "@/lib/room-install";

/**
 * R4-D1 adds the fifth, `set_audio_input`. Three definitions move together: this list, migration
 * 0080's CHECK, and the app's `BenchCommandKind`. The browser kiosk ignores it (R4-D7) — the native
 * app owns audio — so a room listening from a browser never acks it and the caller sees a timeout.
 */
export const COMMAND_KINDS = [
  "start_day",
  "pause_day",
  "resume_day",
  "end_day",
  "set_audio_input",
  "check_update_now",
  "report_diag",
  "restart_engine",
] as const;
export type CommandKind = (typeof COMMAND_KINDS)[number];

/**
 * Tier 1 §3 — the three operator verbs, in lock-step with migration 0081's CHECK and the app's
 * `BenchCommandKind`. Like `set_audio_input` they are the NATIVE app's alone: the browser kiosk
 * ignores them without acking (R4-D7), and the server refuses them below 0.1.22.
 */
export const TIER1_VERBS = ["check_update_now", "report_diag", "restart_engine"] as const;
export type Tier1Verb = (typeof TIER1_VERBS)[number];
export const isTier1Verb = (k: unknown): k is Tier1Verb => (TIER1_VERBS as readonly unknown[]).includes(k);

/** Tier 1 §3. How many log lines `report_diag` may ask for. The app's default is 100. */
export const REPORT_DIAG_MAX_LINES = 500;

/**
 * Tier 1 §3 — the args each verb takes, STRICT, for the reason `parseSetAudioInputArgs` gives: the
 * app acts on a Mac with a patient in the room, so an unknown key is refused rather than ignored.
 * Absent and `null` are the same thing; `{}` is "no options" for the two that take options.
 */
const VERB_ARGS = {
  check_update_now: z.null(),
  report_diag: z
    .object({ log_lines: z.number().int().min(0).max(REPORT_DIAG_MAX_LINES).optional() })
    .strict()
    .nullable(),
  restart_engine: z.object({ force: z.boolean().optional() }).strict().nullable(),
} satisfies Record<Tier1Verb, z.ZodTypeAny>;

/**
 * PURE — a verb's args, or a CommandArgsError. The admin route, the MCP tool and `insertCommand` all
 * call it, so no path onto the bus can skip it. Returns what is stored: null for no options.
 */
export function parseVerbArgs(kind: Tier1Verb, raw: unknown): Record<string, unknown> | null {
  const parsed = VERB_ARGS[kind].safeParse(raw === undefined ? null : raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    throw new CommandArgsError(`${kind} ${where}${(issue?.message ?? "invalid args").slice(0, 120)}`);
  }
  const out = parsed.data as Record<string, unknown> | null;
  return out && Object.keys(out).length > 0 ? out : null;
}

/** R4-D1. At least one of the two; the app applies whichever is present. */
export type SetAudioInputArgs = { device_uid?: string; input_volume?: number };

export class CommandArgsError extends Error {
  readonly code = "BAD_ARGS" as const;
  constructor(public reason: string) {
    super(`BAD_ARGS: ${reason}`);
  }
}

/**
 * PURE — R4-S item 2. A `set_audio_input` body, or a CommandArgsError. The one validator: the admin
 * route and the MCP tool call it for their own answer, and `insertCommand` calls it again so no path
 * onto the bus can skip it.
 *
 * STRICT, because the app acts on a Mac with a patient in the room: an object naming `device_uid`
 * (a string, trimmed, 1..256 — the fleet's bound on a CoreAudio uid) and/or `input_volume` (a
 * number in 0..1), and nothing else. Out of range is refused, never clamped: a clamped 1.5 would set
 * full volume on a request nobody made.
 */
export function parseSetAudioInputArgs(raw: unknown): SetAudioInputArgs {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new CommandArgsError("args must be an object");
  const o = raw as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => k !== "device_uid" && k !== "input_volume");
  if (extra.length) throw new CommandArgsError(`unknown field ${extra[0]!.slice(0, 32)}`);
  const out: SetAudioInputArgs = {};
  if (o.device_uid !== undefined) {
    const u = typeof o.device_uid === "string" ? o.device_uid.trim() : "";
    if (!u || u.length > INPUT_DEVICE_UID_MAX) throw new CommandArgsError(`device_uid must be a string of 1..${INPUT_DEVICE_UID_MAX} characters`);
    out.device_uid = u;
  }
  if (o.input_volume !== undefined) {
    const v = o.input_volume;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) throw new CommandArgsError("input_volume must be a number in 0..1");
    out.input_volume = v;
  }
  if (out.device_uid === undefined && out.input_volume === undefined) throw new CommandArgsError("name device_uid or input_volume");
  return out;
}

/**
 * R4-D11. The first app that decodes `set_audio_input`. An older one fails its WHOLE poll on the kind
 * (R4-D2's reason), and a row it has been handed never expires — so that room's bus would stay
 * blocked. The route and the tool refuse below this, before anything is inserted.
 */
export const SET_AUDIO_INPUT_MIN_APP_VERSION = "0.1.21";

/**
 * PURE — R4-D11. `version >= min`, comparing dotted integers numerically (0.1.100 is above 0.1.21;
 * 0.1.3 is below it — the two cases a string compare gets wrong). Missing parts count as 0.
 *
 * ANYTHING ELSE IS "TOO OLD": null, blank, a `v` prefix, a pre-release suffix, a letter. The app
 * reports `Packaging/VERSION`, which is plain digits and dots; a value that is not is not something
 * this check should guess about, and refusing costs one retry while guessing wrong blocks a room.
 */
export function appVersionAtLeast(version: string | null | undefined, min: string): boolean {
  const parse = (v: string | null | undefined): number[] | null => {
    const t = typeof v === "string" ? v.trim() : "";
    return /^\d+(\.\d+){0,3}$/.test(t) ? t.split(".").map(Number) : null;
  };
  const a = parse(version);
  const b = parse(min);
  if (!a || !b) return false;
  for (let k = 0; k < Math.max(a.length, b.length); k++) {
    const x = a[k] ?? 0;
    const y = b[k] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

export type AppTooOld = { code: "APP_TOO_OLD"; message: string; app_version: string | null };

/**
 * PURE — R4-D11. Null when the bound install's reported version may receive `set_audio_input`;
 * otherwise the one error object both the route (409) and the MCP tool return.
 */
export function audioInputRefusal(appVersion: string | null | undefined): AppTooOld | null {
  if (appVersionAtLeast(appVersion, SET_AUDIO_INPUT_MIN_APP_VERSION)) return null;
  const reported = typeof appVersion === "string" && appVersion.trim() ? appVersion.trim() : null;
  return {
    code: "APP_TOO_OLD",
    message: `this room's app reports ${reported ?? "no version"}; set_audio_input needs ${SET_AUDIO_INPUT_MIN_APP_VERSION} or later`,
    app_version: reported,
  };
}

/**
 * Tier 1 §3 — the floor for the three verbs, D11's rule for them: an app below it cannot decode the
 * kind (0.1.21 acks it `unsupported_kind`; anything older fails the poll), so the route and the tool
 * refuse before inserting.
 */
export const VERBS_MIN_APP_VERSION = "0.1.22";

/** PURE — Tier 1 §3. Null when the bound install may receive `kind`; else the one error object. */
export function verbRefusal(kind: Tier1Verb, appVersion: string | null | undefined): AppTooOld | null {
  if (appVersionAtLeast(appVersion, VERBS_MIN_APP_VERSION)) return null;
  const reported = typeof appVersion === "string" && appVersion.trim() ? appVersion.trim() : null;
  return {
    code: "APP_TOO_OLD",
    message: `this room's app reports ${reported ?? "no version"}; ${kind} needs ${VERBS_MIN_APP_VERSION} or later`,
    app_version: reported,
  };
}

/**
 * R4-D12. What a 0.1.21 app says it applied, carried into `bench_command.result`.
 * Tier 1 §3 adds the three verbs' results: `check_update_now` {checked_at, offered_version?, deferred,
 * held?}, `restart_engine` {restarting}, `report_diag` {diag}.
 */
export type AckApplied = {
  applied_device_uid?: string;
  applied_input_volume?: number;
  input_volume_settable?: boolean;
  checked_at?: string;
  offered_version?: string;
  deferred?: boolean;
  held?: boolean;
  restarting?: boolean;
  diag?: Record<string, unknown>;
};

/** Tier 1 §3. The largest `report_diag` payload stored, as JSON text. 500 lines of 300 fit twice. */
export const DIAG_MAX_CHARS = 262_144;

/**
 * Tier 1 §3 — words a diagnostic payload must never contain. The app strips the session and redacts
 * any log line carrying one of these; this is the server's second look, and a payload that still
 * carries one is NOT STORED (`diag_withheld`), because `result` is readable by every operator door.
 *
 * MIGRATION_SECRET added by the 12 Sep ruling on the Refuter's naming gap (f). Nothing in
 * `apps/room-recorder` reads it — it is a server-only env var — so today this guards nothing. It is
 * here because this list is the NAME OF EVERY SECRET THAT MUST NOT COME BACK FROM A MAC, not a list
 * of the ones that currently could: the day a diagnostic starts quoting the server's own environment
 * is the day it is needed, and that day must not depend on somebody remembering to add it.
 */
export const DIAG_FORBIDDEN = ["eta_room_session", "etaRoomSession", "commandVerifyKey", "SCRIBE_MCP_TOKEN", "MIGRATION_SECRET"] as const;

/**
 * PURE — R4-D12. The three applied fields of an ack body, each validated on its own and DROPPED if
 * malformed — an ack is never refused for them, because a refused ack leaves the command pending.
 * Every other key is dropped. A body without them yields `{}`, so the four day verbs' results are
 * unchanged.
 */
export function cleanAckApplied(body: unknown): AckApplied {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  const o = body as Record<string, unknown>;
  const out: AckApplied = {};
  const uid = typeof o.applied_device_uid === "string" ? o.applied_device_uid.trim() : "";
  if (uid && uid.length <= INPUT_DEVICE_UID_MAX) out.applied_device_uid = uid;
  const v = o.applied_input_volume;
  if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1) out.applied_input_volume = v;
  if (typeof o.input_volume_settable === "boolean") out.input_volume_settable = o.input_volume_settable;
  // ── Tier 1 §3. Same rule: each field on its own, dropped if malformed, never a refusal. ──────
  if (typeof o.checked_at === "string" && o.checked_at.length <= 40 && Number.isFinite(Date.parse(o.checked_at))) {
    out.checked_at = new Date(Date.parse(o.checked_at)).toISOString();
  }
  if (typeof o.offered_version === "string" && /^[0-9]+(\.[0-9]+){1,3}(-[0-9A-Za-z.]+)?$/.test(o.offered_version) && o.offered_version.length <= 64) {
    out.offered_version = o.offered_version;
  }
  if (typeof o.deferred === "boolean") out.deferred = o.deferred;
  if (typeof o.held === "boolean") out.held = o.held;
  if (typeof o.restarting === "boolean") out.restarting = o.restarting;
  if (o.diag && typeof o.diag === "object" && !Array.isArray(o.diag)) {
    let text = "";
    try {
      text = JSON.stringify(o.diag);
    } catch {
      text = "";
    }
    if (text && text.length <= DIAG_MAX_CHARS) {
      if (DIAG_FORBIDDEN.some((w) => text.includes(w))) {
        out.diag = { diag_withheld: "the payload named a secret and was not stored" };
      } else {
        out.diag = o.diag as Record<string, unknown>;
      }
    }
  }
  return out;
}
// S3-2: the timing constants live in the pure lib/bench-bus-constants.ts (kiosk-bundle safe);
// re-exported here so every existing caller keeps working unchanged.
export { COMMAND_EXPIRY_SECONDS, LISTENER_FRESH_MS, ACK_WAIT_MS, ACK_POLL_MS, REPORT_DIAG_ACK_WAIT_MS, ackWaitMsFor } from "./bench-bus-constants";
import { COMMAND_EXPIRY_SECONDS, LISTENER_FRESH_MS, ACK_WAIT_MS, ACK_POLL_MS } from "./bench-bus-constants";

const cmdId = customAlphabet("abcdefghjkmnpqrstuvwxyz23456789", 8);
export const newCommandId = (): string => `cmd_${cmdId()}`;

export type BusErrorCode = "bus_not_migrated" | "bus_down";
export class BusError extends Error {
  constructor(public code: BusErrorCode, public cause_message?: string) {
    super(code);
  }
}

/** 42P01 undefined_table → bus_not_migrated; anything else → bus_down. */
export function classifyBusError(e: unknown): BusError {
  if (e instanceof BusError) return e;
  const code = (e as { code?: unknown })?.code;
  const msg = String((e as Error)?.message ?? e);
  if (code === "42P01" || /relation "?bench_(command|listener)"? does not exist/i.test(msg) || /undefined_table/i.test(msg)) {
    return new BusError("bus_not_migrated", msg.slice(0, 200));
  }
  return new BusError("bus_down", msg.slice(0, 200));
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw classifyBusError(e);
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ListenerRow = {
  room_id: string;
  tab_id: string;
  last_poll_at: string | Date;
  recording_session_id: string | null;
  paused: boolean;
  /** §2.2 — what the microphones heard since this room's previous poll. NULL = NOT MEASURED,
   *  never silent: an older kiosk, a refused AudioContext, or a rig with no second device. */
  mic_peak?: number | null;
  mic_avg?: number | null;
  spare_peak?: number | null;
  spare_avg?: number | null;
  levels_at?: string | Date | null;
  /** §2.4 (D32/P8) — TRUE only when the client reported an EXPLICITLY chosen second device.
   *  NULL = not reported, NEVER "no spare": the arrival of a backup piece must never imply one.
   *  The browser kiosk does not set it (its capture code is untouched this build); the native
   *  Room Recorder app will. Until then it is null on every rig and no spare lane is drawn. */
  spare_device?: boolean | null;
};

export type CommandRow = {
  id: string;
  room_id: string;
  kind: CommandKind;
  args: unknown;
  status: "pending" | "acked" | "failed" | "expired";
  source: string;
  result: unknown;
  error: string | null;
  created_at: string | Date;
  acked_at: string | Date | null;
};

export type PendingCommand = { id: string; kind: CommandKind; args: unknown; created_at: string };

// ---------------------------------------------------------------------------
// Kiosk side — poll + ack
// ---------------------------------------------------------------------------

export type { MicLevels } from "@/lib/bench-levels";

export type PollInput = {
  roomId: string;
  tabId: string;
  /** server `now` this tab received on its previous successful poll (null on first poll) */
  prevPollAt: Date | null;
  recordingSessionId: string | null;
  paused: boolean;
  /** §2.2 — optional, and its absence is never an error. See the upsert for why. */
  mic?: MicLevels | null;
  spare?: MicLevels | null;
  /** §2.4 — did the client report an explicitly chosen second device? undefined = not reported
   *  (the browser kiosk never sends it), and undefined never erases a stored value. */
  spareDevice?: boolean | null;
  /**
   * Install and Fleet §4.3 — the native Room Recorder's seven optional fields.
   *
   * ABSENT MEANS THE BROWSER KIOSK, and the browser kiosk must behave EXACTLY as it does today.
   * That is not a hope about this code, it is the shape of it: `install` is undefined on every
   * poll the kiosk sends, and the one branch that reads it is skipped entirely. Nothing above
   * this line changed, so there is no path by which a room recording in a browser can notice
   * that this build shipped.
   */
  install?: InstallPollFields | null;
};

/**
 * PURE — one level pair, sanitised, or null.
 *
 * RMS is 0..1 by construction. Anything outside that, or not a number at all, is a bug somewhere
 * upstream and is DROPPED rather than clamped: a clamped value is indistinguishable from a real
 * one and would put a number on a clinical screen that no microphone produced. Dropping it leaves
 * the column NULL, which every reader already renders as "not measured".
 */
export function cleanLevels(v: unknown): MicLevels | null {
  return parseMicLevels(v);
}

export type PollResult =
  | { superseded: true; now: string; owner_tab_id: string }
  | { retired: true; now: string }
  | {
      superseded: false;
      now: string;
      commands: PendingCommand[];
      /** B2-D5. Native polls only — from applyInstallPoll's own RETURNING, no extra read. */
      assigned_channel?: "stable" | "test" | null;
    };

/**
 * One kiosk poll: D4 supersede check → upsert listener → lazy-expire → pending commands
 * (oldest first). Throws BusError on any DB failure (routes answer 503 — D10).
 */
export async function pollCommands(input: PollInput): Promise<PollResult> {
  return guarded(async () => {
    // ── Install and Fleet §4.3 / §4.5 rule 3 ────────────────────────────────────────────────
    // The native app's poll writes its own row BEFORE anything touches bench_listener, and a
    // retired install is turned away here. The ordering IS the supersession rule: a retired copy
    // must not write the listener row on the same poll that tells it to stop, or it would take
    // the room back from the install that just replaced it for one more beat.
    //
    // THE BROWSER KIOSK NEVER ENTERS THIS BLOCK. `install` is undefined on every poll it sends.
    // B2-D5: what the install row's UPDATE returned, carried to the response. Null on any fault —
    // "nothing assigned" leaves the Mac on the channel its own config.json names.
    let assignedChannel: "stable" | "test" | null = null;
    if (input.install?.install_id) {
      let applied: Awaited<ReturnType<typeof applyInstallPoll>> | null = null;
      try {
        // Tier 1 §2. "Recording" for the named states is THIS poll's listener answer: a session id
        // reported and not paused. A consent pause is silence on purpose and must not read as a
        // dead microphone.
        applied = await applyInstallPoll(input.install, {
          recording: input.recordingSessionId !== null && !input.paused,
        });
        if (applied.ok) assignedChannel = applied.assigned_channel;
      } catch (e) {
        // FAIL OPEN, LOUDLY. The install registry is bookkeeping; the tape is not. A room that
        // is recording must not stop because the fleet card cannot be updated, and the card
        // shows the consequence anyway — the Mac goes stale and the row asks for attention.
        console.warn(
          "[bench-commands] install poll write failed",
          JSON.stringify({
            room_id: input.roomId,
            install_id: input.install.install_id,
            err: String((e as Error)?.message ?? e).slice(0, 200),
          }),
        );
      }
      if (applied && !applied.ok && applied.code === "RETIRED") {
        return { retired: true, now: new Date().toISOString() };
      }
      if (applied && !applied.ok && applied.code === "NOT_FOUND") {
        // An install_id nobody minted. NOT fatal: telling this app to stop for ever on the
        // strength of a typo would take a room down, and the poll below is the same poll a
        // browser kiosk makes. Named here so it is findable rather than mysterious.
        console.warn(
          "[bench-commands] poll carried an unknown install_id",
          JSON.stringify({ room_id: input.roomId, install_id: input.install.install_id }),
        );
      }
    }

    const existing = (await sql`
      SELECT room_id, tab_id, last_poll_at, recording_session_id, paused,
             mic_peak, mic_avg, spare_peak, spare_avg, levels_at, spare_device
        FROM bench_listener
       WHERE room_id = ${input.roomId}
       LIMIT 1
    `) as ListenerRow[];
    const cur = existing[0];
    if (cur && cur.tab_id !== input.tabId) {
      const storedAt = new Date(cur.last_poll_at).getTime();
      const prev = input.prevPollAt ? input.prevPollAt.getTime() : null;
      // Newest poll wins. A tab that has polled before and finds a DIFFERENT tab polled
      // more recently than it did is superseded. A fresh tab (no previous poll) takes over.
      if (prev !== null && storedAt > prev) {
        return { superseded: true, now: new Date().toISOString(), owner_tab_id: cur.tab_id };
      }
    }
    // §2.2 — THE LEVELS RIDE THE ROW THAT IS ALREADY BEING WRITTEN. No new table, no new write,
    // no new failure mode: four values are added to an upsert that runs on every poll anyway.
    //
    // A POLL WITH NO LEVELS MUST NOT ERASE THE LAST ONES IT HAD. `COALESCE(EXCLUDED.x, old.x)`
    // rather than a plain assignment, because a page that momentarily cannot measure — a
    // suspended AudioContext, a permission prompt — would otherwise blank the bars on a room that
    // is recording perfectly well, and a bar that drops to nothing reads as a dead microphone.
    // `levels_at` moves only when a reading actually arrives, so a reader can always tell a fresh
    // silence from a stale number left by a kiosk that stopped sending.
    // §2.4 — the explicit-second-device flag rides the same upsert, COALESCEd like the levels: an
    // absent value (undefined → null here) never erases a stored one, so a native-app poll that
    // reports it once keeps reporting it and a browser-kiosk poll that never sends it leaves it be.
    const spareDevice = input.spareDevice === undefined ? null : input.spareDevice;
    const mic = input.mic ?? null;
    // The browser still measures an automatically selected phantom backup input. It never reports
    // a chosen second device, so those numbers are not a spare vital and must not be persisted.
    // A native client may omit the flag after reporting it once; the stored true keeps its lane.
    const spareReported = spareDevice === true || (spareDevice === null && cur?.spare_device === true);
    const spare = spareReported ? (input.spare ?? null) : null;
    const anyLevel = mic !== null || spare !== null;
    await sql`
      INSERT INTO bench_listener (
        room_id, tab_id, last_poll_at, recording_session_id, paused,
        mic_peak, mic_avg, spare_peak, spare_avg, levels_at, spare_device
      )
      VALUES (
        ${input.roomId}, ${input.tabId}, now(), ${input.recordingSessionId}, ${input.paused},
        ${mic?.peak ?? null}, ${mic?.avg ?? null},
        ${spare?.peak ?? null}, ${spare?.avg ?? null},
        ${anyLevel ? "now()" : null}::timestamptz, ${spareDevice}
      )
      ON CONFLICT (room_id) DO UPDATE
         SET tab_id = EXCLUDED.tab_id,
             last_poll_at = now(),
             recording_session_id = EXCLUDED.recording_session_id,
             paused = EXCLUDED.paused,
             mic_peak     = COALESCE(EXCLUDED.mic_peak,     bench_listener.mic_peak),
             mic_avg      = COALESCE(EXCLUDED.mic_avg,      bench_listener.mic_avg),
             spare_peak   = CASE WHEN EXCLUDED.spare_device IS FALSE THEN NULL ELSE COALESCE(EXCLUDED.spare_peak, bench_listener.spare_peak) END,
             spare_avg    = CASE WHEN EXCLUDED.spare_device IS FALSE THEN NULL ELSE COALESCE(EXCLUDED.spare_avg, bench_listener.spare_avg) END,
             levels_at    = COALESCE(EXCLUDED.levels_at,    bench_listener.levels_at),
             spare_device = COALESCE(EXCLUDED.spare_device, bench_listener.spare_device)
    `;
    // Lazy expiry (PRD §8.2 "pending > 15 s WITHOUT a poll"): a command older than 15 s that no
    // poll has delivered — i.e. created after this room's previous poll (`cur.last_poll_at`,
    // read above before the upsert) — is expired and will NOT be executed on reconnect. A
    // command already delivered by an earlier poll stays pending until the kiosk acks it (a
    // slow end_day flush must not be expired out from under the kiosk).
    const prevPoll = cur ? new Date(cur.last_poll_at).toISOString() : null;
    await sql`
      UPDATE bench_command
         SET status = 'expired'
       WHERE room_id = ${input.roomId}
         AND status = 'pending'
         AND created_at < now() - (${COMMAND_EXPIRY_SECONDS}::int * INTERVAL '1 second')
         AND (${prevPoll}::timestamptz IS NULL OR created_at > ${prevPoll}::timestamptz)
    `;
    const rows = (await sql`
      SELECT id, kind, args, created_at
        FROM bench_command
       WHERE room_id = ${input.roomId} AND status = 'pending'
       ORDER BY created_at ASC
       LIMIT 20
    `) as Array<{ id: string; kind: CommandKind; args: unknown; created_at: string | Date }>;
    return {
      superseded: false,
      now: new Date().toISOString(),
      commands: rows.map((r) => ({ id: r.id, kind: r.kind, args: r.args ?? null, created_at: new Date(r.created_at).toISOString() })),
      // The browser kiosk never gets the key: its response is exactly what it was before B2.
      ...(input.install?.install_id ? { assigned_channel: assignedChannel } : {}),
    };
  });
}

export type AckInput = {
  roomId: string;
  commandId: string;
  ok: boolean;
  sessionId?: string | null;
  error?: string | null;
  /** R4-D12 — already through `cleanAckApplied`. Absent or `{}` leaves `result` exactly as before. */
  applied?: AckApplied;
};

/** Ack (or fail) a pending command that belongs to this room. Returns the new status, or null when no such pending row. */
export async function ackCommand(input: AckInput): Promise<"acked" | "failed" | null> {
  return guarded(async () => {
    const status = input.ok ? "acked" : "failed";
    const result = JSON.stringify({
      ok: input.ok,
      ...(input.sessionId ? { session_id: input.sessionId } : {}),
      ...(input.error ? { error: input.error } : {}),
      ...(input.applied ?? {}),
    });
    const rows = (await sql`
      UPDATE bench_command
         SET status = ${status},
             result = ${result}::jsonb,
             error = ${input.ok ? null : (input.error ?? "failed")},
             acked_at = now()
       WHERE id = ${input.commandId} AND room_id = ${input.roomId} AND status = 'pending'
       RETURNING id, kind
    `) as Array<{ id: string; kind?: string }>;
    if (!rows.length) return null;
    if (rows[0]!.kind === "set_audio_input" && input.ok && input.applied?.applied_device_uid) {
      await recordExpectedDevice(input.roomId, input.applied.applied_device_uid);
    }
    return status;
  });
}

/**
 * Tier 1 §2, DEVICE_CHANGED. A desk switch the app has acked is the device the room is now EXPECTED
 * to record from. The name comes from the room's own last-reported device list, by the uid the app
 * says it applied; a uid the list does not carry sets NULL, and the next poll adopts the name it
 * reports (`applyInstallPoll`), which is the switched-to device by then.
 *
 * BEST-EFFORT, AFTER THE ACK HAS LANDED. The command's status is already written; a failure here is
 * logged and the ack still answers success, because a refused ack leaves the command pending and the
 * app acking it again. INFERRED against 0079 (`input_devices`) and 0081 (`expected_device_name`).
 */
async function recordExpectedDevice(roomId: string, uid: string): Promise<void> {
  try {
    await sql`
      UPDATE room_install
         SET expected_device_name = (
               SELECT d ->> 'name'
                 FROM jsonb_array_elements(
                        CASE WHEN jsonb_typeof(input_devices) = 'array' THEN input_devices ELSE '[]'::jsonb END
                      ) AS d
                WHERE d ->> 'uid' = ${uid}
                LIMIT 1
             )
       WHERE room_id = ${roomId}
         AND enrolled_at IS NOT NULL
         AND retired_at IS NULL
    `;
  } catch (e) {
    console.warn(
      "[bench-commands] expected device not recorded",
      JSON.stringify({ room_id: roomId, err: String((e as Error)?.message ?? e).slice(0, 200) }),
    );
  }
}

// ---------------------------------------------------------------------------
// Operator side — listener reads + command insert/wait
// ---------------------------------------------------------------------------

export async function getListener(roomId: string): Promise<ListenerRow | null> {
  return guarded(async () => {
    const rows = (await sql`
      SELECT room_id, tab_id, last_poll_at, recording_session_id, paused,
             mic_peak, mic_avg, spare_peak, spare_avg, levels_at, spare_device
        FROM bench_listener
       WHERE room_id = ${roomId}
       LIMIT 1
    `) as ListenerRow[];
    return rows[0] ?? null;
  });
}

export type ListenerView = ListenerRow & { slug: string; name: string; listening: boolean; age_ms: number };

export async function listListeners(now: Date = new Date()): Promise<ListenerView[]> {
  return guarded(async () => {
    const rows = (await sql`
      SELECT l.room_id, l.tab_id, l.last_poll_at, l.recording_session_id, l.paused,
             l.mic_peak, l.mic_avg, l.spare_peak, l.spare_avg, l.levels_at, l.spare_device,
             r.slug, r.name
        FROM bench_listener l
        JOIN room r ON r.id = l.room_id
       ORDER BY l.last_poll_at DESC
    `) as Array<ListenerRow & { slug: string; name: string }>;
    return rows.map((r) => {
      const age = now.getTime() - new Date(r.last_poll_at).getTime();
      return { ...r, age_ms: age, listening: age <= LISTENER_FRESH_MS };
    });
  });
}

export function isListening(l: ListenerRow | null, now: Date = new Date()): boolean {
  if (!l) return false;
  return now.getTime() - new Date(l.last_poll_at).getTime() <= LISTENER_FRESH_MS;
}

export async function insertCommand(input: { roomId: string; kind: CommandKind; args?: unknown; source?: string }): Promise<string> {
  // R4-S item 2. Validated OUTSIDE `guarded`, so the throw stays a CommandArgsError and no SQL runs.
  // The four existing kinds are not validated here, exactly as before. Tier 1 §3: the three verbs
  // are, by the same zod schemas the route and the tool use.
  const checked =
    input.kind === "set_audio_input"
      ? parseSetAudioInputArgs(input.args)
      : isTier1Verb(input.kind)
        ? parseVerbArgs(input.kind, input.args)
        : input.args;
  return guarded(async () => {
    const id = newCommandId();
    const args = checked === undefined || checked === null ? null : JSON.stringify(checked);
    await sql`
      INSERT INTO bench_command (id, room_id, kind, args, status, source)
      VALUES (${id}, ${input.roomId}, ${input.kind}, ${args}::jsonb, 'pending', ${input.source ?? "mcp"})
    `;
    return id;
  });
}

export async function getCommand(id: string): Promise<CommandRow | null> {
  return guarded(async () => {
    const rows = (await sql`
      SELECT id, room_id, kind, args, status, source, result, error, created_at, acked_at
        FROM bench_command
       WHERE id = ${id}
       LIMIT 1
    `) as CommandRow[];
    return rows[0] ?? null;
  });
}

export type CommandListRow = CommandRow & { room_slug: string; room_name: string };

/**
 * Operator view of the bus (S3 scribe_list_commands): newest first, optional room / status
 * filters, limit 1..200 (default 50). INFERRED against 0044 + 0041.
 */
export async function listCommands(f: { roomId?: string | null; status?: string | null; limit?: number | null } = {}): Promise<CommandListRow[]> {
  return guarded(async () => {
    const roomId = f.roomId ?? null;
    const status = f.status ?? null;
    const limit = Math.min(Math.max(Math.trunc(f.limit ?? 50) || 50, 1), 200);
    return (await sql`
      SELECT c.id, c.room_id, c.kind, c.args, c.status, c.source, c.result, c.error, c.created_at, c.acked_at,
             r.slug AS room_slug, r.name AS room_name
        FROM bench_command c
        JOIN room r ON r.id = c.room_id
       WHERE (${roomId}::text IS NULL OR c.room_id = ${roomId}::text)
         AND (${status}::text IS NULL OR c.status = ${status}::text)
       ORDER BY c.created_at DESC
       LIMIT ${limit}::int
    `) as CommandListRow[];
  });
}

/** Poll the command row until acked/failed/expired or timeout (null). */
export async function waitForAck(
  id: string,
  opts: { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<CommandRow | null> {
  const timeoutMs = opts.timeoutMs ?? ACK_WAIT_MS;
  const intervalMs = opts.intervalMs ?? ACK_POLL_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const t0 = Date.now();
  for (;;) {
    const row = await getCommand(id);
    if (row && row.status !== "pending") return row;
    if (Date.now() - t0 >= timeoutMs) return null;
    await sleep(intervalMs);
  }
}

/** The room's live bench_session (recording or paused), newest first. Existing table (0041). */
export async function findActiveSession(roomId: string): Promise<{ id: string; status: string; started_at: string } | null> {
  const rows = (await sql`
    SELECT id, status, started_at
      FROM bench_session
     WHERE room_id = ${roomId} AND status IN ('recording','paused')
     ORDER BY started_at DESC
     LIMIT 1
  `) as Array<{ id: string; status: string; started_at: string | Date }>;
  const r = rows[0];
  return r ? { id: r.id, status: r.status, started_at: new Date(r.started_at).toISOString() } : null;
}

// ---------------------------------------------------------------------------
// Pure decision for scribe_start_recording pre-checks (unit-tested)
// ---------------------------------------------------------------------------

export type StartDecision =
  | { action: "reject"; error: "kiosk_not_listening" | "room_paused" }
  | { action: "already_recording"; session_id: string }
  | { action: "send"; args: { override_pause?: true } | null };

export function decideStart(input: {
  listener: ListenerRow | null;
  activeSession: { id: string; status: string } | null;
  overridePause: boolean;
  now?: Date;
}): StartDecision {
  const now = input.now ?? new Date();
  if (!isListening(input.listener, now)) return { action: "reject", error: "kiosk_not_listening" };
  const s = input.activeSession;
  // Idempotent start: a live tape means "return it", never a second tape.
  if (s?.status === "recording" || (input.listener?.recording_session_id && !input.listener.paused && !s)) {
    return { action: "already_recording", session_id: s?.id ?? input.listener!.recording_session_id! };
  }
  const paused = Boolean(input.listener?.paused) || s?.status === "paused";
  if (paused && !input.overridePause) return { action: "reject", error: "room_paused" };
  return { action: "send", args: paused && input.overridePause ? { override_pause: true } : null };
}
