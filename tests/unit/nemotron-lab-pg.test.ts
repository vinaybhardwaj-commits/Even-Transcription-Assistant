/**
 * nemotron-lab-pg.test.ts — the Nemotron LAB lane on postgres:16 with EVERY migration (0143 included), through the real runner:
 *   1. migration 0143 applies twice, registers once, its constraints hold, and diarize_nemotron_window gains probs_r2_key;
 *   2. the lab store's real SQL: items claimed oldest-run-first, 15-min lease, SKIP LOCKED (two racing claims never share a row), 3 attempts, the run deadline,
 *      the live-lease rule on ingest, retryable vs terminal failures, spec_hash mismatch, a repeat answer;
 *   3. LAB OUTPUT NEVER TOUCHES PRODUCTION: a full lab lifecycle leaves room_diarize_window, room_turn_speaker, diarize_nemotron_window / _claim / _worker
 *      byte-identical (row hash), and the lab store's source names none of them;
 *   4. productionPendingExists agrees with claimPending's own eligibility on seeded windows;
 *   5. the production ingest's probability pointer: stored with the row, attached to an existing row only where NULL, never part of the duplicate test;
 *   6. the nemotron_lab_run JOB through claimJobs + runOneStep: prepare → cut → wait → done, the 24 h timeout, an unresolved window, the flag, a span cut.
 * Only the outside world is faked (the join service). All ids are fake. DOCKER: CI host only.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const H = vi.hoisted(() => ({
  sql: (async () => []) as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>,
  join: vi.fn(),
  chunks: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => H.sql(s, ...v) }));
vi.mock("@/lib/bench-join", async (orig) => ({ ...(await orig<Record<string, unknown>>()), callJoinService: (...a: unknown[]) => H.join(...a) }));
vi.mock("@/lib/bench", async (orig) => ({ ...(await orig<Record<string, unknown>>()), listBenchChunks: (...a: unknown[]) => H.chunks(...a) }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

const HAVE = dockerAvailable();
const pg = pgContainer("eta-nemo-lab");
const q = async <T = Record<string, unknown>>(strings: TemplateStringsArray, ...v: unknown[]) => (await pg.sql(strings, ...v)) as T[];
const fails = (text: string) => { try { pg.exec(text); return ""; } catch (e) { return String((e as { stderr?: unknown }).stderr ?? e); } };

const lab = await import("@/lib/diarize-nemotron/lab");
const L = await import("@/lib/room-access/nemotron-lab-store");
const N = await import("@/lib/room-access/nemotron-store");
const V = await import("@/lib/diarize-nemotron/validate");
const { nemotronLabRunKind } = await import("@/lib/jobs/kinds/nemotron-lab-run");

let nextStart = 1_790_100_000_000;
const SPEC = lab.parseLabSpec({ return_probs: true });
const SPEC_NONE = lab.parseLabSpec(undefined);
const win = (id: string, o: { clip?: boolean; state?: string } = {}) => {
  const start = (nextStart += 900_000);
  pg.exec(`INSERT INTO bench_window (id, session_id, room_day_id, start_ms, end_ms, source_mic, clip_r2_key, grid_aligned, state, closed_at)
           VALUES ('${id}', 'bs_l1', 'rd_l1', ${start}, ${start + 900_000}, 'primary', ${o.clip === false ? "NULL" : `'clips/${id}.webm'`}, TRUE, '${o.state ?? "transcribed"}', NOW());`);
};
const labBody = (runId: string, idx: number, o: Record<string, unknown> = {}) => {
  const body = {
    run_id: runId, idx, worker_id: "box-1", status: "ok", error_code: null, model: "nvidia/Nemotron-3-Diarization", model_rev: "rev1", config: { chunk_len: 340 },
    spec_hash: lab.specHash(SPEC), audio_ms: 900_000, clip_sha256: "b".repeat(64), turns: [[0, 4000, "spk0"], [3500, 9000, "spk1"]],
    probs_r2_key: null, embeddings_r2_key: null, embeddings_dims: null, infer_s: 2.5, ...o,
  };
  const v = lab.checkLabIngest(body);
  if (!v.ok) throw new Error(`fixture refused: ${v.error}`);
  return v;
};
const ingestLab = (runId: string, idx: number, o: Record<string, unknown> = {}, worker = "box-1") => {
  const v = labBody(runId, idx, { worker_id: worker, ...o });
  return L.recordLabIngest(v.body, v.derived);
};
const item = async (runId: string, idx: number) =>
  (await q<Record<string, any>>`SELECT * FROM nemotron_lab_item WHERE run_id = ${runId} AND idx = ${idx}`)[0]!;
const expireLeases = () => pg.exec(`UPDATE nemotron_lab_item SET lease_until = now() - interval '1 second' WHERE state = 'queued' AND lease_until IS NOT NULL;`);
const wipeLab = () => pg.exec(`DELETE FROM nemotron_lab_run;`);

const PRODUCTION = ["room_diarize_window", "room_turn_speaker", "diarize_nemotron_window", "diarize_nemotron_claim", "diarize_nemotron_worker"] as const;
const fingerprint = async () => {
  const out: Record<string, string> = {};
  for (const t of PRODUCTION) {
    const text = `SELECT count(*) || ':' || COALESCE(md5(string_agg(x::text, '|' ORDER BY x::text)), '-') AS fp FROM ${t} x`;
    out[t] = String(((await pg.sql(Object.assign([text], { raw: [text] }) as unknown as TemplateStringsArray)) as Array<{ fp: string }>)[0]!.fp);
  }
  return out;
};

beforeAll(() => {
  if (!HAVE) return;
  pg.start();
  for (const f of readdirSync("db/migrations").filter((x) => x.endsWith(".sql")).sort()) pg.exec(readFileSync(`db/migrations/${f}`, "utf8"));
  H.sql = pg.sql as never;
  pg.exec(`
    INSERT INTO room (id, slug, name, pin_hash, transcript_enabled) VALUES ('room_l1', 'lab-room', 'Lab Room', 'x', TRUE);
    INSERT INTO room_day (id, room_id, ist_date) VALUES ('rd_l1', 'room_l1', '2026-10-02');
    INSERT INTO bench_session (id, room_id, started_at, ended_at, status) VALUES ('bs_l1', 'room_l1', '2026-10-02T04:00:00Z', '2026-10-02T20:00:00Z', 'ended');
  `);
}, 300_000);
afterAll(() => { if (HAVE) pg.stop(); });
afterEach(() => { vi.useRealTimers(); });

describe.skipIf(!HAVE)("migration 0143", () => {
  it("applies twice, registers once, and its constraints hold", async () => {
    const sqlText = readFileSync("db/migrations/0143_nemotron_lab.sql", "utf8");
    pg.exec(sqlText);
    pg.exec(sqlText);
    expect((await q<{ n: number }>`SELECT count(*)::int AS n FROM schema_migrations WHERE version = 143`)[0]!.n).toBe(1);
    expect((await q<{ t: string }>`SELECT data_type AS t FROM information_schema.columns WHERE table_name = 'diarize_nemotron_window' AND column_name = 'probs_r2_key'`)[0]!.t).toBe("text");
    pg.exec(`INSERT INTO nemotron_lab_run (job_id, spec, spec_hash, n_items, deadline_at) VALUES ('mig_run', '{}', 'h', 1, now() + interval '1 hour');`);
    const ins = (cols: string, vals: string) => fails(`INSERT INTO nemotron_lab_item (run_id, idx, ${cols}) VALUES ('mig_run', ${vals});`);
    expect(ins("source_kind, window_id", "11, 'window', 'bw_x'")).toMatch(/idx_chk/);
    expect(ins("source_kind", "0, 'window'")).toMatch(/source_cols_chk/);
    expect(ins("source_kind, window_id", "0, 'upload', 'bw_x'")).toMatch(/source_chk/);
    expect(ins("source_kind, window_id, state", "0, 'window', 'bw_x', 'failed'")).toMatch(/failed_chk/);
    expect(ins("source_kind, window_id, state", "0, 'window', 'bw_x', 'done'")).toMatch(/state_chk/);
    expect(ins("source_kind, window_id, attempts", "0, 'window', 'bw_x', 4")).toMatch(/attempts_chk/);
    expect(fails(`INSERT INTO nemotron_lab_run (job_id, spec, spec_hash, n_items, deadline_at) VALUES ('mig_run2', '{}', 'h', 11, now());`)).toMatch(/items_chk/);
    expect(fails(`INSERT INTO nemotron_lab_item (run_id, idx, source_kind, window_id) VALUES ('no_such_run', 0, 'window', 'bw_x');`)).toMatch(/foreign key/);
    wipeLab();
  });
});

describe.skipIf(!HAVE)("the lab store", () => {
  beforeEach(() => { wipeLab(); });

  it("insertLabRun is idempotent and a window input takes its clip key; a clipless window stays unresolved", async () => {
    win("bw_s1");
    win("bw_s2", { clip: false });
    const inputs = lab.parseLabInputs({ windows: ["bw_s1", "bw_s2", "bw_missing"], r2_keys: ["clips/bs_l1/x-primary.webm"], spans: [{ session_id: "bs_l1", start: 1000, end: 9000 }] });
    await L.insertLabRun("run_s", SPEC, inputs, "tester");
    await L.insertLabRun("run_s", SPEC, inputs, "tester");
    const items = await q<{ idx: number; source_kind: string; clip_r2_key: string | null }>`SELECT idx, source_kind, clip_r2_key FROM nemotron_lab_item WHERE run_id = 'run_s' ORDER BY idx`;
    expect(items.map((i) => [i.idx, i.source_kind, i.clip_r2_key])).toEqual([[0, "window", "clips/bw_s1.webm"], [1, "window", null], [2, "window", null], [3, "r2_key", "clips/bs_l1/x-primary.webm"], [4, "span", null]]);
    expect((await q<{ n: number }>`SELECT count(*)::int AS n FROM nemotron_lab_run`)[0]!.n).toBe(1);
    expect(await L.unresolvedWindowItems("run_s")).toEqual([1, 2]);
    expect((await L.spansToCut("run_s")).map((s) => [s.idx, s.session_id, s.start_ms])).toEqual([[4, "bs_l1", 1000]]);
    await L.setItemClip("run_s", 4, "clips/bs_l1/cut.webm");
    expect(await L.spansToCut("run_s")).toEqual([]);
    await L.setItemClip("run_s", 4, "clips/bs_l1/other.webm"); // never replaces
    expect((await item("run_s", 4)).clip_r2_key).toBe("clips/bs_l1/cut.webm");
  });

  it("claims only items with a clip, oldest run first, and hands back the spec", async () => {
    win("bw_c1"); win("bw_c2");
    await L.insertLabRun("run_old", SPEC, lab.parseLabInputs({ windows: ["bw_c1", "bw_c2"] }), null);
    await new Promise((r) => setTimeout(r, 20));
    await L.insertLabRun("run_new", SPEC_NONE, lab.parseLabInputs({ r2_keys: ["clips/bs_l1/n-primary.webm"] }), null);
    await L.insertLabRun("run_noclip", SPEC, lab.parseLabInputs({ spans: [{ session_id: "bs_l1", start: 1, end: 100 }] }), null);
    const got = await L.claimLabItems("box-1", 10);
    expect(got.map((g) => [g.run_id, g.idx, g.attempt])).toEqual([["run_old", 0, 1], ["run_old", 1, 1], ["run_new", 0, 1]]);
    expect(got[0]!.spec).toEqual(SPEC);
    expect(got[0]!.spec_hash).toBe(lab.specHash(SPEC));
    expect(await L.claimLabItems("box-2", 10)).toEqual([]); // leased
    const row = await item("run_old", 0);
    expect([row.worker_id, row.attempts]).toEqual(["box-1", 1]);
  });

  it("two racing claims never share a row (SKIP LOCKED)", async () => {
    win("bw_r1"); win("bw_r2"); win("bw_r3"); win("bw_r4");
    await L.insertLabRun("run_race", SPEC, lab.parseLabInputs({ windows: ["bw_r1", "bw_r2", "bw_r3", "bw_r4"] }), null);
    const [a, b] = await Promise.all([L.claimLabItems("box-a", 2), L.claimLabItems("box-b", 2)]);
    const all = [...a, ...b].map((x) => x.idx);
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBe(4);
  });

  it("an expired lease is re-offered; the third attempt is the last; a run past its deadline is not offered", async () => {
    win("bw_l1");
    await L.insertLabRun("run_lease", SPEC, lab.parseLabInputs({ windows: ["bw_l1"] }), null);
    for (const attempt of [1, 2, 3]) {
      const got = await L.claimLabItems("box-1", 1);
      expect(got.map((g) => g.attempt)).toEqual([attempt]);
      expireLeases();
    }
    expect(await L.claimLabItems("box-1", 1)).toEqual([]); // attempts exhausted
    pg.exec(`UPDATE nemotron_lab_item SET attempts = 0 WHERE run_id = 'run_lease'; UPDATE nemotron_lab_run SET deadline_at = now() - interval '1 second' WHERE job_id = 'run_lease';`);
    expect(await L.claimLabItems("box-1", 1)).toEqual([]);
  });

  it("releaseLabClaim refunds the attempt and frees the lease", async () => {
    win("bw_rl");
    await L.insertLabRun("run_rel", SPEC, lab.parseLabInputs({ windows: ["bw_rl"] }), null);
    await L.claimLabItems("box-1", 1);
    await L.releaseLabClaim("box-2", "run_rel", 0); // not the holder: nothing
    expect((await item("run_rel", 0)).attempts).toBe(1);
    await L.releaseLabClaim("box-1", "run_rel", 0);
    expect((await item("run_rel", 0)).attempts).toBe(0);
    expect((await L.claimLabItems("box-3", 1)).map((g) => g.attempt)).toEqual([1]);
  });

  it("ingest: ok stores the result and the counts; the lease is required; a repeat is already_done", async () => {
    win("bw_i1");
    await L.insertLabRun("run_ing", SPEC, lab.parseLabInputs({ windows: ["bw_i1"] }), null);
    expect(await ingestLab("run_ing", 0)).toEqual({ result: "no_live_claim" }); // never claimed
    await L.claimLabItems("box-1", 1);
    expect(await ingestLab("run_ing", 0, {}, "box-2")).toEqual({ result: "no_live_claim" }); // someone else's lease
    expect(await ingestLab("run_ing", 0, { spec_hash: "f".repeat(64) })).toEqual({ result: "spec_mismatch" });
    expect(await ingestLab("run_nope", 0)).toEqual({ result: "unknown_item" });
    expect(await ingestLab("run_ing", 0, { probs_r2_key: "lab/nemotron/run_ing/0/probs.nlp" })).toEqual({ result: "stored", state: "ok" });
    const row = await item("run_ing", 0);
    expect([row.state, row.speaker_count, row.turn_count, row.speech_ms, row.overlap_ms, row.probs_r2_key, row.model_rev, row.audio_ms]).toEqual(["ok", 2, 2, 9000, 500, "lab/nemotron/run_ing/0/probs.nlp", "rev1", 900000]);
    expect(row.turns_json).toEqual([[0, 4000, "spk0"], [3500, 9000, "spk1"]]);
    expect(await ingestLab("run_ing", 0)).toEqual({ result: "already_done" });
    expect((await item("run_ing", 0)).turn_count).toBe(2); // a repeat changed nothing
  });

  it("ingest after the lease expired stores nothing", async () => {
    win("bw_i2");
    await L.insertLabRun("run_exp", SPEC, lab.parseLabInputs({ windows: ["bw_i2"] }), null);
    await L.claimLabItems("box-1", 1);
    expireLeases();
    expect(await ingestLab("run_exp", 0)).toEqual({ result: "no_live_claim" });
    expect((await item("run_exp", 0)).state).toBe("queued");
  });

  it("an empty answer is stored as empty", async () => {
    win("bw_i3");
    await L.insertLabRun("run_emp", SPEC, lab.parseLabInputs({ windows: ["bw_i3"] }), null);
    await L.claimLabItems("box-1", 1);
    expect(await ingestLab("run_emp", 0, { status: "empty", turns: [] })).toEqual({ result: "stored", state: "empty" });
    expect((await item("run_emp", 0)).state).toBe("empty");
  });

  it("a retryable failure is recorded and the item is offered again; the last attempt and a terminal code make it failed", async () => {
    win("bw_f1"); win("bw_f2");
    await L.insertLabRun("run_fail", SPEC, lab.parseLabInputs({ windows: ["bw_f1", "bw_f2"] }), null);
    const fail = (idx: number, code: string) => ingestLab("run_fail", idx, { status: "failed", error_code: code, turns: [], clip_sha256: null, audio_ms: 0 });

    await L.claimLabItems("box-1", 1); // idx 0, attempt 1
    expect(await fail(0, "infer_failed")).toEqual({ result: "failure_recorded", attempts: 1 });
    let row = await item("run_fail", 0);
    expect([row.state, row.error_code, row.last_error_code, row.failure_history.length]).toEqual(["queued", null, "infer_failed", 1]);
    for (const attempt of [2, 3]) {
      const got = await L.claimLabItems("box-1", 1);
      expect([got[0]!.idx, got[0]!.attempt]).toEqual([0, attempt]);
      const out = await fail(0, "gpu_oom");
      expect(out).toEqual(attempt === 3 ? { result: "stored", state: "failed" } : { result: "failure_recorded", attempts: attempt });
    }
    row = await item("run_fail", 0);
    expect([row.state, row.error_code]).toEqual(["failed", "gpu_oom"]);
    expect(row.failure_history.length).toBe(3);

    const got = await L.claimLabItems("box-1", 1); // idx 1, attempt 1: a terminal code ends it at once
    expect(got[0]!.idx).toBe(1);
    expect(await fail(1, "bad_spec")).toEqual({ result: "stored", state: "failed" });
    expect((await item("run_fail", 1)).state).toBe("failed");
    expect(await L.claimLabItems("box-1", 5)).toEqual([]);
  });

  it("labProgress and labItemSummaries count ids and states only", async () => {
    win("bw_p1"); win("bw_p2"); win("bw_p3");
    await L.insertLabRun("run_prog", SPEC, lab.parseLabInputs({ windows: ["bw_p1", "bw_p2", "bw_p3"] }), null);
    expect(await L.labProgress("run_prog")).toEqual({ total: 3, queued: 3, ok: 0, empty: 0, failed: 0, deadline_passed: false });
    await L.claimLabItems("box-1", 3);
    await ingestLab("run_prog", 0, { probs_r2_key: "lab/nemotron/run_prog/0/probs.nlp" });
    await ingestLab("run_prog", 1, { status: "empty", turns: [] });
    await ingestLab("run_prog", 2, { status: "failed", error_code: "bad_spec", turns: [], clip_sha256: null, audio_ms: 0 });
    expect(await L.labProgress("run_prog")).toEqual({ total: 3, queued: 0, ok: 1, empty: 1, failed: 1, deadline_passed: false });
    const sums = await L.labItemSummaries("run_prog");
    expect(sums.map((s) => [s.idx, s.state, s.has_probs])).toEqual([[0, "ok", true], [1, "empty", false], [2, "failed", false]]);
    expect(Object.keys(sums[0]!).sort()).toEqual(["audio_ms", "error_code", "has_embeddings", "has_probs", "idx", "speaker_count", "state", "turn_count"]);
    expect(await L.labProgress("run_none")).toBeNull();
  });
});

describe.skipIf(!HAVE)("LAB OUTPUT NEVER TOUCHES PRODUCTION", () => {
  it("a full lab lifecycle leaves every production diarize table byte-identical", async () => {
    wipeLab();
    // production rows exist (so a stray write would show as a changed hash, not just a count)
    win("bw_prod");
    pg.exec(`
      INSERT INTO room_diarize_window (window_id, room_day_id, state, speakers_json, segments_json, segments_run_id, clip_r2_key, last_run_id, timing_json)
        VALUES ('bw_prod', 'rd_l1', 'ok', '[{"idx":0}]'::jsonb, '[{"start_ms":0,"end_ms":1,"speaker_idx":0}]'::jsonb, 'run_p', 'clips/bw_prod.webm', 'run_p', '{"engine":{"name":"nemotron"}}'::jsonb);
      INSERT INTO diarize_nemotron_window (window_id, room_day_id, model, model_rev, config, config_hash, worker_id, machine, audio_ms, clip_sha256, turns_json, speaker_count, turn_count, speech_ms, overlap_ms, payload_sha256, status)
        VALUES ('bw_prod', 'rd_l1', 'm', 'r1', '{"a":1}', 'h', 'box-1', 'box', 900000, '${"c".repeat(64)}', '[[0,1000,"spk0"]]', 1, 1, 1000, 0, 'p', 'ok');
      INSERT INTO diarize_nemotron_claim (window_id, worker_id, lease_until, attempts, done_at) VALUES ('bw_prod', 'box-1', now(), 1, now());
      INSERT INTO diarize_nemotron_worker (worker_id, payload) VALUES ('box-1', '{}');
    `);
    const before = await fingerprint();
    for (const t of PRODUCTION.filter((x) => x !== "room_turn_speaker")) expect(before[t]!.startsWith("0:")).toBe(false); // seeded, so a stray write changes a hash
    expect(before.room_turn_speaker!.startsWith("0:")).toBe(true); // empty: a stray write would show as a count

    win("bw_lab1"); win("bw_lab2");
    await L.insertLabRun("run_iso", SPEC, lab.parseLabInputs({ windows: ["bw_lab1", "bw_lab2", "bw_prod"], r2_keys: ["clips/bs_l1/z-primary.webm"] }), "tester");
    const claimed = await L.claimLabItems("box-1", 4);
    expect(claimed).toHaveLength(4);
    await ingestLab("run_iso", 0, { probs_r2_key: "lab/nemotron/run_iso/0/probs.nlp" });
    await ingestLab("run_iso", 1, { status: "empty", turns: [] });
    await ingestLab("run_iso", 2, { status: "failed", error_code: "infer_failed", turns: [], clip_sha256: null, audio_ms: 0 });
    await ingestLab("run_iso", 3, { status: "failed", error_code: "bad_spec", turns: [], clip_sha256: null, audio_ms: 0 });
    await L.labProgress("run_iso");
    await L.labItemSummaries("run_iso");
    expect(await fingerprint()).toEqual(before);
    // 3 of the 4 are final; the retryable failure (attempt 1 of 3) correctly stays queued for another go
    expect((await q<{ n: number }>`SELECT count(*)::int AS n FROM nemotron_lab_item WHERE run_id = 'run_iso' AND state <> 'queued'`)[0]!.n).toBe(3);
  });

  it("the lab store's source names none of the production diarize tables (and the job kind runs no SQL of its own)", () => {
    const names = /room_diarize_window|room_turn_speaker|diarize_nemotron_window|diarize_nemotron_claim|diarize_nemotron_worker/;
    expect(readFileSync("lib/room-access/nemotron-lab-store.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(names);
    const kindSrc = readFileSync("lib/jobs/kinds/nemotron-lab-run.ts", "utf8");
    expect(kindSrc.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(names);
    expect(kindSrc).not.toMatch(/from "@\/lib\/db"/);
  });
});

describe.skipIf(!HAVE)("productionPendingExists agrees with claimPending", () => {
  it("is true exactly while claimPending would offer a window", async () => {
    pg.exec(`DELETE FROM diarize_nemotron_claim; DELETE FROM diarize_nemotron_window; DELETE FROM bench_window WHERE id LIKE 'bw_pp%';`);
    // bench_window rows from other cases are fixtures too: take them out of play so only this case's windows decide
    pg.exec(`UPDATE bench_window SET state = 'open' WHERE id NOT LIKE 'bw_pp%';`);
    expect(await N.productionPendingExists()).toBe(false);
    expect(await N.claimPending("box-p", 4)).toEqual([]);

    win("bw_pp1");
    expect(await N.productionPendingExists()).toBe(true);
    const claimed = await N.claimPending("box-p", 4);
    expect(claimed.map((c) => c.window_id)).toEqual(["bw_pp1"]);
    expect(await N.productionPendingExists()).toBe(false); // leased
    expect(await N.claimPending("box-p", 4)).toEqual([]);

    pg.exec(`UPDATE diarize_nemotron_claim SET lease_until = now() - interval '1 second' WHERE window_id = 'bw_pp1';`);
    expect(await N.productionPendingExists()).toBe(true); // lease lapsed, attempts left
    expect((await N.claimPending("box-p", 4)).map((c) => c.attempts)).toEqual([2]);

    pg.exec(`UPDATE diarize_nemotron_claim SET lease_until = now() - interval '1 second', attempts = 3 WHERE window_id = 'bw_pp1';`);
    expect(await N.productionPendingExists()).toBe(false); // attempts used
    expect(await N.claimPending("box-p", 4)).toEqual([]);

    win("bw_pp2", { clip: false });
    win("bw_pp3", { state: "open" });
    expect(await N.productionPendingExists()).toBe(false); // no clip / not closed: not offered, so not pending
    win("bw_pp4");
    pg.exec(`INSERT INTO diarize_nemotron_window (window_id, room_day_id, model, model_rev, config, config_hash, worker_id, machine, audio_ms, clip_sha256, turns_json, speaker_count, turn_count, speech_ms, overlap_ms, payload_sha256, status)
             VALUES ('bw_pp4', 'rd_l1', 'm', 'r1', '{"a":1}', 'h', 'box-1', 'box', 900000, '${"c".repeat(64)}', '[[0,1000,"spk0"]]', 1, 1, 1000, 0, 'p4', 'ok');`);
    expect(await N.productionPendingExists()).toBe(false); // already answered
    expect(await N.claimPending("box-p", 4)).toEqual([]);
  });
});

describe.skipIf(!HAVE)("production ingest: the probability pointer (0143)", () => {
  const CONFIG = { chunk: 340, fifo: 40 };
  const prod = (windowId: string, o: Record<string, unknown> = {}) => {
    const v = V.checkIngest({
      window_id: windowId, room_day_id: "rd_l1", engine: "nemotron", model: "nvidia/Nemotron-3-Diarization", model_rev: "rev1", config: CONFIG, config_hash: V.configHash(CONFIG),
      worker_id: "box-1", machine: "box", audio_ms: 900000, clip_sha256: "c".repeat(64), status: "ok", error_code: null, turns: [[0, 4210, "spk0"], [3900, 9100, "spk1"]], ...o,
    });
    if (!v.ok) throw new Error(`fixture refused: ${v.error}`);
    return N.recordIngest(v.body, v.derived, v.payload_sha256);
  };
  const key = (id: string) => lab.windowProbsKey(id);
  const stored = async (id: string) => (await q<{ probs_r2_key: string | null }>`SELECT probs_r2_key FROM diarize_nemotron_window WHERE window_id = ${id}`)[0]?.probs_r2_key;

  it("is stored with the row; a body without it stores NULL", async () => {
    win("bw_k1"); win("bw_k2");
    expect((await prod("bw_k1", { probs_r2_key: key("bw_k1") })).result).toBe("stored");
    expect(await stored("bw_k1")).toBe(key("bw_k1"));
    expect((await prod("bw_k2")).result).toBe("stored");
    expect(await stored("bw_k2")).toBeNull();
  });
  it("a duplicate re-post attaches the pointer where it is NULL, and never replaces one", async () => {
    expect((await prod("bw_k2", { probs_r2_key: key("bw_k2") })).result).toBe("duplicate"); // same turns: the pointer is not part of the hash
    expect(await stored("bw_k2")).toBe(key("bw_k2"));
    pg.exec(`UPDATE diarize_nemotron_window SET probs_r2_key = 'lab/nemotron-probs/earlier.nlp' WHERE window_id = 'bw_k1';`);
    expect((await prod("bw_k1", { probs_r2_key: key("bw_k1") })).result).toBe("duplicate");
    expect(await stored("bw_k1")).toBe("lab/nemotron-probs/earlier.nlp");
    expect((await prod("bw_k2")).result).toBe("duplicate"); // a re-post without it removes nothing
    expect(await stored("bw_k2")).toBe(key("bw_k2"));
  });
  it("different turns for the same key are still a conflict, with or without the pointer", async () => {
    expect((await prod("bw_k1", { turns: [[0, 1000, "spk0"]], probs_r2_key: key("bw_k1") })).result).toBe("conflict");
  });
});

// ---- the job, through the real runner -------------------------------------------------------------------------------------------------
describe.skipIf(!HAVE)("nemotron_lab_run through claimJobs + runOneStep", () => {
  const runner = async () => ({ ...(await import("@/lib/jobs/store")), ...(await import("@/lib/jobs/runner")), ...(await import("@/lib/jobs/submit")) });
  const submit = async (args: Record<string, unknown>) => {
    const { submitJob } = await runner();
    return submitJob({ kind: "nemotron_lab_run", args, actor: "tester", scopes: new Set(["invoke"] as const) });
  };
  /** Claim and run one step of THIS job (other queued jobs are cancelled first so the claim can only be ours). */
  async function step(jobId: string) {
    const { claimJobs, runOneStep } = await runner();
    const id = `r_${Math.random()}`;
    pg.exec(`UPDATE scribe_job SET status = 'cancelled' WHERE status IN ('queued', 'running') AND id <> '${jobId}'`);
    const claimed = (await claimJobs(1, 240_000, id)).filter((j) => j.id === jobId);
    if (!claimed.length) return null;
    return runOneStep(claimed[0]!, id);
  }
  const job = async (id: string) => (await q<{ status: string; step: string | null; error: string | null; result: Record<string, any> | null }>`SELECT status, step, error, result FROM scribe_job WHERE id = ${id}`)[0]!;

  beforeEach(() => {
    wipeLab();
    process.env.NEMOTRON_LAB_ENABLED = "1";
    H.join.mockReset();
    H.chunks.mockReset();
  });

  it("refuses to queue while the lane is off, and a bad override or input never queues", async () => {
    process.env.NEMOTRON_LAB_ENABLED = "0";
    await expect(submit({ windows: ["bw_x"] })).rejects.toThrow(/lab_disabled/);
    process.env.NEMOTRON_LAB_ENABLED = "1";
    await expect(submit({ windows: ["bw_x"], overrides: { model: "x" } })).rejects.toThrow(/override not allowed/);
    await expect(submit({ windows: ["bw_x"], overrides: { postprocessing_yaml: "evil: 1" } })).rejects.toThrow(/not allowed/);
    await expect(submit({ r2_keys: ["encounters/a.webm"] })).rejects.toThrow(/r2 key/);
    await expect(submit({})).rejects.toThrow(/at least one/);
    expect((await q<{ n: number }>`SELECT count(*)::int AS n FROM scribe_job WHERE kind = 'nemotron_lab_run'`)[0]!.n).toBe(0);
  });

  it("queues, writes the run, waits for the worker, and finishes with counts only", async () => {
    win("bw_j1"); win("bw_j2");
    const j = await submit({ windows: ["bw_j1", "bw_j2"], overrides: { return_probs: true, postprocessing_yaml: "onset: 0.4" } });
    expect((await step(j.id))?.step ?? null).toBe("prepare");
    expect((await job(j.id)).step).toBe("cut");
    const run = (await q<{ spec: any; n_items: number }>`SELECT spec, n_items FROM nemotron_lab_run WHERE job_id = ${j.id}`)[0]!;
    expect([run.n_items, run.spec.postprocessing, run.spec.return_probs]).toEqual([2, { onset: 0.4 }, true]);
    await step(j.id); // cut: nothing to cut
    expect((await job(j.id)).step).toBe("wait");

    // the worker: claim, answer
    const claimed = await L.claimLabItems("box-1", 4);
    expect(claimed.map((c) => c.run_id)).toEqual([j.id, j.id]);
    const spec = claimed[0]!.spec;
    const answer = (idx: number, o: Record<string, unknown>) => {
      const v = lab.checkLabIngest({ run_id: j.id, idx, worker_id: "box-1", status: "ok", error_code: null, model: "m", model_rev: "r", config: { a: 1 }, spec_hash: lab.specHash(spec), audio_ms: 900000, clip_sha256: "b".repeat(64), turns: [[0, 1000, "spk0"]], probs_r2_key: null, embeddings_r2_key: null, embeddings_dims: null, infer_s: 1, ...o });
      if (!v.ok) throw new Error(v.error);
      return L.recordLabIngest(v.body, v.derived);
    };
    await answer(0, { probs_r2_key: `lab/nemotron/${j.id}/0/probs.nlp` });
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"], now: Date.now() });
    const pending = step(j.id);
    await vi.advanceTimersByTimeAsync(200_000); // one answer outstanding: the step polls, then hands the row back
    const handed = await pending;
    vi.useRealTimers();
    expect(handed?.outcome).toBe("advanced");
    expect((await job(j.id)).step).toBe("wait"); // handed back between steps (running, no lease), not finished

    await answer(1, { status: "failed", error_code: "bad_spec", turns: [], clip_sha256: null, audio_ms: 0 });
    const fin = await step(j.id);
    expect(fin?.outcome).toBe("done");
    const done = await job(j.id);
    expect(done.status).toBe("done");
    expect(done.result).toMatchObject({ run_id: j.id, total: 2, ok: 1, empty: 0, failed: 1 });
    expect(done.result!.items.map((i: any) => [i.idx, i.state, i.has_probs])).toEqual([[0, "ok", true], [1, "failed", false]]);
    expect(JSON.stringify(done.result)).not.toMatch(/spk0|turns/); // counts and ids, never the turns
  });

  it("fails lab_input_unresolved for a window with no clip, and lab_timeout after the run's deadline", async () => {
    win("bw_u1", { clip: false });
    const a = await submit({ windows: ["bw_u1"] });
    await step(a.id);
    const ja = await job(a.id);
    expect([ja.status, ja.error]).toEqual(["failed", expect.stringContaining("lab_input_unresolved")]);

    win("bw_u2");
    const b = await submit({ windows: ["bw_u2"] });
    await step(b.id); await step(b.id);
    expect((await job(b.id)).step).toBe("wait");
    pg.exec(`UPDATE nemotron_lab_run SET deadline_at = now() - interval '1 second' WHERE job_id = '${b.id}'`);
    const out = await step(b.id);
    expect(out?.outcome).toBe("failed");
    expect((await job(b.id)).error).toContain("lab_timeout");
  });

  it("cuts a span through the join service and offers the clip to the worker", async () => {
    const t0 = Date.parse("2026-10-02T05:00:00Z");
    H.chunks.mockResolvedValue([{ idx: 0, source: "primary", r2_key: "bench/lab-room/2026-10-02/bs_l1/chunk_00000.webm", content_type: "audio/webm", started_at: new Date(t0 - 60_000).toISOString(), ended_at: new Date(t0 + 600_000).toISOString(), upload_state: "uploaded" }]);
    H.join.mockResolvedValue({ ok: true, key: "clips/bs_l1/cut-primary.webm" });
    const j = await submit({ spans: [{ session_id: "bs_l1", start: t0, end: t0 + 120_000 }, { session_id: "bs_l1", start: t0 + 700_000, end: t0 + 800_000 }] });
    await step(j.id); // prepare
    await step(j.id); // cut
    expect(H.join).toHaveBeenCalledTimes(1); // the second span is past the last chunk: nothing to join
    const items = await q<{ idx: number; state: string; clip_r2_key: string | null; error_code: string | null }>`SELECT idx, state, clip_r2_key, error_code FROM nemotron_lab_item WHERE run_id = ${j.id} ORDER BY idx`;
    expect(items.map((i) => [i.idx, i.state, i.clip_r2_key, i.error_code])).toEqual([[0, "queued", "clips/bs_l1/cut-primary.webm", null], [1, "failed", null, "no_audio_in_range"]]);
    expect((await L.claimLabItems("box-1", 4)).map((c) => [c.idx, c.clip_r2_key])).toEqual([[0, "clips/bs_l1/cut-primary.webm"]]);
  });

  it("a join failure fails that item (lab_cut_failed) without failing the whole job", async () => {
    const t0 = Date.parse("2026-10-02T06:00:00Z");
    H.chunks.mockResolvedValue([{ idx: 0, source: "primary", r2_key: "bench/lab-room/2026-10-02/bs_l1/chunk_00001.webm", content_type: "audio/webm", started_at: new Date(t0 - 60_000).toISOString(), ended_at: new Date(t0 + 600_000).toISOString(), upload_state: "uploaded" }]);
    H.join.mockResolvedValue({ ok: false, error: "boom", hop: "join" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const j = await submit({ spans: [{ session_id: "bs_l1", start: t0, end: t0 + 60_000 }] });
    await step(j.id); await step(j.id);
    expect((await item(j.id, 0)).error_code).toBe("lab_cut_failed");
    const fin = await step(j.id);
    expect(fin?.outcome).toBe("done");
    expect((await job(j.id)).result).toMatchObject({ total: 1, failed: 1 });
  });

  it("the held-out guard runs at submit for every input form", async () => {
    // BLIND_ROOM_DAYS is empty on main, so nothing is held out today; this proves the guard is CALLED for each form and a throwing guard is not a pass
    const rooms = await import("@/lib/room-access/jobs");
    const spy = vi.spyOn(rooms, "windowHeldOut");
    win("bw_h1");
    await submit({ windows: ["bw_h1"] });
    expect(spy).toHaveBeenCalledWith("bw_h1");
    spy.mockRestore();
    expect(nemotronLabRunKind.roomData).toBe(true);
    expect(typeof nemotronLabRunKind.heldOut).toBe("function");
  });
});
