import { describe, it, expect } from "vitest";
import {
  ORBOX_SCHEDULE,
  DEFAULT_CLINIC_SCHEDULE,
  activeWindow,
  notStartedAlert,
  scheduleForRoom,
  NOT_STARTED_GRACE_MS,
} from "@/lib/room-schedule";

// IST wall clock -> UTC ms. 2026-09-28 is a Monday; 2026-09-27 a Sunday.
const ist = (d: string, hhmm: string) => Date.parse(`${d}T${hhmm}:00+05:30`);
const MIN = 60_000;

describe("clinic default: every day 08:30-20:30 IST, 7 days a week", () => {
  const s = DEFAULT_CLINIC_SCHEDULE;
  it("is inside on Monday at 08:30 and 20:29, outside at 08:29 and 20:30", () => {
    expect(activeWindow(s, ist("2026-09-28", "08:30"))).not.toBeNull();
    expect(activeWindow(s, ist("2026-09-28", "20:29"))).not.toBeNull();
    expect(activeWindow(s, ist("2026-09-28", "08:29"))).toBeNull();
    expect(activeWindow(s, ist("2026-09-28", "20:30"))).toBeNull();
  });
  it("every weekday including Sunday is a working day", () => {
    for (const d of ["2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03"]) {
      expect(activeWindow(s, ist(d, "12:00"))).not.toBeNull();
      expect(activeWindow(s, ist(d, "08:29"))).toBeNull();
      expect(activeWindow(s, ist(d, "20:30"))).toBeNull();
    }
  });
  it("reports the window's real UTC bounds", () => {
    const w = activeWindow(s, ist("2026-09-28", "10:00"))!;
    expect(w.startMs).toBe(ist("2026-09-28", "08:30"));
    expect(w.endMs).toBe(ist("2026-09-28", "20:30"));
  });
});

describe("ORBOX: 06:00 -> 02:00 next day, every day (crosses midnight)", () => {
  const s = ORBOX_SCHEDULE;
  it("at 01:30 it is INSIDE the window that opened at 06:00 the day before", () => {
    const w = activeWindow(s, ist("2026-09-29", "01:30"))!;
    expect(w).not.toBeNull();
    expect(w.startMs).toBe(ist("2026-09-28", "06:00"));
    expect(w.endMs).toBe(ist("2026-09-29", "02:00"));
  });
  it("02:00 is outside (exclusive), 05:59 is outside, 06:00 is inside", () => {
    expect(activeWindow(s, ist("2026-09-29", "01:59"))).not.toBeNull();
    expect(activeWindow(s, ist("2026-09-29", "02:00"))).toBeNull();
    expect(activeWindow(s, ist("2026-09-29", "05:59"))).toBeNull();
    expect(activeWindow(s, ist("2026-09-29", "06:00"))).not.toBeNull();
  });
  it("spans midnight itself, and the Sunday window spills into Monday", () => {
    expect(activeWindow(s, ist("2026-09-28", "00:00"))!.startMs).toBe(ist("2026-09-27", "06:00"));
    expect(activeWindow(s, ist("2026-09-28", "01:30"))).not.toBeNull();
  });
  it("Saturday's window spills into Sunday morning (a start-day rule, not a today rule)", () => {
    expect(activeWindow(s, ist("2026-09-27", "01:30"))!.startMs).toBe(ist("2026-09-26", "06:00"));
  });
});

describe("a clinic window does NOT spill past 20:30", () => {
  it("Tuesday 00:30 for a clinic is outside", () => {
    expect(activeWindow(DEFAULT_CLINIC_SCHEDULE, ist("2026-09-29", "00:30"))).toBeNull();
  });
});

describe("notStartedAlert", () => {
  const base = { sessionOpen: false, lastSessionStartedMs: null as number | null };
  it("clinic: quiet inside the 10-minute grace, alerts after it", () => {
    const s = DEFAULT_CLINIC_SCHEDULE;
    expect(notStartedAlert({ ...base, schedule: s, nowMs: ist("2026-09-28", "08:39") })).toBeNull();
    expect(notStartedAlert({ ...base, schedule: s, nowMs: ist("2026-09-28", "08:40") })).not.toBeNull();
  });
  it("Sunday alerts like any other day (7-day hospital); outside the window it never does", () => {
    expect(notStartedAlert({ ...base, schedule: DEFAULT_CLINIC_SCHEDULE, nowMs: ist("2026-09-27", "10:00") })).not.toBeNull();
    expect(notStartedAlert({ ...base, schedule: DEFAULT_CLINIC_SCHEDULE, nowMs: ist("2026-09-27", "07:00") })).toBeNull();
    expect(notStartedAlert({ ...base, schedule: DEFAULT_CLINIC_SCHEDULE, nowMs: ist("2026-09-28", "07:00") })).toBeNull();
  });
  it("orbox3 at 01:30 with a session open is NOT flagged", () => {
    const nowMs = ist("2026-09-29", "01:30");
    expect(
      notStartedAlert({ schedule: ORBOX_SCHEDULE, nowMs, sessionOpen: true, lastSessionStartedMs: ist("2026-09-28", "06:02") }),
    ).toBeNull();
  });
  it("orbox3 at 01:30, session started 06:02 the day before and since ended: not flagged (it did start)", () => {
    expect(
      notStartedAlert({
        schedule: ORBOX_SCHEDULE,
        nowMs: ist("2026-09-29", "01:30"),
        sessionOpen: false,
        lastSessionStartedMs: ist("2026-09-28", "06:02"),
      }),
    ).toBeNull();
  });
  it("orbox3 at 01:30 that NEVER started this window IS flagged, against the day-before window", () => {
    const w = notStartedAlert({
      schedule: ORBOX_SCHEDULE,
      nowMs: ist("2026-09-29", "01:30"),
      sessionOpen: false,
      // last session began the previous window, not this one
      lastSessionStartedMs: ist("2026-09-27", "06:02"),
    });
    expect(w).not.toBeNull();
    expect(w!.startMs).toBe(ist("2026-09-28", "06:00"));
  });
  it("orbox3 at 01:30 is not flagged 'not started' merely because it is before 06:00 today", () => {
    // the regression this test names: reading 01:30 as 'Tuesday before open' instead of 'Monday's window still running'
    expect(
      notStartedAlert({ schedule: ORBOX_SCHEDULE, nowMs: ist("2026-09-29", "01:30"), sessionOpen: true, lastSessionStartedMs: null }),
    ).toBeNull();
  });
  it("a session that began BEFORE the window opened does not clear it", () => {
    expect(
      notStartedAlert({
        schedule: DEFAULT_CLINIC_SCHEDULE,
        nowMs: ist("2026-09-28", "09:00"),
        sessionOpen: false,
        lastSessionStartedMs: ist("2026-09-27", "18:00"),
      }),
    ).not.toBeNull();
  });
  it("the grace is a parameter", () => {
    expect(NOT_STARTED_GRACE_MS).toBe(10 * MIN);
    expect(
      notStartedAlert({ ...base, schedule: DEFAULT_CLINIC_SCHEDULE, nowMs: ist("2026-09-28", "08:35"), graceMs: 5 * MIN }),
    ).not.toBeNull();
  });
});

describe("scheduleForRoom", () => {
  it("orb3 carries its own window; everything else is the clinic default", () => {
    expect(scheduleForRoom("orb3-29ac")).toBe(ORBOX_SCHEDULE);
    expect(scheduleForRoom("opd-4-ortho-778q")).toBe(DEFAULT_CLINIC_SCHEDULE);
    expect(scheduleForRoom(null)).toBe(DEFAULT_CLINIC_SCHEDULE);
  });
});
