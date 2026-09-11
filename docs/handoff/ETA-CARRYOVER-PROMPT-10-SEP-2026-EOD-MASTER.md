# ETA carryover, 10 September 2026, 20:20 IST — EOD MASTER

**Spin up from this file.** Supersedes every earlier `ETA-CARRYOVER-PROMPT-*` (including the 05:50 and 19:40 versions of
this date). Companions, read in this order at spin-up: `ETA-ORCHESTRATOR-MEMORY.md` (how to work the line, rules 1–18) ·
`ETA-OPD-VISIT-RUNBOOK-11-SEP-2026.md` (the last walk, and §B the desk-side sequence after it) ·
`ETA-SESSION-MIGRATION-RUNBOOK-10-SEP-2026.md` v2 (the per-room keychain step) ·
`ETA-INSTALL-BUILD-B1-B1.5-ACCEPTANCE-VERDICT-10-SEP-2026.md` (evidence) ·
`ETA-ROOM-RECORDER-INSTALL-AND-FLEET-PRD-7-SEP-2026-v1.0.md` + its R3, B1, B1.5 addenda (the spec).

## 0. Where to work

Bus = the repo's own `docs/handoff/` on the Mini (`~/dev/Even-Transcription-Assistant`), mirrored to iCloud
`Daily Dash EHRC/ETA/`. Request `/Volumes/MiniDev`; `ReadMini` MCP reads the Mini when the share is down. The Air's clone is
stale; never read it. Mini: `ssh mini` (Tailscale 100.75.214.19); tmux `scribe` for Claude Code. Signing over SSH:
`security unlock-keychain ~/Library/Keychains/login.keychain-db`, password at the prompt; the cert is the `.p12` on the Mini —
**never raise credentials with V again.** `.env.local` in the repo root holds `MIGRATION_SECRET` + `BLOB_READ_WRITE_TOKEN`;
`vercel env pull` hangs over SSH — source the file. Fleet read: `GET $BASE/api/admin/bench/fleet` with
`Authorization: Bearer $MIGRATION_SECRET`. Every GitHub push/merge and every migration goes through Claude Code.

## 1. Live state (verified 10 Sep 14:24Z)

Production `7d21f5e`, migrations through 0078. Branch `vinay/release-b1`: pushed tip **`5cc6931` = the accepted code
(0.1.13)**; two local-only commits on the Mini, `b05523d` (0.1.15 bump) and `5dff406` (0.1.16 bump) — push with the next
Claude Code session. `main` = `7ffb168`, `feat/room-recorder` = `1193083`, both untouched. `Packaging/VERSION` = `0.1.16`;
**next version string 0.1.17.**

Releases: stable **0.1.8** `rel_nz8d8uh5q9pj` (+0.1.7). test **0.1.13** `rel_55k9s67ab6af` (+0.1.10, 0.1.8). Dead:
0.1.9, 0.1.11, 0.1.12, 0.1.15, 0.1.16 (withdrawn rows are permanent; every re-offer is a new version).

| Room | Mac | Install (card) | App | Last poll 14:24Z | sshd | Mic |
|---|---|---|---|---|---|---|
| Home Office (= the Mini) | Vinay's Mac mini | `install_k54jsz5r4cyz` | **0.1.13 `test`**, migrated | live | yes | — |
| Cardiology | ECHO 100.74.103.103 | `install_qaymgdq3cgvq` | 0.1.8 | **13:57Z — asleep/off since 19:27 IST** | yes | **none** |
| OPD 3 | CONSUL4 100.102.9.70 | two rows: `CONSUL4` and `CONSUL4 (2)` | 0.1.8 | live | no | TONOR (clips) |
| OPD 5 | CONSUL5 100.87.161.101 | `install_yut3nnsvhn68` | 0.1.8 | live | no | C270 (unusable) |
| OPD 6 | CONSUL6 100.122.91.123 | `install_j6k3essxumrc` | 0.1.8 | live | no | C270 (by decision) |
| OPD 7 | CONSUL7 100.127.98.43 | `install_xw3fzmzkc8bz` | 0.1.8 | 14:18Z — 6 min behind | no | TONOR |
| Room 4.1 | DISCUSSION 100.109.240.30 | `install_4gx7pey6h55s` | 0.1.8 | live | no | C270 |

Also on the card: `EHRC-CONSUL2's Mac mini (2)` (no room known) and one all-null row — reinstall-round duplicates; the
install_id in each Mac's `config.json` is the truth (visit runbook §A3 collects it).

## 2. What is DONE, and the one gate in front of everything

**Release B1 + B1.5 are accepted at `5cc6931`, proven remote on Home Office 10 Sep:** session file + clean fallback (0.2 s),
launch canary (ack 2 s), rollback (181 s ×3, H1 restore-before-delete), ledger (one retry, then 6 h hold), withdraw as a
canary-guarded downgrade, 535 tests 0 issues, §13.5 items 1–4 + 7 proven remote. Keychain root cause closed: partition list
(cdhash) + ACL (designated requirement); migration = admit the new cdhash over SSH, offer the build, the app writes the file.

**The gate:** every clinic Mac's keychain item admits only 0.1.8, and only Cardiology has sshd — and Cardiology went to sleep.
V ruled **B (Cardiology first on `test`)**, then merged with A: **one visit** (`ETA-OPD-VISIT-RUNBOOK-11-SEP-2026.md` §A) makes
all six Macs sleepless, sshd-on, Tailscale-up, correctly miked; after it nothing on this line is ever done in a room again.
**Do not publish anything to `stable` before the six partition steps** — offered early, a room fails clean, rolls back, retries
once, holds 6 h, and clearing the hold burns a version.

## 3. The ladder to completion (sequential; each rung has its exit test)

1. **The visit** (runbook §A). Exit: six `ssh <user>@<tailscale-ip>` connections from the Air succeed; §C table full.
2. **Partition steps ×6** (runbook v2). Exit: `partition list: resident + <cdhash> admitted` on each; card ids match config.json.
3. **Cardiology on `test`** (bootout → `update_channel: test` → bootstrap). Exit: row `0.1.13 / ok`, `room-session.json` 0600,
   `scribe_diff_room` listening, one OPD day with no finding.
4. **0.1.17 → `stable`** (same code as 0.1.13; new version string; `build-bundle.sh` → publish; each room takes it at its next
   check — first poll after launch, session end, or 6 h). Exit: six rows `0.1.17 / 5cc6931-line / ok`; `update.log` on one
   room read over SSH shows `acknowledged the canary`. **This closes the Install & Fleet PRD §13/§14/§15 on the whole fleet.**
5. **Release B2** (remote, one kickoff, one refutation; write the PRD addendum first, no open issues): real peak + exact-zero in
   `TapeWriter.swift:256-260`; `tape_advancing` unit; `currentLevels` reparse; input-device read-only list on the card;
   retention; rescue-`mv` check; G2 residual; fleet `last_update_reason` mapping (verdict finding 1); the double session-read
   log line (finding 5); `build-bundle.sh` preflight text; fleet duplicate-row hygiene (dedupe by install_id, show the
   config.json id); §13.5 item 5 (corrupted zip) and item 6 live kill as acceptance items. Exit: verdict PASS on Home Office,
   then the same test→stable rhythm as rung 3–4.
6. **R2.5 server-side per-piece audio measurement** (ratified order 9 Sep: server-side at ingest, stored beside each piece,
   each room judged against its own history; MCP is only the door). Can run in parallel with rung 5 in the web repo.
7. **R4 room audio control** (app reports every input device + level; command bus sets both; fifth command kind — ride a
   fetched route so 0.1.7-era clients are not broken). This is what makes OPD 3's clipping and OPD 5's instrument a paste, not a walk.
8. **Loudness normalisation**, then **active tone self-test** last (designed now, built last, out-of-hours only).
9. Hygiene at the end: fast-forward or retire `feat/room-recorder`; version scheme (acceptance burns ~3 versions per release —
   ratify or add an `-rcN` lane); `.p12` escrow off the Mini; Vercel `maxDuration`.

**Definition of done for this line:** all six rooms on a `stable` build ≥ B2, every room adjustable from the desk (R4), every
piece measured at ingest (R2.5), and the programme question — is the audio transcribable — answered with paid runs V ordered.

## 4. Owed / carried

1. Cardiology: awake + mic (visit). OPD 7 auto-login. OPD 5 TONOR swap. OPD 3 input level.
2. Push `b05523d`, `5dff406` (or drop them) with the first Claude Code order of the next thread.
3. Carried unchanged: `AUDIO_JOIN_*`; Neon checks; Gemini flips; tuning-fork clip; eleven Cardiology windows; gold
   graduation; `ZZ Verification Probe`; transcript lanes off in OPD 3/5/7.

## 5. The programme question

Unchanged: is this audio transcribable? OPD 7 almost certainly; Cardiology probably, once it has a mic; OPD 3 damaged by
clipping (input level, then measure); OPD 5 wrong instrument (TONOR, then measure). Nothing paid has run; every transcription
is a paid call fired only when V asks.

## 6. Spin-up paste for the next thread

> Spin up ETA from `docs/handoff/ETA-CARRYOVER-PROMPT-10-SEP-2026-EOD-MASTER.md` on the Mini (mirror in
> `Daily Dash EHRC/ETA/`). Read it and `ETA-ORCHESTRATOR-MEMORY.md` first. Verify live state before trusting either:
> `scribe_diff_room` once per room, the fleet route, the Mini's git refs. Then: if the OPD visit is done, take the §C table
> from `ETA-OPD-VISIT-RUNBOOK-11-SEP-2026.md` and run its §B; if not, the visit is the first move. Orchestrator only —
> Builder/Refuter/Scout/Researcher per the six-role split; verdicts never delegated.
