/**
 * Night drain — closed hours. The boundary is 21:30 → 07:30 IST, taken from the recorded activity (first clinic chunk
 * of a day 08:22 at the earliest, last session end 21:10). What would break these: someone reading the machine's
 * timezone, someone treating Sunday as closed, or the end boundary becoming inclusive.
 */
import { describe, it, expect } from "vitest";
import { CLOSED_HOURS, START_BUFFER_MS, END_GRACE_MS, abandonAtMs, isClosed, istMsOfDay, mayStartWindow, msUntilClose, msUntilOpenForWork, nightOf } from "@/lib/night-drain/hours";

/** IST wall clock → epoch ms. IST is a fixed +05:30. */
const ist = (date: string, hhmm: string, sec = 0, ms = 0): number => Date.parse(`${date}T${hhmm}:${String(sec).padStart(2, "0")}.${String(ms).padStart(3, "0")}+05:30`);

describe("night drain: closed hours 21:30–07:30 IST", () => {
  it("is closed from 21:30:00.000 inclusive and open again at 07:30:00.000 exclusive", () => {
    expect(isClosed(ist("2026-09-18", "21:29", 59, 999))).toBe(false);
    expect(isClosed(ist("2026-09-18", "21:30"))).toBe(true);
    expect(isClosed(ist("2026-09-19", "07:29", 59, 999))).toBe(true);
    expect(isClosed(ist("2026-09-19", "07:30"))).toBe(false);
  });

  it("is closed across midnight and open through the clinic day", () => {
    for (const t of ["22:00", "23:59", "00:00", "03:00", "07:00"]) expect(isClosed(ist("2026-09-19", t)), t).toBe(true);
    for (const t of ["07:30", "08:22", "12:00", "19:46", "20:04", "21:10", "21:29"]) expect(isClosed(ist("2026-09-19", t)), t).toBe(false);
  });

  it("does not treat weekends as closed: the gate is the clock, not the day (Sunday 13 Sep had 535 chunks)", () => {
    expect(new Date(ist("2026-09-13", "12:00")).getUTCDay()).toBe(0); // 12:00 IST on 13 Sep is a Sunday
    expect(isClosed(ist("2026-09-13", "12:00"))).toBe(false);
    expect(isClosed(ist("2026-09-13", "23:00"))).toBe(true);
    expect(isClosed(ist("2026-09-12", "12:00"))).toBe(false); // Saturday
  });

  it("does not read the machine timezone: the same instant gives the same answer under any TZ", () => {
    const t = ist("2026-09-19", "22:00");
    const before = process.env.TZ;
    for (const tz of ["UTC", "Asia/Kolkata", "America/Los_Angeles", "Pacific/Auckland"]) {
      process.env.TZ = tz;
      expect(isClosed(t), tz).toBe(true);
      expect(isClosed(ist("2026-09-19", "12:00")), tz).toBe(false);
    }
    if (before === undefined) delete process.env.TZ; else process.env.TZ = before;
  });

  it("istMsOfDay is the IST wall clock, including for instants before the epoch's first midnight", () => {
    expect(istMsOfDay(ist("2026-09-19", "07:30"))).toBe(7.5 * 3_600_000);
    expect(istMsOfDay(Date.UTC(1969, 11, 31, 18, 30))).toBe(0); // 1970-01-01 00:00 IST
  });

  it("measures the time left in the closed period, across midnight", () => {
    expect(msUntilClose(ist("2026-09-19", "07:00"))).toBe(30 * 60_000);
    expect(msUntilClose(ist("2026-09-18", "23:30"))).toBe(8 * 3_600_000);
    expect(msUntilClose(ist("2026-09-18", "21:30"))).toBe(10 * 3_600_000);
    expect(msUntilClose(ist("2026-09-18", "12:00"))).toBe(0);
  });

  it("measures the time until closed hours begin", () => {
    expect(msUntilOpenForWork(ist("2026-09-18", "21:00"))).toBe(30 * 60_000);
    expect(msUntilOpenForWork(ist("2026-09-19", "07:30"))).toBe(14 * 3_600_000);
    expect(msUntilOpenForWork(ist("2026-09-18", "22:00"))).toBe(0);
  });

  it("starts no window in the last four minutes: 07:25:59 may start one, 07:26:00 may not", () => {
    expect(START_BUFFER_MS).toBe(4 * 60_000);
    expect(mayStartWindow(ist("2026-09-19", "07:25", 59))).toBe(true);
    expect(mayStartWindow(ist("2026-09-19", "07:26", 0))).toBe(false);
    expect(mayStartWindow(ist("2026-09-19", "07:29"))).toBe(false);
    expect(mayStartWindow(ist("2026-09-19", "07:30"))).toBe(false);
    expect(mayStartWindow(ist("2026-09-18", "21:30"))).toBe(true);
    expect(mayStartWindow(ist("2026-09-18", "21:29", 59))).toBe(false);
  });

  it("abandons an in-flight window two minutes after closed hours end", () => {
    const t = ist("2026-09-19", "07:20");
    expect(END_GRACE_MS).toBe(2 * 60_000);
    expect(abandonAtMs(t)).toBe(ist("2026-09-19", "07:32"));
  });

  it("names a night by the date it STARTED on", () => {
    expect(nightOf(ist("2026-09-18", "22:00"))).toBe("2026-09-18");
    expect(nightOf(ist("2026-09-19", "03:00"))).toBe("2026-09-18");
    expect(nightOf(ist("2026-09-19", "07:29"))).toBe("2026-09-18");
  });

  it("gets the non-wrapping case right too (a window inside one day): start inclusive, end exclusive", () => {
    const day = { startMin: 9 * 60, endMin: 17 * 60 };
    expect(isClosed(ist("2026-09-19", "08:59", 59), day)).toBe(false);
    expect(isClosed(ist("2026-09-19", "09:00"), day)).toBe(true);
    expect(isClosed(ist("2026-09-19", "16:59", 59), day)).toBe(true);
    expect(isClosed(ist("2026-09-19", "17:00"), day)).toBe(false);
    expect(msUntilClose(ist("2026-09-19", "16:00"), day)).toBe(3_600_000);
    expect(msUntilOpenForWork(ist("2026-09-19", "17:00"), day)).toBe(16 * 3_600_000);
  });

  it("is a 10-hour night", () => {
    expect(CLOSED_HOURS).toEqual({ startMin: 21 * 60 + 30, endMin: 7 * 60 + 30 });
    expect(msUntilClose(ist("2026-09-18", "21:30"))).toBe(10 * 3_600_000);
  });
});
