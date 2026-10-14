#!/usr/bin/env python3
import sys

path = "lib/overnight-translate/driver.ts"
with open(path, "r", encoding="utf-8") as f:
    text = f.read()

old = '''        await deps.sleep(JOIN_RETRY_DELAY_MS, signal);

        // THE SAME TWO GATES EVERY OTHER SUBMIT CHECKS (driver.ts's own steps 1 and 2), re-read on the far
        // side of the backoff sleep — real time the retry itself just spent. A clock that closed, or a
        // watchdog/disk gate that said STOP, while this retry waited is not a fact about THIS window, so it
        // is not a failure and it does not touch `consecutiveFailures`: the retry is simply abandoned and the
        // window is left for a later run to re-pick (Refuter finding 1, 22 Sep 2026).
        if (!maySubmit(deps.now())) {
          s.windowDeferred += 1;
          deps.log({ event: "window_deferred", window_id: a.c.window_id, job_id: jobId, reason: "clock_closed", retry: a.joinRetries + 1 });
          return false;
        }
        const g = deps.gate();
        if (!g.go) {
          s.windowDeferred += 1;
          deps.log({ event: "window_deferred", window_id: a.c.window_id, job_id: jobId, reason: "gate_hold", retry: a.joinRetries + 1 });
          return false;
        }

        const sub = await deps.door.submitRoomWindow(jobArgsFor(a.c, deps.origin), signal);'''

new = '''        await deps.sleep(JOIN_RETRY_DELAY_MS, signal);

        // MUTATED: the re-check removed.
        const sub = await deps.door.submitRoomWindow(jobArgsFor(a.c, deps.origin), signal);'''

n = text.count(old)
if n != 1:
    print(f"FAIL: anchor found {n} times (expected 1)")
    sys.exit(1)
text = text.replace(old, new)
with open(path, "w", encoding="utf-8") as f:
    f.write(text)
print("MUTATED")
