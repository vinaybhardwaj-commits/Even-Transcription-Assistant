# ETA carryover, 11 September 2026, 14:50 IST — EOD MASTER (v2)

**Spin up from this file.** Supersedes `ETA-CARRYOVER-PROMPT-10-SEP-2026-EOD-MASTER.md` and everything before it. Companions,
in this order: `ETA-ORCHESTRATOR-MEMORY.md` (rules 1–26) · `ETA-OPD-VISIT-RUNBOOK-11-SEP-2026.md` §C (the fleet table, now
mostly filled) · `ETA-ROOM-OPD7-BRING-UP-11-SEP-2026.md`, `ETA-ROOM-OPD4-BRING-UP-11-SEP-2026.md`,
`ETA-ROOM-OPD1-BRING-UP-11-SEP-2026.md` (the three remaining walks) · `ETA-ROOM-SSH-ACCESS-NOTE-11-SEP-2026.md` (shareable) ·
`ETA-KICKOFF-0.1.18-DROP-ANCHOR-TRUSTED-11-SEP-2026.md` + `ETA-0.1.18-BUILD-REPORT-…` + `ETA-0.1.18-REFUTER-VERDICT-…` (the
build) · `ETA-KICKOFF-0.1.17-STALE-SESSION-ID-11-SEP-2026.md` + its report and verdict.
**Obsolete as of today:** `ETA-SESSION-MIGRATION-RUNBOOK-10-SEP-2026.md` (partition step), orchestrator rule 19 (keychain unlock
before enrol) — both only applied to the 0.1.8/0.1.13 line, which no clinic Mac runs any more.

## 0. Where to work (unchanged, two corrections)

Bus = `~/dev/Even-Transcription-Assistant/docs/handoff/` on the Mini, mirrored to iCloud `Daily Dash EHRC/ETA/`. `ReadMini` MCP
reads the Mini; `/Volumes/MiniDev` did not mount all day. Claude Code on the Mini in tmux `scribe`. Corrections: the VERSION file is
`apps/room-recorder/Packaging/VERSION`; the fleet route (`www.evenscribe.app`) is proxy-blocked from every Cowork shell — read
fleet state from `scribe_system_map` (listener `tab_id` = install id) or from Claude Code on the Mini. `.env.local` on the Mini
holds the secrets; source it, never `vercel env pull` over SSH.

## 1. Live state (verified 14:24 IST, `scribe_system_map` + per-room `scribe_diff_room`)

Production `7d21f5e`, migrations through 0078 (no server change today). Branch `vinay/release-b1`: origin = `964e426` (0.1.18),
`faafd04` (0.1.18 verdict) pushed after. Releases: **`stable` 0.1.18 `rel_2wkm4erfbysh`, `test` 0.1.18 `rel_nr39q24q9v9n`.**
Retired today: `test` 0.1.17 `rel_7be2fv7s62x9`, `stable` 0.1.8. Next version string: **0.1.19.**

| Room | Mac / user | Tailscale | App | install_id (config.json) | Tape 14:24 |
|---|---|---|---|---|---|
| Home Office (Mini) | vinaybhardwaj | 100.75.214.19 | 0.1.18 `test` | `install_539avu7gqzz5` | idle |
| Room 4.1 | DISCUSSION / ehrc-discussion | 100.109.240.30 | 0.1.18 `stable` | `install_d3sy3ufas8jv` | recording |
| OPD 6 | CONSUL6 / ehrc-consul6 | 100.122.91.123 | 0.1.18 `stable` | `install_d2nkvqcnqb7k` | recording |
| OPD 5 | CONSUL5 / ehrc-consul5 | 100.87.161.101 | 0.1.18 `stable` | `install_e3yjw3ut698x` | recording (C270 — TONOR swap still owed) |
| OPD 3 | CONSUL4 / ehrc-consul4 | 100.102.9.70 | 0.1.18 `stable` | `install_fc2jt2zs4x8v` | recording (TONOR level 50% still owed) |
| Cardiology | ECHO / ehrc-echo | 100.74.103.103 | 0.1.18 `stable` | `install_pgrped6322ss` | recording, TONOR TM20, first full day (4 h 10 m) |
| OPD 7 | CONSUL7 / ehrc-consul7 | 100.127.98.43 | 0.1.18 `stable` | `install_6m45w69ux7tj` | recording — sleep=0, sshd, auto-login (`/etc/kcpassword` 13:48) all proven 14:29 |
| OPD 1 | ? | not on Tailscale | 0.1.8 | `install_fygsnma88x2d` | **PARKED by V (11 Sep)** — recording; will fail-and-hold 0.1.18; leave alone |
| OPD 4 (Ortho) | ? | not on Tailscale | 0.1.8 | `install_kurmsj5wdjau` | **PARKED by V (11 Sep)** — "recording", mic level 0; leave alone |

Six clinic Macs (all but OPD 4 and OPD 1) have `sleep=0`, sshd on, Tailscale up, auto-login where needed — proven by login. **The fleet for every order below = these six + Home Office. OPD 4 and OPD 1 are parked; do not spend a turn on them unless V says so.** SSH note for staff: `ETA-ROOM-SSH-ACCESS-NOTE-11-SEP-2026.md`.

## 2. What closed today (and how)

1. **The visit, most of it, from the desk.** Cardiology, OPD 3, OPD 5, OPD 6, Room 4.1: pmset/sshd/Tailscale proven by one collector
   paste (§C). OPD 6's stall was a half-enrolled install, not the C270.
2. **0.1.17 — stale session id** (`5a36727`, ACCEPT 11:49): config.json outranks a stale `room-session.json`; one RETIRED retry;
   re-enrol resets channel to `stable`. Root cause of the four dead Home Office bootstraps.
3. **0.1.18 — `anchor trusted` removed from the pinned requirement** (`964e426`, ACCEPT 13:23). Discovered when Room 4.1, the
   first clinic Mac ever to run a self-update, rejected 0.1.17: `anchor trusted` consults the Mac's trust store, the Even cert is
   self-signed, no clinic Mac trusts it, and trust cannot be set over SSH (`SecTrustSettingsSetTrustSettings: no user interaction`).
   Proven both ways on Room 4.1 (leaf-only exit 0, old exit 3), twice. Leaf pin + sha256 + size + `--strict --deep` remain. PRD R3-5
   addendum written by the Builder.
4. **The keychain left the line.** 0.1.17+ `enrol` writes `room-session.json` only, so a bootstrap paste over SSH re-enrols a Mac on
   0.1.18 with no keychain unlock, no partition step, no keychain password, no trust click. Five rooms done 13:58–14:23, ~3 min gap
   each (stop tape via MCP → ssh -t → card's curl → check line → start tape via MCP). Cardiology's and OPD 3's unknown keychain
   passwords never mattered.
5. **Home Office** self-updated 0.1.13 → 0.1.17 → 0.1.18 through the real path (canary ack 2 s each).

## 3. The ladder from here (V ratified 14:50: OPD 4 and OPD 1 parked; the seven rooms are the fleet)

1. **The first true clinic self-update — the acceptance the whole line has been waiting for.** Every clinic Mac now runs the
   leaf-only verifier, but no clinic Mac has yet SWAPPED unattended. Build **0.1.19** (smallest possible change: VERSION bump +
   the `build-bundle.sh:231` stale "pinned to our anchor" heading + CHANGELOG line), Refuter, publish to `test`, switch **Room 4.1**
   to `test` (bootout → `plutil -replace update_channel -string test` → bootstrap; the app's first poll checks), then stop its
   tape via MCP so the deferral clears, and watch `update.log`: `swapping to 0.1.19` → `explicit requirement satisfied` →
   `acknowledged the canary`. Fleet row `0.1.19 / ok`. Then publish 0.1.19 to `stable`; the other five take it at their next check
   (first poll after launch, session end, 6 h). **Exit: six clinic rows `0.1.19 / ok` with nobody in a room.** That closes
   Install & Fleet PRD §13/§14/§15 on the fleet.
2. **B2 kickoff** (write it first — no open issues in the PRD addendum; carryover 10 Sep §3 item 5 plus today's list): fleet card
   dedupe by config.json id (≈12 retired rows today); `ended_at_lies` on `bs_zgrm28z3` / `bs_3t5tp8qy`; enrol-saves-file-not-config
   edge (Refuter, 0.1.17); server-assigned channel (one-way: server may move a Mac to `stable`, never to `test`); transcript-lane
   drain (Room 4.1: 12 windows waiting, no cron); `set-key-partition-list` refusal on the Mini; retire the partition-step runbook and
   rule 19 formally; real peak + exact-zero in `TapeWriter.swift:256-260`; `tape_advancing`; `currentLevels` reparse; input-device
   read-only list on the card; retention; rescue-`mv`; G2 residual; `last_update_reason` mapping; double session-read log line.
3. **Room audio from the desk, now that SSH is everywhere:** OPD 3 input level (`osascript -e "set volume input volume 50"`), OPD 5
   TONOR swap still needs a hand (the mic is physical), OPD 7 has both a TONOR and a C270 — confirm which is the default input.
4. **R2.5 → R4 → loudness → tone**, order unchanged from 9 Sep.

## 4. Owed / carried

OPD 5 TONOR swap · OPD 3 input level (`osascript -e "set volume input volume 50"` over SSH now possible) · OPD 4 + OPD 1 walks (PARKED) ·
Even cert sits untrusted in Room 4.1's System keychain (harmless) · room Macs share one login password and two have a different
keychain password (governance item) · `.p12` escrow off the Mini · `feat/room-recorder` retire · version scheme (today burned
0.1.17 and 0.1.18 on the way to a clean fleet — acceptable, ratify or add `-rcN`) · everything in the 10 Sep §4 list not named here.

## 5. The programme question

Unchanged: is the audio transcribable? Today's evidence: Room 4.1 3.78 B/ms over 12 pieces, Cardiology 3.60 B/ms (TONOR, first day),
OPD 6 3.74 B/ms (C270 works there), OPD 4 flat 0 (no input). Nothing paid has run; 12 windows wait in Room 4.1.

## 6. Kickoff for the next thread (the first hour)

1. Spin up (paste below). Verify: `scribe_system_map` — seven listeners on the ids in §1 (OPD 4/OPD 1 will also show; ignore them);
   Mini refs via ReadMini: `origin/vinay/release-b1` = `faafd04` or later.
2. Write `docs/handoff/ETA-KICKOFF-0.1.19-FIRST-CLINIC-SELF-UPDATE-<date>.md` from §3 step 1 (goal, known facts from §1–§2, scope =
   VERSION + the `build-bundle.sh:231` heading + CHANGELOG, verify = suite + signed build + DR/CDHash, do-nots = no publish without V,
   passwords never through `!`, output = report ≤200 words; Refuter section = fresh session). Hand V the Claude Code paste.
3. Builder → Refuter → V → publish `test` → Room 4.1 to `test` → tape stop via MCP → watch the swap → `stable` → six rows.
4. Then the B2 kickoff (§3 step 2), PRD addendum first.

## 7. Spin-up paste for the next thread

> Spin up ETA from `docs/handoff/ETA-CARRYOVER-PROMPT-11-SEP-2026-EOD-MASTER.md` on the Mini (mirror in `Daily Dash EHRC/ETA/`). Read it and `ETA-ORCHESTRATOR-MEMORY.md` (rules 1–26) first. Verify live state before trusting either: `scribe_system_map` listeners (tab_id = install id) and `scribe_diff_room` once per room; the Mini's git refs via ReadMini. OPD 4 and OPD 1 are parked — ignore them. Then run carryover §6: write the 0.1.19 first-clinic-self-update kickoff, hand me the Claude Code paste, and drive Builder → Refuter → publish → Room 4.1 on `test` → stable. Orchestrator only — Builder/Refuter/Scout/Researcher per the six-role split; verdicts never delegated; passwords never through Claude Code `!`.
