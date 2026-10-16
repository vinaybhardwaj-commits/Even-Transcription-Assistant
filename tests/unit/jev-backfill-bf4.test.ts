/**
 * JEV-C4-BACKFILL BF-4: (a) since_state / bad_since for the two BACKFILL_SINCE vars, (b) vercel.json jev-sweep schedule coupling. No database: the select layer is mocked. No text, no ids.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("@/lib/db", () => ({ sql: () => Promise.resolve([]) }));
vi.mock("@/lib/room-access/catalog-c4-select", () => ({
  selectC4Candidates: () => Promise.resolve([]), selectC4CandidatesBefore: () => Promise.resolve([]),
  selectClefPicks: () => Promise.resolve([]), selectCurrentSets: () => Promise.resolve([]), selectJevPicks: () => Promise.resolve([]),
}));
const H = vi.hoisted(() => ({ consultSql: 0 }));
vi.mock("@/lib/room-access/consult-select", () => ({
  selectTranscribedConsults: () => Promise.resolve([]),
  selectTranscribedConsultsBefore: () => { H.consultSql += 1; return Promise.resolve([]); },
}));

import { backfillSinceState, allTranscribedConsults, parseBackfillSince } from "@/lib/jev/worker/consult-eligible";
import { runCatalogC4Sync, zeroCounts, BACKFILL_ROTATE_SLOTS, ROTATE_TICK_MS } from "@/lib/jev/worker/catalog-sync";

const NOW = Date.parse("2026-10-16T06:00:00Z");
const ENV = ["CATALOG_C4_SYNC_ENABLED", "CATALOG_C4_BACKFILL_SINCE", "JEV_CONSULT_BACKFILL_SINCE"] as const;
afterEach(() => { for (const k of ENV) delete process.env[k]; vi.restoreAllMocks(); H.consultSql = 0; });
const tickOf = (spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> => {
  const line = spy.mock.calls.map((a) => String(a[0])).find((l) => l.startsWith("catalog_c4 tick "))!;
  return JSON.parse(line.slice("catalog_c4 tick ".length));
};

describe("backfillSinceState", () => {
  it("off for unset, empty and whitespace-only; on for a valid date; bad for everything else that is set", () => {
    expect(backfillSinceState(undefined, NOW)).toBe("off");
    expect(backfillSinceState("", NOW)).toBe("off");
    expect(backfillSinceState("   ", NOW)).toBe("off");
    expect(backfillSinceState("2026-09-09", NOW)).toBe("on");
    for (const v of ["yesterday", "2026-13-01", "2026-02-30", "2026-08-31", "2026-10-17", "09-09-2026", "2026-09-09T00:00"]) expect(backfillSinceState(v, NOW)).toBe("bad");
  });
  it("is exactly parseBackfillSince's language (the parser is unchanged: it trims, so a padded valid date is on)", () => {
    for (const v of ["2026-09-09", " 2026-09-09", "2026-09-09\n", "2026-09-09 ", "x", "2026-10-17"]) {
      expect(backfillSinceState(v, NOW) === "on").toBe(parseBackfillSince(v, NOW) !== null);
    }
  });
});

describe("catalog_c4 since_state / bad_since", () => {
  const run = async (since: string | undefined) => {
    process.env.CATALOG_C4_SYNC_ENABLED = "1";
    if (since !== undefined) process.env.CATALOG_C4_BACKFILL_SINCE = since;
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    const r = await runCatalogC4Sync();
    return { r, spy };
  };
  it("zeroCounts starts at off", () => { expect(zeroCounts().since_state).toBe("off"); });
  it("unset: off, no error", async () => { const { r, spy } = await run(undefined); expect(r).toMatchObject({ since_state: "off", error_class: null }); expect(tickOf(spy).since_state).toBe("off"); });
  it("empty: off, no error", async () => { const { r } = await run(""); expect(r).toMatchObject({ since_state: "off", error_class: null }); });
  it("valid: on, no error", async () => { const { r, spy } = await run("2026-09-09"); expect(r).toMatchObject({ since_state: "on", error_class: null }); expect(tickOf(spy).since_state).toBe("on"); });
  it("bad: since_state bad, error_class bad_since, in the tick line, and the value is never logged", async () => {
    const { r, spy } = await run("not-a-date");
    expect(r).toMatchObject({ since_state: "bad", error_class: "bad_since" });
    const t = tickOf(spy);
    expect(t).toMatchObject({ since_state: "bad", error_class: "bad_since" });
    expect(spy.mock.calls.map((a) => String(a[0])).join("\n")).not.toContain("not-a-date");
  });
  it("bad does not replace an error_class that is already set (flag off path returns before the check; a failing step keeps its own token)", async () => {
    process.env.CATALOG_C4_SYNC_ENABLED = "1"; process.env.CATALOG_C4_BACKFILL_SINCE = "nope";
    const sel = await import("@/lib/room-access/catalog-c4-select");
    vi.spyOn(sel, "selectC4Candidates").mockRejectedValue(new Error("boom"));
    vi.spyOn(console, "info").mockImplementation(() => {});
    const r = await runCatalogC4Sync();
    expect(r.since_state).toBe("bad");
    expect(r.error_class).not.toBeNull();
    expect(r.error_class).not.toBe("bad_since");
  });
  it("flag off: reads nothing, logs nothing, even with a bad since", async () => {
    process.env.CATALOG_C4_BACKFILL_SINCE = "nope";
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    expect(await runCatalogC4Sync()).toEqual(zeroCounts());
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("Jev sweeper backfill_since=bad", () => {
  const lines = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls.map((a) => String(a[0]));
  it("bad: exactly one backfill_since line (plus the per-sweep nodata_retry count) per call, no pass 2, value not logged", async () => {
    process.env.JEV_CONSULT_BACKFILL_SINCE = "2026-99-99";
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    await allTranscribedConsults(10, undefined, NOW);
    expect(lines(spy)).toEqual(["jev consult backfill_since=bad", "jev consult nodata_retry=0"]);
    expect(H.consultSql).toBe(0);
  });
  it("off and on log no bad line", async () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    await allTranscribedConsults(10, undefined, NOW);
    process.env.JEV_CONSULT_BACKFILL_SINCE = "2026-09-09";
    await allTranscribedConsults(10, undefined, NOW);
    expect(lines(spy).filter((l) => l.includes("backfill_since=bad"))).toEqual([]);
    expect(H.consultSql).toBe(1);
  });
});

describe("scribe_jev_health coverage.backfill_since", () => {
  it("is built from backfillSinceState for JEV_CONSULT_BACKFILL_SINCE, with all three states", () => {
    expect(readFileSync("lib/jev/worker/health.ts", "utf8")).toContain("backfill_since: backfillSinceState(process.env.JEV_CONSULT_BACKFILL_SINCE)");
  });
});

describe("schedule coupling", () => {
  it("vercel.json jev-sweep runs every 5 minutes, the period the backfill rotation assumes", () => {
    const cfg = JSON.parse(readFileSync("vercel.json", "utf8")) as { crons: Array<{ path: string; schedule: string }> };
    const c = cfg.crons.find((x) => x.path === "/api/cron/jev-sweep");
    expect(c, "jev-sweep cron missing from vercel.json").toBeDefined();
    expect(c!.schedule, `jev-sweep schedule changed: BACKFILL_ROTATE_SLOTS (${BACKFILL_ROTATE_SLOTS}) and the 5-min tick constant ROTATE_TICK_MS (${ROTATE_TICK_MS} ms) in lib/jev/worker/catalog-sync.ts assume "*/5 * * * *"; change them together or rotation coverage silently shrinks`).toBe("*/5 * * * *");
    expect(ROTATE_TICK_MS).toBe(5 * 60_000);
  });
});
