/** lib/rooms-live/state.ts — the six states, every SPEC-v1 §3 fixture, and the edges around them. */
import { describe, it, expect } from "vitest";
import { computeState, sinceOfRun, type LevelRow, type StateInput } from "@/lib/rooms-live/state";

const NOW = Date.parse("2026-10-07T10:00:00Z");
const S = 1000;
const known = { listener: true, install: true, session: true, heartbeat: true, ext: true, levels: true };

/** n rows ending at NOW, one every 2.3 s, value from fn(i) (i = 0 is the newest) */
const rows = (n: number, fn: (i: number) => { rms: number; zero?: number }): LevelRow[] =>
  Array.from({ length: n }, (_, k) => {
    const i = n - 1 - k;
    const v = fn(i);
    return { t: NOW - Math.round(i * 2300), rms: v.rms, zero: v.zero ?? 0.001 };
  });
/** jittered ambient around `mid` so no two rows are identical */
const ambient = (n: number, mid: number): LevelRow[] => rows(n, (i) => ({ rms: mid * (1 + ((i % 7) - 3) * 0.04), zero: 0.001 + (i % 3) * 0.0004 }));

function input(over: Partial<StateInput> = {}): StateInput {
  const lv = over.levels ?? ambient(200, 0.01);
  const newest = lv.length ? [...lv].sort((a, b) => b.t - a.t)[0]! : null;
  return {
    now: NOW,
    listener: { last_poll_at: NOW - 1 * S, levels_at: newest ? newest.t : NOW - 1 * S, rms: newest?.rms ?? null, zero: newest?.zero ?? null },
    install: { flags: [], state_changed_at: null, input_device_name: "C270 HD WEBCAM", input_devices: ["C270 HD WEBCAM"] },
    session: { open: true, since: NOW - 3_600_000, chunk_age_s: 60 },
    heartbeat_at: NOW - 20 * S,
    ext_at: NOW - 20 * S,
    levels: lv,
    steward: null,
    known: { ...known },
    ...over,
  };
}

describe("SPEC fixtures", () => {
  it("OPD 4 06:56 UTC frozen tail (zero .73 identical for 20 min, DEVICE_MISSING) -> unplugged, since = state_changed_at", () => {
    const frozen = rows(500, () => ({ rms: 0.0164, zero: 0.73 }));
    const changed = NOW - 20 * 60_000;
    const r = computeState(input({ levels: frozen, install: { flags: ["DEVICE_MISSING", "ENCODER_STALLED"], state_changed_at: changed, input_device_name: "C270 HD WEBCAM", input_devices: [] } }));
    expect(r.state).toBe("unplugged");
    expect(r.state_since).toBe(changed);
    expect(r.device.missing).toBe(true);
    expect(r.level.stale).toBe(true); // the frozen tail is stale, and it never became "quiet"
  });
  it("OPD 3 zero 1.000 (TM20, digital silence) -> muted", () => {
    const r = computeState(input({ levels: rows(120, () => ({ rms: 0, zero: 1 })) }));
    expect(r.state).toBe("muted");
    expect(r.level.stale).toBe(false); // an identical (0, 1.0) pair is legitimate digital silence
    expect(r.state_since).not.toBeNull();
  });
  it("zero 0.967 with a live peak (FIX-1 F3b): NOT silent below 0.995, however long it lasts -> quiet", () => {
    const r = computeState(input({ levels: rows(300, (i) => ({ rms: 0.01 + (i % 3) * 0.001, zero: 0.967 })) }));
    expect(r.state).toBe("quiet");
  });
  it("C270 ambient rms 0.010 with p25 0.009 -> quiet", () => {
    const r = computeState(input({ levels: rows(200, (i) => ({ rms: i < 4 ? [0.0100, 0.0102, 0.0098, 0.0101][i]! : [0.0085, 0.009, 0.0105, 0.0105][i % 4]!, zero: 0.001 })) }));
    expect(r.baseline_rms).toBeCloseTo(0.0085, 4); // v1.4: p10 (0.0085), not p25 (0.009)
    expect(r.state).toBe("quiet");
  });
  it("speech rms 0.035 -> listening", () => {
    const lv = rows(200, (i) => ({ rms: i < 6 ? 0.035 + i * 0.001 : 0.009 + (i % 5) * 0.0005, zero: 0.001 }));
    expect(computeState(input({ levels: lv })).state).toBe("listening");
  });
  it("TM20 room p25 0.10: rms 0.11 -> quiet, rms 0.30 -> listening", () => {
    const base = (hi: number) => rows(200, (i) => ({ rms: i < 6 ? hi + i * 0.0007 : 0.10 + (i % 5) * 0.004, zero: 0 }));
    const q = computeState(input({ levels: base(0.11) }));
    expect(q.baseline_rms).toBeGreaterThan(0.09);
    expect(q.baseline_rms).toBeLessThan(0.11);
    expect(q.state).toBe("quiet");
    expect(computeState(input({ levels: base(0.30) })).state).toBe("listening");
  });
  it("everything stale -> off", () => {
    const r = computeState(input({ listener: { last_poll_at: NOW - 60 * S, levels_at: NOW - 60 * S, rms: 0.01, zero: 0 }, heartbeat_at: NOW - 600 * S, ext_at: null, levels: [] }));
    expect(r.state).toBe("off");
  });
  it("listener fresh, no session -> notrec", () => {
    expect(computeState(input({ session: { open: false, since: null, chunk_age_s: null } })).state).toBe("notrec");
  });
  it("listener says rec=true but the server has no session -> notrec (server truth wins)", () => {
    const r = computeState(input({ session: { open: false, since: null, chunk_age_s: null } }));
    expect(r.state).toBe("notrec");
    expect(r.detail_code).toBeNull();
  });
});

describe("rule order and edges", () => {
  it("off needs ALL three stale: a fresh heartbeat or a fresh ext event keeps the room 'not recording / app not responding'", () => {
    const stale = { last_poll_at: NOW - 30 * S, levels_at: NOW - 30 * S, rms: 0.01, zero: 0 };
    expect(computeState(input({ listener: stale, heartbeat_at: NOW - 100 * S, ext_at: NOW - 900 * S })).detail_code).toBe("app_not_responding");
    expect(computeState(input({ listener: stale, heartbeat_at: NOW - 900 * S, ext_at: NOW - 100 * S })).state).toBe("notrec");
    expect(computeState(input({ listener: stale, heartbeat_at: NOW - 181 * S, ext_at: NOW - 181 * S })).state).toBe("off");
    expect(computeState(input({ listener: stale, heartbeat_at: NOW - 180 * S, ext_at: NOW - 181 * S })).state).toBe("notrec");
  });
  it("listener age exactly 10 s is fresh, 10.1 s is stale", () => {
    const at = (age: number) => computeState(input({ listener: { last_poll_at: NOW - age, levels_at: NOW - 1000, rms: 0.01, zero: 0.001 } })).state;
    expect(at(10_000)).toBe("quiet");
    expect(at(10_100)).toBe("notrec"); // stale listener, fresh heartbeat: app_not_responding
  });
  it("unplugged by the device list alone (no flag), and only while the listener is fresh", () => {
    const inst = { flags: [], state_changed_at: null, input_device_name: "TONOR TM20", input_devices: ["C270 HD WEBCAM"] };
    expect(computeState(input({ install: inst })).state).toBe("unplugged");
    expect(computeState(input({ install: { ...inst, input_devices: null } })).state).not.toBe("unplugged"); // an app that does not report devices says nothing
    expect(computeState(input({ install: inst, listener: { last_poll_at: NOW - 30 * S, levels_at: NOW - 30 * S, rms: 0.01, zero: 0 }, heartbeat_at: NOW - 900 * S, ext_at: NOW - 900 * S })).state).toBe("off");
  });
  it("unplugged beats not-recording and muted", () => {
    expect(computeState(input({ session: { open: false, since: null, chunk_age_s: null }, install: { flags: ["DEVICE_MISSING"], state_changed_at: NOW - 5000, input_device_name: "x", input_devices: [] } })).state).toBe("unplugged");
  });
  it("muted by the recorder's own SILENT_WHILE_RECORDING flag", () => {
    expect(computeState(input({ install: { flags: ["SILENT_WHILE_RECORDING"], state_changed_at: null, input_device_name: "a", input_devices: ["a"] } })).state).toBe("muted");
  });
  it("FIX-1 F3b boundary: zero >= 0.995 must be sustained for >= 60 s; 57 s of it is still Quiet; 63 s is Mic silent", () => {
    const base = ambient(100, 0.01).map((x) => ({ ...x, t: x.t - 400_000 }));
    const run = (seconds: number, z: number) => {
      const n = Math.floor((seconds * 1000) / 2300);
      return [...base, ...rows(n + 1, (i) => ({ rms: (z >= 0.995 ? 0.005 : 0.01) + (i % 3) * 0.0004, zero: z }))];
    };
    const at = (seconds: number, z: number) => computeState(input({ levels: run(seconds, z) }));
    expect(at(63, 0.995).state).toBe("muted");
    expect(at(63, 1).state).toBe("muted");
    expect(at(57, 0.995).state).toBe("quiet");
    expect(at(10, 1).state).toBe("quiet");
    expect(at(600, 0.994).state).toBe("quiet");     // 0.994 never counts, however long
    expect(at(600, 0.95).state).toBe("quiet");
  });
  it("exactly 60.000 s of an unbroken run is Mic silent; 59.999 s is not", () => {
    const base = ambient(60, 0.01).map((x) => ({ ...x, t: x.t - 300_000 }));
    const mk = (spanMs: number) => {
      const lv = [...base];
      for (let t = NOW - spanMs; t <= NOW; t += 2000) lv.push({ t, rms: 0, zero: 1 });
      if (lv[lv.length - 1]!.t !== NOW) lv.push({ t: NOW, rms: 0, zero: 1 });
      return computeState(input({ levels: lv })).state;
    };
    expect(mk(60_000)).toBe("muted");
    expect(mk(59_999)).toBe("quiet");
  });
  it("a run broken by one non-silent row starts again: 90 s of silence, one speech row, then 20 s of silence -> Quiet/Listening, not Mic silent", () => {
    const lv = [...ambient(60, 0.01).map((x) => ({ ...x, t: x.t - 200_000 })), ...rows(40, (i) => (i === 9 ? { rms: 0.012, zero: 0.002 } : { rms: 0, zero: 1 }))];
    const r = computeState(input({ levels: lv }));
    expect(["quiet", "listening"]).toContain(r.state);
    expect(r.state_since === null || r.state_since >= NOW - 10 * 2300).toBe(true);
  });
  it("a stale silence (newest row older than 15 s) is not 'Mic silent'", () => {
    const lv = rows(120, () => ({ rms: 0, zero: 1 })).map((x) => ({ ...x, t: x.t - 20_000 }));
    const r = computeState(input({ levels: lv, listener: { last_poll_at: NOW - 1000, levels_at: NOW - 20_000, rms: 0, zero: 1 } }));
    expect(r.state).not.toBe("muted");
  });
  it("a frozen non-silent level is stale and never yields quiet/listening: notrec + level_stale", () => {
    const r = computeState(input({ levels: rows(60, () => ({ rms: 0.0125, zero: 0 })) }));
    expect(r.state).toBe("notrec");
    expect(r.detail_code).toBe("level_stale");
    expect(r.level.stale).toBe(true);
  });
  it("a level older than 6 s is stale; 6.0 s is not", () => {
    const lv = ambient(200, 0.01).map((x) => ({ ...x, t: x.t - 6000 }));
    const mk = (age: number) => computeState(input({ levels: lv, listener: { last_poll_at: NOW - 1000, levels_at: NOW - age, rms: lv[lv.length - 1]!.rms, zero: 0.001 } }));
    expect(mk(6000).level.stale).toBe(false);
    expect(mk(6100).level.stale).toBe(true);
  });
  it("a single loud row (>= 2.0 x baseline) in the last 20 s makes it listening even when the mean is low", () => {
    const lv = rows(200, (i) => ({ rms: i === 2 ? 0.0235 : 0.009 + (i % 5) * 0.0003, zero: 0.001 }));
    const r = computeState(input({ levels: lv }));
    expect(r.baseline_rms).toBeCloseTo(0.0093, 3);
    expect(r.state).toBe("listening");
  });
  it("a near-silent mic (baseline ~0.003, zero 0.84) is quiet, not 'listening': the spike rule never goes below the 0.008 floor", () => {
    const lv = rows(200, (i) => ({ rms: 0.0025 + (i % 4) * 0.0004, zero: 0.84 + (i % 3) * 0.01 }));
    const r = computeState(input({ levels: lv }));
    expect(r.baseline_rms).toBeLessThan(0.004);
    expect(r.state).toBe("quiet");
  });
  // v1.3: speech 2-4 dB over the floor. Rows are 2.3 s apart, so the last 20 s is i = 0..8.
  const shaped = (base: number, tailFn: (i: number) => { rms: number; zero?: number }, n = 200) =>
    // zero_ratio is jittered so the series is not a "frozen" repeat of one (rms, zero) pair
    rows(n, (i) => {
      const v = i <= 8 ? tailFn(i) : { rms: base * (1 + ((i % 5) - 2) * 0.002), zero: 0.001 };
      return { rms: v.rms, zero: (v.zero ?? 0.001) < 0.5 ? (v.zero ?? 0.001) + (i % 3) * 0.0004 : v.zero };
    });
  it("v1.3 OPD 7 shape: baseline 0.0081, 20 s alternating 0.0081 / 0.0110 / 0.0125 / 0.0090 -> listening", () => {
    const lv = shaped(0.0081, (i) => ({ rms: [0.0081, 0.0110, 0.0125, 0.0090][i % 4]!, zero: 0.001 }));
    const r = computeState(input({ levels: lv }));
    expect(r.baseline_rms).toBeCloseTo(0.0081, 3);
    expect(r.state).toBe("listening");
    expect(r.state_since).not.toBeNull();
    expect(r.state_since!).toBeGreaterThanOrEqual(NOW - 20 * S);
  });
  it("v1.3 OPD 3 silent shape: baseline 0.0088, 20 s of rows 0.0084-0.0092 -> quiet", () => {
    const lv = shaped(0.0088, (i) => ({ rms: 0.0084 + (i % 3) * 0.0004, zero: 0.001 }));
    const r = computeState(input({ levels: lv }));
    expect(r.baseline_rms).toBeCloseTo(0.0088, 3);
    expect(r.state).toBe("quiet");
  });
  it("v1.3 a single spike 0.020 on baseline 0.009 -> listening", () => {
    const lv = shaped(0.009, (i) => ({ rms: i === 5 ? 0.020 : 0.009, zero: 0.001 }));
    expect(computeState(input({ levels: lv })).state).toBe("listening");
  });
  it("v1.3 two rows >= 1.25x only -> quiet; the third makes it listening", () => {
    const two = shaped(0.009, (i) => ({ rms: i === 1 || i === 6 ? 0.0125 : 0.009, zero: 0.001 }));
    expect(computeState(input({ levels: two })).state).toBe("quiet");
    const three = shaped(0.009, (i) => ({ rms: i === 1 || i === 4 || i === 6 ? 0.0125 : 0.009, zero: 0.001 }));
    expect(computeState(input({ levels: three })).state).toBe("listening");
  });
  it("v1.3 mute rows (zero >= 0.995 or rms < 0.002) never count toward the 3", () => {
    const lv = shaped(0.009, (i) => (i === 1 ? { rms: 0.0125 } : i === 4 ? { rms: 0.0125, zero: 0.999 } : i === 6 ? { rms: 0.0015 } : { rms: 0.009 }));
    expect(computeState(input({ levels: lv })).state).toBe("quiet");
    // a muted row that is also loud must not trigger the spike rule
    const spike = shaped(0.009, (i) => (i === 3 ? { rms: 0.05, zero: 0.999 } : { rms: 0.009 }));
    expect(computeState(input({ levels: spike })).state).toBe("quiet");
  });
  it("v1.3 rows older than 20 s do not count", () => {
    const lv = shaped(0.009, () => ({ rms: 0.009 })).map((r, k, a) => (k >= a.length - 14 && k < a.length - 10 ? { ...r, rms: 0.0125 } : r));
    expect(computeState(input({ levels: lv })).state).toBe("quiet");
  });
  it("v1.3 no baseline (< 30 rows): mean 0.0085 -> listening, mean 0.0075 -> quiet, no spike rule", () => {
    expect(computeState(input({ levels: rows(10, (i) => ({ rms: 0.0085, zero: 0.001 + (i % 3) * 0.0004 })) })).state).toBe("listening");
    expect(computeState(input({ levels: rows(10, (i) => ({ rms: 0.0075, zero: 0.001 + (i % 3) * 0.0004 })) })).state).toBe("quiet");
    expect(computeState(input({ levels: rows(10, (i) => ({ rms: i === 2 ? 0.03 : 0.002 + (i % 2) * 0.0005, zero: 0.001 + (i % 3) * 0.0004 })) })).state).toBe("quiet");
  });
  it("the floor 0.008 applies when there is no baseline yet (fewer than 30 rows)", () => {
    const lv = rows(10, (i) => ({ rms: 0.005 + i * 0.0002, zero: 0.001 }));
    const r = computeState(input({ levels: lv }));
    expect(r.baseline_rms).toBeNull();
    expect(r.state).toBe("quiet");
    expect(computeState(input({ levels: rows(10, (i) => ({ rms: 0.012 + i * 0.0002, zero: 0.001 })) })).state).toBe("listening");
  });
  it("source failures are 'unknown', never a guess: listener/install/session unreadable, or heartbeat/ext unreadable with a stale listener", () => {
    expect(computeState(input({ known: { ...known, session: false } })).state).toBe("unknown");
    expect(computeState(input({ known: { ...known, listener: false } })).state).toBe("unknown");
    const stale = { last_poll_at: NOW - 60 * S, levels_at: NOW - 60 * S, rms: 0.01, zero: 0 };
    expect(computeState(input({ listener: stale, heartbeat_at: null, ext_at: null, known: { ...known, heartbeat: false } })).state).toBe("unknown");
    expect(computeState(input({ known: { ...known, heartbeat: false, ext: false } })).state).not.toBe("unknown"); // fresh listener does not need them
  });
  it("level history unreadable and too few rows -> unknown (levels_unavailable)", () => {
    const r = computeState(input({ levels: [], listener: { last_poll_at: NOW - 1000, levels_at: NOW - 1000, rms: 0.01, zero: 0.001 }, known: { ...known, levels: false } }));
    expect(r.state).toBe("unknown");
    expect(r.detail_code).toBe("levels_unavailable");
  });
  it("Steward overlay: a live scribe_start within 10 min -> detail restarting on a not-recording room; shadow, old or other actions do nothing", () => {
    const nr = { session: { open: false, since: null, chunk_age_s: null } };
    expect(computeState(input({ ...nr, steward: { action: "scribe_start", mode: "live", at: NOW - 9 * 60_000 } })).detail_code).toBe("restarting");
    expect(computeState(input({ ...nr, steward: { action: "scribe_start", mode: "live", at: NOW - 11 * 60_000 } })).detail_code).toBeNull();
    expect(computeState(input({ ...nr, steward: { action: "scribe_start", mode: "shadow", at: NOW - 60_000 } })).detail_code).toBeNull();
    expect(computeState(input({ ...nr, steward: { action: "scribe_restart", mode: "live", at: NOW - 60_000 } })).detail_code).toBeNull();
  });
  it("state_since: the start of the unbroken run of matching rows", () => {
    const lv = [...ambient(60, 0.01).map((x) => ({ ...x, t: x.t - 400_000 })), ...rows(40, (i) => ({ rms: 0, zero: 1 - i * 0.0001 }))];
    const r = computeState(input({ levels: lv }));
    expect(r.state).toBe("muted");
    expect(r.state_since).toBe(NOW - 39 * 2300);
    expect(sinceOfRun([], () => true)).toBeNull();
    expect(sinceOfRun([{ t: 1, rms: 0, zero: 0 }], () => false)).toBeNull();
  });
});

describe("v1.1: a dead input is silent by peak as well as by zero_ratio", () => {
  const base = () => ambient(60, 0.01).map((x) => ({ ...x, t: x.t - 300_000 }));
  const tail = (spanMs: number, fn: (t: number, k: number) => { rms: number; zero: number }) => {
    const lv: LevelRow[] = base();
    let k = 0;
    for (let t = NOW - spanMs; t <= NOW; t += 2000, k++) lv.push({ t, ...fn(t, k) });
    if (lv[lv.length - 1]!.t !== NOW) lv.push({ t: NOW, ...fn(NOW, k) });
    return lv;
  };
  it("OPD 5-shaped (peak 0..0.001, zero_ratio 0.98-1.0 for 90 s, doctor consulting) -> Mic silent", () => {
    const lv = tail(90_000, (_t, k) => ({ rms: (k % 3) * 0.0005, zero: 0.98 + (k % 5) * 0.005 }));
    const r = computeState(input({ levels: lv }));
    expect(r.state).toBe("muted");
    expect(r.level.stale).toBe(false);
    expect(r.state_since).not.toBeNull();
  });
  it("OPD 5-shaped with a changing-by-nothing pair (peak 0.001, zero 0.99 repeated) is silence, not a frozen level", () => {
    const r = computeState(input({ levels: tail(90_000, () => ({ rms: 0.001, zero: 0.99 })) }));
    expect(r.state).toBe("muted");
    expect(r.level.stale).toBe(false);
  });
  it("OPD 7-shaped (peak 0.008 steady, zero 0.0002) all day -> Quiet", () => {
    const lv = rows(400, (i) => ({ rms: 0.008 + (i % 3) * 0.0001, zero: 0.0002 }));
    expect(computeState(input({ levels: lv })).state).toBe("quiet");
  });
  it("boundary: peak 0.0019 for 90 s -> Mic silent; peak 0.0021 (zero 0.5) for 90 s -> Quiet", () => {
    expect(computeState(input({ levels: tail(90_000, (_t, k) => ({ rms: 0.0019 + (k % 2) * 0.00001, zero: 0.5 })) })).state).toBe("muted");
    expect(computeState(input({ levels: tail(90_000, (_t, k) => ({ rms: 0.0021 + (k % 2) * 0.00001, zero: 0.5 })) })).state).toBe("quiet");
  });
  it("run length: 59 s of silent peaks -> Quiet; 61 s -> Mic silent", () => {
    expect(computeState(input({ levels: tail(59_000, () => ({ rms: 0.0005, zero: 0.9 })) })).state).toBe("quiet");
    expect(computeState(input({ levels: tail(61_000, () => ({ rms: 0.0005, zero: 0.9 })) })).state).toBe("muted");
  });
  it("one live row inside the run breaks it", () => {
    const lv = tail(90_000, (t) => (t === NOW - 30_000 ? { rms: 0.02, zero: 0.001 } : { rms: 0.0005, zero: 0.9 }));
    expect(computeState(input({ levels: lv })).state).not.toBe("muted");
  });
});

describe("v1.4: baseline is p10 over 45 min, minus the rows the rule calls loud", () => {
  const MIN = 60_000;
  /** a series ending at NOW, one row every 2.3 s over `spanMin` minutes; fn(ageS) gives the row */
  const series = (spanMin: number, fn: (ageS: number) => number): LevelRow[] => {
    const n = Math.floor((spanMin * 60) / 2.3);
    return Array.from({ length: n }, (_, i) => ({ t: NOW - Math.round(i * 2300), rms: fn(i * 2.3), zero: 0.001 + (i % 3) * 0.0004 })).reverse();
  };
  const jit = (mid: number, i: number) => mid * (1 + ((Math.round(i) % 7) - 3) * 0.02);

  it("10 min of a 0.009 floor then 30 min of speech at 1.3-1.6x it stays listening", () => {
    const lv = series(40, (age) => (age <= 30 * 60 ? 0.009 * (1.3 + ((Math.round(age) % 4) * 0.1)) : jit(0.009, age)));
    const r = computeState(input({ levels: lv }));
    expect(r.baseline_rms).toBeLessThan(0.0095);
    expect(r.baseline_rms).toBeGreaterThan(0.0084);
    expect(r.state).toBe("listening");
    expect(lv[lv.length - 1]!.t).toBe(NOW);
    expect(NOW - lv[0]!.t).toBeGreaterThan(39 * MIN);
  });
  it("floor-only rows (45 min at 0.009) stay quiet", () => {
    const r = computeState(input({ levels: series(45, (age) => jit(0.009, age)) }));
    expect(r.state).toBe("quiet");
    expect(r.baseline_rms).toBeGreaterThan(0.0082); // p10 of +-6 % jitter around 0.009
    expect(r.baseline_rms).toBeLessThan(0.0095);
  });
  it("Dietary-shaped series (floor 0.0195): 3 rows >= 0.0244 in 20 s reads listening; 2 such rows reads quiet", () => {
    const base = (hot: number[]) => series(45, (age) => (hot.some((h) => Math.abs(age - h) < 1.1) ? 0.0250 : jit(0.0195, age)));
    const on = computeState(input({ levels: base([0, 4.6, 9.2]) }));
    expect(on.baseline_rms).toBeGreaterThan(0.0178);
    expect(on.baseline_rms).toBeLessThan(0.0200);
    expect(on.state).toBe("listening");
    expect(computeState(input({ levels: base([0, 4.6]) })).state).toBe("quiet");
  });
  it("speech that fills the whole 45 min cannot drag the floor to itself: baseline stays at the quiet end", () => {
    // 75 % of rows are speech at 1.4 x 0.009; p10 of all rows is still the floor rows
    const lv = series(45, (age) => (age % 8 < 2 ? jit(0.009, age) : 0.009 * 1.4));
    const r = computeState(input({ levels: lv }));
    expect(r.baseline_rms).toBeLessThan(0.0095);
    expect(r.state).toBe("listening");
  });
  it("the window is exactly 45 min: 0-15 min at 0.020, 15-45 min at 0.012, 45-90 min at 0.009 -> baseline ~0.012 (a 15-min window sees 0.020, a 90-min window sees 0.009)", () => {
    const lv = series(90, (age) => (age <= 15 * 60 ? jit(0.020, age) : age <= 45 * 60 ? jit(0.012, age) : jit(0.009, age)));
    const b = computeState(input({ levels: lv })).baseline_rms!;
    expect(b).toBeGreaterThan(0.0105);
    expect(b).toBeLessThan(0.0125);
  });
  it("the second pass matters: 8 % floor rows, 12 % at 1.22x, 80 % speech at 2.2x -> the baseline is the floor (~0.0087); one pass alone would give ~0.0104", () => {
    const lv = series(45, (age) => {
      const k = Math.round(age / 2.3) % 25;
      return k < 2 ? jit(0.009, age) : k < 5 ? jit(0.011, age) : jit(0.020, age);
    });
    const b = computeState(input({ levels: lv })).baseline_rms!;
    expect(b).toBeLessThan(0.0095);
  });
  it("the limit (R1): continuous speech over ~95 % of the 45 min still raises the floor to the speech level", () => {
    const lv = series(45, (age) => {
      const k = Math.round(age / 2.3) % 20;
      return k === 0 ? jit(0.009, age) : 0.009 * (1.3 + ((Math.round(age) % 4) * 0.1));
    });
    expect(computeState(input({ levels: lv })).baseline_rms!).toBeGreaterThan(0.0110);
  });
});
