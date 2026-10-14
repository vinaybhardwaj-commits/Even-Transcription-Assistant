# HANDOVER radar-kit (Claude Code pane -> OpenCode, r432/432a) — written 26 Sep 2026 ~11:15 box clock

## (a) Role
Builder, Mini pane wX:p1. Owned: the herdr-radar sidebar plugin fork (rulings 145-259), the mic call-and-response self-test (W21, r368/369), piece C of link-3's translated stratum (r222). Everything lands via a named refuter's PASS, cherry-picked from a temp worktree onto then-current main; never `git add -A`, never the shared checkout's local branch.

## (b) Open items (bus ids)
1. **W21 mic self-test — run gate CLOSED, code done.** Landed main (base f30b279, several fixes on top — check `git log -- kit/mic-selftest` on current main for the real head). Default mode PLAN, no network, touches nothing. `--check-only`/`--live` refuse without a `calibration.json` at `status:"preregistered"` (today's is only `"proposed"`, in `calibration-proposal-20260925.json`) and `--fable-order`. NEEDS: V/Fable to label one occupied-quiet real-tape stretch so `calibrate.py --preregister` can run, then a named order. eta-refuter's last PASS: #2284. **Nothing has ever run on any room.**
2. **link-3 piece C — COMPLETE, landed, working in linker's real runs** (bus #1574, #1490). No open item; linker owns further changes.
3. **Radar daemons — running, healthy, untouched for hours.** Mini pid 1344 (survived the 25 Sep power-loss reboot via herdr's own startup hook, no manual restart needed — confirms the accepted design). eta-lab-t4 pid 40362 (headless, unaffected). Both `herdr config check` = ok, all agents tokenised. **Never `herdr server stop`**; if a server restarts, the daemon returns on its own (startup hook / `pane.agent_detected` event); only re-run the `state-start` plugin action if it does not.
4. **Mini sidebar visual check** (r237/240) never confirmed done on the bus — cosmetic only. Rollback in #1176 if disliked.
5. **voice-lab-1 residue**: `~/.local/node` (~200 MB), disposable, already disclosed (#2404); host now stopped.

## (c) Paths/shas
`kit/mic-selftest/` on main: mic_selftest.py, canary.wav (synthetic TTS, no patient audio, `-f` past the wav-ignore rule), selftest_filter.py, calibrate.py, tape_stats.py, null_distribution*.py + reports, calibration-proposal-20260925.json, README.md, 5 test_*.py (~150 tests, offline, ~150s). Radar plugin installed as a `git archive` extract, NOT a live checkout: Mini `~/.local/opt/herdr-radar-fork`, t4 `/home/eta/herdr-radar-fork` — both from an eta-lab main commit in the `10bc3d2`/`0619c5d`-era; re-extract from current main's `kit/herdr-radar/` if ever reinstalling. Mini config backups: `config.toml.bak-20260924-radar-check`, `...-220030-radar-mini` (untouched). No pids owned besides the two daemons above; no cron/units.

## (d) Rules never to break
Branch-first, cherry-pick only reviewed commits, check `git log origin/main..HEAD` before push, never force. Never stop/restart a herdr server, never rename/close a pane/tab/workspace. On a room Mac: only `afplay date tail stat pgrep scp rm`, never python3; no live self-test run without a named order + preregistered calibration. No secrets printed/argv'd — I hold none.

## (e) Tools
git, ssh/scp to the box (read-only + niced stats under `~/mic-cal`), `herdr` CLI (local + `--machine eta-lab-t4`), node, python3 stdlib (no numpy on the Mini), ffmpeg via the box, mcp__eta-bus.

## (f) Last decisions
#2284/#2292 W21 PASS + landed; #2404 disclosed voice-lab-1 residue; #2747 Mini daemon self-recovery confirmed, no action; consistently declined to touch the Mini before its gate, never restarted a herdr server even when it would have been faster.

## (g) First thing on waking
1. `bus_inbox`. 2. Confirm both daemon pids are unchanged (Mini 1344, t4 40362); if not, find out what restarted a server before touching anything. 3. Check if Fable ruled on W21's occupancy-label blocker. 4. Never `herdr server stop`. 5. Any link-3 piece-C change: fresh branch, mutation-test, land only on the named refuter's explicit "land".
