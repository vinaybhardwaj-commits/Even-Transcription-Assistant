/**
 * Night drain — the watchdog gate. GO when the verdict does not start with STOP_ and diarize_ms is under 400.
 * free_pct is never read. Anything unreadable, non-numeric or stale is NO-GO. What would break these: reading
 * free_pct, treating 400 as under 400, or a dead watchdog's last "ok" line being believed for ever.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRESSURE_MAX_AGE_MS, pressureDecision, parsePressureLine, readLastLine } from "@/lib/night-drain/pressure";

const NOW = Date.parse("2026-09-19T20:00:00Z");
const line = (o: Record<string, unknown>) => JSON.stringify({ t: "2026-09-19T20:00:00Z", free_pct: 41, swap_used_mb: 1, load1: "1", diarize_ms: 5, ollama: [], bad_streak: 0, verdict: "ok", ...o });

describe("night drain: pressure gate", () => {
  it("goes on a fresh ok line with a fast diarize probe", () => {
    expect(pressureDecision(line({}), NOW)).toEqual({ go: true, reason: "ok" });
  });

  it("goes on WARN verdicts — only STOP_ stops", () => {
    for (const v of ["WARN_tightening", "WARN_spike", "ok"]) expect(pressureDecision(line({ verdict: v }), NOW).go, v).toBe(true);
  });

  it("stops on any STOP_ verdict, even with a fast probe and lots of free memory", () => {
    for (const v of ["STOP_sustained_pressure", "STOP_heavy_swap_now", "STOP_x"]) {
      const d = pressureDecision(line({ verdict: v, diarize_ms: 5, free_pct: 90 }), NOW);
      expect(d.go, v).toBe(false);
      expect(d.reason).toBe(`stop:${v}`);
    }
  });

  it("uses diarize_ms strictly under 400: 399 goes, 400 stops, 401 stops", () => {
    expect(pressureDecision(line({ diarize_ms: 399 }), NOW).go).toBe(true);
    expect(pressureDecision(line({ diarize_ms: 400 }), NOW).go).toBe(false);
    expect(pressureDecision(line({ diarize_ms: 401 }), NOW)).toEqual({ go: false, reason: "diarize_ms:401" });
  });

  it("ignores free_pct entirely (it lies on this box)", () => {
    expect(pressureDecision(line({ free_pct: 0 }), NOW).go).toBe(true);
    expect(pressureDecision(line({ free_pct: 100, verdict: "STOP_a" }), NOW).go).toBe(false);
    expect(pressureDecision(JSON.stringify({ t: "2026-09-19T20:00:00Z", verdict: "ok", diarize_ms: 5 }), NOW).go).toBe(true); // no free_pct at all
  });

  it("fails closed on anything it cannot read", () => {
    for (const bad of [null, "", "   ", "not json", "[]", "{}", line({ diarize_ms: null }), line({ diarize_ms: "5" }), line({ diarize_ms: Number.NaN }), JSON.stringify({ t: "2026-09-19T20:00:00Z", verdict: 7, diarize_ms: 5 })]) {
      const d = pressureDecision(bad as string | null, NOW);
      expect(d.go, String(bad)).toBe(false);
      expect(d.reason).toMatch(/^unreadable:/);
    }
    expect(pressureDecision(line({ t: "yesterday" }), NOW)).toEqual({ go: false, reason: "unreadable:bad_timestamp" });
  });

  it("does not believe a dead watchdog's last ok line: older than two minutes is NO-GO", () => {
    expect(PRESSURE_MAX_AGE_MS).toBe(120_000);
    expect(pressureDecision(line({ t: "2026-09-19T19:58:01Z" }), NOW).go).toBe(true);   // 119 s
    expect(pressureDecision(line({ t: "2026-09-19T19:58:00Z" }), NOW).go).toBe(true);   // 120 s, on the line
    expect(pressureDecision(line({ t: "2026-09-19T19:57:59Z" }), NOW)).toEqual({ go: false, reason: "stale:121s" });
  });

  it("parses only t, verdict and diarize_ms", () => {
    const p = parsePressureLine(line({ verdict: "WARN_spike", diarize_ms: 12 }));
    expect(p).toEqual({ ok: true, p: { t: "2026-09-19T20:00:00Z", verdict: "WARN_spike", diarize_ms: 12 } });
  });

  it("reads the LAST non-empty line of a file, from the tail", () => {
    const dir = mkdtempSync(join(tmpdir(), "nd-p-"));
    try {
      const f = join(dir, "p.jsonl");
      writeFileSync(f, [line({ verdict: "STOP_old" }), line({ verdict: "ok" }), ""].join("\n") + "\n\n");
      expect(JSON.parse(readLastLine(f)!).verdict).toBe("ok");
      writeFileSync(f, "x".repeat(50_000) + "\n" + line({ verdict: "WARN_spike" }) + "\n");
      expect(JSON.parse(readLastLine(f)!).verdict).toBe("WARN_spike");
      writeFileSync(f, "");
      expect(readLastLine(f)).toBeNull();
      expect(readLastLine(join(dir, "missing.jsonl"))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
