/**
 * Arch #17 fix F (refute, proven on real postgres): a deferred start whose only session died ~15 s in with no audio must NEVER settle "ok: deferred then recording",
 * and a later failure ack revises even an ok settlement to failed. Runs reconcilePending + ackCommand against real postgres.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const H = vi.hoisted(() => ({ sql: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>) }));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => H.sql!(s, ...v) }));
const HAVE = dockerAvailable();
const pg = pgContainer("eta-arch17-settle");

const T = Date.parse("2026-10-07T08:00:00Z");
const at = (s: number) => `'${new Date(T + s * 1000).toISOString()}'`;
const PENDING = (cmd: string) => `pending: sent, awaiting ack (deferred: the kiosk accepted the start and is waiting for its input device) command_id=${cmd}`;
const ROOMS = ["r_died", "r_alive", "r_chunk", "r_notape", "r_ok_then_fail", "r_other", "r_early"];

beforeAll(() => {
  if (!HAVE) return;
  pg.start();
  const cmds = ROOMS.map((r) => `('cmd_${r}', '${r}', 'start_day', 'acked', '{"ok":true,"deferred":true}'::jsonb, ${at(0)}, ${at(1)})`).join(",");
  const decisions = ROOMS.map((r) => `('${r}', ${at(0)}, 'scribe_start', 'live', '${PENDING("cmd_" + r)}', '{}'::jsonb)`).join(",");
  pg.exec(`
    CREATE TABLE steward_decisions (id bigserial PRIMARY KEY, room_id text, ts timestamptz NOT NULL, action text, mode text, result text, inputs jsonb NOT NULL DEFAULT '{}');
    CREATE TABLE bench_command (id text PRIMARY KEY, room_id text NOT NULL, kind text NOT NULL, args jsonb, status text NOT NULL DEFAULT 'pending', source text,
      result jsonb, error text, created_at timestamptz NOT NULL DEFAULT now(), acked_at timestamptz);
    CREATE TABLE bench_session (id text PRIMARY KEY, room_id text NOT NULL, started_at timestamptz NOT NULL, ended_at timestamptz, status text NOT NULL);
    CREATE TABLE bench_chunk (id text PRIMARY KEY, session_id text NOT NULL);
    CREATE TABLE bench_level_sample (room_id text NOT NULL, sampled_at timestamptz NOT NULL, session_open boolean, tape_advancing boolean);
    INSERT INTO bench_command (id, room_id, kind, status, result, created_at, acked_at) VALUES ${cmds};
    INSERT INTO steward_decisions (room_id, ts, action, mode, result, inputs) VALUES ${decisions};
    -- r_died: a session opened 20 s after the command, died 15 s later, nothing recorded (no chunk, tape never advanced)
    INSERT INTO bench_session VALUES ('bs_died', 'r_died', ${at(20)}, ${at(35)}, 'ended');
    INSERT INTO bench_level_sample VALUES ('r_died', ${at(22)}, true, false), ('r_died', ${at(30)}, true, false);
    -- r_alive: open session, tape advancing reported by polls
    INSERT INTO bench_session VALUES ('bs_alive', 'r_alive', ${at(20)}, NULL, 'recording');
    INSERT INTO bench_level_sample VALUES ('r_alive', ${at(25)}, true, true);
    -- r_chunk: open session with a piece landed
    INSERT INTO bench_session VALUES ('bs_chunk', 'r_chunk', ${at(20)}, NULL, 'recording');
    INSERT INTO bench_chunk VALUES ('ch1', 'bs_chunk');
    -- r_notape: open session, polls say open but the tape is not advancing, no piece
    INSERT INTO bench_session VALUES ('bs_notape', 'r_notape', ${at(20)}, NULL, 'recording');
    INSERT INTO bench_level_sample VALUES ('r_notape', ${at(25)}, true, false);
    -- r_early: an OLDER session (began 10 min BEFORE the start_day command), still open, with a piece AND an advancing tape — it is not the session this start produced
    INSERT INTO bench_session VALUES ('bs_early', 'r_early', ${at(-600)}, NULL, 'recording');
    INSERT INTO bench_chunk VALUES ('ch_early', 'bs_early');
    INSERT INTO bench_level_sample VALUES ('r_early', ${at(-300)}, true, true), ('r_early', ${at(25)}, true, true);
    -- r_ok_then_fail: alive with audio
    INSERT INTO bench_session VALUES ('bs_okf', 'r_ok_then_fail', ${at(20)}, NULL, 'recording');
    INSERT INTO bench_level_sample VALUES ('r_ok_then_fail', ${at(25)}, true, true);
  `);
  H.sql = pg.sql as never;
}, 120_000);
afterAll(() => { if (HAVE) pg.stop(); });

const resultOf = async (room: string) => ((await pg.sql`SELECT result FROM steward_decisions WHERE room_id = ${room} ORDER BY id DESC LIMIT 1`)[0] as { result: string }).result;
const reconcile = async (nowS: number) => (await import("@/lib/steward/loop")).reconcilePending(pg.sql as never, T + nowS * 1000, 5000);

describe("REQUIRED PROOF ran, or was skipped deliberately", () => {
  it("needs Docker", () => {
    if (HAVE || process.env.ETA_ALLOW_SKIP_E2E === "1") return;
    throw new Error("REQUIRED PROOF NOT RUN: needs Docker for postgres:16, or set ETA_ALLOW_SKIP_E2E=1.");
  });
});

describe.runIf(HAVE)("a deferred start settles ok only on a LIVE session that PRODUCED AUDIO", () => {
  it("alive with audio (tape advancing) -> ok; open with a piece -> ok", async () => {
    await reconcile(60);
    expect(await resultOf("r_alive")).toMatch(/^ok: start_day deferred then recording \(late\) session_id=bs_alive/);
    expect(await resultOf("r_chunk")).toMatch(/^ok: start_day deferred then recording \(late\) session_id=bs_chunk/);
  });
  it("the session that died ~15 s in with no audio is NEVER ok: pending while young, failed at 120 s", async () => {
    expect(await resultOf("r_died")).toMatch(/^pending/);
    await reconcile(100);
    expect(await resultOf("r_died")).toMatch(/^pending/);
    await reconcile(125);
    expect(await resultOf("r_died")).toMatch(/^failed: start_day deferred, no recording session after 120 s/);
  });
  it("M4: a session that began BEFORE the command (still open, with audio) can never satisfy the deferred start; only one started after the command can", async () => {
    expect(await resultOf("r_early")).not.toMatch(/^ok/);                  // it was reconciled with r_alive at 60 s: the older session must not have satisfied it
    await reconcile(125);
    expect(await resultOf("r_early")).toMatch(/^failed: start_day deferred, no recording session after 120 s/);
    // ...and the moment a session starts AFTER the command with audio, the same start does settle ok
    pg.exec(`UPDATE steward_decisions SET result = '${PENDING("cmd_r_early")}', inputs = '{}'::jsonb WHERE room_id = 'r_early';
             INSERT INTO bench_session VALUES ('bs_early_new', 'r_early', ${at(30)}, NULL, 'recording');
             INSERT INTO bench_chunk VALUES ('ch_early_new', 'bs_early_new');`);
    await reconcile(135);
    expect(await resultOf("r_early")).toMatch(/^ok: start_day deferred then recording \(late\) session_id=bs_early_new/);
  });
  it("an open session whose tape never advanced and has no piece is not audio: same as the dead one", async () => {
    expect(await resultOf("r_notape")).toMatch(/^failed: start_day deferred, no recording session/);
  });
  it("died-15s-no-audio, then the app's failure ack: the COMMAND becomes failed and a still-pending row would settle failed with the reason", async () => {
    // a fresh pending row for the dead start, settled by the command's failure instead of the clock
    const { ackCommand } = await import("@/lib/bench-commands");
    pg.exec(`UPDATE steward_decisions SET result = '${PENDING("cmd_r_died")}', inputs = '{}'::jsonb WHERE room_id = 'r_died';`);
    expect(await ackCommand({ roomId: "r_died", commandId: "cmd_r_died", ok: false, sessionId: null, error: "input_device_not_ready" })).toBe("failed");
    await reconcile(130);
    expect(await resultOf("r_died")).toMatch(/^failed: start_day failed \(input_device_not_ready\) command_id=cmd_r_died/);
  });
});

describe.runIf(HAVE)("a later failure ack overrides an ok settlement, idempotently, own room only", () => {
  it("ok settled -> the app's failure ack -> the row is revised to failed; a repeat changes nothing", async () => {
    const { ackCommand } = await import("@/lib/bench-commands");
    await reconcile(60);
    expect(await resultOf("r_ok_then_fail")).toMatch(/^ok: start_day deferred then recording/);
    expect(await ackCommand({ roomId: "r_ok_then_fail", commandId: "cmd_r_ok_then_fail", ok: false, sessionId: null, error: "tapewriter exited with status 1" })).toBe("failed");
    expect(await reconcile(300)).toBe(1);
    expect(await resultOf("r_ok_then_fail")).toMatch(/^failed: start_day failed after it was settled ok \(tapewriter exited with status 1\) command_id=cmd_r_ok_then_fail/);
    const before = await resultOf("r_ok_then_fail");
    expect(await reconcile(400)).toBe(0);
    expect(await resultOf("r_ok_then_fail")).toBe(before);
  });
  it("own room only: a decision row for another room that names this command is left alone", async () => {
    pg.exec(`INSERT INTO steward_decisions (room_id, ts, action, mode, result, inputs) VALUES ('r_other', ${at(0)}, 'scribe_start', 'live', 'ok: start_day deferred then recording (late) session_id=bs_x command_id=cmd_r_ok_then_fail', '{}'::jsonb);`);
    await reconcile(500);
    const other = (await pg.sql`SELECT result FROM steward_decisions WHERE room_id = 'r_other' AND result LIKE 'ok: start_day deferred%'`) as Array<{ result: string }>;
    expect(other).toHaveLength(1);
  });
});
