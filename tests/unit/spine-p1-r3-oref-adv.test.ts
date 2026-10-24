/** OREF R3 adversarial (Opus refute) — SPINE-P1 R3: acousticDue edges, rotation x hourly acoustic starvation, acoustic key collisions, TS/Python key parity, v3 gone. Synthetic ids only. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { acousticDue, rotateByTick, runProducers, TICK_MS, STOP_AFTER_MS, type RoomDayRef } from "@/lib/spine/producers";
import { acousticKey, toSignals, hashOfSignal } from "@/lib/spine/ingest";
import { FORMATS } from "@/lib/spine/phi-screen";
import { smoothEncounters, type ProbeVerdict } from "@/lib/encounter-clock/smooth";

const ist = (s: string) => Date.parse(`2026-10-22T${s}+05:30`);
const day = (n: number): RoomDayRef => ({ id: `rd_test${n}`, room_id: `room_test${n}`, ist_date: "2026-10-22" });

describe("F2 acousticDue edges (IST)", () => {
  it.each([["12:00:00", true], ["12:14:59.999", true], ["12:15:00", false], ["12:59:59.999", false], ["00:00:00", true], ["05:30:00", false]])("%s -> %s", (t, d) => expect(acousticDue(ist(t))).toBe(d));
  it("the due tick is the UTC :30 cron tick, i.e. tick index = 2 mod 4", () => {
    for (let h = 0; h < 48; h++) for (let q = 0; q < 4; q++) {
      const t = Date.parse("2026-10-22T00:00:00Z") + h * 3_600_000 + q * TICK_MS;
      expect(acousticDue(t)).toBe(Math.floor(t / TICK_MS) % 4 === 2);
    }
  });
});

/** Simulate 24 h of 15-min ticks; each acoustic run costs `cost` ms of the 45 s budget. Returns which room-days got an acoustic run. */
async function acousticCoverage(n: number, cost: number, hours = 24) {
  const days = Array.from({ length: n }, (_, i) => day(i));
  const got = new Set<string>();
  const t0 = Date.parse("2026-10-22T00:00:00Z");
  for (let k = 0; k < hours * 4; k++) {
    let t = t0 + k * TICK_MS;
    await runProducers(days, 12, { now: () => t, isBlind: async () => false, acoustic: async (i) => { got.add(i.room_day_id); t += cost; return { ok: true }; }, leave: async () => ({ ok: true }), timelineEnabled: () => false, gateDiar: () => false });
  }
  return got.size;
}

describe("F4 rotation x hourly acoustic (R4 fix: due ticks rotate by the hour index)", () => {
  /** Hours until every room-day has had an acoustic run, or Infinity within `cap` hours. */
  async function hoursToCover(n: number, b: number, cap: number) {
    const days = Array.from({ length: n }, (_, i) => day(i));
    const got = new Set<string>();
    const t0 = Date.parse("2026-10-22T00:00:00Z");
    const cost = Math.floor(STOP_AFTER_MS / b) + (b > 1 ? 1 : 0);
    for (let k = 0; k < cap * 4; k++) {
      let t = t0 + k * TICK_MS;
      await runProducers(days, 12, { now: () => t, isBlind: async () => false, acoustic: async (i) => { got.add(i.room_day_id); t += cost; return { ok: true }; }, leave: async () => ({ ok: true }), timelineEnabled: () => false, gateDiar: () => false });
      if (got.size === n) return Math.floor(k / 4) + 1;
    }
    return Infinity;
  }
  it("every room-day gets acoustic within n-b+1 hours (n 1..16, b 1..4, b capped at n)", async () => {
    for (let n = 1; n <= 16; n++) for (let b = 1; b <= 4; b++) {
      const eff = Math.min(b, n);
      expect(await hoursToCover(n, b, 24), `n=${n} b=${b}`).toBeLessThanOrEqual(n - eff + 1);
    }
  }, 120_000);
  it("the old starving cases are covered: n=4 b=1, n=8 b=2, n=8 b=3", async () => {
    expect(await hoursToCover(4, 1, 24)).toBeLessThanOrEqual(4);
    expect(await hoursToCover(8, 2, 24)).toBeLessThanOrEqual(7);
    expect(await hoursToCover(8, 3, 24)).toBeLessThanOrEqual(6);
  });
  it("pure model: hour-index rotation heads cover all n in n hours", () => {
    for (let n = 1; n <= 24; n++) {
      const got = new Set<number>();
      const t0 = Date.parse("2026-10-22T00:00:00Z");
      for (let h = 0; h < n; h++) got.add(rotateByTick(Array.from({ length: n }, (_, i) => i), t0 + h * 3_600_000, 3_600_000)[0]!);
      expect(got.size).toBe(n);
    }
  });
});

describe("F1 key collisions", () => {
  it("smoother invariant (fuzz): within one run, interval starts are >= 2 hops apart, so no two intervals share a minute bucket", () => {
    let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const V = ["speech", "non_speech", "unjudged"] as const;
    for (let trial = 0; trial < 400; trial++) {
      const phase = Math.floor(rnd() * 60_000);
      const ps: ProbeVerdict[] = [];
      for (let i = 0; i < 300; i++) { if (rnd() < 0.03) continue; ps.push({ t: 1_760_000_000_000 + phase + i * 60_000, verdict: V[rnd() < 0.5 ? 0 : rnd() < 0.7 ? 1 : 2], ...(rnd() < 0.02 ? { reason: "dead_mic" as const } : {}) }); }
      const enc = smoothEncounters(ps, { tape_off: rnd() < 0.5 ? [{ start_ms: ps[100]!.t, end_ms: ps[100]!.t + 30_000 }] : [] });
      const keys = enc.map((e) => acousticKey({ room_day_id: "rd_abcd2345", start_ms: e.start_ms }));
      expect(new Set(keys).size).toBe(keys.length);
      for (let i = 1; i < enc.length; i++) expect(enc[i]!.start_ms - enc[i - 1]!.start_ms).toBeGreaterThanOrEqual(120_000);
    }
  });
  it("RESIDUE: a start that moves by one hop between runs is a NEW key; the old key is never retracted (2 live keys for one interval)", () => {
    const S = 1_760_760_000_000;
    const r1 = toSignals([{ id: "eh_a", run_id: "ehr_a", room_day_id: "rd_abcd2345", room_id: "room_abcd2345", start_ms: S, end_ms: S + 600_000, created_at: "2026-10-18T05:00:00Z" }], "acoustic");
    const prior = new Map([[r1[0]!.source_key, { rev: 1, hash: hashOfSignal(r1[0]!) }]]);
    const r2 = toSignals([{ id: "eh_b", run_id: "ehr_b", room_day_id: "rd_abcd2345", room_id: "room_abcd2345", start_ms: S + 60_000, end_ms: S + 600_000, created_at: "2026-10-18T06:00:00Z" }], "acoustic", prior);
    expect(r2[0]!.source_key).not.toBe(r1[0]!.source_key);
    expect(r2[0]!.source_rev).toBe(1);
  });
  it("different room-days never share a key", () => {
    expect(acousticKey({ room_day_id: "rd_abcd2345", start_ms: 1 })).not.toBe(acousticKey({ room_day_id: "rd_abcd2346", start_ms: 1 }));
  });
  it("realistic epoch minutes (2025-2035) are 5 base-36 chars and pass the shared format", () => {
    for (const y of ["2025-01-01", "2030-06-15", "2035-12-31"]) {
      const k = acousticKey({ room_day_id: "rd_abcd2345", start_ms: Date.parse(`${y}T00:00:00Z`) })!;
      expect(k.split(":")[1]).toHaveLength(5);
      expect(FORMATS.acoustic_key!.test(k)).toBe(true);
    }
  });
  it("junk start_ms gives no key", () => {
    for (const s of [null, undefined, "", "abc", NaN]) expect(acousticKey({ room_day_id: "rd_abcd2345", start_ms: s })).toBeNull();
  });
});

describe("F1 TS and Python acoustic_key screens agree", () => {
  const cases = ["rd_abcd2345:z9x8k", "rd_abcd2345:abcd", "rd_abcd2345:zzzzzz", "rd_abcd2345:abc", "rd_abcd2345:abcdefg", "rd_abcd2345:1234567", "rd_abcd2345:123456", "rd_abcd2345:abcd\n", "rd_abcd2345:ABCD", "rd_abci2345:abcd", " rd_abcd2345:abcd", "rd_abcd2345:abcd ", "rd_abcd2345::abcd", "rd_abcd2345:аbcd"];
  it("same verdict for every case", () => {
    const py = JSON.parse(execFileSync("python3", ["-I", "-c",
      "import sys,json; sys.path.insert(0,'tools/eta-spine'); import post_signals as p; print(json.dumps([bool(p._fmt('acoustic_key', c)) for c in json.loads(sys.argv[1])]))", JSON.stringify(cases)], { encoding: "utf8" }));
    expect(cases.map((c) => FORMATS.acoustic_key!.test(c))).toEqual(py);
  });
});

describe("F3 v3 is gone from the cron", () => {
  it("no shadow-v3 import, no runTimelineShadowForRoomDay, no jev in producers.ts or route.ts code", () => {
    for (const f of ["lib/spine/producers.ts", "app/api/cron/encounter-shadow/route.ts"]) {
      const code = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(code).not.toMatch(/shadow-v3|runTimelineShadowForRoomDay|jev/i);
    }
  });
});

describe("flag-off unchanged", () => {
  it("timeline off and acoustic not due: no runner is called at all", async () => {
    const calls: string[] = [];
    const c = await runProducers([day(1), day(2)], 12, { now: () => ist("12:30:00"), isBlind: async () => false, acoustic: async () => { calls.push("a"); return { ok: true }; }, leave: async () => { calls.push("l"); return { ok: true }; }, timelineEnabled: () => false, gateDiar: () => { throw new Error("must not be read"); } });
    expect(calls).toEqual([]);
    expect(c).toMatchObject({ acoustic_due: false, timeline_enabled: false, timeline_flag_invalid: 0, room_days: 2 });
  });
});
