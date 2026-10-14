#!/usr/bin/env python3
import sys

def patch(path, replacements):
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()
    for label, old, new in replacements:
        n = text.count(old)
        if n != 1:
            print(f"FAIL [{path}] anchor '{label}': found {n} occurrences (expected 1)")
            sys.exit(1)
        text = text.replace(old, new)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    print(f"OK patched {path}")

# ---------------------------------------------------------------------------
# tests/unit/jev-english.test.ts — the ONE assertion that actually depends on
# the old strict three-way-agreement rule (everything else in that describe
# block already holds under the new majority-of-present rule too).
# ---------------------------------------------------------------------------
jev_old_title = 'describe("J0 — isNativeEnglish: all three signals must agree to skip translation", () => {'
jev_new_title = 'describe("J0 — isNativeEnglish: at least two of three PRESENT signals must agree; none may disagree (majority-of-present, V 21 Sep 2026)", () => {'

jev_old_test = '''  it("a missing or empty mix is NOT agreement (absent metric never reads as English)", () => {
    expect(isNativeEnglish({ full_window_language: "english", sarvam_language: "en" })).toBe(false);
    expect(isNativeEnglish(en({}))).toBe(false);
    expect(isNativeEnglish(null)).toBe(false);
    expect(isNativeEnglish(undefined)).toBe(false);
  });'''

jev_new_test = '''  it("an ABSENT mix ABSTAINS rather than vetoes: the other two signals carry it (supersedes the old three-way-agreement rule)", () => {
    expect(isNativeEnglish({ full_window_language: "english", sarvam_language: "en" })).toBe(true);
  });
  it("an EMPTY mix ABSTAINS too: it names no language, so it carries no information", () => {
    expect(isNativeEnglish(en({}))).toBe(true);
  });
  it("an absent/empty mix cannot rescue a window alone — the other two signals must still agree", () => {
    expect(isNativeEnglish(en({}, "hindi", "en"))).toBe(false);
    expect(isNativeEnglish({ full_window_language: "english", language_timeline: { language_mix: {} } })).toBe(false);
  });
  it("one signal alone is never enough — at least two of the three must be present and say English", () => {
    expect(isNativeEnglish({ full_window_language: "english" })).toBe(false);
    expect(isNativeEnglish({ sarvam_language: "en" })).toBe(false);
    expect(isNativeEnglish({ language_timeline: { language_mix: { en: 4 } } })).toBe(false);
  });
  it("no metrics at all is never English — nothing voted", () => {
    expect(isNativeEnglish(null)).toBe(false);
    expect(isNativeEnglish(undefined)).toBe(false);
    expect(isNativeEnglish({})).toBe(false);
  });'''

patch(
    "tests/unit/jev-english.test.ts",
    [
        ("describe title", jev_old_title, jev_new_title),
        ("absent/empty mix test", jev_old_test, jev_new_test),
    ],
)

# ---------------------------------------------------------------------------
# tests/unit/overnight-translate-driver.test.ts
# ---------------------------------------------------------------------------
keys_old = '"started", "done", "failed", "refused", "abandoned", "unverified", "joinDeferred", "overridden", "fatal", "stop", "error_name",'
keys_new = '"started", "done", "failed", "refused", "abandoned", "unverified", "joinDeferred", "windowDeferred", "overridden", "fatal", "stop", "error_name",'

exhaust_old = '''  it(`exhausting JOIN_RETRY_LIMIT (${JOIN_RETRY_LIMIT}) collisions in a row: the LAST one counts as a real failure`, async () => {
    const h = harness({ cands: [cand("A")], status: () => joinContended() });
    const s = await h.run();
    expect(s).toMatchObject({ started: 1, done: 0, failed: 1, joinDeferred: JOIN_RETRY_LIMIT });
    expect(h.submits.filter((x) => x.args.window_id === "A")).toHaveLength(JOIN_RETRY_LIMIT + 1);
    expect(evs(h.log, "window_join_deferred")).toHaveLength(JOIN_RETRY_LIMIT);
    expect(evs(h.log, "window_failed")).toHaveLength(1);
  });'''

exhaust_new = '''  it(`exhausting JOIN_RETRY_LIMIT (${JOIN_RETRY_LIMIT}) collisions in a row: the LAST one is a distinct, non-generic failure (join_contention_exhausted)`, async () => {
    const h = harness({ cands: [cand("A")], status: () => joinContended() });
    const s = await h.run();
    expect(s).toMatchObject({ started: 1, done: 0, failed: 1, joinDeferred: JOIN_RETRY_LIMIT });
    expect(h.submits.filter((x) => x.args.window_id === "A")).toHaveLength(JOIN_RETRY_LIMIT + 1);
    expect(evs(h.log, "window_join_deferred")).toHaveLength(JOIN_RETRY_LIMIT);
    expect(evs(h.log, "window_failed")).toHaveLength(1);
    expect(evs(h.log, "window_failed")[0]).toMatchObject({ window_id: "A", error_code: "join_contention_exhausted" });
  });'''

refused_old = '    expect(evs(h.log, "window_failed")[0]).toMatchObject({ window_id: "A", error_code: "room_window_failed" });'
refused_new = '    expect(evs(h.log, "window_failed")[0]).toMatchObject({ window_id: "A", error_code: "join_contention_exhausted" });'

insert_anchor_old = '''    expect(Object.keys(line).sort()).toEqual(["event", "job_id", "retry", "retry_job_id", "window_id"].sort());
  });
});

describe("A STUCK JOB", () => {'''

new_describe = '''describe("THE JOIN-RETRY BACKOFF RE-CHECKS THE CLOCK AND THE GATE (Refuter finding 1, 22 Sep 2026)", () => {
  it("a gate STOP that lands during the backoff abandons the retry: no resubmit, not a failure, doesn't touch consecutiveFailures", async () => {
    let n = 0;
    const h = harness({
      cands: [cand("A")],
      status: () => (++n === 1 ? joinContended() : done()),
      gate: (_t, call) => (call === 3 ? { go: false, reason: "stop:STOP_retry_test" } : { go: true, reason: "ok" }),
    });
    const s = await h.run();
    expect(s).toMatchObject({ started: 1, done: 0, failed: 0, joinDeferred: 0, windowDeferred: 1, fatal: null, stop: "backlog_empty" });
    expect(h.submits.filter((x) => x.args.window_id === "A"), "no resubmit went out").toHaveLength(1);
    expect(evs(h.log, "window_deferred")).toEqual([{ event: "window_deferred", window_id: "A", job_id: "job_1", reason: "gate_hold", retry: 1 }]);
    expect(evs(h.log, "window_join_deferred")).toHaveLength(0);
    expect(evs(h.log, "window_failed")).toHaveLength(0);
  });

  it("the clock closing during the backoff abandons the retry the same way: reason clock_closed, no resubmit", async () => {
    let n = 0;
    const h = harness({
      start: at(7, 9, 56, 22),
      cands: [cand("A")],
      status: () => (++n === 1 ? joinContended() : done()),
    });
    const s = await h.run();
    expect(s).toMatchObject({ started: 1, done: 0, failed: 0, joinDeferred: 0, windowDeferred: 1, fatal: null, stop: "submit_window_closed" });
    expect(h.submits.filter((x) => x.args.window_id === "A"), "no resubmit went out").toHaveLength(1);
    expect(evs(h.log, "window_deferred")).toEqual([{ event: "window_deferred", window_id: "A", job_id: "job_1", reason: "clock_closed", retry: 1 }]);
    expect(evs(h.log, "window_join_deferred")).toHaveLength(0);
    expect(evs(h.log, "window_failed")).toHaveLength(0);
  });

  it("a fatal (401/403 / mcp_scope_refused) answer on the RETRY submit stops the run exactly like a fatal on any other submit — not counted as a window failure", async () => {
    const h = harness({
      cands: [cand("A")],
      status: () => joinContended(),
      submit: (_args, k) => (k === 2 ? { ok: false, kind: "fatal", code: "mcp_scope_refused" } : { ok: true, job_id: `job_${k}` }),
    });
    const s = await h.run();
    expect(s).toMatchObject({ fatal: "mcp_scope_refused", stop: "fatal", failed: 0, started: 1 });
    expect(evs(h.log, "fatal")[0]).toMatchObject({ code: "mcp_scope_refused", window_id: "A", job_id: "job_1" });
    expect(evs(h.log, "window_failed")).toHaveLength(0);
  });

  it("join_contention_exhausted failures are kept OUT of the canary's consecutive-failure count: 6 in a row never trips too_many_failures", async () => {
    const cands = Array.from({ length: 6 }, (_, i) => cand(`W${i}`));
    const h = harness({ cands, status: () => joinContended() });
    const s = await h.run();
    expect(s).toMatchObject({ started: 6, done: 0, failed: 6, fatal: null, stop: "backlog_empty" });
    expect(evs(h.log, "window_failed")).toHaveLength(6);
    expect(evs(h.log, "window_failed").every((e) => e.error_code === "join_contention_exhausted")).toBe(true);
  });
});

describe("A STUCK JOB", () => {'''

insert_anchor_new = '''    expect(Object.keys(line).sort()).toEqual(["event", "job_id", "retry", "retry_job_id", "window_id"].sort());
  });
});

''' + new_describe

patch(
    "tests/unit/overnight-translate-driver.test.ts",
    [
        ("KEYS whitelist", keys_old, keys_new),
        ("exhausting JOIN_RETRY_LIMIT test", exhaust_old, exhaust_new),
        ("refused/deferred retry-submit test assertion", refused_old, refused_new),
        ("insert new join-retry-backoff describe block", insert_anchor_old, insert_anchor_new),
    ],
)

print("ALL PATCHES APPLIED")
