/**
 * DRAFT (Fable ruling 255b) — the hourly exact-zero alarm's rules, pinned. The module is inert (nothing calls it), so these tests are the whole behaviour.
 * Pure rules first; then the SQL against a REAL postgres, because "one glitch sample clears the bucket", "unreported is not ok" and "IST hours are 05:30 ahead of UTC" are
 * properties of the query, not of a mock.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const H = vi.hoisted(() => ({ sql: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>) }));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => H.sql!(s, ...v) }));

import {
  ALARM_MIN_ZERO_BUCKETS, ALARM_SHARE, DEFAULT_THRESHOLDS, EXACT_ZERO_RATIO, MIN_MEASURED_BUCKETS,
  classifyHour, exactZeroMessage, istHourLabel, istHourStart, readExactZeroHours,
} from "@/lib/exact-zero-alarm";

const HAVE_DOCKER = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-exact-zero-alarm");

describe("REQUIRED PROOF — the exact-zero alarm's query runs against a real postgres", () => {
  it("ran, or was skipped deliberately", () => {
    if (HAVE_DOCKER || ALLOW_SKIP) return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/exact-zero-alarm.test.ts needs Docker for postgres:16. Start Docker, or set ETA_ALLOW_SKIP_E2E=1 to accept that it was not proven.");
  });
});

const hour = (rec: number, meas: number, zero: number) => ({ recording_buckets: rec, measured_buckets: meas, exact_zero_buckets: zero });

describe("classifyHour — the decision", () => {
  it("the proposed constants are the ones the spec states", () => {
    expect(EXACT_ZERO_RATIO).toBe(0.999);
    expect(MIN_MEASURED_BUCKETS).toBe(20);
    expect(ALARM_MIN_ZERO_BUCKETS).toBe(20);
    expect(ALARM_SHARE).toBe(0.1);
  });

  it("a clean hour is ok", () => {
    expect(classifyHour(hour(240, 240, 0))).toMatchObject({ state: "ok", zero_share: 0, zero_minutes: 0, unmeasured_buckets: 0 });
  });

  it("ALARMS when at least 20 buckets are exact zero AND that is at least 10 % of the measured ones (both conditions, boundaries on both)", () => {
    expect(classifyHour(hour(200, 200, 20)).state, "20 of 200 = exactly 10 %, exactly 20 buckets").toBe("alarm");
    expect(classifyHour(hour(200, 200, 19)).state, "19 buckets is under the count floor").toBe("ok");
    expect(classifyHour(hour(240, 240, 23)).state, "23 of 240 is 9.58 %, under the share").toBe("ok");
    expect(classifyHour(hour(240, 240, 24)).state, "24 of 240 is exactly 10 %").toBe("alarm");
    expect(classifyHour(hour(1000, 1000, 100)).state).toBe("alarm");
    expect(classifyHour(hour(1000, 1000, 99)).state, "99 of 1000 is 9.9 %").toBe("ok");
  });

  it("a short hour that is ALL zero still alarms once it has enough measured time; below it, it is insufficient, never ok", () => {
    expect(classifyHour(hour(20, 20, 20)).state).toBe("alarm");
    expect(classifyHour(hour(19, 19, 19)).state, "5 minutes short of judging").toBe("insufficient");
    expect(classifyHour(hour(19, 19, 0)).state, "clean but unjudged is NOT ok").toBe("insufficient");
  });

  it("UNMEASURED recording is neither ok nor zero: it is named, and an hour with no reports at all is insufficient (absent is not healthy)", () => {
    const partly = classifyHour(hour(300, 240, 24));
    expect(partly).toMatchObject({ state: "alarm", unmeasured_buckets: 60 });
    expect(partly.zero_share, "the share is over MEASURED buckets, not recording buckets").toBeCloseTo(0.1, 10);
    const none = classifyHour(hour(240, 0, 0));
    expect(none.state).toBe("insufficient");
    expect(none.zero_share).toBeNull();
    expect(none.unmeasured_buckets).toBe(240);
  });

  it("zero_minutes is buckets x 15 s", () => {
    expect(classifyHour(hour(240, 240, 24)).zero_minutes).toBe(6);
  });

  it("malformed counts are insufficient, never a quiet ok", () => {
    for (const bad of [hour(-1, 0, 0), hour(10, 20, 0), hour(240, 100, 101), hour(Number.NaN, 1, 0), hour(240, 240, Number.POSITIVE_INFINITY)]) {
      expect(classifyHour(bad).state, JSON.stringify(bad)).toBe("insufficient");
    }
  });

  it("the thresholds are parameters, so a calibrated set can replace the proposal without touching the rule", () => {
    // 60 measured buckets is enough to JUDGE under the defaults, but 6 zero buckets is under the 20-bucket floor: ok. A calibrated set that lowers the floor alarms on the same hour.
    expect(classifyHour(hour(60, 60, 6), DEFAULT_THRESHOLDS).state).toBe("ok");
    expect(classifyHour(hour(60, 60, 6), { minMeasured: 10, alarmMinZero: 6, alarmShare: 0.1 }).state).toBe("alarm");
    // and raising minMeasured turns the same hour into insufficient
    expect(classifyHour(hour(60, 60, 6), { minMeasured: 100, alarmMinZero: 6, alarmShare: 0.1 }).state).toBe("insufficient");
  });
});

describe("IST hours and the message", () => {
  it("IST is 05:30 AHEAD of UTC: 00:05 IST on 25 Sep belongs to the hour starting 00:00 IST, which is 18:30Z on the 24th", () => {
    expect(new Date(istHourStart(Date.parse("2026-09-24T18:35:00Z"))).toISOString()).toBe("2026-09-24T18:30:00.000Z");
    expect(new Date(istHourStart(Date.parse("2026-09-24T18:29:59Z"))).toISOString()).toBe("2026-09-24T17:30:00.000Z");
    expect(istHourLabel(Date.parse("2026-09-24T18:30:00Z"))).toBe("2026-09-25 00:00 IST");
    expect(istHourLabel(Date.parse("2026-09-24T04:30:00Z"))).toBe("2026-09-24 10:00 IST");
  });

  it("the message carries counts and times only, and names the unmeasured minutes when there are some", () => {
    const h = { room_id: "room_x", hour_start: "2026-09-24T04:30:00.000Z", recording_buckets: 300, measured_buckets: 240, exact_zero_buckets: 60 };
    const v = classifyHour(h);
    const m = exactZeroMessage("room_x", h, v);
    expect(m.subject).toContain("room_x");
    expect(m.subject).toContain("2026-09-24 10:00 IST");
    expect(m.text).toContain("15.0 of the 60.0 minutes measured");
    expect(m.text).toContain("25 %");
    expect(m.text).toContain("hardware-mute signature");
    expect(m.text).toContain("15.0 minutes of recording did not report a level");
    const clean = exactZeroMessage("room_x", { ...h, recording_buckets: 240 }, classifyHour({ ...h, recording_buckets: 240 }));
    expect(clean.text).not.toContain("did not report");
  });
});

const seed = (room: string, startIso: string, n: number, zr: number | null, opts: { open?: boolean; adv?: boolean; samplesPerBucket?: number } = {}) => {
  const open = opts.open ?? true;
  const adv = opts.adv ?? true;
  const zrSql = zr === null ? "NULL" : String(zr);
  pg.exec(`
    INSERT INTO bench_level_sample (room_id, ist_date, sampled_at, peak, avg, zero_ratio, session_open, tape_advancing)
    SELECT '${room}', (('${startIso}'::timestamptz) AT TIME ZONE 'Asia/Kolkata')::date, ('${startIso}'::timestamptz) + (g * interval '15 seconds'),
           0.1, 0.05, ${zrSql}, ${open}, ${adv}
      FROM generate_series(0, ${n - 1}) g;`);
};
const T10 = "2026-09-24T04:30:00Z"; // 10:00 IST

beforeAll(() => {
  if (!HAVE_DOCKER) return;
  pg.start();
  pg.exec(`CREATE TABLE bench_level_sample (
    room_id text NOT NULL, ist_date date NOT NULL, sampled_at timestamptz NOT NULL, peak real, avg real, zero_ratio real,
    session_open boolean NOT NULL DEFAULT false, tape_advancing boolean NOT NULL DEFAULT false);`);
  H.sql = pg.sql;
}, 240_000);
afterAll(() => { if (HAVE_DOCKER) pg.stop(); });
beforeEach(() => { if (HAVE_DOCKER) pg.exec("TRUNCATE bench_level_sample;"); });

const read = (o: { roomId?: string; sinceMs?: number; untilMs?: number } = {}) =>
  readExactZeroHours({ roomId: o.roomId, sinceMs: o.sinceMs ?? Date.parse("2026-09-24T00:00:00Z"), untilMs: o.untilMs ?? Date.parse("2026-09-26T00:00:00Z") });

describe.runIf(HAVE_DOCKER)("readExactZeroHours — the definitions, against a real postgres", () => {
  it("counts recording, measured and exact-zero buckets per room and IST hour", async () => {
    seed("room_a", T10, 200, 0.1);                                  // 200 buckets, live
    seed("room_a", "2026-09-24T05:20:00Z", 40, 1);                   // 40 buckets fully zero, later in the same IST hour (10:50-11:00)
    const rows = await read({ roomId: "room_a" });
    expect(rows).toEqual([{ room_id: "room_a", hour_start: "2026-09-24T04:30:00.000Z", recording_buckets: 240, measured_buckets: 240, exact_zero_buckets: 40 }]);
    expect(classifyHour(rows[0]).state).toBe("alarm");
  });

  it("a bucket is exact zero only if EVERY reporting sample in it is: one live sample clears it (min, not max)", async () => {
    // three samples in one 15 s bucket: 1, 1, 0.5  -> NOT exact zero;  another bucket: 1, 1, 1 -> exact zero
    pg.exec(`INSERT INTO bench_level_sample (room_id, ist_date, sampled_at, zero_ratio, session_open, tape_advancing) VALUES
      ('room_m', '2026-09-24', '${T10}'::timestamptz + interval '1 second', 1, true, true),
      ('room_m', '2026-09-24', '${T10}'::timestamptz + interval '2 seconds', 1, true, true),
      ('room_m', '2026-09-24', '${T10}'::timestamptz + interval '3 seconds', 0.5, true, true),
      ('room_m', '2026-09-24', '${T10}'::timestamptz + interval '16 seconds', 1, true, true),
      ('room_m', '2026-09-24', '${T10}'::timestamptz + interval '17 seconds', 1, true, true),
      ('room_m', '2026-09-24', '${T10}'::timestamptz + interval '18 seconds', 1, true, true);`);
    const [r] = await read({ roomId: "room_m" });
    expect(r).toMatchObject({ recording_buckets: 2, measured_buckets: 2, exact_zero_buckets: 1 });
  });

  it("the line is 0.999: 0.99 is a dead-looking input but NOT exact zero, 0.999 and 1 are", async () => {
    seed("room_t", T10, 10, 0.99);
    seed("room_t", "2026-09-24T04:33:00Z", 10, 0.999);
    seed("room_t", "2026-09-24T04:36:00Z", 10, 1);
    const [r] = await read({ roomId: "room_t" });
    expect(r).toMatchObject({ recording_buckets: 30, measured_buckets: 30, exact_zero_buckets: 20 });
  });

  it("UNREPORTED is neither ok nor zero: a recording bucket with no zero_ratio is recording, not measured, and not zero", async () => {
    seed("room_u", T10, 30, null);
    seed("room_u", "2026-09-24T04:38:00Z", 10, 1);
    const [r] = await read({ roomId: "room_u" });
    expect(r).toMatchObject({ recording_buckets: 40, measured_buckets: 10, exact_zero_buckets: 10 });
    expect(classifyHour(r).state, "10 measured buckets is under the floor").toBe("insufficient");
  });

  it("a sample with a NULL zero_ratio does not break a bucket that has a reporting one", async () => {
    pg.exec(`INSERT INTO bench_level_sample (room_id, ist_date, sampled_at, zero_ratio, session_open, tape_advancing) VALUES
      ('room_n', '2026-09-24', '${T10}'::timestamptz + interval '1 second', NULL, true, true),
      ('room_n', '2026-09-24', '${T10}'::timestamptz + interval '2 seconds', 1, true, true);`);
    const [r] = await read({ roomId: "room_n" });
    expect(r).toMatchObject({ recording_buckets: 1, measured_buckets: 1, exact_zero_buckets: 1 });
  });

  it("only RECORDING buckets count: a room that is listening but not recording, or whose tape is not advancing, is excluded from every count", async () => {
    seed("room_r", T10, 50, 1, { open: false });
    seed("room_r", "2026-09-24T04:44:00Z", 50, 1, { adv: false });
    seed("room_r", "2026-09-24T04:58:00Z", 30, 1);
    const [r] = await read({ roomId: "room_r" });
    expect(r).toMatchObject({ recording_buckets: 30, measured_buckets: 30, exact_zero_buckets: 30 });
  });

  it("hours are IST: a bucket at 00:05 IST (18:35Z) is in the hour starting 18:30Z, and the neighbouring IST hours stay separate", async () => {
    seed("room_h", "2026-09-24T18:35:00Z", 4, 1);                    // 00:05 IST on the 25th
    seed("room_h", "2026-09-24T18:25:00Z", 4, 1);                    // 23:55 IST on the 24th
    const rows = await read({ roomId: "room_h" });
    expect(rows.map((r) => r.hour_start)).toEqual(["2026-09-24T17:30:00.000Z", "2026-09-24T18:30:00.000Z"]);
    expect(rows.map((r) => r.recording_buckets)).toEqual([4, 4]);
  });

  it("rooms stay separate, roomId narrows, the window is [since, until), and a room with nothing recorded returns no row", async () => {
    seed("room_a", T10, 30, 1);
    seed("room_b", T10, 30, 0.1);
    const both = await read();
    expect(both.map((r) => [r.room_id, r.exact_zero_buckets])).toEqual([["room_a", 30], ["room_b", 0]]);
    expect((await read({ roomId: "room_b" })).map((r) => r.room_id)).toEqual(["room_b"]);
    expect(await read({ roomId: "room_none" })).toEqual([]);
    const until = Date.parse(T10) + 60_000;                          // exclusive: the first four buckets only
    const [w] = await read({ roomId: "room_a", untilMs: until });
    expect(w.recording_buckets).toBe(4);
    expect(await read({ roomId: "room_a", sinceMs: until + 3_600_000 })).toEqual([]);
  });

  it("READ-ONLY: it changes nothing", async () => {
    seed("room_a", T10, 30, 1);
    const before = ((await pg.sql`SELECT count(*)::int AS n FROM bench_level_sample`) as Array<{ n: number }>)[0].n;
    await read();
    await read({ roomId: "room_a" });
    const after = ((await pg.sql`SELECT count(*)::int AS n FROM bench_level_sample`) as Array<{ n: number }>)[0].n;
    expect(after).toBe(before);
  });
});
