/**
 * E17 — the drain must not starve a room (lib/stt/auto-drain.ts, orderAutoDrainOffers).
 *
 * The ORDER is proven here, on the pure function, because it is where the defect was: `closed_at DESC`
 * across rooms. The SQL filters around it (Transcript join before selection, refusal cooldown, queued job,
 * age) are unchanged and proven in s1-auto-drain.test.ts against a real postgres.
 *
 * EVERY BEHAVIOUR IS SHOWN AGAINST THE OLD ORDER TOO. `closedAtDesc` below is the shipped selector's
 * ranking (ORDER BY closed_at DESC LIMIT n), written out, so each test states what the old order did on the
 * same fixture. A test the old order also passes would prove nothing about the change.
 *
 * THE MODEL (V2) is the E4 starvation model (docs/handoff/scratch/E4-STARVATION-MODEL-14-SEP-2026.py.txt)
 * restated in TypeScript so it drives the REAL function: six to nine rooms, 36 windows each over a nine-hour
 * clinic, a cron tick every 300 s, one window per tick, six hours back. A window's slot ends on the grid line;
 * it closes `phase + 20 s + jitter` later, the phase fixed per kiosk run.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", () => ({ sql: async () => [] }));
vi.mock("@/lib/stt/room-drain", () => ({ drainRoomWindow: async () => ({ ok: false, step: "flag_off" }) }));
vi.mock("@/lib/stt/fanout", () => ({ enqueueSubject: async () => undefined }));

const { orderAutoDrainOffers } = await import("@/lib/stt/auto-drain");
type DrainCandidate = import("@/lib/stt/auto-drain").DrainCandidate;

const closedAtDesc = (c: DrainCandidate[], limit: number) => [...c].sort((a, b) => b.closed_ms - a.closed_ms).slice(0, limit);
const H = 3_600_000;
const cand = (id: string, room_id: string, end_ms: number, closed_ms: number, last_served_ms: number | null = null): DrainCandidate =>
  ({ id, room_id, start_ms: end_ms - 900_000, end_ms, closed_ms, last_served_ms });
const ids = (c: DrainCandidate[]) => c.map((x) => x.id);

// ═══ THE MODEL ══════════════════════════════════════════════════════════════════════════════════════
const GRID = 900, TICK = 300, CLINIC_S = 9 * 3600, MAX_AGE = 6 * 3600, N_WIN = 36, END = CLINIC_S + MAX_AGE + 2 * GRID;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Pick = (c: DrainCandidate[], limit: number) => DrainCandidate[];
type ModelOut = { clinic: number[]; drained: number[]; secondServeWhileAnotherWaits: number };

/** One clinic day. Seconds on the model clock, milliseconds on the candidates. */
function runModel(rooms: number, seed: number, jitter: number, pick: Pick): ModelOut {
  const rng = mulberry32(seed);
  const phase = Array.from({ length: rooms }, () => rng() * 300);
  const wins: Array<{ room: number; k: number; end: number; closed: number; servedAt: number | null }> = [];
  for (let r = 0; r < rooms; r++)
    for (let k = 0; k < N_WIN; k++) {
      const end = (k + 1) * GRID;
      wins.push({ room: r, k, end, closed: end + phase[r]! + 20 + (rng() * 2 - 1) * jitter, servedAt: null });
    }
  const lastServed: Array<number | null> = Array(rooms).fill(null);
  const out: ModelOut = { clinic: Array(rooms).fill(0), drained: Array(rooms).fill(0), secondServeWhileAnotherWaits: 0 };
  let grid = -1, servedInGrid: number[] = [];
  for (let t = 15; t < END; t += TICK) {
    const g = Math.floor(t / GRID);
    if (g !== grid) { grid = g; servedInGrid = Array(rooms).fill(0); }
    const eligible = wins.filter((w) => w.servedAt === null && w.closed <= t && w.closed >= t - MAX_AGE);
    const candidates = eligible.map((w) => cand(`r${w.room}_k${w.k}`, `room_${w.room}`, w.end * 1000, w.closed * 1000,
      lastServed[w.room] !== null && lastServed[w.room]! >= t - MAX_AGE ? lastServed[w.room]! * 1000 : null));
    for (const chosen of pick(candidates, 1)) {
      const w = eligible.find((x) => `r${x.room}_k${x.k}` === chosen.id)!;
      const holding = new Set(eligible.map((x) => x.room));
      if (servedInGrid[w.room]! >= 1 && [...holding].some((r) => r !== w.room && servedInGrid[r] === 0)) out.secondServeWhileAnotherWaits += 1;
      w.servedAt = t; lastServed[w.room] = t; servedInGrid[w.room]! += 1;
      out.drained[w.room]! += 1;
      if (t < CLINIC_S + TICK) out.clinic[w.room]! += 1;
    }
  }
  return out;
}

describe("V1 — the property, over a multi-room day: no room is served twice in a grid while a room holding a window waits", () => {
  it("the live run's shape — two backlogged rooms, 76 and 113 windows, 25 ticks: every grid shared, no room served twice while the other waits", () => {
    // room_2qe955hy's newest window 13 Sep against room_ymch4bxu's 12 Sep; nothing new arriving (E9 §5).
    const day = 24 * H;
    const backlog = [
      ...Array.from({ length: 76 }, (_, i) => cand(`a${i}`, "room_a", 13 * day - i * 900_000, 13 * day - i * 900_000 + 60_000)),
      ...Array.from({ length: 113 }, (_, i) => cand(`b${i}`, "room_b", 12 * day - i * 900_000, 12 * day - i * 900_000 + 60_000)),
    ];
    const run = (pick: Pick) => {
      let pool = backlog.map((c) => ({ ...c }));
      const last: Record<string, number | null> = { room_a: null, room_b: null };
      const count: Record<string, number> = { room_a: 0, room_b: 0 };
      let violations = 0, inGrid: Record<string, number> = {};
      for (let tick = 0; tick < 25; tick++) {
        if (tick % 3 === 0) inGrid = { room_a: 0, room_b: 0 };
        const now = 20 * day + tick * TICK * 1000;
        const [chosen] = pick(pool.map((c) => ({ ...c, last_served_ms: last[c.room_id]! })), 1);
        const other = chosen!.room_id === "room_a" ? "room_b" : "room_a";
        if (inGrid[chosen!.room_id]! >= 1 && inGrid[other] === 0 && pool.some((c) => c.room_id === other)) violations += 1;
        inGrid[chosen!.room_id]! += 1; count[chosen!.room_id]! += 1; last[chosen!.room_id] = now;
        pool = pool.filter((c) => c.id !== chosen!.id);
      }
      return { violations, count };
    };
    const fair = run(orderAutoDrainOffers);
    const old = run(closedAtDesc);
    expect(fair.violations).toBe(0);
    expect(fair.count, "the 25 slots shared 13 / 12; the newer room takes the first, tied, slot").toEqual({ room_a: 13, room_b: 12 });
    expect(old.count, "control: the old order gives all 25 to one room, as it did live").toEqual({ room_a: 25, room_b: 0 });
    expect(old.violations, "control: and serves it twice per grid while the other waits").toBeGreaterThan(0);
  });

  it("six rigid kiosks (±0 s): zero violations and no room unserved under the new order (the old order's failure here is starvation — see V2's control)", () => {
    const fair = runModel(6, 7, 0, orderAutoDrainOffers);
    expect(fair.secondServeWhileAnotherWaits).toBe(0);
    expect(Math.min(...fair.clinic)).toBeGreaterThan(0);
  });

  it("holds across 20 phase sets at 6 and 9 rooms", () => {
    for (const rooms of [6, 9]) for (let s = 0; s < 20; s++) expect(runModel(rooms, 100 + s, 0, orderAutoDrainOffers).secondServeWhileAnotherWaits, `rooms ${rooms} seed ${s}`).toBe(0);
  });
});

describe("V2 — the E4 model at 6, 7, 8 and 9 rooms: no room gets nothing in clinic hours", () => {
  for (const rooms of [6, 7, 8, 9])
    for (const jitter of [0, 30, 150])
      it(`${rooms} rooms, ±${jitter} s: zero starved rooms over 30 phase sets`, () => {
        for (let s = 0; s < 30; s++) {
          const m = runModel(rooms, 20_000 + s, jitter, orderAutoDrainOffers);
          expect(m.clinic.filter((c) => c === 0), `seed ${s}`).toEqual([]);
        }
      });

  it("control: the same model under closed_at DESC starves rooms at ±0 s — the harness can fail", () => {
    let starvedSets = 0;
    for (let s = 0; s < 30; s++) if (runModel(6, 20_000 + s, 0, closedAtDesc).clinic.some((c) => c === 0)) starvedSets += 1;
    expect(starvedSets).toBe(30);
  });

  it("capacity is unchanged: the new order drains the same total as the old, it only spreads it", () => {
    for (const rooms of [6, 9]) {
      const fair = runModel(rooms, 20_001, 0, orderAutoDrainOffers).drained.reduce((a, b) => a + b, 0);
      const old = runModel(rooms, 20_001, 0, closedAtDesc).drained.reduce((a, b) => a + b, 0);
      expect(Math.abs(fair - old), `rooms ${rooms}: ${fair} vs ${old}`).toBeLessThanOrEqual(2);
    }
  });
});

describe("V3 — a window verified 18 hours late does not jump the queue", () => {
  const now = 100 * H;
  it("within a room: the window recorded minutes ago is offered before one recorded 18 h ago but verified just now", () => {
    const recent = cand("recent", "room_a", now - 15 * 60_000, now - 10 * 60_000);
    const lateVerify = cand("late_verify", "room_a", now - 18 * H, now - 60_000);
    expect(ids(orderAutoDrainOffers([lateVerify, recent], 1))).toEqual(["recent"]);
    expect(ids(closedAtDesc([lateVerify, recent], 1)), "control: closed_at DESC takes the late verify").toEqual(["late_verify"]);
  });

  it("across rooms, neither served: the late-verified window does not take the slot from fresh material in another room", () => {
    const fresh = cand("fresh", "room_b", now - 15 * 60_000, now - 10 * 60_000);
    const lateVerify = cand("late_verify", "room_a", now - 18 * H, now - 60_000);
    expect(ids(orderAutoDrainOffers([lateVerify, fresh], 1))).toEqual(["fresh"]);
    expect(ids(closedAtDesc([lateVerify, fresh], 1)), "control").toEqual(["late_verify"]);
  });
});

describe("V4 — within a room, newest first still holds (fairness did not become FIFO)", () => {
  it("one room, served tick after tick: offered newest slot first, every time", () => {
    const now = 50 * H;
    let pool = [0, 1, 2, 3].map((i) => cand(`w${i}`, "room_a", now - (4 - i) * 900_000, now - (4 - i) * 900_000 + 60_000));
    const order: string[] = [];
    while (pool.length) {
      const [next] = orderAutoDrainOffers(pool, 1);
      order.push(next!.id);
      pool = pool.filter((c) => c.id !== next!.id);
    }
    expect(order).toEqual(["w3", "w2", "w1", "w0"]);
  });

  it("two lanes of one slot tie on the slot; the tie breaks by closed_at, then id — never by insertion order", () => {
    const a = cand("bw_x_primary", "room_a", 10 * H, 10 * H + 5_000);
    const b = cand("bw_x_backup", "room_a", 10 * H, 10 * H + 9_000);
    expect(ids(orderAutoDrainOffers([a, b], 1))).toEqual(["bw_x_backup"]);
    expect(ids(orderAutoDrainOffers([b, a], 1))).toEqual(["bw_x_backup"]);
  });
});

describe("one window per room per tick, and the room order", () => {
  it("a cap of 3 with two rooms offers two windows — one each — not three from the bigger room", () => {
    const c = [cand("a1", "room_a", 9 * H, 9 * H), cand("a2", "room_a", 8 * H, 8 * H), cand("a3", "room_a", 7 * H, 7 * H), cand("b1", "room_b", 6 * H, 6 * H)];
    const got = orderAutoDrainOffers(c, 3);
    expect(ids(got).sort()).toEqual(["a1", "b1"]);
    expect(ids(closedAtDesc(c, 3)), "control: the old order gives room_a all three").toEqual(["a1", "a2", "a3"]);
  });

  it("a room never served goes before any served room; among served rooms, the one served longest ago goes first", () => {
    const c = [cand("x", "room_x", 9 * H, 9 * H, 8 * H), cand("y", "room_y", 5 * H, 5 * H, null), cand("z", "room_z", 9 * H, 9 * H, 2 * H)];
    expect(ids(orderAutoDrainOffers(c, 3))).toEqual(["y", "z", "x"]);
  });

  it("rooms tied on last served: the room with the newer window first, then room_id — the order is total", () => {
    const c = [cand("p", "room_p", 5 * H, 5 * H), cand("q", "room_q", 7 * H, 7 * H), cand("r", "room_r", 7 * H, 7 * H)];
    expect(ids(orderAutoDrainOffers(c, 3))).toEqual(["q", "r", "p"]);
    expect(ids(orderAutoDrainOffers([...c].reverse(), 3))).toEqual(["q", "r", "p"]);
  });

  it("the cap holds: never more than `limit` windows, and nothing eligible means nothing offered", () => {
    const many = Array.from({ length: 9 }, (_, i) => cand(`w${i}`, `room_${i}`, H, H));
    expect(orderAutoDrainOffers(many, 1)).toHaveLength(1);
    expect(orderAutoDrainOffers(many, 4)).toHaveLength(4);
    expect(orderAutoDrainOffers([], 1)).toEqual([]);
  });
});
