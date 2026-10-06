/**
 * scribe_start_recording — the same start_day backoff as the admin route (bench-start-backoff.test.ts),
 * through the MCP door the Kiosk Bot uses. Mocked `sql`; no live database.
 *   · 2 failed starts in the hour → ok:true {skipped, reason:"room_failing", failed_attempts, retry_after_s, room_id}, nothing queued
 *   · force:true bypasses (and does not read the attempts)
 *   · an active session still answers already_recording first
 *   · an unreadable attempts query fails open
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

type Row = Record<string, unknown>;
const ROOM = { id: "room_opd5", slug: "opd-test-wxmp", name: "OPD Test" };

const calls: Array<{ text: string; values: unknown[] }> = [];
let attempts: Row[] = [];
let attemptsThrow = false;
let active: Row | null = null;

const listener = () => ({ room_id: ROOM.id, tab_id: "tab_A", last_poll_at: new Date().toISOString(), recording_session_id: null, paused: false });

vi.mock("@/lib/db", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    calls.push({ text, values });
    if (/FROM room WHERE/.test(text)) return Promise.resolve([{ ...ROOM, disabled_at: null }]);
    if (/FROM bench_listener/.test(text)) return Promise.resolve([listener()]);
    if (/FROM bench_command c/.test(text)) return attemptsThrow ? Promise.reject(new Error("boom")) : Promise.resolve(attempts);
    if (/status IN \('recording','paused'\)/.test(text)) return Promise.resolve(active ? [active] : []);
    // waitForAck → getCommand: acked at once.
    if (/FROM bench_command WHERE id = \?/.test(text)) {
      return Promise.resolve([{ id: values[0], room_id: ROOM.id, kind: "start_day", args: null, status: "acked", source: "mcp", result: { ok: true, session_id: "bs_new" }, error: null, created_at: new Date().toISOString(), acked_at: new Date().toISOString() }]);
    }
    return Promise.resolve([]);
  };
  sql.transaction = async () => [];
  return { sql, db: {} };
});
vi.mock("@/lib/brain/db", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, brainLog: () => {}, query: async () => ({ rows: [], rowCount: 0 }) };
});

const { BENCH_TOOLS } = await import("@/lib/mcp/tools/bench");
const start = BENCH_TOOLS.find((t) => t.name === "scribe_start_recording")!;

const rel = (status: string, createdMinAgo: number, ackedMinAgo: number | null, session = false): Row => ({
  status,
  created_at: new Date(Date.now() - createdMinAgo * 60_000).toISOString(),
  acked_at: ackedMinAgo === null ? null : new Date(Date.now() - ackedMinAgo * 60_000).toISOString(),
  session_started: session,
  session_named: false,
});

const run = async (args: Record<string, unknown> = {}) =>
  (await start.handler({ room: ROOM.slug, ...args }, { origin: "https://preview.example" } as never)) as Row;
const inserts = () => calls.filter((c) => /INSERT INTO bench_command/.test(c.text));
const attemptReads = () => calls.filter((c) => /FROM bench_command c/.test(c.text));

beforeEach(() => {
  calls.length = 0;
  attempts = [];
  attemptsThrow = false;
  active = null;
});

describe("scribe_start_recording — start_day backoff", () => {
  it("schema carries an optional boolean force, default false", () => {
    const props = (start.inputSchema as { properties: Record<string, { type: string; default?: unknown }> }).properties;
    expect(props.force).toMatchObject({ type: "boolean", default: false });
  });

  it("0 failed attempts → the start is sent", async () => {
    const out = await run();
    expect(out.skipped).toBeUndefined();
    expect(out).toMatchObject({ ok: true, kind: "start_day", status: "acked" });
    expect(String(out.command_id)).toMatch(/^cmd_/);
    expect(attemptReads()).toHaveLength(1);
    expect(inserts()).toHaveLength(1);
  });

  it("1 failed attempt → the start is still sent (run() called, command inserted and acked)", async () => {
    attempts = [rel("failed", 30, 30)];
    const out = await run();
    expect(out.skipped).toBeUndefined();
    expect(out).toMatchObject({ ok: true, kind: "start_day", status: "acked", result: { session_id: "bs_new" } });
    expect(String(out.command_id)).toMatch(/^cmd_/);
    expect(attemptReads()).toHaveLength(1);
    expect(inserts()).toHaveLength(1);
    expect(inserts()[0]!.values).toContain(ROOM.id);
  });

  it("2 failed → ok:true skip shape with retry_after_s, nothing queued", async () => {
    attempts = [rel("failed", 50, 50), rel("expired", 20, null)];
    const out = await run();
    expect(out).toMatchObject({ ok: true, queued: false, skipped: true, reason: "room_failing", failed_attempts: 2, room_id: ROOM.id });
    expect(out.error).toBeUndefined();
    expect(Number(out.retry_after_s)).toBeGreaterThan(590);
    expect(Number(out.retry_after_s)).toBeLessThanOrEqual(600);
    expect(inserts()).toHaveLength(0);
  });

  it("acked-but-no-session counts; a start that produced a session does not", async () => {
    attempts = [rel("acked", 40, 35, false), rel("acked", 20, 15, false)];
    expect((await run()).skipped).toBe(true);
    calls.length = 0;
    attempts = [rel("acked", 40, 35, true), rel("acked", 20, 15, true)];
    expect((await run()).skipped).toBeUndefined();
    expect(inserts()).toHaveLength(1);
  });

  it("force:true bypasses and does not read the attempts", async () => {
    attempts = [rel("failed", 50, 50), rel("failed", 20, 20)];
    const out = await run({ force: true });
    expect(out.skipped).toBeUndefined();
    expect(out).toMatchObject({ ok: true, kind: "start_day" });
    expect(inserts()).toHaveLength(1);
    expect(attemptReads()).toHaveLength(0);
  });

  it("F2: a paused room started with override_pause is not skipped even with 2 failures and a paused session", async () => {
    attempts = [rel("failed", 50, 50), rel("failed", 20, 20)];
    active = { id: "bs_p", status: "paused", started_at: new Date().toISOString() };
    const out = await run({ override_pause: true });
    expect(out.skipped).toBeUndefined();
    expect(inserts()).toHaveLength(1);
  });

  it("active session still wins: already_recording, no attempts read", async () => {
    attempts = [rel("failed", 50, 50), rel("failed", 20, 20)];
    active = { id: "bs_live", status: "recording", started_at: new Date().toISOString() };
    const out = await run();
    expect(out).toMatchObject({ ok: true, already_recording: true, session_id: "bs_live" });
    expect(out.skipped).toBeUndefined();
    expect(inserts()).toHaveLength(0);
    expect(attemptReads()).toHaveLength(0);
  });

  it("an unreadable attempts query fails open", async () => {
    attemptsThrow = true;
    const out = await run();
    expect(out.skipped).toBeUndefined();
    expect(out).toMatchObject({ ok: true, kind: "start_day" });
    expect(inserts()).toHaveLength(1);
  });
});
