/**
 * DRAFT (Fable ruling 345) — the hourly NEAR-SILENCE alarm's rules, pinned. The module is inert (nothing calls it), so these tests are the whole behaviour.
 * Pure rules first; then the SQL against a REAL postgres, because "IST hours are 05:30 ahead of UTC", "both floors count the same rows" and "only capturing
 * samples count" are properties of the query, not of a mock.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const H = vi.hoisted(() => ({ sql: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>) }));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => H.sql!(s, ...v) }));

import {
  ALARM_SHARE, DEFAULT_THRESHOLDS, FLOOR_WORDING, HOUR_MS, LOOSE_FLOOR_PEAK, MIN_SAMPLES, RENOTICE_AFTER_MS,
  classifyHour, groupEpisodes, nearSilenceMessage, readNearSilenceHours, renoticeDue, unknownRooms,
} from "@/lib/near-silence-alarm";

const HAVE_DOCKER = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-near-silence-alarm");

describe("REQUIRED PROOF — the near-silence alarm's query runs against a real postgres", () => {
  it("ran, or was skipped deliberately", () => {
    if (HAVE_DOCKER || ALLOW_SKIP) return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/near-silence-alarm.test.ts needs Docker for postgres:16. Start Docker, or set ETA_ALLOW_SKIP_E2E=1 to accept that it was not proven.");
  });
});

const h = (samples: number, zero_samples: number, loose_samples: number) => ({ samples, zero_samples, loose_samples });

describe("classifyHour — the decision", () => {
  it("the constants are the proposed, shadow ones", () => {
    expect(MIN_SAMPLES).toBe(100);
    expect(ALARM_SHARE).toBe(0.1);
    expect(LOOSE_FLOOR_PEAK).toBe(0.001);
    expect(DEFAULT_THRESHOLDS).toEqual({ minSamples: 100, alarmShare: 0.1 });
  });

  it("below the sample floor an hour is INSUFFICIENT, never ok, even when it is entirely near-silent or entirely healthy", () => {
    expect(classifyHour(h(99, 99, 99), "zero").state).toBe("insufficient");
    expect(classifyHour(h(99, 0, 0), "zero").state).toBe("insufficient");
    expect(classifyHour(h(0, 0, 0), "zero")).toEqual({ state: "insufficient", share: null, near_silent_samples: 0, samples: 0 });
  });

  it("at the floor it is judged: share exactly 0.10 alarms, 0.099 does not", () => {
    expect(classifyHour(h(100, 10, 10), "zero").state).toBe("alarm");
    expect(classifyHour(h(1000, 99, 99), "zero").state).toBe("ok");
    expect(classifyHour(h(1000, 100, 100), "zero").state).toBe("alarm");
    expect(classifyHour(h(100, 9, 9), "zero").state).toBe("ok");
  });

  it("the two floors read different columns: the same hour can alarm at 'loose' and not at 'zero'", () => {
    const hour = h(1000, 20, 300);                                   // 2 % exactly zero, 30 % under 0.001
    expect(classifyHour(hour, "zero")).toEqual({ state: "ok", share: 0.02, near_silent_samples: 20, samples: 1000 });
    expect(classifyHour(hour, "loose")).toEqual({ state: "alarm", share: 0.3, near_silent_samples: 300, samples: 1000 });
  });

  it("MALFORMED counts are insufficient, never a silent ok (negative, non-finite, zero above loose, loose above samples)", () => {
    for (const bad of [h(-1, 0, 0), h(500, -1, 0), h(500, 0, -1), h(500, 5, 4), h(500, 0, 501), h(NaN, 0, 0), h(500, Infinity, Infinity)]) {
      expect(classifyHour(bad, "zero").state, JSON.stringify(bad)).toBe("insufficient");
      expect(classifyHour(bad, "loose").state, JSON.stringify(bad)).toBe("insufficient");
    }
  });

  it("thresholds are parameters, not constants baked into the decision", () => {
    expect(classifyHour(h(50, 30, 30), "zero", { minSamples: 40, alarmShare: 0.5 }).state).toBe("alarm");
    expect(classifyHour(h(50, 30, 30), "zero", { minSamples: 60, alarmShare: 0.5 }).state).toBe("insufficient");
  });
});

const T = Date.parse("2026-09-24T04:30:00Z");                        // 10:00 IST
const hr = (room_id: string, k: number, state: "ok" | "alarm" | "insufficient") => ({ room_id, hour_start_ms: T + k * HOUR_MS, state });

describe("groupEpisodes — one message per episode", () => {
  it("consecutive alarming hours are ONE episode; an ok hour closes it (recovered); a later alarm is a NEW episode", () => {
    const eps = groupEpisodes([hr("a", 0, "alarm"), hr("a", 1, "alarm"), hr("a", 2, "ok"), hr("a", 3, "alarm")]);
    expect(eps).toEqual([
      { room_id: "a", start_ms: T, last_alarm_hour_ms: T + HOUR_MS, alarming_hours: 2, recovered_at_ms: T + 2 * HOUR_MS },
      { room_id: "a", start_ms: T + 3 * HOUR_MS, last_alarm_hour_ms: T + 3 * HOUR_MS, alarming_hours: 1, recovered_at_ms: null },
    ]);
  });

  it("an INSUFFICIENT hour, or a missing hour, HOLDS an open episode open: absence of evidence is not recovery", () => {
    const eps = groupEpisodes([hr("a", 0, "alarm"), hr("a", 1, "insufficient"), hr("a", 3, "alarm")]);   // hour 2 has no row at all
    expect(eps).toEqual([{ room_id: "a", start_ms: T, last_alarm_hour_ms: T + 3 * HOUR_MS, alarming_hours: 2, recovered_at_ms: null }]);
  });

  it("an ok hour with no open episode does nothing; insufficient never starts one", () => {
    expect(groupEpisodes([hr("a", 0, "ok"), hr("a", 1, "insufficient")])).toEqual([]);
  });

  it("rooms are independent, and input order does not matter", () => {
    const a = groupEpisodes([hr("b", 1, "alarm"), hr("a", 2, "ok"), hr("a", 0, "alarm"), hr("b", 0, "alarm")]);
    expect(a.map((e) => [e.room_id, e.start_ms, e.alarming_hours, e.recovered_at_ms])).toEqual([["a", T, 1, T + 2 * HOUR_MS], ["b", T, 2, null]]);
  });
});

describe("renoticeDue, unknownRooms and the message", () => {
  it("an open episode is re-announced only after 3 h; a recovered one never", () => {
    expect(RENOTICE_AFTER_MS).toBe(3 * HOUR_MS);
    const open = { recovered_at_ms: null };
    expect(renoticeDue(open, 0, 3 * HOUR_MS - 1)).toBe(false);
    expect(renoticeDue(open, 0, 3 * HOUR_MS)).toBe(true);
    expect(renoticeDue({ recovered_at_ms: 5 }, 0, 10 * HOUR_MS)).toBe(false);
  });

  it("a room with no JUDGED hour is UNKNOWN: it produced nothing, or only too few samples, and it is never green", () => {
    const hours = [
      { room_id: "a", hour_start: "2026-09-24T04:30:00.000Z", ...h(500, 0, 0) },
      { room_id: "b", hour_start: "2026-09-24T04:30:00.000Z", ...h(99, 0, 0) },
    ];
    expect(unknownRooms(["a", "b", "c", "c"], hours)).toEqual(["b", "c"]);
    expect(unknownRooms(["a"], hours)).toEqual([]);
  });

  it("the message says NEAR-SILENCE with the dBFS floor and never 'zero' or 'digital silence'; it carries counts and a time, and says what it cannot know", () => {
    const hour = { room_id: "room_x", hour_start: "2026-09-24T04:30:00.000Z", ...h(400, 20, 300) };
    for (const floor of ["zero", "loose"] as const) {
      const m = nearSilenceMessage("OPD 4", hour, floor, classifyHour(hour, floor));
      const all = `${m.subject}\n${m.text}`;
      expect(all).toContain(FLOOR_WORDING[floor]);
      expect(all).toContain("2026-09-24 10:00 IST");
      expect(all).not.toMatch(/zero|digital silence|bit-exact|hardware-mute/i);
      expect(all).toContain("does not say why");
    }
    const loose = nearSilenceMessage("OPD 4", hour, "loose", classifyHour(hour, "loose"));
    expect(loose.text).toContain("300 of 400 level readings");
    expect(loose.text).toContain("(75 %)");
    expect(FLOOR_WORDING.zero).toBe("near-silence (peak below -86 dBFS)");
    expect(FLOOR_WORDING.loose).toBe("near-silence (peak below -60 dBFS)");
  });
});

const seed = (room: string, startIso: string, n: number, peak: number | null, opts: { open?: boolean; adv?: boolean } = {}) => {
  const open = opts.open ?? true;
  const adv = opts.adv ?? true;
  const peakSql = peak === null ? "NULL" : String(peak);
  pg.exec(`
    INSERT INTO bench_level_sample (room_id, ist_date, sampled_at, peak, avg, zero_ratio, session_open, tape_advancing)
    SELECT '${room}', (('${startIso}'::timestamptz) AT TIME ZONE 'Asia/Kolkata')::date, ('${startIso}'::timestamptz) + (g * interval '3 seconds'),
           ${peakSql}, 0.05, NULL, ${open}, ${adv}
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
  readNearSilenceHours({ roomId: o.roomId, sinceMs: o.sinceMs ?? Date.parse("2026-09-24T00:00:00Z"), untilMs: o.untilMs ?? Date.parse("2026-09-26T00:00:00Z") });

describe.runIf(HAVE_DOCKER)("readNearSilenceHours — the definitions, against a real postgres", () => {
  it("counts samples, exact-zero samples and under-0.001 samples per room and IST hour; the loose floor includes every zero sample", async () => {
    seed("room_a", T10, 100, 0.01);                                  // healthy
    seed("room_a", "2026-09-24T04:36:00Z", 30, 0);                   // exactly zero
    seed("room_a", "2026-09-24T04:38:00Z", 50, 0.0004);              // under 0.001 but not zero
    const rows = await read({ roomId: "room_a" });
    expect(rows).toEqual([{ room_id: "room_a", hour_start: "2026-09-24T04:30:00.000Z", samples: 180, zero_samples: 30, loose_samples: 80 }]);
    expect(classifyHour(rows[0], "zero").state).toBe("alarm");        // 30/180 = 0.167
    expect(classifyHour(rows[0], "loose").state).toBe("alarm");       // 80/180 = 0.44
  });

  it("the line for 'loose' is 0.001: 0.00099 is under it, 0.001 and 0.0011 are not", async () => {
    seed("room_l", T10, 10, 0.00099);
    seed("room_l", "2026-09-24T04:33:00Z", 10, 0.001);
    seed("room_l", "2026-09-24T04:36:00Z", 10, 0.0011);
    const [r] = await read({ roomId: "room_l" });
    expect(r).toMatchObject({ samples: 30, zero_samples: 0, loose_samples: 10 });
  });

  it("only CAPTURING samples with a peak count: session closed, tape not advancing and NULL peak are all excluded", async () => {
    seed("room_c", T10, 40, 0, { open: false });
    seed("room_c", "2026-09-24T04:34:00Z", 40, 0, { adv: false });
    seed("room_c", "2026-09-24T04:38:00Z", 40, null);
    seed("room_c", "2026-09-24T04:42:00Z", 25, 0);
    const [r] = await read({ roomId: "room_c" });
    expect(r).toMatchObject({ samples: 25, zero_samples: 25, loose_samples: 25 });
  });

  it("hours are IST: a sample at 00:05 IST (18:35Z) is in the hour starting 18:30Z, and the neighbouring IST hours stay separate", async () => {
    seed("room_h", "2026-09-24T18:35:00Z", 4, 0);                    // 00:05 IST on the 25th
    seed("room_h", "2026-09-24T18:25:00Z", 4, 0);                    // 23:55 IST on the 24th
    const rows = await read({ roomId: "room_h" });
    expect(rows.map((r) => r.hour_start)).toEqual(["2026-09-24T17:30:00.000Z", "2026-09-24T18:30:00.000Z"]);
    expect(rows.map((r) => r.samples)).toEqual([4, 4]);
  });

  it("rooms stay separate, roomId narrows, the window is [since, until), and a room with nothing capturing returns no row", async () => {
    seed("room_a", T10, 30, 0);
    seed("room_b", T10, 30, 0.02);
    const both = await read();
    expect(both.map((r) => [r.room_id, r.zero_samples])).toEqual([["room_a", 30], ["room_b", 0]]);
    expect((await read({ roomId: "room_b" })).map((r) => r.room_id)).toEqual(["room_b"]);
    expect(await read({ roomId: "room_none" })).toEqual([]);
    const until = Date.parse(T10) + 30_000;                          // exclusive: the first ten samples only
    const [w] = await read({ roomId: "room_a", untilMs: until });
    expect(w.samples).toBe(10);
    expect(await read({ roomId: "room_a", sinceMs: until + 3_600_000 })).toEqual([]);
  });

  it("READ-ONLY: it changes nothing", async () => {
    seed("room_a", T10, 30, 0);
    const count = async () => ((await pg.sql`SELECT count(*)::int AS n FROM bench_level_sample`) as Array<{ n: number }>)[0].n;
    const before = await count();
    await read();
    await read({ roomId: "room_a" });
    expect(await count()).toBe(before);
  });
});
