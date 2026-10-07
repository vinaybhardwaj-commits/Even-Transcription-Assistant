/** lib/steward/start-schedule.ts — the pure rate limit: 3 steward attempts per IST day, 5 / 15 / 45 min after the 1st / 2nd / 3rd FAILED attempt, a 4th never. */
import { describe, it, expect } from "vitest";
import { START_BACKOFF_MIN, attemptFailed, failureKnownAtMs, startVerdict, type StartAttemptLike } from "@/lib/steward/start-schedule";

const T0 = Date.parse("2026-10-07T08:00:00Z");
const MIN = 60_000;
const iso = (min: number) => new Date(T0 + min * MIN).toISOString();
/** a failed attempt queued at `min`, the failure reported (acked_at) at `knownMin` (default: at once) */
const at = (min: number, over: Partial<StartAttemptLike> = {}, knownMin = min): StartAttemptLike => ({ status: "failed", created_at: iso(min), acked_at: iso(knownMin), session_started: false, session_named: false, ...over });
const v = (attempts: StartAttemptLike[], min: number) => startVerdict(attempts, T0 + min * MIN, 3);

describe("startVerdict", () => {
  it("the table is 5 / 15 / 45 min", () => expect(START_BACKOFF_MIN).toEqual([5, 15, 45]));

  it("1st at T0, refused at +4, 2nd at +5, refused until +20, 3rd at +20, then the cap (FLEET's scenario)", () => {
    expect(v([], 0)).toMatchObject({ kind: "go" });
    expect(v([at(0)], 4)).toMatchObject({ kind: "backoff", retry_after_s: 60 });
    expect(v([at(0)], 5)).toMatchObject({ kind: "go" });
    expect(v([at(0), at(5)], 19)).toMatchObject({ kind: "backoff", retry_after_s: 60 });
    expect(v([at(0), at(5)], 20)).toMatchObject({ kind: "go" });
    expect(v([at(0), at(5), at(20)], 20)).toMatchObject({ kind: "exhausted", attempts: 3 });
    // the 45 min after the 3rd is moot: a 4th is never issued that day, however long we wait
    expect(v([at(0), at(5), at(20)], 20 + 600)).toMatchObject({ kind: "exhausted" });
  });

  it("pending and young-acked attempts hold; an ack that made a session is a success (no backoff, still counted)", () => {
    expect(v([at(0, { status: "pending" })], 1)).toMatchObject({ kind: "pending" });
    expect(v([at(0, { status: "acked", acked_at: new Date(T0 + MIN).toISOString() })], 3)).toMatchObject({ kind: "pending" });
    expect(v([at(0, { status: "acked", acked_at: new Date(T0 + MIN).toISOString(), session_started: true })], 3)).toMatchObject({ kind: "go" });
    // acked at +1 with no session: failed once the 5 min grace is over (+6); its 5 min backoff runs from THERE (F21), so a retry is allowed at +11, not at +5
    expect(attemptFailed(at(0, { status: "acked", acked_at: iso(1) }), T0 + 7 * MIN)).toBe(true);
    expect(attemptFailed(at(0, { status: "expired" }), T0)).toBe(true);
    expect(v([at(0, { status: "acked", acked_at: iso(1) })], 7)).toMatchObject({ kind: "backoff", retry_after_s: 240 });
    expect(v([at(0, { status: "acked", acked_at: iso(1) })], 11)).toMatchObject({ kind: "go" });
  });

  it("an out-of-order list is read by creation time; the cap is configurable", () => {
    expect(v([at(5), at(0)], 12)).toMatchObject({ kind: "backoff", retry_after_s: 480 });
    expect(startVerdict([at(0), at(5)], T0 + 600 * MIN, 2)).toMatchObject({ kind: "exhausted" });
  });

  it("F21: the backoff runs from the moment the failure became known, not from the moment the command was queued", () => {
    // queued at 0, the kiosk reported the failure at +2: the 5 min wait ends at +7 (not +5)
    const a1 = at(0, {}, 2);
    expect(failureKnownAtMs(a1)).toBe(T0 + 2 * MIN);
    expect(v([a1], 6)).toMatchObject({ kind: "backoff", retry_after_s: 60 });
    expect(v([a1], 7)).toMatchObject({ kind: "go" });
    // no ack / failure time at all: queued + 8 s (the executor's ack wait)
    const none = at(0, { acked_at: null });
    expect(failureKnownAtMs(none)).toBe(T0 + 8_000);
    expect(v([none], 5)).toMatchObject({ kind: "backoff", retry_after_s: 8 });
    expect(v([none], 5.2)).toMatchObject({ kind: "go" });
    // acked, no session: known at ack + 300 s
    expect(failureKnownAtMs(at(0, { status: "acked", acked_at: iso(1) }))).toBe(T0 + 6 * MIN);
  });

  it("F21 timeline: attempt 1 queued 08:00 (failure known 08:00:20), attempt 2 allowed 08:05:20, queued 08:06 (known 08:06:30), attempt 3 allowed 08:21:30, then never", () => {
    const sec = (s: number) => new Date(T0 + s * 1000).toISOString();
    const a1 = { ...at(0), acked_at: sec(20) };
    expect(startVerdict([a1], T0 + 5 * MIN + 19_000, 3)).toMatchObject({ kind: "backoff", retry_after_s: 1 });
    expect(startVerdict([a1], T0 + 5 * MIN + 20_000, 3)).toMatchObject({ kind: "go" });
    const a2 = { ...at(6), acked_at: sec(6 * 60 + 30) };
    expect(startVerdict([a1, a2], T0 + 21 * MIN + 29_000, 3)).toMatchObject({ kind: "backoff", retry_after_s: 1 });
    expect(startVerdict([a1, a2], T0 + 21 * MIN + 30_000, 3)).toMatchObject({ kind: "go" });
    const a3 = at(22);
    expect(startVerdict([a1, a2, a3], T0 + 24 * 60 * MIN, 3)).toMatchObject({ kind: "exhausted" });
  });
});
