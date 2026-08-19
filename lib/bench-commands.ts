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

export const COMMAND_KINDS = ["start_day", "pause_day", "resume_day", "end_day"] as const;
export type CommandKind = (typeof COMMAND_KINDS)[number];
export const COMMAND_EXPIRY_SECONDS = 15; // pending > 15 s without a poll → expired (PRD §8.2)
export const LISTENER_FRESH_MS = 10_000; // last_poll_at within 10 s = listening (kickoff)
export const ACK_WAIT_MS = 8_000; // MCP tools wait this long for the kiosk ack (PRD §8.2)
export const ACK_POLL_MS = 400;

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

export type PollInput = {
  roomId: string;
  tabId: string;
  /** server `now` this tab received on its previous successful poll (null on first poll) */
  prevPollAt: Date | null;
  recordingSessionId: string | null;
  paused: boolean;
};

export type PollResult =
  | { superseded: true; now: string; owner_tab_id: string }
  | { superseded: false; now: string; commands: PendingCommand[] };

/**
 * One kiosk poll: D4 supersede check → upsert listener → lazy-expire → pending commands
 * (oldest first). Throws BusError on any DB failure (routes answer 503 — D10).
 */
export async function pollCommands(input: PollInput): Promise<PollResult> {
  return guarded(async () => {
    const existing = (await sql`
      SELECT room_id, tab_id, last_poll_at, recording_session_id, paused
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
    await sql`
      INSERT INTO bench_listener (room_id, tab_id, last_poll_at, recording_session_id, paused)
      VALUES (${input.roomId}, ${input.tabId}, now(), ${input.recordingSessionId}, ${input.paused})
      ON CONFLICT (room_id) DO UPDATE
         SET tab_id = EXCLUDED.tab_id,
             last_poll_at = now(),
             recording_session_id = EXCLUDED.recording_session_id,
             paused = EXCLUDED.paused
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
    };
  });
}

export type AckInput = { roomId: string; commandId: string; ok: boolean; sessionId?: string | null; error?: string | null };

/** Ack (or fail) a pending command that belongs to this room. Returns the new status, or null when no such pending row. */
export async function ackCommand(input: AckInput): Promise<"acked" | "failed" | null> {
  return guarded(async () => {
    const status = input.ok ? "acked" : "failed";
    const result = JSON.stringify({ ok: input.ok, ...(input.sessionId ? { session_id: input.sessionId } : {}), ...(input.error ? { error: input.error } : {}) });
    const rows = (await sql`
      UPDATE bench_command
         SET status = ${status},
             result = ${result}::jsonb,
             error = ${input.ok ? null : (input.error ?? "failed")},
             acked_at = now()
       WHERE id = ${input.commandId} AND room_id = ${input.roomId} AND status = 'pending'
       RETURNING id
    `) as Array<{ id: string }>;
    return rows.length ? status : null;
  });
}

// ---------------------------------------------------------------------------
// Operator side — listener reads + command insert/wait
// ---------------------------------------------------------------------------

export async function getListener(roomId: string): Promise<ListenerRow | null> {
  return guarded(async () => {
    const rows = (await sql`
      SELECT room_id, tab_id, last_poll_at, recording_session_id, paused
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
      SELECT l.room_id, l.tab_id, l.last_poll_at, l.recording_session_id, l.paused, r.slug, r.name
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
  return guarded(async () => {
    const id = newCommandId();
    const args = input.args === undefined || input.args === null ? null : JSON.stringify(input.args);
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
