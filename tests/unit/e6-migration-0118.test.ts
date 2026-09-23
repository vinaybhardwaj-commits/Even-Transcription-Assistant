/**
 * tests/unit/e6-migration-0118.test.ts — REQUIRED PROOF: 0118 (E-6 fusion) against a real postgres:16 that
 * already carries every migration through 0117, driven through the REAL store (lib/encounter-hypotheses.ts).
 *
 *   1. DEPLOY ORDER. Before 0118: the acoustic write and the unfiltered read work (they never mention
 *      `source`); a fused write is refused by the database (the column does not exist) — which is why v2
 *      runs only behind ENCOUNTER_FUSION_SHADOW or an explicit replay, after Fable applies 0118.
 *   2. AFTER 0118: the pre-existing run reads back as 'acoustic' (the DEFAULT, no row rewritten); a fused
 *      run with a `content_boundary` interval writes and reads back by source; an unknown source, an
 *      unknown closed_by and an unknown jev_decision subject_type are refused; 'probe' is admitted.
 *      readLatestAcousticRun (v1's `supersedes`) falls back before 0118 and skips a fused run after it.
 *   3. IDEMPOTENT: applying 0118 again changes nothing and errors on nothing.
 *
 * Only the driver is a stand-in: `@/lib/db` is the harness's psql-backed sql. Values synthetic.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const H = vi.hoisted(() => ({ sql: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>) }));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => H.sql!(s, ...v) }));

import { readLatestAcousticRun, readLatestRun, writeHypothesisRun, type HypothesisInterval, type HypothesisRunInput } from "@/lib/encounter-hypotheses";

const HAVE_DOCKER = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-e6-migration-0118");

const T0 = 1_790_000_000_000;
const iv = (over: Partial<HypothesisInterval> = {}): HypothesisInterval => ({
  start_ms: T0, end_ms: T0 + 600_000, speech_probes: 8, non_speech_probes: 2, unjudged_ms: 0,
  longest_unjudged_run_ms: 0, dead_mic_ms: 0, closed_by: "non_speech", merged_from: 1,
  doctor_present: { yes: 0, no: 0, unknown: 8 }, ...over,
});
const run = (over: Partial<HypothesisRunInput> = {}): HypothesisRunInput => ({
  room_day_id: "rd_e6proof", smoother_version: "encounter-clock-smooth-v1", gate_version: "encounter-clock-gate-v1",
  params: {}, probes: { total: 10, speech: 8, non_speech: 2, unjudged: 0 }, intervals: [iv()], ...over,
});

describe("REQUIRED PROOF — 0118 against a real postgres", () => {
  it("ran, or was skipped deliberately", () => {
    if (HAVE_DOCKER || ALLOW_SKIP) return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/e6-migration-0118.test.ts needs Docker for postgres:16. Start Docker, or set ETA_ALLOW_SKIP_E2E=1 to accept that it was not proven.");
  });
});

describe.skipIf(!HAVE_DOCKER)("0118 (encounter fusion) over a real 0001-0117 schema", () => {
  it("deploy order holds, the vocabularies are enforced, and it is idempotent", async () => {
    pg.start();
    H.sql = pg.sql as never;
    try {
      pg.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      const files = readdirSync("db/migrations").filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
      const m118 = files.find((f) => f.startsWith("0118_"));
      expect(m118, "0118 is in the discovered set").toBeTruthy();
      for (const f of files.filter((f) => Number(f.slice(0, 4)) <= 117)) pg.exec(readFileSync(`db/migrations/${f}`, "utf8"));

      // ── 1. before 0118
      const pre = await writeHypothesisRun(run());
      expect(pre.ok).toBe(true);
      const preRead = await readLatestRun("rd_e6proof");
      expect(preRead.run?.id).toBe(pre.ok ? pre.run_id : "");
      expect(preRead.run?.source).toBeUndefined();
      // the v1 runner's supersedes read: scoped read refused by THIS database, fallback returns the same run
      await expect(readLatestRun("rd_e6proof", undefined, "acoustic")).rejects.toThrow();
      expect((await readLatestAcousticRun("rd_e6proof", "encounter-clock-smooth-v1")).run?.id).toBe(pre.ok ? pre.run_id : "");
      await expect(writeHypothesisRun(run({ source: "fused" }))).rejects.toThrow();

      // ── 2. the act
      pg.exec(readFileSync(`db/migrations/${m118}`, "utf8"));
      expect(await pg.sql`SELECT version, name FROM schema_migrations WHERE version = 118`).toEqual([{ version: 118, name: "0118_encounter_fusion" }]);

      const acousticAfter = await readLatestRun("rd_e6proof", undefined, "acoustic");
      expect(acousticAfter.run).toMatchObject({ id: pre.ok ? pre.run_id : "", source: "acoustic" });

      const fused = await writeHypothesisRun(run({
        source: "fused",
        intervals: [iv({ end_ms: T0 + 300_000, closed_by: "content_boundary" }), iv({ start_ms: T0 + 300_000, closed_by: "non_speech" })],
      }));
      expect(fused.ok).toBe(true);
      const fusedRead = await readLatestRun("rd_e6proof", "encounter-clock-smooth-v1", "fused");
      expect(fusedRead.run).toMatchObject({ id: fused.ok ? fused.run_id : "", source: "fused", n_hypotheses: 2 });
      expect(fusedRead.run!.hypotheses.map((h) => h.closed_by)).toEqual(["content_boundary", "non_speech"]);
      // the acoustic reader still gets the acoustic run, not the newer fused one
      expect((await readLatestRun("rd_e6proof", undefined, "acoustic")).run?.id).toBe(pre.ok ? pre.run_id : "");
      // the v1 runner's supersedes read skips the newer fused run (ETA-Refuter, E6 verdict)
      expect((await readLatestRun("rd_e6proof", "encounter-clock-smooth-v1")).run?.id).toBe(fused.ok ? fused.run_id : "");
      expect((await readLatestAcousticRun("rd_e6proof", "encounter-clock-smooth-v1")).run?.id).toBe(pre.ok ? pre.run_id : "");
      // an acoustic write after 0118 lands as 'acoustic' by default
      const post = await writeHypothesisRun(run());
      expect((await readLatestRun("rd_e6proof", undefined, "acoustic")).run).toMatchObject({ id: post.ok ? post.run_id : "", source: "acoustic" });

      await expect(pg.sql`
        INSERT INTO encounter_hypothesis_run (id, room_day_id, smoother_version, gate_version, probes_total, probes_speech, probes_non_speech, probes_unjudged, n_hypotheses, source)
        VALUES ('ehr_bad', 'rd_e6proof', 's', 'g', 0, 0, 0, 0, 0, 'guessed')`).rejects.toThrow();
      await expect(pg.sql`
        INSERT INTO encounter_hypothesis (id, run_id, room_day_id, start_ms, end_ms, speech_probes, non_speech_probes, unjudged_ms, longest_unjudged_run_ms, dead_mic_ms, closed_by, merged_from)
        VALUES ('eh_bad', ${post.ok ? post.run_id : ""}, 'rd_e6proof', 0, 1, 0, 0, 0, 0, 0, 'guessed', 1)`).rejects.toThrow();

      for (const good of ["window", "turn", "note_sentence", "encounter", "collapse", "probe"]) {
        await pg.sql`
          INSERT INTO jev_decision (id, subject_type, subject_id, question_id, prompt_version, model, answer)
          VALUES (${`jd_${good}`}, ${good}, 's1', 'q1', 'v1', 'jev-x', '{"type":"noul","noul":0.5}'::jsonb)`;
      }
      await expect(pg.sql`
        INSERT INTO jev_decision (id, subject_type, subject_id, question_id, prompt_version, model, answer)
        VALUES ('jd_bad', 'bad_type', 's1', 'q1', 'v1', 'jev-x', '{"type":"noul","noul":0.5}'::jsonb)`).rejects.toThrow();

      // ── 3. idempotent
      pg.exec(readFileSync(`db/migrations/${m118}`, "utf8"));
      expect(await pg.sql`SELECT count(*)::int AS n FROM schema_migrations WHERE version = 118`).toEqual([{ n: 1 }]);
      const runs = (await pg.sql`SELECT source, count(*)::int AS n FROM encounter_hypothesis_run GROUP BY source ORDER BY source`) as unknown;
      expect(runs).toEqual([{ source: "acoustic", n: 2 }, { source: "fused", n: 1 }]);
    } finally {
      pg.stop();
    }
  }, 180_000);
});
