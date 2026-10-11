/** E-7 boundary scores, and the dependency-free script agrees with them. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { boundaryScore, closeCoverage } from "@/lib/encounter-clock/e7-boundaries";

const room = "room_fake1";
const fx = JSON.parse(readFileSync("tests/fixtures/e7-timeline.json", "utf8")) as {
  room_id: string;
  pulse: Array<{ start_ms: number; end_ms: number; close_kind: string; end_clicked: boolean }>;
  cuts: Array<{ start_ms: number; end_ms: number }>;
  shadow: Array<{ start_ms: number; end_ms: number }>;
};

describe("boundaryScore", () => {
  it("counts a missed consult, an extra consult, and a truth matched twice", () => {
    const score = boundaryScore(
      [{ start_ms: 0, end_ms: 100_000, room_id: room }, { start_ms: 200_000, end_ms: 260_000, room_id: room }],
      [
        { start_ms: 0, end_ms: 40_000, room_id: room },
        { start_ms: 50_000, end_ms: 100_000, room_id: room },
        { start_ms: 400_000, end_ms: 450_000, room_id: room },
      ],
    );
    expect(score).toMatchObject({ truth: 2, hypotheses: 3, missed: 1, extra: 1, two_consult_splits: 1 });
    expect(score.start_error_s.n).toBe(1);
    expect(score.end_error_s.median_s).toBe(0);
  });

  it("a zero error is 0 seconds, not a missing median", () => {
    const score = boundaryScore([{ start_ms: 0, end_ms: 10_000 }], [{ start_ms: 0, end_ms: 10_000 }]);
    expect(score.start_error_s).toEqual({ n: 1, median_s: 0, p90_s: 0 });
    expect(score.missed).toBe(0);
    expect(score.extra).toBe(0);
  });

  it("close coverage counts endConsult separately from url_clear", () => {
    expect(closeCoverage([
      { close_kind: "clicked_end", end_clicked: true },
      { close_kind: "url_clear", end_clicked: false },
    ])).toEqual({ consults: 2, by_close_kind: { clicked_end: 1, url_clear: 1 }, end_clicked: 1, not_clicked: 1 });
  });
});

describe("scripts/e7-timeline-score.mjs", () => {
  it("agrees with the TypeScript scorer on the fixture", () => {
    const tag = <T extends { start_ms: number; end_ms: number }>(rows: T[]) => rows.map((r) => ({ ...r, room_id: fx.room_id }));
    const ts = {
      pulse: boundaryScore(tag(fx.pulse), tag(fx.shadow)),
      cuts: boundaryScore(tag(fx.cuts), tag(fx.shadow)),
      close: closeCoverage(fx.pulse),
    };
    const out = execFileSync(process.execPath, ["scripts/e7-timeline-score.mjs", "--fixture", "tests/fixtures/e7-timeline.json"], { encoding: "utf8" });
    expect(JSON.parse(out)).toEqual(ts);
  });

  it("dry-run prints the reads and does not write", () => {
    const out = execFileSync(process.execPath, ["scripts/e7-timeline-score.mjs", "--dry-run"], { encoding: "utf8" });
    expect(out.toLowerCase()).toContain("select");
    expect(out).toContain("encounter_timeline_shadow");
    expect(out).toContain("eta_encounter_windows");
    expect(out).toContain("consult_index");
    expect(out.toLowerCase()).not.toMatch(/\b(insert|update|delete|drop|alter)\b/);
  });
});
