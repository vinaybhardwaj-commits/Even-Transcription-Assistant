import test from "node:test";
import assert from "node:assert/strict";
import { inFeedWindow, istMinutes, parseCsv, pickNext, breakerTripped, errorClass } from "./feeder-3.mjs";

// IST = UTC+5:30.  20:45 IST = 15:15 UTC; 07:30 IST = 02:00 UTC.
const at = (h, m) => new Date(Date.UTC(2026, 8, 24, h, m));
test("feed window is 20:45-07:30 IST, half-open, wrapping midnight", () => {
  assert.equal(inFeedWindow(at(15, 14)), false);  // 20:44
  assert.equal(inFeedWindow(at(15, 15)), true);   // 20:45
  assert.equal(inFeedWindow(at(20, 0)), true);    // 01:30 next day
  assert.equal(inFeedWindow(at(1, 59)), true);    // 07:29
  assert.equal(inFeedWindow(at(2, 0)), false);    // 07:30 -> stop
  assert.equal(inFeedWindow(at(9, 0)), false);    // 14:30 clinic
});
test("istMinutes wraps", () => { assert.equal(istMinutes(at(18, 30)), 0); assert.equal(istMinutes(at(0, 0)), 330); });
test("parseCsv keeps column names", () => {
  const r = parseCsv("rank,window_id,set\n1,bw_a_1_primary,F22\n2,bw_b_2_primary,D21\n");
  assert.deepEqual(r.map((x) => x.window_id), ["bw_a_1_primary", "bw_b_2_primary"]);
});
test("pickNext: rank order, eligible only, at most slots", () => {
  const ranked = ["a", "b", "c", "d", "e"];
  assert.deepEqual(pickNext(ranked, new Set(["b", "c", "d", "e"]), new Map(), 3), ["b", "c", "d"]);
  assert.deepEqual(pickNext(ranked, new Set(ranked), new Map(), 0), []);
});
test("pickNext: a window already submitted twice this run is skipped; once is allowed again", () => {
  const ranked = ["a", "b", "c"];
  assert.deepEqual(pickNext(ranked, new Set(ranked), new Map([["a", 2], ["b", 1]]), 3), ["b", "c"]);
});
test("breaker trips at 3 failures in the last 6 and not at 2", () => {
  assert.equal(breakerTripped(["done", "failed", "failed", "done"]), false);
  assert.equal(breakerTripped(["done", "failed", "failed", "done", "failed"]), true);
  assert.equal(breakerTripped(["failed", "failed", "failed", "done", "done", "done", "done"]), false); // old failures age out
});
test("errorClass: busy is its own class; phase for room_window_failed; other leading codes kept", () => {
  assert.equal(errorClass("room_window_failed: join_failed: join_already_running after 4 busy retries over 2391s"), "join_busy");
  assert.equal(errorClass("room_window_failed: join_failed: container_failed"), "join_failed");
  assert.equal(errorClass("room_window_failed: cues_refused: x"), "cues_refused");
  assert.equal(errorClass("router_job_lost: poll: gone"), "router_job_lost");
  assert.equal(errorClass(null), "none");
});
