# ORDER — yoga-drain — put the night-drain under launchd, like the watchdog

## Why
The night-drain processed **620 windows** last night (night_end for 2026-09-20 at 01:57:28Z) and is
now idle by design until the 21:30 IST gate. But it is running as a **background shell owned by the
scribe3 Claude Code pane** — `nd-run.sh` in scribe3's scratchpad, runtime 20h+. If scribe3 is closed,
cleared or crashes, **the drain dies with it**, and it will not survive a reboot. You already made the
watchdog survive both. Do the same here.

## Task
1. Build a launchd job for the night-drain using the **same bootout-then-bootstrap pattern** you used
   for the watchdog. `kickstart` alone does not reload an edited plist; do not accept it as proof.
2. It must read the token from where scribe3 installed it on the Mini at 0600 — **never put the token
   in the plist, a command line, or a log**. Environment or file reference only.
3. It must keep the **closed-hours gate** (21:30–07:30 IST) exactly as it is. Do not move it — that is
   V's decision and he has not made it.
4. **Cut over without two drains running at once.** Wait until the current one is idle in its gate
   wait (it is now), stop it cleanly, then start the launchd one. Confirm exactly one night-drain
   process exists afterwards. Two drains leasing the same windows is the failure to avoid.
5. **Prove it**: restart the launchd job and show it comes back; show the new process is not a child
   of any tmux pane.

## Not allowed
Do not change the gate hours, concurrency (LIMIT 1 stays), the watchdog, or `ETA_MAX_INFLIGHT`.
Do not print any credential. Do not start a drain outside closed hours.

## Output
The plist path, the restart proof, the single-process check, and confirmation the gate is unchanged.
CAP 120 words.
