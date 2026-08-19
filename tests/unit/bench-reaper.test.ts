/**
 * Room Bench session janitor + stalled badge (Kickoff K-A v2, 19 Aug 2026; R1–R3, R10–R11).
 * Pure rules in lib/bench-reaper-core; the sweep in lib/bench-reaper driven through an injected
 * tagged-template `sql` (no live DB) — captures every statement and its parameters.
 */
import { describe, it, expect, vi } from "vitest";
import {
  decideBenchReaps, isBenchStalled, istDate, lastAudioMs, newestChunkMs,
  NOTE_ROLLOVER, NOTE_STALL, REAP_CAP, STALL_MINUTES, STALLED_BADGE_MINUTES,
} from "../../lib/bench-reaper-core";
import { reapBenchSessions, type SqlTag } from "../../lib/bench-reaper";

vi.mock("../../lib/db", () => ({ sql: async () => { throw new Error("real sql must not be called in tests"); } }));

const NOW = Date.parse("2026-08-19T12:00:00.000Z");   // 17:30 IST
const min = (n: number) => n * 60_000;
const iso = (t: number) => new Date(t).toISOString();

describe("pure helpers", () => {
  it("newestChunkMs / lastAudioMs span BOTH sources; started_at is the zero-chunk fallback", () => {
    expect(newestChunkMs({ last_primary_at: iso(NOW - min(31)), last_backup_at: iso(NOW - min(2)) })).toBe(NOW - min(2));
    expect(newestChunkMs({ last_primary_at: null, last_backup_at: null })).toBeNull();
    expect(lastAudioMs({ id: "a", status: "recording", started_at: iso(NOW - min(31)) })).toBe(NOW - min(31));
    expect(lastAudioMs({ id: "a", status: "recording", started_at: iso(NOW - min(90)), last_primary_at: iso(NOW - min(40)) })).toBe(NOW - min(40));
  });
  it("istDate: Asia/Kolkata calendar day, the 18:30 UTC boundary exact", () => {
    expect(istDate("2026-08-18T18:29:59.000Z")).toBe("2026-08-18");
    expect(istDate("2026-08-18T18:30:00.000Z")).toBe("2026-08-19");
    expect(istDate(NOW)).toBe("2026-08-19");
    expect(istDate("junk")).toBe("");
  });
  it("the normative numbers + notes", () => {
    expect(STALL_MINUTES).toBe(30); expect(STALLED_BADGE_MINUTES).toBe(10); expect(REAP_CAP).toBe(50);
    expect(NOTE_STALL).toBe("auto-ended: no chunks >30m (reaper)");
    expect(NOTE_ROLLOVER).toBe("auto-ended: day rollover (reaper)");
  });
});

describe("Rule 1 — stall (R1/R3)", () => {
  it("reaps a 31-min-silent recording session at its LAST CHUNK time with the stall note", () => {
    const d = decideBenchReaps([{ id: "bs_1", status: "recording", started_at: iso(NOW - min(120)), last_primary_at: iso(NOW - min(31)), last_backup_at: iso(NOW - min(35)) }], NOW);
    expect(d).toEqual([{ id: "bs_1", rule: "stall", note: NOTE_STALL, ended_at: iso(NOW - min(31)) }]);
  });
  it("BACKUP ALIVE: primary silent 31 min but a backup chunk 2 min ago → NOT reaped", () => {
    expect(decideBenchReaps([{ id: "bs_2", status: "recording", started_at: iso(NOW - min(120)), last_primary_at: iso(NOW - min(31)), last_backup_at: iso(NOW - min(2)) }], NOW)).toEqual([]);
  });
  it("a zero-chunk recording session 31 min old → reaped at started_at; 29 min old → untouched", () => {
    expect(decideBenchReaps([{ id: "bs_3", status: "recording", started_at: iso(NOW - min(31)) }], NOW)).toEqual([{ id: "bs_3", rule: "stall", note: NOTE_STALL, ended_at: iso(NOW - min(31)) }]);
    expect(decideBenchReaps([{ id: "bs_4", status: "recording", started_at: iso(NOW - min(29)) }], NOW)).toEqual([]);
  });
  it("a PAUSED session from today, silent 31 min → untouched by Rule 1", () => {
    expect(decideBenchReaps([{ id: "bs_5", status: "paused", started_at: iso(NOW - min(120)), last_primary_at: iso(NOW - min(31)) }], NOW)).toEqual([]);
  });
  it("ended sessions are never candidates; junk rows are skipped", () => {
    expect(decideBenchReaps([{ id: "bs_6", status: "ended", started_at: iso(NOW - min(500)) }, { id: "", status: "recording", started_at: iso(NOW - min(500)) }, { id: "bs_7", status: "recording", started_at: "junk" }], NOW)).toEqual([]);
  });
});

describe("Rule 2 — day rollover (R2, IST)", () => {
  it("a paused session from yesterday IST → reaped at its honest last-audio time; today's paused → untouched", () => {
    const yesterdayStart = "2026-08-18T04:30:00.000Z";   // 10:00 IST 18 Aug
    const d = decideBenchReaps([
      { id: "y", status: "paused", started_at: yesterdayStart, last_primary_at: "2026-08-18T10:00:00.000Z" },
      { id: "t", status: "paused", started_at: "2026-08-19T04:30:00.000Z", last_primary_at: iso(NOW - min(1)) },
    ], NOW);
    expect(d).toEqual([{ id: "y", rule: "rollover", note: NOTE_ROLLOVER, ended_at: "2026-08-18T10:00:00.000Z" }]);
  });
  it("the IST boundary: started 18:29:59Z on the 18th = yesterday IST → reaped; 18:30:00Z = today IST → untouched (paused, so Rule 1 cannot apply)", () => {
    expect(decideBenchReaps([{ id: "b1", status: "paused", started_at: "2026-08-18T18:29:59.000Z" }], NOW).map((x) => x.id)).toEqual(["b1"]);
    expect(decideBenchReaps([{ id: "b2", status: "paused", started_at: "2026-08-18T18:30:00.000Z" }], NOW)).toEqual([]);
  });
  it("a yesterday recording session that is ALSO silent > 30 min carries the stall note (Rule 1 wins the note); a yesterday recording session still landing chunks rolls over", () => {
    const both = decideBenchReaps([{ id: "r", status: "recording", started_at: "2026-08-18T04:30:00.000Z", last_backup_at: "2026-08-18T11:00:00.000Z" }], NOW);
    expect(both[0].rule).toBe("stall");
    const live = decideBenchReaps([{ id: "l", status: "recording", started_at: "2026-08-18T04:30:00.000Z", last_primary_at: iso(NOW - min(1)) }], NOW);
    expect(live).toEqual([{ id: "l", rule: "rollover", note: NOTE_ROLLOVER, ended_at: iso(NOW - min(1)) }]);
  });
  it("cap: at most REAP_CAP decisions per run", () => {
    const rows = Array.from({ length: 80 }, (_, i) => ({ id: `bs_${i}`, status: "recording", started_at: iso(NOW - min(60)) }));
    expect(decideBenchReaps(rows, NOW).length).toBe(REAP_CAP);
  });
});

/** A fake tagged-template sql: records each statement (text + params) and answers by statement kind. */
function fakeSql(candidates: unknown, opts: { updateReturns?: (id: string) => Array<{ id: string }>; failSelect?: boolean; failAudit?: boolean } = {}) {
  const calls: Array<{ text: string; params: unknown[] }> = [];
  const run: SqlTag = async (strings, ...values) => {
    const text = strings.join("?");
    calls.push({ text, params: values });
    if (/^\s*SELECT/i.test(text)) { if (opts.failSelect) throw new Error("relation \"bench_session\" does not exist"); return candidates; }
    if (/^\s*UPDATE bench_session/i.test(text)) return opts.updateReturns ? opts.updateReturns(String(values[2])) : [{ id: String(values[2]) }];
    if (/^\s*INSERT INTO audit_log/i.test(text)) { if (opts.failAudit) throw new Error("audit down"); return []; }
    throw new Error(`unexpected statement: ${text.slice(0, 40)}`);
  };
  return { run, calls };
}

describe("reapBenchSessions — the sweep through an injected sql", () => {
  it("reaps a stalled session: ended_at = last chunk time, note appended via the notes CASE, one audit row per reaped session with the reaper actor", async () => {
    const { run, calls } = fakeSql([{ id: "bs_1", status: "recording", started_at: iso(NOW - min(120)), last_primary_at: iso(NOW - min(31)), last_backup_at: null }]);
    const r = await reapBenchSessions({ now: new Date(NOW) }, run);
    expect(r.reaped).toEqual([{ id: "bs_1", rule: "stall", note: NOTE_STALL, ended_at: iso(NOW - min(31)), audit: "written" }]);
    expect(calls.map((c) => c.text.trim().split(/\s+/)[0])).toEqual(["SELECT", "UPDATE", "INSERT"]);
    const upd = calls[1];
    expect(upd.text).toMatch(/UPDATE bench_session\s+SET status = 'ended',\s+ended_at = \?::timestamptz,\s+notes = CASE WHEN notes IS NULL OR notes = '' THEN \? ELSE notes \|\| chr\(10\) \|\| \? END\s+WHERE id = \? AND status <> 'ended'\s+RETURNING id/);
    expect(upd.params).toEqual([iso(NOW - min(31)), NOTE_STALL, NOTE_STALL, "bs_1"]);
    const aud = calls[2];
    expect(aud.text).toMatch(/INSERT INTO audit_log \(actor_type, actor_id, action, target_type, target_id, metadata_json\)\s+VALUES \('system', 'reaper', 'bench_session\.reap', 'bench_session', \?,\s+\?::jsonb\)/);
    expect(aud.params[0]).toBe("bs_1");
    expect(JSON.parse(String(aud.params[1]))).toEqual({ rule: "stall", note: NOTE_STALL, ended_at: iso(NOW - min(31)) });
    // the candidate SELECT spans both sources
    expect(calls[0].text).toMatch(/MAX\(c\.created_at\) FILTER \(WHERE c\.source = 'primary'\) AS last_primary_at/);
    expect(calls[0].text).toMatch(/MAX\(c\.created_at\) FILTER \(WHERE c\.source = 'backup'\)\s+AS last_backup_at/);
    expect(calls[0].text).toMatch(/WHERE s\.status <> 'ended'/);
  });
  it("backup-alive and today's paused sessions produce NO update and NO audit row", async () => {
    const { run, calls } = fakeSql([
      { id: "alive", status: "recording", started_at: iso(NOW - min(120)), last_primary_at: iso(NOW - min(31)), last_backup_at: iso(NOW - min(2)) },
      { id: "paused", status: "paused", started_at: iso(NOW - min(120)), last_primary_at: iso(NOW - min(31)), last_backup_at: null },
    ]);
    const r = await reapBenchSessions({ now: new Date(NOW) }, run);
    expect(r.reaped).toEqual([]); expect(r.candidates).toBe(2);
    expect(calls.length).toBe(1);   // the SELECT only
  });
  it("rollover: yesterday's paused session → reaped with the rollover note; ended meanwhile (UPDATE returns nothing) → no audit row", async () => {
    const { run, calls } = fakeSql([{ id: "y", status: "paused", started_at: "2026-08-18T04:30:00.000Z", last_primary_at: "2026-08-18T10:00:00.000Z", last_backup_at: null }]);
    const r = await reapBenchSessions({ now: new Date(NOW) }, run);
    expect(r.reaped[0]).toMatchObject({ id: "y", rule: "rollover", note: NOTE_ROLLOVER, ended_at: "2026-08-18T10:00:00.000Z" });
    expect(calls.length).toBe(3);
    const raced = fakeSql([{ id: "y", status: "paused", started_at: "2026-08-18T04:30:00.000Z", last_primary_at: null, last_backup_at: null }], { updateReturns: () => [] });
    const r2 = await reapBenchSessions({ now: new Date(NOW) }, raced.run);
    expect(r2.reaped).toEqual([]); expect(raced.calls.length).toBe(2);   // SELECT + UPDATE, no INSERT
  });
  it("sweep DB error → no-op with the error on the result (the cron route still returns 200)", async () => {
    const { run } = fakeSql([], { failSelect: true });
    const r = await reapBenchSessions({ now: new Date(NOW) }, run);
    expect(r.reaped).toEqual([]); expect(r.candidates).toBe(0); expect(r.error).toMatch(/does not exist/);
  });
  it("a failed audit write is best-effort: the session is still ended, audit marked failed", async () => {
    const { run } = fakeSql([{ id: "bs_1", status: "recording", started_at: iso(NOW - min(120)), last_primary_at: iso(NOW - min(31)), last_backup_at: null }], { failAudit: true });
    const r = await reapBenchSessions({ now: new Date(NOW) }, run);
    expect(r.reaped[0].audit).toBe("failed");
  });
  it("dry run reads candidates and writes nothing", async () => {
    const { run, calls } = fakeSql([{ id: "bs_1", status: "recording", started_at: iso(NOW - min(120)), last_primary_at: iso(NOW - min(31)), last_backup_at: null }]);
    const r = await reapBenchSessions({ now: new Date(NOW), dryRun: true }, run);
    expect(r.dry_run).toBe(true); expect(r.reaped.length).toBe(1); expect(calls.length).toBe(1);
  });
});

describe("stalled badge (R10, time-based)", () => {
  it("9 min → no chip; 11 min → stalled; ended → never; paused → never; backup chunk keeps it un-stalled; zero chunks falls back to started_at", () => {
    expect(isBenchStalled({ status: "recording", last_any_chunk_at: iso(NOW - min(9)) }, NOW)).toBe(false);
    expect(isBenchStalled({ status: "recording", last_any_chunk_at: iso(NOW - min(11)) }, NOW)).toBe(true);
    expect(isBenchStalled({ status: "ended", last_any_chunk_at: iso(NOW - min(500)) }, NOW)).toBe(false);
    expect(isBenchStalled({ status: "paused", last_any_chunk_at: iso(NOW - min(500)) }, NOW)).toBe(false);
    expect(isBenchStalled({ status: "recording", last_any_chunk_at: iso(NOW - min(2)) }, NOW)).toBe(false);   // backup landed → last_any is fresh
    expect(isBenchStalled({ status: "recording", last_any_chunk_at: null, started_at: iso(NOW - min(11)) }, NOW)).toBe(true);
    expect(isBenchStalled({ status: "recording", last_any_chunk_at: null, started_at: iso(NOW - min(3)) }, NOW)).toBe(false);
    expect(isBenchStalled({ status: "recording", last_any_chunk_at: null, started_at: null }, NOW)).toBe(false);
  });
});
