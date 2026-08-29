/**
 * Diarize dispatch — the clock starts when the request is SENT, and only one is ever in flight.
 *
 * WHAT THE MEASUREMENT FOUND (docs/ETA-DIARIZE-TIMING-PROBE-22-AUG-2026.md, 22 Aug 2026).
 *
 * The premise everyone was working from was false. Diarization does not fail on long files: of
 * six encounters FIVE completed, and the one that failed (enc_7kszcrtwzc, 288 s) was SHORTER
 * than the longest success (enc_bn5ttmn7qm, 482 s). Measured on real audio the service is
 * linear across a 10x range — service_ms = 46.42 x seconds + 148 — so a 403-second file is
 * about 26 seconds of work against what was a 90-second budget.
 *
 * The bug is that the service SERIALISES (single-worker uvicorn, GIL + MPS) and the caller's
 * timeout clock started at ENQUEUE. A request sent while another was running burned its budget
 * waiting inside the service, and then real work breached what was left.
 *
 * These tests hold the two halves of the fix to that account:
 *
 *   1. The queue is ours and it is one deep. Three callers offered at once produce three
 *      dispatches whose in-flight intervals never overlap — observed by instrumenting the
 *      fetch, not inferred from the lease SQL.
 *   2. Queue wait is not charged to the timeout. A caller that waits far longer than the whole
 *      budget still gets the full budget once dispatched, and the timeout error names the
 *      budget it applied to.
 *   3. Transfer and service time are recorded apart, because 28% of the probe's 15-minute wall
 *      was upload and a folded number would have read as a slow model.
 *
 * The lease is exercised against a fake Postgres that implements the real upsert semantics
 * (steal only an EXPIRED row), so "depth 1" is a property of the statement, not of the mock.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── a fake `sql` that implements diarize_slot's actual semantics ───────────────────────────────
type Lease = { holder: string; expires_at: number };
let lease: Lease | null = null;
let now = 1_000_000;
let sqlFailsWith: unknown = null;
const sqlCalls: string[] = [];

const fakeSql = (strings: TemplateStringsArray, ...values: unknown[]) => {
  const text = strings.join("?");
  sqlCalls.push(text.replace(/\s+/g, " ").trim().slice(0, 60));
  if (sqlFailsWith) return Promise.reject(sqlFailsWith);
  if (/INSERT INTO diarize_slot/.test(text)) {
    const holder = values[1] as string;
    const ttlSec = values[2] as number;
    if (lease && lease.expires_at > now) return Promise.resolve([]); // live lease: nobody steals it
    lease = { holder, expires_at: now + ttlSec * 1000 };
    return Promise.resolve([{ holder }]);
  }
  if (/DELETE FROM diarize_slot/.test(text)) {
    const holder = values[1] as string;
    if (lease?.holder === holder) lease = null;
    return Promise.resolve([]);
  }
  if (/SELECT holder, acquired_at/.test(text)) {
    return Promise.resolve(lease && lease.expires_at > now ? [{ holder: lease.holder, acquired_at: "", expires_at: "" }] : []);
  }
  return Promise.resolve([]);
};

vi.mock("@/lib/db", () => ({ sql: (...a: unknown[]) => (fakeSql as (...x: unknown[]) => unknown)(...a) }));

process.env.DIARIZE_BASE_URL = "https://diarize.test";

const { runDiarize, DIARIZE_TIMEOUT_MS_DEFAULT, DIARIZE_TIMEOUT_MS, diarizeTimingLine } = await import("@/lib/diarize");
const { acquireDiarizeSlot, DIARIZE_QUEUE_WAIT_MS_DEFAULT } = await import("@/lib/diarize-gate");

const AUDIO = new Uint8Array(1024);

/** Instrumented service: records when each call is in flight, so overlap is OBSERVED. */
type Flight = { id: string; start: number; end: number };
let flights: Flight[] = [];
let inFlight = 0;
let maxInFlight = 0;

function serviceTakes(ms: number, serviceMs: number) {
  return vi.fn(async () => {
    const id = `f${flights.length}`;
    const rec: Flight = { id, start: Date.now(), end: 0 };
    flights.push(rec);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, ms));
    inFlight--;
    rec.end = Date.now();
    return new Response(JSON.stringify({ speakers: [{ idx: 0, label: "Speaker 1", type: "other" }], latency_ms: serviceMs }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  });
}

beforeEach(() => {
  lease = null; now = 1_000_000; sqlFailsWith = null; sqlCalls.length = 0;
  flights = []; inFlight = 0; maxInFlight = 0;
  delete process.env.DIARIZE_TIMEOUT_MS;
  delete process.env.DIARIZE_QUEUE_WAIT_MS;
});
afterEach(() => { vi.restoreAllMocks(); });

describe("B2 — the caller is held at depth 1", () => {
  it("three requests offered at once never overlap in flight", async () => {
    const fetchMock = serviceTakes(60, 40);
    vi.stubGlobal("fetch", fetchMock);
    // keep the fake lease clock moving so a stale lease could in principle be stolen
    const tick = setInterval(() => { now += 50; }, 10);
    try {
      const outs = await Promise.all(
        ["a", "b", "c"].map((e) => runDiarize(AUDIO, "audio/webm", { encounterId: `enc_${e}` })),
      );
      expect(outs.every((o) => o.ok)).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(3);

      // OBSERVED, not inferred: at no instant were two calls inside the service.
      expect(maxInFlight).toBe(1);
      const sorted = [...flights].sort((a, b) => a.start - b.start);
      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i]!.start).toBeGreaterThanOrEqual(sorted[i - 1]!.end);
      }
    } finally { clearInterval(tick); }
  });

  it("the second caller's wait is reported as queue wait, not as service time", async () => {
    vi.stubGlobal("fetch", serviceTakes(80, 30));
    const tick = setInterval(() => { now += 50; }, 10);
    try {
      const [first, second] = await Promise.all([
        runDiarize(AUDIO, "audio/webm", { encounterId: "enc_first" }),
        // a beat later, so "first" is deterministically the one that wins the slot
        new Promise((r) => setTimeout(r, 15)).then(() => runDiarize(AUDIO, "audio/webm", { encounterId: "enc_second" })),
      ]) as [Awaited<ReturnType<typeof runDiarize>>, Awaited<ReturnType<typeof runDiarize>>];

      expect(first.ok && second.ok).toBe(true);
      expect(first.timing.queue_wait_ms).toBeLessThan(50);
      expect(second.timing.queue_wait_ms).toBeGreaterThan(30);
      // The queued call's DISPATCHED time is its own work only — it did not inherit the first
      // call's runtime, which is exactly what used to blow the budget.
      expect(second.timing.wall_ms).toBeLessThan(second.timing.queue_wait_ms + 60);
      expect(second.timing.dispatched_at! >= first.timing.completed_at!).toBe(true);
    } finally { clearInterval(tick); }
  });

  it("a caller that never gets the slot is retryable, and never reached the service", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    lease = { holder: "someone-else", expires_at: now + 3_600_000 }; // held, and not expiring
    const out = await runDiarize(AUDIO, "audio/webm", { encounterId: "enc_x", queueWaitMs: 120 });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.retryable).toBe(true);
    expect(out.error).toMatch(/^diarize_busy_queue_wait_exceeded_/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(out.timing.dispatched_at).toBeNull();
    expect(out.timing.queue_wait_ms).toBeGreaterThanOrEqual(120);
  });

  it("the slot is released even when the dispatched call throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("econnreset"); }));
    const out = await runDiarize(AUDIO, "audio/webm", { encounterId: "enc_boom" });
    expect(out.ok).toBe(false);
    expect(lease).toBeNull();
    expect(sqlCalls.some((c) => /DELETE FROM diarize_slot/.test(c))).toBe(true);
  });

  it("a missing diarize_slot table admits the call rather than failing diarization", async () => {
    const fetchMock = serviceTakes(5, 3);
    vi.stubGlobal("fetch", fetchMock);
    sqlFailsWith = Object.assign(new Error('relation "diarize_slot" does not exist'), { code: "42P01" });
    const out = await runDiarize(AUDIO, "audio/webm", { encounterId: "enc_nomig" });
    expect(out.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.timing.ungated).toBe(true); // recorded, never hidden
  });

  it("a transient DB fault is treated as busy, not as a free pass", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    sqlFailsWith = Object.assign(new Error("connection terminated"), { code: "57P01" });
    const out = await acquireDiarizeSlot({ label: "enc_y", ttlMs: 1000, waitMs: 80 });
    expect(out.acquired).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("B1 — the timeout budget belongs to the dispatched call", () => {
  it("time spent queued does not shorten the budget of the call that follows it", async () => {
    process.env.DIARIZE_TIMEOUT_MS = "200";
    // The blocker holds the slot for longer than the WHOLE timeout budget. Under the old
    // start-at-enqueue behaviour the waiter would be dead before it was ever sent.
    vi.stubGlobal("fetch", serviceTakes(60, 40));
    const tick = setInterval(() => { now += 50; }, 10);
    try {
      const blocker = runDiarize(AUDIO, "audio/webm", { encounterId: "enc_block" });
      await new Promise((r) => setTimeout(r, 20));
      const waiter = runDiarize(AUDIO, "audio/webm", { encounterId: "enc_wait" });
      const [b, w] = await Promise.all([blocker, waiter]);
      expect(b.ok).toBe(true);
      expect(w.ok).toBe(true);            // survived a wait it could not have survived before
      if (!w.ok) throw new Error("unreachable");
      expect(w.timing.timed_out).toBe(false);
      expect(w.timing.queue_wait_ms).toBeGreaterThan(20);
      expect(w.timing.wall_ms).toBeLessThan(200);
    } finally { clearInterval(tick); }
  });

  it("the timeout still binds on the dispatched call, and names the budget it applied", async () => {
    process.env.DIARIZE_TIMEOUT_MS = "60";
    vi.stubGlobal("fetch", vi.fn((_u: string, init: RequestInit) => new Promise((_res, rej) => {
      init.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
    })));
    const out = await runDiarize(AUDIO, "audio/webm", { encounterId: "enc_slow" });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.error).toBe("timeout_60ms");
    expect(out.timing.timed_out).toBe(true);
    expect(out.timing.timeout_ms).toBe(60);
    expect(out.retryable).toBeUndefined(); // a real timeout IS a failure; only "no slot" retries
    expect(lease).toBeNull();
  });

  it("an outer abort is not reported as a diarization timeout", async () => {
    process.env.DIARIZE_TIMEOUT_MS = "5000";
    const outer = new AbortController();
    vi.stubGlobal("fetch", vi.fn((_u: string, init: RequestInit) => new Promise((_res, rej) => {
      init.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
    })));
    setTimeout(() => outer.abort(), 30);
    const out = await runDiarize(AUDIO, "audio/webm", { encounterId: "enc_cancel", signal: outer.signal });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.error).toBe("aborted");
    expect(out.timing.timed_out).toBe(false);
  });
});

describe("B3 — the timeout is configurable and its default carries its provenance", () => {
  it("defaults to the probe's figure and is overridable by env", () => {
    expect(DIARIZE_TIMEOUT_MS_DEFAULT).toBe(300_000);
    expect(DIARIZE_TIMEOUT_MS()).toBe(300_000);
    process.env.DIARIZE_TIMEOUT_MS = "45000";
    expect(DIARIZE_TIMEOUT_MS()).toBe(45_000);
  });

  it("the queue wait is a separate, configurable budget", () => {
    expect(DIARIZE_QUEUE_WAIT_MS_DEFAULT).toBe(120_000);
  });

  it("the source file says the default was measured under load and must be re-measured", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("lib/diarize.ts", "utf8");
    const block = src.slice(0, src.indexOf("export const DIARIZE_TIMEOUT_MS_DEFAULT"));
    expect(block).toMatch(/UNDER LOAD/i);
    expect(block).toMatch(/UPPER BOUND/i);
    expect(block).toMatch(/re-measure/i);
  });

  it("no bare 300000 literal exists anywhere else in the source", async () => {
    const { execFileSync } = await import("node:child_process");
    // Every occurrence of the number in code we own. Exactly one may be a statement, and it must
    // be the named constant that carries the provenance note. A constant explained in one place
    // and re-typed in another is an invented constant again — this codebase names, exports and
    // reports its numbers, and the point of B3 was not to smuggle one in.
    const hits = execFileSync("git", ["grep", "-n", "-E", "300_?000", "--", "app", "lib", "components", "db", "scripts"], {
      encoding: "utf8",
    }).trim().split("\n").filter(Boolean);
    const code = hits.filter((h) => {
      const body = h.split(":").slice(2).join(":").trim();
      if (body.startsWith("//") || body.startsWith("*") || body.startsWith("--")) return false;
      // STANDALONE ONLY. `git grep -E` has no word boundaries, so the pattern above also matches
      // 300000 sitting INSIDE a longer digit run — e.g. the epoch window-ms literals
      // `1787553000000` in migration 0072, which are a window address and not a timeout at all.
      // The boundary check is done here, in JS, where lookarounds are reliable. B3's intent is
      // unchanged: a re-typed 300000 timeout constant still fails this test.
      return /(?<![0-9])300_?000(?![0-9])/.test(body);
    });
    expect(code).toHaveLength(1);
    expect(code[0]).toContain("export const DIARIZE_TIMEOUT_MS_DEFAULT = 300_000;");
  });
});

describe("B4 — transfer time and service time are recorded separately", () => {
  it("splits wall into service and transfer using the service's own figure", async () => {
    vi.stubGlobal("fetch", serviceTakes(80, 30));
    const out = await runDiarize(AUDIO, "audio/webm", { encounterId: "enc_t" });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(out.timing.service_ms).toBe(30);
    expect(out.timing.wall_ms).toBeGreaterThanOrEqual(80);
    expect(out.timing.transfer_ms).toBe(out.timing.wall_ms - 30);
    expect(out.timing.audio_bytes).toBe(AUDIO.byteLength);
    // 28% of the probe's 15-minute wall was upload. The line a human reads must keep them apart.
    expect(diarizeTimingLine(out.timing)).toMatch(/service.*transfer.*queued/);
  });

  it("transfer is null, not zero, when the service reported no latency of its own", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ speakers: [] }), { status: 200 })));
    const out = await runDiarize(AUDIO, "audio/webm", { encounterId: "enc_nolat" });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(out.timing.service_ms).toBeNull();
    expect(out.timing.transfer_ms).toBeNull(); // unknown is not the same as instant
  });
});
