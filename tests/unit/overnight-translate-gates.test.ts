/**
 * Overnight translate — the two gates every submit passes through: the CLOCK (closed hours, with a hard
 * stop on submitting at 07:10 IST) and the WATCHDOG + DISK. Pure functions, pinned at their boundaries,
 * because a gate that is off by one minute is a gate that lets a job start at 07:10:01.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IST_OFFSET_MS, isClosed, maySubmit, msUntilMaySubmit, closedHoursOver, istMsOfDay,
  CLOSED_START_MIN, CLOSED_END_MIN, STOP_SUBMIT_MIN, OPEN_EARLY_ENV, OPEN_EARLY_START_MIN, openEarlyEnabled,
} from "@/lib/overnight-translate/hours";
import {
  pressureDecision, parsePressureLine, diskDecision, gateDecision, readLastLine, freeDiskGb,
  DIARIZE_MS_LIMIT, PRESSURE_MAX_AGE_MS, DISK_FLOOR_GB,
} from "@/lib/overnight-translate/gate";

/** An instant expressed as an IST wall-clock time on 21 Sep 2026 (or the day offset given). */
const at = (h: number, m = 0, s = 0, day = 21) => Date.UTC(2026, 8, day, h, m, s) - IST_OFFSET_MS;

describe("the clock — constants are what V and Fable ruled", () => {
  it("closed hours 21:30-07:30 IST, submissions stop at 07:10", () => {
    expect(CLOSED_START_MIN).toBe(21 * 60 + 30);
    expect(CLOSED_END_MIN).toBe(7 * 60 + 30);
    expect(STOP_SUBMIT_MIN).toBe(7 * 60 + 10);
    expect(STOP_SUBMIT_MIN, "the stop is EARLIER than the end of closed hours, not equal to it").toBeLessThan(CLOSED_END_MIN);
  });
});

describe("maySubmit — the hard stop on submitting", () => {
  const cases: Array<[string, number, boolean]> = [
    ["21:00:00 — clinic could still be running", at(21, 0, 0), false],
    ["21:29:59 — one second before closed hours", at(21, 29, 59), false],
    ["21:30:00 — closed hours begin", at(21, 30, 0), true],
    ["23:59:59", at(23, 59, 59), true],
    ["00:00:00 the next day (wraps midnight)", at(0, 0, 0, 22), true],
    ["03:00:00", at(3, 0, 0, 22), true],
    ["07:09:59 — the last second a job may be submitted", at(7, 9, 59, 22), true],
    ["07:10:00 — HARD STOP on submitting", at(7, 10, 0, 22), false],
    ["07:10:01", at(7, 10, 1, 22), false],
    ["07:29:59 — still closed, but nothing new starts", at(7, 29, 59, 22), false],
    ["07:30:00 — closed hours over", at(7, 30, 0, 22), false],
    ["08:22:00 — the earliest first clinic chunk seen", at(8, 22, 0, 22), false],
    ["12:00:00", at(12, 0, 0, 22), false],
  ];
  for (const [label, t, want] of cases) {
    it(`${label} → ${want}`, () => expect(maySubmit(t)).toBe(want));
  }

  it("is decided in IST from epoch milliseconds, not from the machine's timezone", () => {
    const before = process.env.TZ;
    try {
      for (const tz of ["UTC", "America/Los_Angeles", "Asia/Kolkata", "Pacific/Auckland"]) {
        process.env.TZ = tz;
        expect(maySubmit(at(7, 9, 59, 22)), tz).toBe(true);
        expect(maySubmit(at(7, 10, 0, 22)), tz).toBe(false);
        expect(maySubmit(at(21, 30, 0)), tz).toBe(true);
      }
    } finally {
      if (before === undefined) delete process.env.TZ; else process.env.TZ = before;
    }
  });
});

describe("isClosed / closedHoursOver — when the clinic side opens", () => {
  it("closed at 21:30:00 and 07:29:59; open at 21:29:59 and 07:30:00", () => {
    expect(isClosed(at(21, 29, 59))).toBe(false);
    expect(isClosed(at(21, 30, 0))).toBe(true);
    expect(isClosed(at(7, 29, 59, 22))).toBe(true);
    expect(isClosed(at(7, 30, 0, 22))).toBe(false);
  });
  it("closedHoursOver is the exact complement", () => {
    for (const t of [at(7, 29, 59, 22), at(7, 30, 0, 22), at(12, 0, 0, 22), at(22, 0, 0), at(21, 29, 59)]) {
      expect(closedHoursOver(t)).toBe(!isClosed(t));
    }
  });
  it("istMsOfDay wraps correctly for instants before the epoch's IST midnight", () => {
    expect(istMsOfDay(-1)).toBeGreaterThanOrEqual(0);
    expect(istMsOfDay(-1)).toBeLessThan(86_400_000);
  });
});

describe("msUntilMaySubmit", () => {
  it("is 0 whenever a submit is allowed", () => {
    expect(msUntilMaySubmit(at(22, 0, 0))).toBe(0);
    expect(msUntilMaySubmit(at(7, 9, 59, 22))).toBe(0);
  });
  it("counts to 21:30 from the day and from the dead zone between 07:10 and 07:30", () => {
    expect(msUntilMaySubmit(at(12, 0, 0))).toBe(9.5 * 3_600_000);
    expect(msUntilMaySubmit(at(7, 15, 0, 22))).toBe((14 * 60 + 15) * 60_000);
    expect(msUntilMaySubmit(at(21, 29, 59))).toBe(1000);
  });
});

// ===========================================================================
const NOW = Date.parse("2026-09-21T20:00:00Z");
const line = (o: Record<string, unknown>) => JSON.stringify({ t: new Date(NOW - 5_000).toISOString(), verdict: "ok", diarize_ms: 7, ...o });

describe("OPEN EARLY — ETA_OVERNIGHT_OPEN_EARLY=1 moves the START to 19:00 IST and nothing else (Fable, 21 Sep 20:45)", () => {
  it("the switch is the exact string \"1\" in the environment; anything else, or nothing, is today's behaviour", () => {
    expect(OPEN_EARLY_ENV).toBe("ETA_OVERNIGHT_OPEN_EARLY");
    expect(openEarlyEnabled({ ETA_OVERNIGHT_OPEN_EARLY: "1" })).toBe(true);
    for (const v of [undefined, "", "0", "true", "yes", " 1", "1 ", "on"]) expect(openEarlyEnabled({ ETA_OVERNIGHT_OPEN_EARLY: v }), String(v)).toBe(false);
    expect(openEarlyEnabled({})).toBe(false);
  });
  it("the default reads process.env at CALL time, so a launchd plist entry is enough", () => {
    const was = process.env[OPEN_EARLY_ENV];
    try {
      delete process.env[OPEN_EARLY_ENV];
      expect(maySubmit(at(20, 45))).toBe(false);
      process.env[OPEN_EARLY_ENV] = "1";
      expect(maySubmit(at(20, 45))).toBe(true);
      process.env[OPEN_EARLY_ENV] = "0";
      expect(maySubmit(at(20, 45))).toBe(false);
    } finally {
      if (was === undefined) delete process.env[OPEN_EARLY_ENV]; else process.env[OPEN_EARLY_ENV] = was;
    }
  });
  it("UNSET: 20:45 is blocked and 21:31 is open — exactly today's behaviour", () => {
    expect(maySubmit(at(20, 45), false)).toBe(false);
    expect(maySubmit(at(21, 29, 59), false)).toBe(false);
    expect(maySubmit(at(21, 31), false)).toBe(true);
    expect(msUntilMaySubmit(at(20, 45), false)).toBe(45 * 60_000);
    expect(isClosed(at(20, 45), false)).toBe(false);
    expect(closedHoursOver(at(20, 45), false)).toBe(true);
  });
  it("SET: 20:45 is open and 18:59 is still blocked; 19:00:00 is the first open second", () => {
    expect(maySubmit(at(20, 45), true)).toBe(true);
    expect(maySubmit(at(18, 59), true)).toBe(false);
    expect(maySubmit(at(18, 59, 59), true)).toBe(false);
    expect(maySubmit(at(19, 0, 0), true)).toBe(true);
    expect(OPEN_EARLY_START_MIN).toBe(19 * 60);
  });
  it("SET: 07:11 is blocked — the stop still wins — and 07:09:59 is still open", () => {
    expect(maySubmit(at(7, 11), true)).toBe(false);
    expect(maySubmit(at(7, 10, 0), true)).toBe(false);
    expect(maySubmit(at(7, 9, 59), true)).toBe(true);
    expect(maySubmit(at(7, 29), true)).toBe(false);
  });
  it("SET: between 07:10 and 19:00 the override does nothing — the whole clinic day stays blocked", () => {
    for (const [h, m] of [[7, 10], [7, 30], [9, 0], [12, 0], [15, 30], [18, 30], [18, 59]] as const) {
      expect(maySubmit(at(h, m), true), `${h}:${m}`).toBe(false);
      expect(maySubmit(at(h, m), true)).toBe(maySubmit(at(h, m), false));
    }
  });
  it("SET changes NOTHING at or after 21:30 or before 07:10 — the two settings agree outside 19:00-21:30", () => {
    for (let mins = 0; mins < 24 * 60; mins += 7) {
      const t = at(0, mins);
      const inWindow = mins >= 19 * 60 && mins < 21 * 60 + 30;
      if (!inWindow) expect(maySubmit(t, true), `minute ${mins}`).toBe(maySubmit(t, false));
      if (!inWindow) expect(isClosed(t, true), `minute ${mins}`).toBe(isClosed(t, false));
    }
  });
  it("SET: the closed period, for the driver's \"has the clinic side opened\" question, starts at 19:00 and still ends at 07:30", () => {
    expect(isClosed(at(19, 0), true)).toBe(true);
    expect(isClosed(at(18, 59, 59), true)).toBe(false);
    expect(isClosed(at(7, 29, 59), true)).toBe(true);
    expect(isClosed(at(7, 30), true)).toBe(false);
    expect(closedHoursOver(at(20, 45), true), "a job stood by for at 20:45 is NOT abandoned as running into clinic hours").toBe(false);
    expect(closedHoursOver(at(7, 30), true)).toBe(true);
  });
  it("SET: msUntilMaySubmit counts to 19:00, and is 0 once open", () => {
    expect(msUntilMaySubmit(at(18, 0), true)).toBe(60 * 60_000);
    expect(msUntilMaySubmit(at(20, 45), true)).toBe(0);
    expect(msUntilMaySubmit(at(7, 20), true)).toBe(11 * 60 * 60_000 + 40 * 60_000);
  });
});

describe("pressureDecision — the watchdog rule, failing closed", () => {
  it("GO on a fresh ok line with diarize_ms under the limit", () => {
    expect(pressureDecision(line({}), NOW)).toEqual({ go: true, reason: "ok" });
  });
  it("any STOP_ verdict is NO-GO and names the verdict", () => {
    expect(pressureDecision(line({ verdict: "STOP_sustained_pressure" }), NOW)).toEqual({ go: false, reason: "stop:STOP_sustained_pressure" });
    expect(pressureDecision(line({ verdict: "STOP_diarize_latency" }), NOW).go).toBe(false);
  });
  it(`diarize_ms at the limit (${DIARIZE_MS_LIMIT}) is NO-GO; one under is GO`, () => {
    expect(pressureDecision(line({ diarize_ms: DIARIZE_MS_LIMIT }), NOW).go).toBe(false);
    expect(pressureDecision(line({ diarize_ms: DIARIZE_MS_LIMIT - 1 }), NOW).go).toBe(true);
  });
  it("a line older than the max age means the watchdog died: NO-GO, however green it says it was", () => {
    const old = JSON.stringify({ t: new Date(NOW - PRESSURE_MAX_AGE_MS - 1000).toISOString(), verdict: "ok", diarize_ms: 1 });
    expect(pressureDecision(old, NOW).go).toBe(false);
    expect(pressureDecision(old, NOW).reason).toMatch(/^stale:/);
  });
  it("unreadable input is NO-GO with a closed reason: null, empty, junk, array, missing fields, non-numeric diarize_ms", () => {
    for (const bad of [null, "", "   ", "{not json", "[]", "42", JSON.stringify({ t: "x" }), JSON.stringify({ t: new Date(NOW).toISOString(), verdict: "ok" }),
      JSON.stringify({ t: new Date(NOW).toISOString(), verdict: "ok", diarize_ms: "7" }), JSON.stringify({ t: "garbage", verdict: "ok", diarize_ms: 1 })]) {
      const d = pressureDecision(bad as string | null, NOW);
      expect(d.go, String(bad)).toBe(false);
      expect(d.reason).toMatch(/^(unreadable|stale)/);
    }
  });
  it("never reads free_pct — a line whose free_pct is 1 is still GO", () => {
    expect(pressureDecision(line({ free_pct: 1 }), NOW).go).toBe(true);
    expect(parsePressureLine(line({ free_pct: 1 }))).toMatchObject({ ok: true });
  });
});

describe("diskDecision — the 40 GB floor", () => {
  it(`GO at the floor (${DISK_FLOOR_GB}) and above; NO-GO below`, () => {
    expect(diskDecision(DISK_FLOOR_GB).go).toBe(true);
    expect(diskDecision(114).go).toBe(true);
    const low = diskDecision(DISK_FLOOR_GB - 0.5);
    expect(low.go).toBe(false);
    expect(low.reason).toBe(`disk:39GB<${DISK_FLOOR_GB}GB`);
  });
  it("an unreadable reading is NO-GO — a floor that fails open is not a floor", () => {
    expect(diskDecision(null).go).toBe(false);
    expect(diskDecision(Number.NaN).go).toBe(false);
    expect(diskDecision(null).reason).toBe("disk:unreadable");
  });
});

describe("gateDecision — watchdog first, then disk", () => {
  it("both fine → GO", () => expect(gateDecision(line({}), NOW, 100)).toEqual({ go: true, reason: "ok" }));
  it("watchdog STOP is reported even when the disk is also low (it says WHY the Mini is busy)", () => {
    expect(gateDecision(line({ verdict: "STOP_x" }), NOW, 1).reason).toBe("stop:STOP_x");
  });
  it("watchdog fine, disk low → NO-GO for the disk", () => expect(gateDecision(line({}), NOW, 10)).toMatchObject({ go: false, reason: expect.stringMatching(/^disk:/) }));
});

describe("readLastLine / freeDiskGb — the two real reads", () => {
  it("returns the last non-empty line of a file, reading only its tail", () => {
    const dir = mkdtempSync(join(tmpdir(), "ot-gate-"));
    try {
      const f = join(dir, "p.jsonl");
      writeFileSync(f, `${"x".repeat(20_000)}\n{"a":1}\n{"a":2}\n\n`);
      expect(readLastLine(f)).toBe('{"a":2}');
      writeFileSync(f, "");
      expect(readLastLine(f)).toBeNull();
      expect(readLastLine(join(dir, "missing.jsonl"))).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("freeDiskGb is a non-negative number for a real path and null for one that cannot be read", () => {
    const g = freeDiskGb("/");
    expect(typeof g).toBe("number");
    expect(g as number).toBeGreaterThanOrEqual(0);
    expect(freeDiskGb("/definitely/not/a/real/path/xyz")).toBeNull();
  });
});
