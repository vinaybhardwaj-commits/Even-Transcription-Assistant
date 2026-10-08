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
const ROOMS = ["r_died", "r_alive", "r_chunk", "r_notape", "r_ok_then_fail", "r_other", "r_early", "r_closed", "r_oldsample", "r_notopen", "r_endtape", "r_yday"];

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
    CREATE TABLE bench_level_sample (room_id text NOT NULL, sampled_at timestamptz NOT NULL, session_open boolean, tape_advancing boolean, ist_date date);
    INSERT INTO bench_command (id, room_id, kind, status, result, created_at, acked_at) VALUES ${cmds};
    INSERT INTO steward_decisions (room_id, ts, action, mode, result, inputs) VALUES ${decisions};
    -- r_died: a session opened 20 s after the command, died 15 s later, nothing recorded (no chunk, tape never advanced)
    INSERT INTO bench_session VALUES ('bs_died', 'r_died', ${at(20)}, ${at(35)}, 'ended');
    INSERT INTO bench_level_sample (room_id, sampled_at, session_open, tape_advancing) VALUES ('r_died', ${at(22)}, true, false), ('r_died', ${at(30)}, true, false);
    -- r_alive: open session, tape advancing reported by polls
    INSERT INTO bench_session VALUES ('bs_alive', 'r_alive', ${at(20)}, NULL, 'recording');
    INSERT INTO bench_level_sample (room_id, sampled_at, session_open, tape_advancing) VALUES ('r_alive', ${at(25)}, true, true);
    -- r_chunk: open session with a piece landed
    INSERT INTO bench_session VALUES ('bs_chunk', 'r_chunk', ${at(20)}, NULL, 'recording');
    INSERT INTO bench_chunk VALUES ('ch1', 'bs_chunk');
    -- r_notape: open session, polls say open but the tape is not advancing, no piece
    INSERT INTO bench_session VALUES ('bs_notape', 'r_notape', ${at(20)}, NULL, 'recording');
    INSERT INTO bench_level_sample (room_id, sampled_at, session_open, tape_advancing) VALUES ('r_notape', ${at(25)}, true, false);
    -- r_early: an OLDER session (began 10 min BEFORE the start_day command), still open, with a piece AND an advancing tape — it is not the session this start produced
    INSERT INTO bench_session VALUES ('bs_early', 'r_early', ${at(-600)}, NULL, 'recording');
    INSERT INTO bench_chunk VALUES ('ch_early', 'bs_early');
    INSERT INTO bench_level_sample (room_id, sampled_at, session_open, tape_advancing) VALUES ('r_early', ${at(-300)}, true, true), ('r_early', ${at(25)}, true, true);
    -- Fix G mutants. r_closed: ENDED session that has a piece and an advancing tape (audio, but not open). r_oldsample: open session whose only advancing sample PREDATES its start.
    -- r_notopen: open session whose advancing sample reports session_open = false.
    INSERT INTO bench_session VALUES ('bs_closed', 'r_closed', ${at(20)}, ${at(90)}, 'ended');
    INSERT INTO bench_chunk VALUES ('ch_closed', 'bs_closed');
    INSERT INTO bench_level_sample (room_id, sampled_at, session_open, tape_advancing) VALUES ('r_closed', ${at(25)}, true, true);
    INSERT INTO bench_session VALUES ('bs_oldsample', 'r_oldsample', ${at(20)}, NULL, 'recording');
    INSERT INTO bench_level_sample (room_id, sampled_at, session_open, tape_advancing) VALUES ('r_oldsample', ${at(10)}, true, true);
    INSERT INTO bench_session VALUES ('bs_notopen', 'r_notopen', ${at(20)}, NULL, 'recording');
    INSERT INTO bench_level_sample (room_id, sampled_at, session_open, tape_advancing) VALUES ('r_notopen', ${at(25)}, false, true);
    -- N1: ENDED session, tape advanced ~10 s then the tapewriter exited (a tape_advancing sample, no piece). N5: open session started after the command, no piece, only samples from the day before.
    INSERT INTO bench_session VALUES ('bs_endtape', 'r_endtape', ${at(20)}, ${at(40)}, 'ended');
    INSERT INTO bench_level_sample (room_id, sampled_at, session_open, tape_advancing) VALUES ('r_endtape', ${at(25)}, true, true);
    INSERT INTO bench_session VALUES ('bs_yday', 'r_yday', ${at(20)}, NULL, 'recording');
    INSERT INTO bench_level_sample (room_id, sampled_at, session_open, tape_advancing) VALUES ('r_yday', ${at(-86400)}, true, true);
    -- r_ok_then_fail: alive with audio
    INSERT INTO bench_session VALUES ('bs_okf', 'r_ok_then_fail', ${at(20)}, NULL, 'recording');
    INSERT INTO bench_level_sample (room_id, sampled_at, session_open, tape_advancing) VALUES ('r_ok_then_fail', ${at(25)}, true, true);

    UPDATE bench_level_sample SET ist_date = (sampled_at AT TIME ZONE 'Asia/Kolkata')::date;
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

describe.runIf(HAVE)("Fix G: one test per clause of the audio evidence (each fails when its clause is removed)", () => {
  it("a CLOSED session with audio never settles the start ok (the 'still open' status filter)", async () => {
    await reconcile(60);
    expect(await resultOf("r_closed")).not.toMatch(/^ok/);
  });
  it("an open session whose only advancing level sample PREDATES the session start is not audio (the 'sampled_at >= started_at' filter)", async () => {
    expect(await resultOf("r_oldsample")).not.toMatch(/^ok/);
  });
  it("an open session whose advancing sample says session_open = false is not audio (the session_open check)", async () => {
    expect(await resultOf("r_notopen")).not.toMatch(/^ok/);
  });
});

describe.runIf(HAVE)("Fix G addendum: N1 and N5", () => {
  it("N1: an ENDED session whose tape advanced then the tapewriter exited (a tape_advancing sample, no piece) never settles ok", async () => {
    expect(await resultOf("r_endtape")).not.toMatch(/^ok/);
  });
  it("N5: an open session started after the command, with no piece and only level samples from before it began (yesterday), never settles ok", async () => {
    expect(await resultOf("r_yday")).not.toMatch(/^ok/);
  });
});

describe.runIf(HAVE)("Fix G: the revision is idempotent, and a fault in it is loud", () => {
  const okRow = (room: string, cmd: string) => `INSERT INTO steward_decisions (room_id, ts, action, mode, result, inputs) VALUES ('${room}', ${at(0)}, 'scribe_start', 'live', 'ok: start_day deferred then recording (late) session_id=bs_g command_id=${cmd}', '{}'::jsonb);`;
  it("a second identical failure ack changes neither the status, the error nor acked_at", async () => {
    const { ackCommand } = await import("@/lib/bench-commands");
    pg.exec(`INSERT INTO bench_command (id, room_id, kind, status, result, created_at, acked_at) VALUES ('cmd_g_ack', 'r_g_ack', 'start_day', 'acked', '{"ok":true,"deferred":true}'::jsonb, ${at(0)}, ${at(1)});`);
    const a = { roomId: "r_g_ack", commandId: "cmd_g_ack", ok: false, sessionId: null, error: "input_device_not_ready" };
    expect(await ackCommand(a)).toBe("failed");
    const first = (await pg.sql`SELECT status, error, acked_at::text AS t FROM bench_command WHERE id = 'cmd_g_ack'`)[0];
    pg.exec(`SELECT pg_sleep(0.05)`);
    await ackCommand(a);
    expect((await pg.sql`SELECT status, error, acked_at::text AS t FROM bench_command WHERE id = 'cmd_g_ack'`)[0]).toEqual(first);
  });
  it("the revise UPDATE is guarded: a row that left 'ok' between the read and the write is not overwritten (the idempotency guard)", async () => {
    const { reviseDeferredOk } = await import("@/lib/steward/loop");
    pg.exec(`INSERT INTO bench_command (id, room_id, kind, status, error, created_at) VALUES ('cmd_g_race', 'r_g_race', 'start_day', 'failed', 'boom', ${at(0)}); ${okRow("r_g_race", "cmd_g_race")}`);
    const racing = ((s: TemplateStringsArray, ...v: unknown[]) => {
      const q = s.join("?");
      const out = pg.sql(s, ...v);
      if (/FROM bench_command WHERE id = ANY/.test(q)) {
        // another reader settles the row after we read the failed command and before our write
        return out.then((r: unknown) => { pg.exec(`UPDATE steward_decisions SET result = 'failed: settled by another reader command_id=cmd_g_race' WHERE room_id = 'r_g_race'`); return r; });
      }
      return out;
    }) as never;
    expect(await reviseDeferredOk(racing, T + 600_000, 5000)).toBe(1); // it counts its attempt; the guard keeps the row
    expect(await resultOf("r_g_race")).toBe("failed: settled by another reader command_id=cmd_g_race");
  });
  it("a throwing revise query logs one line with room and command id, and marks the tick degraded", async () => {
    const { reconcilePending } = await import("@/lib/steward/loop");
    pg.exec(`INSERT INTO bench_command (id, room_id, kind, status, error, created_at) VALUES ('cmd_g_throw', 'r_g_throw', 'start_day', 'failed', 'boom', ${at(0)}); ${okRow("r_g_throw", "cmd_g_throw")}`);
    const throwing = ((s: TemplateStringsArray, ...v: unknown[]) => {
      if (/UPDATE steward_decisions SET result/.test(s.join("?")) && /failed after it was settled ok/.test(String(v[0]))) return Promise.reject(new Error("neon 503"));
      return pg.sql(s, ...v);
    }) as never;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const degraded = vi.fn();
    await reconcilePending(throwing, T + 600_000, 5000, degraded);
    expect(degraded).toHaveBeenCalledTimes(1);
    const line = err.mock.calls.map((c) => String(c[0])).find((l) => l.includes("revision failed"));
    expect(line).toContain("room=r_g_throw");
    expect(line).toContain("command_id=cmd_g_throw");
    err.mockRestore();
  });
});
