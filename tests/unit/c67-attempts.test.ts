/**
 * E31 C6/C7 — EVERY ATTEMPT IS KEPT, AND THE LEADERBOARD SAYS WHAT ITS RELIABILITY FIGURE MEASURES.
 * Against a real postgres:16 holding EVERY migration, through the real runFanoutForEncounter (C6),
 * runScribeForEncounter (C7), dedupRuns and computeLeaderboard.
 *
 * THE DEFECT. Before each retry both fan-outs deleted the engine's prior ERRORED rows, "so a retry replaces the failure
 * rather than duplicating it". The leaderboard computes reliability as ok / rows, so an engine that failed twice and
 * then succeeded read 100% — the figure measured final outcome per encounter, and was labelled reliability.
 *
 * THE RULING (Orchestrator): reliability is PER ATTEMPT; keep every errored row; dedupRuns removes only successful
 * duplicates; the per-attempt figure counts runs from the date every attempt started being kept, and the page says so;
 * room windows stay final outcome and are labelled that way. Final outcome is reported beside per attempt.
 *
 * Only the outside world is faked: R2, the engine registry (listEngines / adapterFor), the paid-call guard (which
 * calls the adapter) and scoring. The database, the statements and the leaderboard's SQL are real.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";
import { makeFakeClinician } from "../support/fake-identity";

type Outcome = "ok" | "err";
const H = vi.hoisted(() => ({
  sql: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>),
  /** Per engine, the outcomes its next calls return, in order. */
  plan: {} as Record<string, Outcome[]>,
  engines: [] as Array<Record<string, unknown>>,
  /** Called before a fan-out loads audio: lets a test hold one call while another runs. */
  audioHook: null as null | (() => Promise<void>),
}));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => H.sql!(s, ...v) }));
vi.mock("@/lib/r2", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  headObject: async () => { if (H.audioHook) await H.audioHook(); return { content_type: "audio/webm", size: 4 }; },
  getObjectBytes: async () => new Uint8Array([1, 2, 3, 4]),
}));
const next = (engine: string): Outcome => {
  const q = H.plan[engine];
  if (!q || q.length === 0) throw new Error(`fixture: no planned outcome left for ${engine}`);
  return q.shift()!;
};
vi.mock("@/lib/stt/registry", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listEngines: async () => H.engines,
  adapterFor: (key: string) => ({
    key,
    transcribe: async () => { throw new Error("fixture: the guard calls the adapter, not the fan-out"); },
    generateNote: async () => {
      const o = next(key);
      return o === "ok"
        ? { noteText: "fixture note", note: { fixture: true }, latencyMs: 20, costUsd: 0, error: null }
        : { noteText: null, note: null, latencyMs: 20, costUsd: 0, error: "fixture: scribe engine failed" };
    },
  }),
}));
vi.mock("@/lib/stt/guarded-transcribe", () => ({
  guardedTranscribe: async (opts: { engineId: string }) => {
    const o = next(opts.engineId);
    return {
      ok: true,
      spend: { engine: opts.engineId, paid: false },
      result: o === "ok"
        ? { original: "fixture words", english: "fixture words", language: "en", latencyMs: 30, costUsd: 0, error: null }
        : { original: null, english: null, language: null, latencyMs: 30, costUsd: 0, error: "fixture: engine failed" },
    };
  },
}));
vi.mock("@/lib/stt/scoring", async (orig) => ({ ...(await orig<Record<string, unknown>>()), scoreEncounter: async () => {}, scoreScribe: async () => {} }));

const HAVE_DOCKER = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-c67-attempts");
const DOC = makeFakeClinician(3);

describe("REQUIRED PROOF — C6/C7 runs against a real postgres", () => {
  it("ran, or was skipped deliberately", () => {
    if (HAVE_DOCKER || ALLOW_SKIP) return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/c67-attempts.test.ts needs Docker for postgres:16. Start Docker, or set ETA_ALLOW_SKIP_E2E=1 to accept that it was not proven.");
  });
});

beforeAll(() => {
  if (!HAVE_DOCKER) return;
  pg.start();
  for (const f of readdirSync("db/migrations").filter((n) => n.endsWith(".sql")).sort()) pg.exec(readFileSync(`db/migrations/${f}`, "utf8"));
  pg.exec(`INSERT INTO clinician (id, email, full_name, url_slug, url_token) VALUES ('${DOC.id}', '${DOC.email}', '${DOC.full_name}', '${DOC.url_slug}', '${DOC.url_token}')`);
  H.sql = pg.sql;
}, 240_000);
afterAll(() => { if (HAVE_DOCKER) pg.stop(); });

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────────────────────
const asrEngine = (id: string) => ({ id, display_name: id, adapter_key: id, enabled: true, fanout_enabled: true, is_paid: false, cost_per_min_usd: null, capabilities_json: { tiers: ["asr"] }, config_json: {}, sort_order: 1 });
const scribeEngine = (id: string) => ({ ...asrEngine(id), capabilities_json: { tiers: ["scribe"] } });
let seq = 0;
const encounter = () => {
  const id = `enc_c67_${process.pid}_${(seq += 1)}`;
  pg.exec(`INSERT INTO encounter (id, doctor_id, status, audio_object_key, detected_language, duration_seconds, note_json)
           VALUES ('${id}', '${DOC.id}', 'complete', 'audio/${id}.webm', 'en-IN', 60, '{"fixture":true}'::jsonb)`);
  return id;
};
const runs = async (subjectId: string, tier: "asr" | "scribe", engine: string) =>
  (await pg.sql`SELECT (error IS NULL) AS ok FROM transcription_run WHERE subject_id = ${subjectId} AND tier = ${tier} AND engine = ${engine} ORDER BY created_at, id`) as Array<{ ok: boolean }>;
const fanout = async (id: string) => (await import("@/lib/stt/fanout")).runFanoutForEncounter(id);
const scribe = async (id: string) => (await import("@/lib/stt/fanout")).runScribeForEncounter(id);
const setSince = (iso: string | null) => { if (iso) process.env.STT_PER_ATTEMPT_SINCE = iso; else delete process.env.STT_PER_ATTEMPT_SINCE; };
const quiet = async <T,>(fn: () => Promise<T>) => {
  const spies = [vi.spyOn(console, "warn").mockImplementation(() => {}), vi.spyOn(console, "error").mockImplementation(() => {})];
  try { return await fn(); } finally { for (const s of spies) s.mockRestore(); }
};

describe.runIf(HAVE_DOCKER)("E31 C6/C7 — every attempt is kept", () => {
  it("C6 AN ERRORED ASR RUN SURVIVES THE NEXT PASS: fail, fail, succeed leaves three rows — and a success is still 'done'", async () => {
    const id = encounter();
    H.engines = [asrEngine("c6_alpha")];
    H.plan = { c6_alpha: ["err", "err", "ok"] };
    await quiet(async () => { await fanout(id); await fanout(id); await fanout(id); });
    expect((await runs(id, "asr", "c6_alpha")).map((r) => r.ok), "both failed attempts survived the passes after them").toEqual([false, false, true]);
    // "done means a successful run exists" is unchanged: a fourth pass does not run the engine again.
    const fourth = await quiet(() => fanout(id));
    expect(fourth.skipped, "the engine with a success is skipped").toBe(1);
    expect(H.plan.c6_alpha, "and was not called").toEqual([]);
    expect(await runs(id, "asr", "c6_alpha")).toHaveLength(3);
  }, 120_000);

  it("C7 AN ERRORED SCRIBE RUN SURVIVES THE NEXT PASS, the same way", async () => {
    const id = encounter();
    H.engines = [scribeEngine("c7_scribe")];
    H.plan = { c7_scribe: ["err", "err", "ok"] };
    await quiet(async () => { await scribe(id); await scribe(id); await scribe(id); });
    expect((await runs(id, "scribe", "c7_scribe")).map((r) => r.ok)).toEqual([false, false, true]);
    await quiet(() => scribe(id));
    expect(await runs(id, "scribe", "c7_scribe"), "a success is 'done': no fourth attempt").toHaveLength(3);
  }, 120_000);

  it("THE OVERLAP: two calls on one encounter, the second held until the first has written its failure — neither call removes the other's row", async () => {
    const id = encounter();
    H.engines = [asrEngine("c6_overlap")];
    H.plan = { c6_overlap: ["err", "err"] };
    // Call A runs to completion while call B is held after its "done" read and before its audio load (where the
    // old code's DELETE sat, just after it).
    let releaseB!: () => void;
    const bHeld = new Promise<void>((r) => { releaseB = r; });
    let calls = 0;
    H.audioHook = async () => { calls += 1; if (calls === 2) await bHeld; };
    try {
      await quiet(async () => {
        const a = fanout(id);
        const b = fanout(id);
        await a;
        expect(await runs(id, "asr", "c6_overlap"), "A's failure is written").toHaveLength(1);
        releaseB();
        await b;
      });
    } finally {
      H.audioHook = null;
    }
    expect((await runs(id, "asr", "c6_overlap")).map((r) => r.ok), "both calls' failures survive").toEqual([false, false]);
  }, 120_000);

  it("dedupRuns REMOVES TRUE DUPLICATES — a second successful row — AND NEVER A FAILED ATTEMPT", async () => {
    const id = encounter();
    const ins = (rid: string, err: string | null, agoMin: number) => pg.exec(`
      INSERT INTO transcription_run (id, encounter_id, engine, stt_engine_id, mode, tier, error, created_at)
      VALUES ('${rid}', '${id}', 'dup_engine', 'dup_engine', 'batch', 'asr', ${err ? `'${err}'` : "NULL"}, NOW() - interval '${agoMin} minutes')`);
    ins(`trun_dup_err1_${seq}`, "fixture: failed", 40);
    ins(`trun_dup_err2_${seq}`, "fixture: failed", 30);
    ins(`trun_dup_okold_${seq}`, null, 20);
    ins(`trun_dup_oknew_${seq}`, null, 10);
    const r = await (await import("@/lib/stt/fanout")).dedupRuns();
    const left = (await pg.sql`SELECT id FROM transcription_run WHERE encounter_id = ${id} ORDER BY created_at`) as Array<{ id: string }>;
    expect(left.map((x) => x.id), "the older success went; both failures and the newest success stayed").toEqual([`trun_dup_err1_${seq}`, `trun_dup_err2_${seq}`, `trun_dup_oknew_${seq}`]);
    expect(r.deleted).toBeGreaterThanOrEqual(1);
  }, 120_000);
});

describe.runIf(HAVE_DOCKER)("E31 C6/C7 — the leaderboard: per attempt, final outcome, and what each says", () => {
  it("THE SAME INJECTED SEQUENCE, BOTH FIGURES SIDE BY SIDE: per attempt differs from final outcome wherever an engine needed retries", async () => {
    pg.exec(`DELETE FROM transcription_run`);
    setSince(new Date(Date.now() - 60_000).toISOString());
    const e1 = encounter();
    const e2 = encounter();
    H.engines = [asrEngine("lb_alpha"), asrEngine("lb_beta"), asrEngine("lb_gamma")];
    // alpha: fails twice on e1, then succeeds; succeeds on e2.        4 attempts, 2 ok.  2 of 2 encounters.
    // beta:  fails three times on e1;          succeeds on e2.        4 attempts, 1 ok.  1 of 2 encounters.
    // gamma: succeeds first time on both.                             2 attempts, 2 ok.  2 of 2 encounters.
    H.plan = { lb_alpha: ["err", "err", "ok", "ok"], lb_beta: ["err", "err", "err", "ok"], lb_gamma: ["ok", "ok"] };
    await quiet(async () => { await fanout(e1); await fanout(e1); await fanout(e1); await fanout(e2); });
    const { computeLeaderboard } = await import("@/lib/stt/leaderboard");
    const board = await computeLeaderboard({ tier: "asr", subjectKind: "encounter" });
    const by = Object.fromEntries(board.engines.map((e) => [e.engine, e]));
    for (const name of ["lb_alpha", "lb_beta", "lb_gamma"]) {
      const e = by[name] as unknown as Record<string, unknown>;
      // The line the report quotes. Printed before any assertion, so it is also what production code prints (M0).
      console.log(`[c67] ${name}: rows=${e.runs} ok=${e.ok} success_rate(headline)=${e.success_rate} attempt_rate=${e.attempt_rate} outcome_rate=${e.outcome_rate} basis=${(board as Record<string, unknown>).reliability_basis}`);
    }
    expect(board.reliability_basis).toBe("per_attempt");
    expect([by.lb_alpha!.attempt_rate, by.lb_beta!.attempt_rate, by.lb_gamma!.attempt_rate], "per attempt").toEqual([0.5, 0.25, 1]);
    expect([by.lb_alpha!.outcome_rate, by.lb_beta!.outcome_rate, by.lb_gamma!.outcome_rate], "final outcome").toEqual([1, 0.5, 1]);
    expect(by.lb_alpha!.success_rate, "the headline IS the per-attempt figure").toBe(0.5);
    expect(by.lb_alpha!.components.reliability, "and so is the composite's reliability component").toBe(0.5);
    expect([by.lb_alpha!.attempts, by.lb_beta!.attempts, by.lb_gamma!.attempts]).toEqual([4, 4, 2]);
  }, 180_000);

  it("CLAMPED TO THE DATE EVERY ATTEMPT STARTED BEING KEPT: older runs are outside per attempt and inside final outcome; with no date the figure is withheld", async () => {
    pg.exec(`DELETE FROM transcription_run`);
    const e1 = encounter();
    const e2 = encounter();
    // A run from BEFORE the cutover: the only surviving row of a history whose failures were deleted.
    pg.exec(`INSERT INTO transcription_run (id, encounter_id, engine, stt_engine_id, mode, tier, error, created_at)
             VALUES ('trun_clamp_old_${seq}', '${e1}', 'cl_engine', 'cl_engine', 'batch', 'asr', NULL, NOW() - interval '10 days')`);
    const cutover = new Date(Date.now() - 60_000).toISOString();
    setSince(cutover);
    H.engines = [asrEngine("cl_engine")];
    H.plan = { cl_engine: ["err", "ok"] };
    await quiet(async () => { await fanout(e2); await fanout(e2); });
    const { computeLeaderboard } = await import("@/lib/stt/leaderboard");
    const set = (await computeLeaderboard({ tier: "asr" })).engines.find((e) => e.engine === "cl_engine")!;
    expect(set.runs, "three rows exist").toBe(3);
    expect([set.attempts, set.attempts_ok, set.attempt_rate], "per attempt: only the two runs after the cutover").toEqual([2, 1, 0.5]);
    expect([set.subjects, set.subjects_ok, set.outcome_rate], "final outcome: both encounters, the old one included").toEqual([2, 2, 1]);

    setSince(null);
    const unset = await computeLeaderboard({ tier: "asr" });
    const row = unset.engines.find((e) => e.engine === "cl_engine")!;
    expect(unset.per_attempt_since).toBeNull();
    expect(row.attempt_rate, "no date: the per-attempt figure is withheld, not computed over a truncated history").toBeNull();
    expect(row.success_rate, "so the headline is withheld too").toBeNull();
    expect(row.components.reliability, "and the composite leaves reliability out").toBeNull();
    expect(row.outcome_rate, "final outcome is still shown").toBe(1);
  }, 180_000);

  it("ROOM WINDOWS ARE FINAL OUTCOME AND SAY SO; the page's heading and caption state the basis and the date", async () => {
    pg.exec(`DELETE FROM transcription_run`);
    setSince(new Date(Date.now() - 60_000).toISOString());
    pg.exec(`INSERT INTO transcription_run (id, encounter_id, subject_type, subject_id, engine, stt_engine_id, mode, tier, error, created_at) VALUES
      ('trun_bw1_${seq}', NULL, 'bench_window', 'bw_c67_1', 'bw_engine', 'bw_engine', 'batch', 'asr', NULL, NOW()),
      ('trun_bw2_${seq}', NULL, 'bench_window', 'bw_c67_2', 'bw_engine', 'bw_engine', 'batch', 'asr', 'fixture: failed', NOW())`);
    const { computeLeaderboard } = await import("@/lib/stt/leaderboard");
    const bw = await computeLeaderboard({ tier: "asr", subjectKind: "bench_window" });
    expect(bw.reliability_basis).toBe("final_outcome");
    expect(bw.engines[0]!.success_rate, "the headline is the final outcome per window").toBe(bw.engines[0]!.outcome_rate);

    const L = await import("@/lib/stt/reliability-label");
    const since = "2026-09-18T04:30:00.000Z";
    expect(L.reliabilityHeading("final_outcome")).toMatch(/final outcome/);
    expect(L.reliabilityHeading("per_attempt")).toMatch(/per attempt/);
    expect(L.reliabilityHeading("final_outcome")).not.toBe(L.reliabilityHeading("per_attempt"));
    expect(L.reliabilityCaption("final_outcome", since)).toMatch(/final outcome per window, not per attempt/);
    expect(L.reliabilityCaption("per_attempt", since), "the page states the date").toContain("from 2026-09-18 only");
    expect(L.reliabilityCaption("per_attempt", null), "and says plainly when it has none").toMatch(/not shown yet/);
    expect(new Set([L.reliabilityCaption("per_attempt", since), L.reliabilityCaption("per_attempt", null), L.reliabilityCaption("final_outcome", since), L.reliabilityCaption("mixed", since)]).size).toBe(4);
    expect(L.reliabilityBasisFor("encounter")).toBe("per_attempt");
    expect(L.reliabilityBasisFor("bench_window")).toBe("final_outcome");
    expect(L.reliabilityBasisFor("all")).toBe("mixed");
  }, 120_000);
});
