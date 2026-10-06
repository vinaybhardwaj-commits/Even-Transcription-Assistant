/**
 * start_day backoff — a room whose recorder is failing is not asked to start again every hour.
 *
 * The PURE verdict (`isFailedStartAttempt` / `evaluateStartBackoff` / `applyStartBackoff`, no clock
 * but the one passed in) and the one query that feeds it (mocked `sql`, no live database). The
 * backoff lives on the MCP door only (scribe_start_recording — see mcp-start-recording-backoff.test.ts);
 * the admin bench route, where a human clicks Start, always queues. Properties pinned:
 *   · 0 or 1 failed starts in the hour → send passes through
 *   · 2 failed → skipped room_failing with retry_after_s
 *   · an ack with no session behind it counts as failed once 5 minutes old; one that produced a
 *     session (named in the ack, or begun in the window) never does
 *   · `force` bypasses, and any active session (paused + override_pause included) is never skipped
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const calls: Array<{ text: string; values: unknown[] }> = [];
let responder: (text: string, values: unknown[]) => Row[] = () => [];

vi.mock("@/lib/db", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    calls.push({ text, values });
    try {
      return Promise.resolve(responder(text, values));
    } catch (e) {
      return Promise.reject(e);
    }
  };
  sql.transaction = async () => [];
  return { sql, db: {} };
});
vi.mock("@/lib/bench", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, benchAdminGuard: async () => ({ ok: true, claims: { admin_id: "adm_1" } }) };
});

const B = await import("@/lib/bench-commands");

const NOW = new Date("2026-10-06T06:00:00.000Z");
const minAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

type Att = Parameters<typeof B.evaluateStartBackoff>[0][number];
const failed = (m: number): Att => ({ status: "failed", created_at: minAgo(m), acked_at: minAgo(m), session_started: false, session_named: false });
const expired = (m: number): Att => ({ status: "expired", created_at: minAgo(m), acked_at: null, session_started: false, session_named: false });
const ackedNoSession = (createdMin: number, ackedMin: number): Att => ({ status: "acked", created_at: minAgo(createdMin), acked_at: minAgo(ackedMin), session_started: false, session_named: false });
const ackedWithSession = (m: number): Att => ({ status: "acked", created_at: minAgo(m), acked_at: minAgo(m), session_started: true, session_named: false });
/** F3 — the session began 1 s BEFORE the command row (outside the started_at window) but the ack names it. */
const ackedNamedSession = (m: number): Att => ({ status: "acked", created_at: minAgo(m), acked_at: minAgo(m), session_started: false, session_named: true });

const SEND = { action: "send", args: null } as const;

describe("evaluateStartBackoff — pure verdict", () => {
  it("0 or 1 failed attempts → below threshold, retry_after_s 0", () => {
    expect(B.evaluateStartBackoff([], NOW)).toEqual({ failed_attempts: 0, retry_after_s: 0 });
    expect(B.evaluateStartBackoff([failed(10)], NOW)).toEqual({ failed_attempts: 1, retry_after_s: 0 });
    expect(B.evaluateStartBackoff([failed(10), ackedWithSession(30)], NOW).failed_attempts).toBe(1);
  });

  it("2 failed → retry_after_s is the time until the OLDEST failed attempt leaves the 60-minute window", () => {
    // oldest at 50 min ago → leaves in 10 minutes.
    expect(B.evaluateStartBackoff([failed(50), expired(20)], NOW)).toEqual({ failed_attempts: 2, retry_after_s: 600 });
    // order of the input does not matter
    expect(B.evaluateStartBackoff([expired(20), failed(50)], NOW).retry_after_s).toBe(600);
  });

  it("3 failed → retry_after_s waits for the failure whose exit drops the count below 2", () => {
    // failures at 55, 40, 10 min ago. 55 leaves in 5 min (3→2: still skipped); 40 leaves in 20 min (2→1: allowed).
    expect(B.evaluateStartBackoff([failed(55), failed(40), failed(10)], NOW)).toEqual({ failed_attempts: 3, retry_after_s: 1200 });
  });

  it("attempts older than the window are ignored", () => {
    expect(B.evaluateStartBackoff([failed(61), failed(90), failed(10)], NOW).failed_attempts).toBe(1);
  });

  it("acked more than 5 minutes ago with no session counts as failed", () => {
    expect(B.isFailedStartAttempt(ackedNoSession(30, 20), NOW)).toBe(true);
    expect(B.evaluateStartBackoff([ackedNoSession(40, 30), failed(10)], NOW).failed_attempts).toBe(2);
  });

  it("acked under 5 minutes ago, still pending, or acked with a session do NOT count", () => {
    expect(B.isFailedStartAttempt(ackedNoSession(4, 3), NOW)).toBe(false);
    expect(B.isFailedStartAttempt({ status: "pending", created_at: minAgo(2), acked_at: null, session_started: false, session_named: false }, NOW)).toBe(false);
    expect(B.isFailedStartAttempt(ackedWithSession(30), NOW)).toBe(false);
    expect(B.evaluateStartBackoff([ackedWithSession(40), ackedWithSession(30), ackedWithSession(20)], NOW).failed_attempts).toBe(0);
  });

  it("F3: an ack that NAMES a room session counts as succeeded even when the session began before the command row", () => {
    // started_at window missed (session_started:false), but result.session_id names the session.
    expect(B.isFailedStartAttempt(ackedNamedSession(30), NOW)).toBe(false);
    expect(B.evaluateStartBackoff([ackedNamedSession(40), ackedNamedSession(30), failed(10)], NOW).failed_attempts).toBe(1);
    expect(B.applyStartBackoff(SEND, { attempts: [ackedNamedSession(40), ackedNamedSession(30)], now: NOW })).toBe(SEND);
  });

  it("'timeout' is not a status the bus has: it is not a failure on its own", () => {
    expect(B.isFailedStartAttempt({ status: "timeout", created_at: minAgo(10), acked_at: null, session_started: false, session_named: false }, NOW)).toBe(false);
  });
});

describe("applyStartBackoff — layering over decideStart", () => {
  it("send + 2 failed → skipped room_failing", () => {
    expect(B.applyStartBackoff(SEND, { attempts: [failed(50), expired(20)], now: NOW })).toEqual({
      action: "skipped",
      skipped: true,
      reason: "room_failing",
      failed_attempts: 2,
      retry_after_s: 600,
    });
  });

  it("send + 1 failed → unchanged", () => {
    expect(B.applyStartBackoff(SEND, { attempts: [failed(50)], now: NOW })).toBe(SEND);
  });

  it("force:true bypasses", () => {
    expect(B.applyStartBackoff(SEND, { attempts: [failed(50), failed(20)], force: true, now: NOW })).toBe(SEND);
  });

  it("F2: any active session returns the send verdict untouched — paused + override_pause included", () => {
    const many = [failed(50), failed(40), failed(30)];
    const plain = { action: "send", args: null } as const;
    const override = { action: "send", args: { override_pause: true } } as const;
    expect(B.applyStartBackoff(plain, { attempts: many, activeSession: { id: "bs_p", status: "recording" }, now: NOW })).toBe(plain);
    expect(B.applyStartBackoff(override, { attempts: many, activeSession: { id: "bs_p", status: "paused" }, now: NOW })).toBe(override);
    // and with no active session the same verdict IS skipped
    expect(B.applyStartBackoff(override, { attempts: many, activeSession: null, now: NOW })).toMatchObject({ action: "skipped" });
  });

  it("reject and already_recording pass through untouched, however many failures", () => {
    const many = [failed(50), failed(40), failed(30)];
    const rec = { action: "already_recording", session_id: "bs_1" } as const;
    const rej = { action: "reject", error: "room_paused" } as const;
    expect(B.applyStartBackoff(rec, { attempts: many, now: NOW })).toBe(rec);
    expect(B.applyStartBackoff(rej, { attempts: many, now: NOW })).toBe(rej);
  });
});

describe("getRecentStartAttempts — one room-scoped, time-bounded query with bound params", () => {
  beforeEach(() => {
    calls.length = 0;
    responder = () => [];
  });

  it("binds room, window start and grace; reads start_day only", async () => {
    responder = () => [{ status: "acked", created_at: minAgo(30), acked_at: minAgo(29), session_started: false, session_named: true }];
    const out = await B.getRecentStartAttempts("room_1", NOW);
    expect(out).toEqual([{ status: "acked", created_at: minAgo(30), acked_at: minAgo(29), session_started: false, session_named: true }]);
    expect(calls).toHaveLength(1);
    const q = calls[0]!;
    expect(q.text).toMatch(/FROM bench_command c/);
    expect(q.text).toMatch(/c\.kind = 'start_day'/);
    expect(q.text).toMatch(/c\.room_id = \?/);
    // F3: the ack's named session is matched by id, scoped to the room, with no started_at condition
    expect(q.text).toMatch(/s\.room_id = c\.room_id AND s\.id = c\.result ->> 'session_id'/);
    expect(q.values).toContain("room_1");
    expect(q.values).toContain(minAgo(60));
    expect(q.values).toContain(300);
  });
});
