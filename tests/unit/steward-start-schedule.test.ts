/** lib/steward/start-schedule.ts — the pure rate limit: 3 steward attempts per IST day, 5 / 15 / 45 min after the 1st / 2nd / 3rd FAILED attempt, a 4th never. */
import { describe, it, expect } from "vitest";
import { START_BACKOFF_MIN, attemptFailed, startVerdict, type StartAttemptLike } from "@/lib/steward/start-schedule";

const T0 = Date.parse("2026-10-07T08:00:00Z");
const MIN = 60_000;
const at = (min: number, over: Partial<StartAttemptLike> = {}): StartAttemptLike => ({ status: "failed", created_at: new Date(T0 + min * MIN).toISOString(), acked_at: null, session_started: false, session_named: false, ...over });
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
    // acked 6 min ago with no session = failed -> its 5 min wait (from creation) is over
    expect(attemptFailed(at(0, { status: "acked", acked_at: new Date(T0 + MIN).toISOString() }), T0 + 7 * MIN)).toBe(true);
    expect(attemptFailed(at(0, { status: "expired" }), T0)).toBe(true);
    expect(v([at(0, { status: "acked", acked_at: new Date(T0 + MIN).toISOString() })], 7)).toMatchObject({ kind: "go" });
  });

  it("an out-of-order list is read by creation time; the cap is configurable", () => {
    expect(v([at(5), at(0)], 12)).toMatchObject({ kind: "backoff", retry_after_s: 480 });
    expect(startVerdict([at(0), at(5)], T0 + 600 * MIN, 2)).toMatchObject({ kind: "exhausted" });
  });
});
