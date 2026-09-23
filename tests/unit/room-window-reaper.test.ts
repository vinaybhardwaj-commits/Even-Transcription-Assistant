/**
 * Orphaned "transcribing" room_window sweep (23 Sep 2026, L1). Pure rules in
 * lib/room-window-reaper-core; the sweep in lib/room-window-reaper driven through an injected
 * tagged-template `sql` (no live DB) — captures every statement and its parameters. Mirrors the
 * Room Bench session janitor's own test shape (tests/unit/bench-reaper.test.ts).
 */
import { describe, it, expect, vi } from "vitest";
import {
  decideRoomWindowReaps, DRAIN_MAX_ATTEMPTS, ROOM_WINDOW_REAP_CAP, ROOM_WINDOW_REAP_STALE_MINUTES,
} from "../../lib/room-window-reaper-core";
import { reapOrphanedRoomWindows, type SqlTag } from "../../lib/room-window-reaper";
import { DRAIN_MAX_ATTEMPTS as REAL_DRAIN_MAX_ATTEMPTS } from "../../lib/stt/room-drain";

vi.mock("../../lib/db", () => ({ sql: async () => { throw new Error("real sql must not be called in tests"); } }));

const NOW = Date.parse("2026-09-23T16:35:00.000Z");
const min = (n: number) => n * 60_000;
const iso = (t: number) => new Date(t).toISOString();

describe("pinned to the real drain bound", () => {
  it("DRAIN_MAX_ATTEMPTS here is the SAME number as lib/stt/room-drain.ts's — duplicated for a dependency-free core, but must never silently drift", () => {
    expect(DRAIN_MAX_ATTEMPTS).toBe(REAL_DRAIN_MAX_ATTEMPTS);
  });
  it("the normative numbers", () => {
    expect(ROOM_WINDOW_REAP_STALE_MINUTES).toBe(15);
    expect(ROOM_WINDOW_REAP_CAP).toBe(200);
  });
});

describe("decideRoomWindowReaps — classification", () => {
  it("CANCELLED, stale, attempts under the bound -> closed / queued, reason job_cancelled", () => {
    const d = decideRoomWindowReaps([{ window_id: "bw_1", job_status: "cancelled", job_finished_at: iso(NOW - min(20)), subject_attempts: 1 }], NOW);
    expect(d).toEqual([{ window_id: "bw_1", next_bench_state: "closed", next_subject_state: "queued", reason: "job_cancelled" }]);
  });
  it("FAILED, stale, attempts under the bound -> closed / queued, reason job_failed_without_bookkeeping", () => {
    const d = decideRoomWindowReaps([{ window_id: "bw_2", job_status: "failed", job_finished_at: iso(NOW - min(20)), subject_attempts: 2 }], NOW);
    expect(d).toEqual([{ window_id: "bw_2", next_bench_state: "closed", next_subject_state: "queued", reason: "job_failed_without_bookkeeping" }]);
  });
  it("EXHAUSTED (attempts >= DRAIN_MAX_ATTEMPTS) -> failed / failed, not closed / queued", () => {
    const d = decideRoomWindowReaps([{ window_id: "bw_3", job_status: "cancelled", job_finished_at: iso(NOW - min(20)), subject_attempts: DRAIN_MAX_ATTEMPTS }], NOW);
    expect(d).toEqual([{ window_id: "bw_3", next_bench_state: "failed", next_subject_state: "failed", reason: "job_cancelled" }]);
  });
  it("attempts one OVER the bound is still exhausted, not a crash", () => {
    const d = decideRoomWindowReaps([{ window_id: "bw_4", job_status: "failed", job_finished_at: iso(NOW - min(20)), subject_attempts: DRAIN_MAX_ATTEMPTS + 5 }], NOW);
    expect(d[0]!.next_bench_state).toBe("failed");
  });
  it("null subject_attempts (no stt_subject_job row) is treated as zero, never exhausted, never a throw", () => {
    const d = decideRoomWindowReaps([{ window_id: "bw_5", job_status: "cancelled", job_finished_at: iso(NOW - min(20)), subject_attempts: null }], NOW);
    expect(d[0]!.next_bench_state).toBe("closed");
  });
});

describe("decideRoomWindowReaps — what is NEVER touched", () => {
  it("DONE is left alone (a 'transcribing' row beside a done job is a different, stranger problem)", () => {
    expect(decideRoomWindowReaps([{ window_id: "bw_done", job_status: "done", job_finished_at: iso(NOW - min(60)), subject_attempts: 0 }], NOW)).toEqual([]);
  });
  it("QUEUED / RUNNING are the live, in-horizon case — never candidates", () => {
    expect(decideRoomWindowReaps([
      { window_id: "bw_q", job_status: "queued", job_finished_at: null, subject_attempts: 0 },
      { window_id: "bw_r", job_status: "running", job_finished_at: null, subject_attempts: 0 },
    ], NOW)).toEqual([]);
  });
  it("no job at all (null status, null finished_at) is left alone, not auto-closed", () => {
    expect(decideRoomWindowReaps([{ window_id: "bw_never", job_status: null, job_finished_at: null, subject_attempts: 0 }], NOW)).toEqual([]);
  });
  it("junk rows (no window_id) are skipped, never a throw", () => {
    expect(decideRoomWindowReaps([{ window_id: "", job_status: "cancelled", job_finished_at: iso(NOW - min(20)), subject_attempts: 0 }] as never, NOW)).toEqual([]);
  });
});

describe("decideRoomWindowReaps — the staleness bound", () => {
  it("exactly ROOM_WINDOW_REAP_STALE_MINUTES old IS reaped; one second short is NOT (the race-avoidance buffer)", () => {
    const atBound = decideRoomWindowReaps([{ window_id: "bw_at", job_status: "cancelled", job_finished_at: iso(NOW - min(ROOM_WINDOW_REAP_STALE_MINUTES)), subject_attempts: 0 }], NOW);
    expect(atBound).toHaveLength(1);
    const justUnder = decideRoomWindowReaps([{ window_id: "bw_under", job_status: "cancelled", job_finished_at: iso(NOW - min(ROOM_WINDOW_REAP_STALE_MINUTES) + 1000), subject_attempts: 0 }], NOW);
    expect(justUnder).toEqual([]);
  });
  it("MUTATION CONTROL — a job finished 1 minute ago is NOT reaped (kills a mutant that drops the staleness check entirely)", () => {
    expect(decideRoomWindowReaps([{ window_id: "bw_fresh", job_status: "cancelled", job_finished_at: iso(NOW - min(1)), subject_attempts: 0 }], NOW)).toEqual([]);
  });
});

describe("decideRoomWindowReaps — cap and order", () => {
  it("cap: at most ROOM_WINDOW_REAP_CAP decisions per run", () => {
    const rows = Array.from({ length: ROOM_WINDOW_REAP_CAP + 20 }, (_, i) => ({ window_id: `bw_${i}`, job_status: "cancelled" as const, job_finished_at: iso(NOW - min(20)), subject_attempts: 0 }));
    expect(decideRoomWindowReaps(rows, NOW).length).toBe(ROOM_WINDOW_REAP_CAP);
  });
  it("oldest-finished first, so a capped run still drains in a stable order across repeated calls", () => {
    const rows = [
      { window_id: "newer", job_status: "cancelled" as const, job_finished_at: iso(NOW - min(16)), subject_attempts: 0 },
      { window_id: "older", job_status: "cancelled" as const, job_finished_at: iso(NOW - min(200)), subject_attempts: 0 },
    ];
    expect(decideRoomWindowReaps(rows, NOW).map((d) => d.window_id)).toEqual(["older", "newer"]);
  });
});

/** A fake tagged-template sql: records each statement (text + params) and answers by statement kind. */
function fakeSql(candidates: unknown, opts: { updateReturns?: (id: string) => Array<{ id: string }>; failSelect?: boolean; failAudit?: boolean } = {}) {
  const calls: Array<{ text: string; params: unknown[] }> = [];
  const run: SqlTag = async (strings, ...values) => {
    const text = strings.join("?");
    calls.push({ text, params: values });
    if (/^\s*SELECT/i.test(text)) { if (opts.failSelect) throw new Error("relation \"bench_window\" does not exist"); return candidates; }
    if (/^\s*UPDATE bench_window/i.test(text)) return opts.updateReturns ? opts.updateReturns(String(values[1])) : [{ id: String(values[1]) }];
    if (/^\s*UPDATE stt_subject_job/i.test(text)) return [];
    if (/^\s*INSERT INTO audit_log/i.test(text)) { if (opts.failAudit) throw new Error("audit down"); return []; }
    throw new Error(`unexpected statement: ${text.slice(0, 60)}`);
  };
  return { run, calls };
}

describe("reapOrphanedRoomWindows — the sweep through an injected sql", () => {
  it("reaps a cancelled, stale window: bench_window closed, stt_subject_job queued, one audit row with the reaper actor", async () => {
    const { run, calls } = fakeSql([{ window_id: "bw_1", job_status: "cancelled", job_finished_at: iso(NOW - min(20)), subject_attempts: 1 }]);
    const r = await reapOrphanedRoomWindows({ now: new Date(NOW) }, run);
    expect(r.reaped).toEqual([{ window_id: "bw_1", next_bench_state: "closed", next_subject_state: "queued", reason: "job_cancelled", audit: "written" }]);
    expect(calls.map((c) => c.text.trim().split(/\s+/)[0])).toEqual(["SELECT", "UPDATE", "UPDATE", "INSERT"]);
    expect(calls[0]!.text).toMatch(/WHERE w\.state = 'transcribing'/);
    expect(calls[0]!.text).toMatch(/kind = 'room_window'/);
    const benchUpd = calls[1]!;
    expect(benchUpd.text).toMatch(/UPDATE bench_window SET state = \?\s+WHERE id = \? AND state = 'transcribing'\s+RETURNING id/);
    expect(benchUpd.params).toEqual(["closed", "bw_1"]);
    const subjUpd = calls[2]!;
    expect(subjUpd.text).toMatch(/UPDATE stt_subject_job/);
    expect(subjUpd.params).toEqual(["queued", "queued", "bw_1"]);
    const aud = calls[3]!;
    expect(aud.text).toMatch(/INSERT INTO audit_log \(actor_type, actor_id, action, target_type, target_id, metadata_json\)\s+VALUES \('system', 'reaper', 'room_window\.reap_orphaned_transcribing', 'bench_window', \?,/);
    expect(aud.params[0]).toBe("bw_1");
    expect(JSON.parse(String(aud.params[1]))).toEqual({ reason: "job_cancelled", next_bench_state: "closed", next_subject_state: "queued" });
  });

  it("live and done candidates produce NO update and NO audit row", async () => {
    const { run, calls } = fakeSql([
      { window_id: "live", job_status: "running", job_finished_at: null, subject_attempts: 0 },
      { window_id: "finished_ok", job_status: "done", job_finished_at: iso(NOW - min(60)), subject_attempts: 0 },
    ]);
    const r = await reapOrphanedRoomWindows({ now: new Date(NOW) }, run);
    expect(r.reaped).toEqual([]); expect(r.candidates).toBe(2);
    expect(calls.length).toBe(1);   // the SELECT only
  });

  it("exhausted attempts -> bench_window failed, stt_subject_job failed", async () => {
    const { run, calls } = fakeSql([{ window_id: "bw_x", job_status: "failed", job_finished_at: iso(NOW - min(20)), subject_attempts: DRAIN_MAX_ATTEMPTS }]);
    const r = await reapOrphanedRoomWindows({ now: new Date(NOW) }, run);
    expect(r.reaped[0]).toMatchObject({ next_bench_state: "failed", next_subject_state: "failed" });
    expect(calls[1]!.params).toEqual(["failed", "bw_x"]);
    expect(calls[2]!.params).toEqual(["failed", "failed", "bw_x"]);
  });

  it("RACE: a fresh drain claimed the window between read and write (bench_window UPDATE returns nothing) -> no stt_subject_job write, no audit row", async () => {
    const raced = fakeSql([{ window_id: "bw_y", job_status: "cancelled", job_finished_at: iso(NOW - min(20)), subject_attempts: 0 }], { updateReturns: () => [] });
    const r = await reapOrphanedRoomWindows({ now: new Date(NOW) }, raced.run);
    expect(r.reaped).toEqual([]);
    expect(raced.calls.length).toBe(2);   // SELECT + the bench_window UPDATE, no stt_subject_job UPDATE, no INSERT
  });

  it("sweep DB error -> no-op with the error on the result (the cron route still returns 200)", async () => {
    const { run } = fakeSql([], { failSelect: true });
    const r = await reapOrphanedRoomWindows({ now: new Date(NOW) }, run);
    expect(r.reaped).toEqual([]); expect(r.candidates).toBe(0); expect(r.error).toMatch(/does not exist/);
  });

  it("a failed audit write is best-effort: the window is still reaped, audit marked failed", async () => {
    const { run } = fakeSql([{ window_id: "bw_1", job_status: "cancelled", job_finished_at: iso(NOW - min(20)), subject_attempts: 0 }], { failAudit: true });
    const r = await reapOrphanedRoomWindows({ now: new Date(NOW) }, run);
    expect(r.reaped[0]!.audit).toBe("failed");
  });

  it("dry run reads candidates and writes nothing", async () => {
    const { run, calls } = fakeSql([{ window_id: "bw_1", job_status: "cancelled", job_finished_at: iso(NOW - min(20)), subject_attempts: 0 }]);
    const r = await reapOrphanedRoomWindows({ now: new Date(NOW), dryRun: true }, run);
    expect(r.dry_run).toBe(true); expect(r.reaped.length).toBe(1); expect(calls.length).toBe(1);
  });

  it("attempts never increments — a cancelled-for-serial-retry job never spent a real attempt (a mutant that increments here would be caught by the 'closed/queued not failed/failed' assertions above, since it would move exhausted-at-3 to exhausted-at-4 rather than change these results — this test pins the INTENT in one place: no attempts column is ever written by this sweep)", async () => {
    const { run, calls } = fakeSql([{ window_id: "bw_1", job_status: "cancelled", job_finished_at: iso(NOW - min(20)), subject_attempts: 1 }]);
    await reapOrphanedRoomWindows({ now: new Date(NOW) }, run);
    const subjUpd = calls.find((c) => /UPDATE stt_subject_job/i.test(c.text))!;
    expect(subjUpd.text).not.toMatch(/attempts/i);
  });
});
