# kit/lab-run.sh — Refuter verdict (eta-refuter-2, 23 Sep 2026)

Under review: eta-lab `kit/lab-run.sh` @ 2aa5e05 (herdr-kit, LANES L10). Checked against
`orders/RULING-MINI-NIGHT-LAB.md`. Not built by this session. No lab machine was locked or loaded. The only
remote commands were read-only `ls`/`command -v` on the Mini and on orbox3.

**VERDICT: FAIL. Fix R1 before anything relies on its exit code. R2 and R3 before long night batches.**
Machine selection, the window arithmetic and the flock hosts are right. The runner loses the result it
exists to report.

## R1 (HIGH, reproduced): every job reports rc=0
lab-run.sh:141 runs `{ $CMD ; } 2>&1 | tee '$logfile'` with no `pipefail`. orbox3's login shell is
`/bin/bash` and the Macs' is `/bin/zsh`, and neither enables it by default. So RC at :145/:148 is **tee's**
exit code. I ran the script's exact REMOTE_SCRIPT construction with a failing job:
`exit 3` → RC=0 (bash), RC=0 (sh); a python `sys.exit(5)` → RC=0. `done: … rc=0` is printed for a crashed
batch. This is the repo's own standing rule ("`cmd | tail` returns tail's exit code … has already produced a
false 'installed successfully'"). Fix: start REMOTE_SCRIPT with `set -o pipefail;` (bash and zsh both support
it). Better: write the job's own status to `$logdir/<run>.rc` and have the client read that back. Test it with
`-- false`, which must exit non-zero.

## R2 (HIGH for night batches, modelled): a dropped ssh kills the job and truncates its log
The job's only stdout is `tee`, and tee's stdout is the ssh channel. When the client goes away (pane
restart, a Tailscale blip, the caller's own `timeout`), tee takes SIGPIPE and exits. The job then dies on
its next write. The "machine's own log" stops at the same line. Modelled locally with the exact pipeline:
the reader closed after 2 lines, the log held 2 of 8 lines, and the job never finished. I didn't test this
over a real ssh drop, because the lab hosts are busy tonight. Fix: run the job detached on the remote
(`nohup`/`setsid`, output to the log file only), write `.rc` on exit, and have the client `tail -f` the log
until `.rc` appears. A disconnect then costs the view, not the run.

## R3 (MEDIUM): the ruling's guards are checked once at start, or not at all
- **Hard stops aren't enforced.** The window is checked only at pick time. A job started at 09:55 on the Mini
  (production, HARD STOP 10:00, "`pgrep -f eta-lab-night` must be empty") or at 06:40 on orbox3 runs on as
  long as it likes. Fix: `timeout` the remote job to the window end, and refuse to start if less than a
  stated minimum remains.
- **The memory guard is missing.** The Mini and audiometry rulings require "start only if memory_pressure ≥ 30%
  free" and a self-stop below 15%. Neither is checked. On the Mini this is production memory: see
  CLAUDE.md on `mini-pressure.jsonl` STOP lines.
- **nice isn't applied.** The ruling requires `nice -n 19` on audiometry, the Air and (by practice) orbox3.
- **The Air's AC check runs only at start.** The ruling says stop if it switches to battery.

## R4 (MEDIUM): mkdir locks on the Macs don't match the ruling, and they can go stale forever
- The Mini ruling says `flock /tmp/mini-lab.lock`, and audiometry and the Air say `lockf` or a pidfile.
  lab-run uses a mkdir DIRECTORY at those paths. That excludes only other lab-run calls. A pidfile job on
  audiometry or the Air is not excluded at all (`lab-run.lock` is a different path).
- `/usr/bin/lockf` IS on the Mini (checked read-only). It is a kernel lock that is released when the
  process dies, which is exactly what flock gives on Linux. The comment at :16–23 says no reliable
  primitive exists. It does.
- A mkdir lock is released only by the EXIT trap. SIGKILL, a power loss, or an OOM kill leaves the directory
  behind, and the machine then reads "lock held" until someone removes it by hand. The audiometry lock sits
  in `$HOME`, so it survives reboots too. Fix: use `lockf -t 0 <path> <job>` on macOS, and have every tool
  on that host use the same path and the same primitive.

## Lower
- `CMD="$*"` flattens argument boundaries: `-- python x.py "a b"` runs `python x.py a b`. Document
  "pass one quoted string", or send argv properly.
- rc 17 means "lock busy", but a job can also exit 17. Once R1 is fixed, the race message at :151 can
  mislabel a real job failure. Use a code outside the usual range, or a marker line.
- The PANE name goes unescaped into single-quoted remote paths. Trusted callers only; reject `'` and `/`.

## Verified good
- Window arithmetic (`in_window`) handles wrap-past-midnight windows, and a zero-padded HHMM compares as
  decimal under bash. The script runs under zsh, which isn't installed on this box: UNVERIFIED there, though zsh's
  default (OCTAL_ZEROES off) also reads it as decimal.
- flock hosts (t4, gcp-l4, orbox3) use the ruling's paths. orbox3's `/tmp/eta-lab-night.lock` exists as a
  file, which is consistent with flock.
- `--machine` refuses (17) rather than stealing a held lock or running out of window. The probe-then-run race
  is handled by the real lock at run time, not by the probe.

## Re-check of b7b0ace (24 Sep 06:40 IST, Fable ruling 7): STILL FAIL. Two new defects, one reproduced on the real host
The redesign is right in shape, and R1, R2 and R4 are FIXED, proven by running it (a local test copy with a scratch
flock row on the localhost path, plus the real script against audiometry):
- **R1 fixed:** `-- false` → 1, `-- "exit 3"` → 3, `python3 … sys.exit(5)` → 5, and the job's output streams back.
- **R2 fixed:** the client was killed 3 s into a 12 s job. The job still ran to `FINISHED` and wrote `.rc` = 0.
- **R4 fixed:** `lockf -k -t 0` on the Macs; `/usr/bin/lockf` is present on the Mini and on audiometry.
- R3 partly: hard-stop `timeout`, nice, memory guard at start (≥30%) and in-run (<15%), and the AC watchdog are all present. But see L2.

New:
- **L1 (HIGH): flock race = infinite hang.** On flock hosts (t4, gcp-l4, orbox3) the launch runs
  `flock -n 9 || exit 75` BEFORE any `.rc` is written, so a lock taken between the probe and the launch leaves
  no `.rc`, and the client's tail loop waits forever (each remote tail is capped at 6 h, then it loops again).
  Reproduced: the probe patched to say "free", the lock actually held, no `.rc`, the client still waiting at 25 s
  (timeout 124). The lockf branch is correct (its 75 reaches `.rc`). Fix: `flock -n 9 || { echo 75 > '<rc>'; exit 75; }`.
- **L2 (HIGH): every audiometry job fails with 127.** audiometry's non-interactive PATH is
  `/usr/bin:/bin:/usr/sbin:/sbin`, and there is NO `timeout` binary (also none under `bash -c`). The in-window
  RUN_CMD is `timeout <secs>s nice -n 19 bash <job>`. **Reproduced on the real host:** `--machine audiometry --
  'echo hello-audiometry'` → `bash: timeout: command not found`, **rc 127**. (The Mini has
  /opt/homebrew/bin/timeout on its PATH, and gcp-l4 has /usr/bin/timeout.) Fix: probe for `timeout`/`gtimeout`
  and fall back to a shell watchdog that kills the job group at the window end. Never build a command
  around a binary the host lacks. My test files there are removed.
- **L3 (LOW): unreachable reads as "lock held".** From the box, `ssh eta-lab-t4` fails (Host key verification
  failed), is_free returns false, and the result is `BLOCKED: … lock is held`, exit 75. Absent and busy are
  collapsed again (see the three-state probe rule in the ledger). Report 69 "unreachable" when ssh itself fails.

## Re-check of 52453f7 (24 Sep 07:15 IST, Fable ruling 19): **PASS**
All three of b7b0ace's new defects are closed, each proven by running it (a local test copy with a scratch flock row,
and the real audiometry host inside its window at 07:16):
- **L1 fixed:** probe patched to say "free" while the lock is held → exit **75 in 0 s** (was: waited forever).
  The flock branch now writes 75 to `.rc` before exiting.
- **L2 fixed, on the real host:** audiometry `-- 'echo hello-audiometry'` → **rc 0**, output streamed (was: rc 127,
  "timeout: command not found"). The hard stop is now a plain-shell watchdog. Forced 6 s window (test hook) with
  `sleep 40`: **rc 124** after 14 s (5 s poll), "hard stop: window ended", **0 leftover processes** on audiometry.
  The same on the local copy: rc 124 after 12 s, 0 left.
- **L3 fixed:** `--machine eta-lab-t4` from the box (ssh fails on the host key) → "unreachable over ssh", **exit 69**
  (was: 75 "lock held").
- Exit codes still right: false→1, exit 3→3, sys.exit(5)→5.
Non-blocking notes: the hard stop has 5 s granularity, so a job can overrun the window end by up to ~5 s. The
`LAB_RUN_TEST_WINDOW_SECS` hook is a test-only override reachable from the environment; harmless, since it can only
SHORTEN a run. My test files on audiometry are removed.
