# ETA carryover, 11 September 2026, 19:45 IST — EOD MASTER (v3, post-B2)

**Spin up from this file.** Supersedes `ETA-CARRYOVER-PROMPT-11-SEP-2026-EOD-MASTER.md` (14:50, v2) and everything before it.
Companions, in this order: `ETA-ORCHESTRATOR-MEMORY.md` (rules 1–30) · `ETA-INSTALL-AND-FLEET-PRD-RELEASE-B2-ADDENDUM-11-SEP-2026.md`
(D1–D14, ratified 18:12) · `ETA-KICKOFF-B2-S-FLEET-SERVER-11-SEP-2026.md` + `ETA-B2-S-BUILD-REPORT-…` + `ETA-B2-S-REFUTER-VERDICT-…` ·
`ETA-KICKOFF-B2-A-APP-0.1.20-11-SEP-2026.md` + `ETA-B2-A-BUILD-REPORT-…` (Rollout section) + `ETA-B2-A-REFUTER-VERDICT-…` ·
`ETA-KICKOFF-0.1.19-FIRST-CLINIC-SELF-UPDATE-11-SEP-2026.md` + report + verdict · `ETA-ROOM-SSH-ACCESS-NOTE-11-SEP-2026.md`.
**Obsolete:** `ETA-SESSION-MIGRATION-RUNBOOK-10-SEP-2026.md` (header says so, kept as history), rule 19.

## 0. Where to work (two changes from v2)
Bus = `~/dev/Even-Transcription-Assistant/docs/handoff/` on the Mini, **now tracked and on origin** (commit `e908b84` onwards; the
committed `CLAUDE.md` rule to keep it untracked was overruled 18:45 — the repo is public, the bus holds Tailscale IPs and room
logins, V to decide private-flip vs move-out). Mirror to iCloud `Daily Dash EHRC/ETA/`. `ReadMini` for reads; the Samba share is up
but `git` over it hangs — write through it, never run git on it. Claude Code sessions on the Mini: tmux `scribe` (Builder) and
`scribe2` (Refuter); every paste names its window. Vercel CLI is not on the Mini and there is no token in `.env.local`: promote
from the Vercel dashboard (a Sonnet browser agent did it at 18:17 in the Cowork browser, signed in). `.env.local` sourced, never
echoed, never `vercel env pull`.

## 1. Live state (verified 14:03Z fleet route + 14:01Z listeners)
Production **`e908b84`** (B2-S), migrations through **0079**. Branch `vinay/release-b1` = origin = **`07dabbf`**, tree clean.
`Packaging/VERSION` = `0.1.20`; next version string **0.1.21**. Releases live: `stable` 0.1.20 `rel_fpscgwpuqqys`, 0.1.19
`rel_t3twevq5msr3`, 0.1.18 `rel_2wkm4erfbysh`; `test` 0.1.20 `rel_neygnnarrp2q`, 0.1.19 `rel_7ty86r437c4e`, 0.1.18 `rel_nr39q24q9v9n`.
Withdrawn 14:03Z: `test` 0.1.17/0.1.13/0.1.10/0.1.8, `stable` 0.1.8/0.1.7; plus `test` 0.1.20-bad `rel_cdgjnjpjhqb6` (item 5 probe).

| Room | install_id | App / channel | Default input | peak / zero_ratio 14:03Z | Disk free |
|---|---|---|---|---|---|
| Home Office (Mini) | `install_539avu7gqzz5` | 0.1.20 `test` | TONOR TM20 (re-seated 19:13, direct port) | idle | — |
| Room 4.1 | `install_d3sy3ufas8jv` | 0.1.20 `test` | C270 | 0.022 / 0.0001 | 167 GB |
| OPD 6 | `install_d2nkvqcnqb7k` | 0.1.20 `stable` | C270 | 0.018 / 0 | 168 GB |
| OPD 5 | `install_e3yjw3ut698x` | 0.1.20 `stable` | C270 | 0.0257 / 0.0003 | 137 GB |
| OPD 3 | `install_fc2jt2zs4x8v` | 0.1.20 `stable` | C270 default, records from TONOR | **0 / 1 — dead input** | — |
| Cardiology | `install_pgrped6322ss` | 0.1.20 `stable` | TONOR TM20 | populated | — |
| OPD 7 | `install_6m45w69ux7tj` | 0.1.20 `stable` | TONOR TM20 | **0 / 1 — dead input** | 143 GB |
| OPD 1 / OPD 4 | `fygsnma88x2d` / `kurmsj5wdjau` | 0.1.8 | — | PARKED | 164 GB (OPD 4) |

All seven ids unchanged through two self-updates. Every disk above the 20 GB amber line. Rooms were empty from ~19:00 IST;
an empty room on a live mic reads peak ≈ 0.02 — **OPD 3 and OPD 7 read bit-exact zero, which only a muted or dead input produces.**

## 2. What closed today
1. **0.1.19 — first clinic self-update** (`da58a4c`, ACCEPT 17:05). Room 4.1 swapped unattended on `test` 11:33:23Z (8 s end to end);
   `stable` 11:35:45Z; five rooms swapped on `kickstart -k` 11:46–11:47Z. Install & Fleet PRD §13/§14/§15 closed on the fleet.
2. **B2-S** (`0b9757a`, ACCEPT; production `e908b84` 12:47Z, 0079 applied 12:42:49Z): one row per room (28 earlier installs behind
   counts), D4 sentence (`room-install-view.ts:534` was printing the stock text), assign-channel one-way + self-clearing, disk levels,
   peak/zero/devices intake, `bench-commands.ts` returns `assigned_channel` in the existing poll query.
3. **B2-A = 0.1.20** (`74a79ea`, 563 tests / 45 suites, ACCEPT with 7/7 adversarial answers cited; rollback both ways proven by
   compiling both revisions). Rollout: `test` 13:37Z Home Office → item 5 corrupted zip PASS 13:48Z (`signature_mismatch`, resident
   untouched, sentence on card) → Room 4.1 13:51:47Z → `stable` 13:53Z → five rooms 13:59:05–14:00:29Z, every canary 2 s.
   D7, D10, D11 each proven on hardware within minutes of landing. Item 6 waived (a kill in the `sleep 3` rescues with the resident in
   place — no rollback to observe; the FIFO test remains the proof).
4. D10's first poll caught a stale card (Home Office "TONOR" with no TONOR attached); D7's first fleet read caught two dead inputs.

## 3. The ladder from here
1. **OPD 3 and OPD 7 inputs, first thing tomorrow** (someone in the room, 2 min each): TM20 mute button → cable → if still 0/1, swap
   the default to the C270 by hand. Confirm on the card: peak > 0. Then OPD 5's TONOR swap (owed since 10 Sep) and OPD 3's level.
2. **B3 kickoff** (PRD addendum first, one line each, no open issues): card "up to date since <t>" after a successful check (today it
   holds the last failure — Home Office still reads `signature_mismatch`); `+` in device names arrives as a space (`BenchClient` query
   encoding); config.json rewrite on D5 drops unknown keys; D11 dedupe also masks the engine's silent read (`RoomEngine.swift:777`);
   D10 total-length cap app-side (server caps 16,384); CoreAudio enumerated twice per poll; D9 tail reader looser than the old
   whole-file read (skips undecodable lines, no `rms` range check); retention deletion after V rules on the archive; `input_device_name`
   COALESCE staleness (the list is fresh, the name is not); the unassigned `install_7fs9pxt8gdcf` row (retire it); `ended_at_lies`
   root cause (Debugger brief, read-only: `bs_zgrm28z3`, `bs_3t5tp8qy`, `bs_cag5hdmb`); public-repo bus decision.
3. **R2.5 → R4 → loudness → tone**, order unchanged. R4 is what turns item 1 into a paste: the app now reports every input (D10);
   R4 adds the set command.
4. Version scheme: 0.1.17–0.1.20 in one day is the acceptance cost; ratify as-is or add `-rcN`.

## 4. Owed / carried
OPD 3 + OPD 7 dead TONOR input (above) · OPD 5 TONOR swap · OPD 3 input level · OPD 4 / OPD 1 walks (PARKED) · Home Office TONOR
was through a dead hub port until 19:13 — now direct · Even cert untrusted in Room 4.1 System keychain (harmless) · shared room login
password (governance) · `.p12` escrow · `feat/room-recorder` retire · transcript lanes: Room 4.1 24 windows, Cardiology 26, OPD 5 26,
OPD 6 23, OPD 3 15, OPD 7 12 waiting — paid runs only on V's order · Gemini STT disabled · OPD Test room listener dead since 7 Sep.

## 5. The programme question
Unchanged: is the audio transcribable? New instruments say: Room 4.1 / OPD 5 / OPD 6 have live mics (peak ≈ 0.02 empty, 0.16–0.62
speech on the Mini's TM20); OPD 3 and OPD 7 have recorded digital silence for an unknown span — check their `tape.idx` zero_ratio
history before spending a paid run on either. Nothing paid has run.

## 6. Kickoff for the next thread (the first hour)
1. Spin up (paste below). Verify: `scribe_system_map` seven listeners on the §1 ids; ReadMini refs `origin/vinay/release-b1` = `07dabbf`;
   fleet row peaks for OPD 3 / OPD 7 (via `scribe` Builder read — the route is proxy-blocked from Cowork).
2. If someone can reach OPD 3 / OPD 7: ladder step 1, then re-read.
3. Write the B3 PRD addendum (§3.2) → V ratifies → B3 kickoff (server first if any server item, then app 0.1.21).

## 7. Spin-up paste for the next thread

> Spin up ETA from `docs/handoff/ETA-CARRYOVER-PROMPT-11-SEP-2026-EOD-B2-MASTER.md` on the Mini (mirror in `Daily Dash EHRC/ETA/`). Read it and `ETA-ORCHESTRATOR-MEMORY.md` (rules 1–30) first. Verify live state before trusting either: `scribe_system_map` listeners (tab_id = install id) and `scribe_diff_room` once per room; the Mini's git refs via ReadMini. OPD 4 and OPD 1 are parked — ignore them. Then run carryover §6: OPD 3 / OPD 7 inputs if a hand is available, then the B3 PRD addendum and kickoff. Orchestrator only — Builder/Refuter/Scout/Researcher per the six-role split; every Claude Code paste in a code block and naming its tmux window; verdicts never delegated; passwords never through Claude Code `!`.
