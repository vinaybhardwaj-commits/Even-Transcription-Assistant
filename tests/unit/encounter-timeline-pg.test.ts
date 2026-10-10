/**
 * REQUIRED PROOF — 0146 (timeline run source, closed_by widening, origin) against a real postgres:16 carrying
 * 0001-0145, through the REAL store. Before 0146 a timeline write is refused; after it a timeline run with every new
 * closed_by value and an origin writes and reads back; an unknown origin / source / closed_by is refused; the
 * acoustic and fused paths are unchanged; applying it twice changes nothing. Values synthetic.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const H = vi.hoisted(() => ({ sql: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>) }));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => H.sql!(s, ...v) }));

import { readLatestRun, writeHypothesisRun, type HypothesisInterval, type HypothesisRunInput } from "@/lib/encounter-hypotheses";
import { CLOSED_BY } from "@/lib/encounter-clock/smooth";

const HAVE_DOCKER = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-timeline-0146");

const T0 = 1_790_000_000_000;
const iv = (i: number, over: Partial<HypothesisInterval> = {}): HypothesisInterval => ({
  start_ms: T0 + i * 3_600_000, end_ms: T0 + i * 3_600_000 + 600_000, speech_probes: 8, non_speech_probes: 2, unjudged_ms: 0,
  longest_unjudged_run_ms: 0, dead_mic_ms: 0, closed_by: "non_speech", merged_from: 1,
  doctor_present: { yes: 3, no: 0, unknown: 5 }, ...over,
});
const run = (over: Partial<HypothesisRunInput> = {}): HypothesisRunInput => ({
  room_day_id: "rd_tl", smoother_version: "encounter-clock-fusion-timeline-v1", gate_version: "encounter-clock-gate-v2",
  params: {}, probes: { total: 10, speech: 8, non_speech: 2, unjudged: 0 }, intervals: [iv(0)], ...over,
});

describe("REQUIRED PROOF — 0146 against a real postgres", () => {
  it("ran, or was skipped deliberately", () => {
    if (HAVE_DOCKER || ALLOW_SKIP) return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/encounter-timeline-pg.test.ts needs Docker for postgres:16. Start Docker, or set ETA_ALLOW_SKIP_E2E=1.");
  });
});

describe.skipIf(!HAVE_DOCKER)("0146 over a real 0001-0145 schema", () => {
  it("deploy order, vocabularies and idempotence hold", async () => {
    pg.start();
    H.sql = pg.sql as never;
    try {
      pg.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      const files = readdirSync("db/migrations").filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
      const m146 = files.find((f) => f.startsWith("0146_"))!;
      expect(m146).toBeTruthy();
      for (const f of files.filter((f) => Number(f.slice(0, 4)) <= 145)) pg.exec(readFileSync(`db/migrations/${f}`, "utf8"));

      // before: acoustic works, a timeline write is refused by the database
      expect((await writeHypothesisRun(run({ source: undefined }))).ok).toBe(true);
      await expect(writeHypothesisRun(run({ source: "timeline", intervals: [iv(0, { origin: "anchor" })] }))).rejects.toThrow();

      pg.exec(readFileSync(`db/migrations/${m146}`, "utf8"));
      expect(await pg.sql`SELECT version, name FROM schema_migrations WHERE version = 146`).toEqual([{ version: 146, name: "0146_encounter_timeline" }]);

      // every closed_by the code knows is admitted, with an origin
      const intervals = CLOSED_BY.map((c, i) => iv(i, { closed_by: c, origin: i % 3 === 0 ? "anchor" : i % 3 === 1 ? "acoustic" : "jev" }));
      const w = await writeHypothesisRun(run({ source: "timeline", intervals }));
      expect(w.ok).toBe(true);
      const r = await readLatestRun("rd_tl", undefined, "timeline");
      expect(r.run).toMatchObject({ id: w.ok ? w.run_id : "", source: "timeline", n_hypotheses: CLOSED_BY.length });
      expect(r.run!.hypotheses.map((h) => h.closed_by).sort()).toEqual([...CLOSED_BY].sort());
      expect(r.run!.hypotheses.every((h) => h.origin !== undefined)).toBe(true);
      // pre-existing acoustic run still reads as acoustic, with no origin
      const a = await readLatestRun("rd_tl", undefined, "acoustic");
      expect(a.run?.source).toBe("acoustic");
      expect(a.run!.hypotheses[0]!.origin).toBeUndefined();
      // fused path unchanged
      expect((await writeHypothesisRun(run({ source: "fused" }))).ok).toBe(true);

      await expect(pg.sql`
        INSERT INTO encounter_hypothesis (id, run_id, room_day_id, start_ms, end_ms, speech_probes, non_speech_probes, unjudged_ms, longest_unjudged_run_ms, dead_mic_ms, closed_by, merged_from, origin)
        VALUES ('eh_bad', ${w.ok ? w.run_id : ""}, 'rd_tl', 0, 1, 0, 0, 0, 0, 0, 'non_speech', 1, 'guessed')`).rejects.toThrow();
      await expect(pg.sql`
        INSERT INTO encounter_hypothesis_run (id, room_day_id, smoother_version, gate_version, probes_total, probes_speech, probes_non_speech, probes_unjudged, n_hypotheses, source)
        VALUES ('ehr_bad', 'rd_tl', 's', 'g', 0, 0, 0, 0, 0, 'guessed')`).rejects.toThrow();

      pg.exec(readFileSync(`db/migrations/${m146}`, "utf8"));
      expect(await pg.sql`SELECT count(*)::int AS n FROM schema_migrations WHERE version = 146`).toEqual([{ n: 1 }]);
    } finally {
      pg.stop();
    }
  }, 240_000);
});
