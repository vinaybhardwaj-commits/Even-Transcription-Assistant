# ETA carryover, 11 September 2026, 21:15 IST — EOD MASTER (v4, post-R4)

**Spin up from this file.** Supersedes `ETA-CARRYOVER-PROMPT-11-SEP-2026-EOD-B2-MASTER.md` (v3, 19:45) and everything before it.
Companions, in this order: `ETA-ORCHESTRATOR-MEMORY.md` (rules 1–34) · `ETA-INSTALL-AND-FLEET-PRD-RELEASE-R4-ADDENDUM-11-SEP-2026.md`
(D1–D12) · `ETA-KICKOFF-R4-S-…` + `ETA-R4-S-BUILD-REPORT-…` + `ETA-R4-S-REFUTER-VERDICT-…` · `ETA-KICKOFF-R4-A-…` +
`ETA-R4-A-BUILD-REPORT-…` (Rollout section) + `ETA-R4-A-REFUTER-VERDICT-…` · the B2 addendum and its four docs · `ETA-ROOM-SSH-ACCESS-NOTE-…`.

## 0. Where to work (one change from v3)
As v3, plus: **every command that prompts runs as `ssh -t …`** (rule 33 — at 20:24 a non-tty `ssh host 'security unlock-keychain …'`
echoed the Mini's login password in clear; V rotates it). The Cowork Scribe-MCP connector caches its tool list: `scribe_set_audio_input`
exists on the server but is invisible from Cowork until the connector is reconnected in claude.ai settings (rule 34); until then the
admin route from `scribe` does the same job. Two Claude Code sessions on the Mini, `scribe` (Builder) and `scribe2` (Refuter),
cross-refuted tonight; every paste names its window.

## 1. Live state (verified 15:36Z fleet route + listeners)
Production **`5ff2ae0`** (R4-S), migrations through **0080**. Branch `vinay/release-b1` = origin = **`d4821ec`**, tree clean.
`Packaging/VERSION` = `0.1.21`; next version string **0.1.22**. Releases live: `stable` 0.1.21 `rel_6wudscmm73ff`, 0.1.20 `rel_fpscgwpuqqys`,
0.1.19, 0.1.18; `test` 0.1.21 `rel_n2ybgcahwvxm`, 0.1.20 `rel_neygnnarrp2q`, 0.1.19, 0.1.18.

| Room | install_id | App / channel | Recording device (config) | input_volume | peak / zero_ratio |
|---|---|---|---|---|---|
| Home Office (Mini) | `install_539avu7gqzz5` | 0.1.21 `test` | TONOR TM20 (settable) | 0.5439 | 0.087 / 0.0008 |
| Room 4.1 | `install_d3sy3ufas8jv` | 0.1.21 `test` | C270 | 0.4489 | 0.031 / 0.0008 |
| OPD 3 | `install_fc2jt2zs4x8v` | 0.1.21 `stable` | **C270 (switched from the desk 15:33:04Z)** | 0.3608 | 0.017 / 0 |
| OPD 5 | `install_e3yjw3ut698x` | 0.1.21 `stable` | C270 | 0.3216 | 0.124 / 0.0005 |
| OPD 6 | `install_d2nkvqcnqb7k` | 0.1.21 `stable` | C270 | 0.3687 | 0.022 / 0.0003 |
| OPD 7 | `install_6m45w69ux7tj` | 0.1.21 `stable` | **C270 (switched from the desk 15:34:25Z)** | 0.498 | 0.013 / 0 |
| Cardiology | `install_pgrped6322ss` | 0.1.20 `stable` | TONOR TM20 | — | **Mac OFF since 14:13:06Z** (powered down ~19:43 IST); takes 0.1.21 on its first check after power-on |
| OPD 1 / OPD 4 | `fygsnma88x2d` / `kurmsj5wdjau` | 0.1.8 | C270 | — | PARKED |

All tapes stopped for the night (rooms empty). Ids unchanged through three self-updates today.

## 2. What closed today (after v3)
1. **R4 — room audio control from the desk.** R4-S (`6df15d7` + `9f11bbd`, 1678 tests, ACCEPT) in production 15:14Z; R4-A = **0.1.21**
   (`5af9075`, 582 tests, ACCEPT) on all six reachable Macs 15:17–15:30Z, 2 s canaries. D9 on Home Office: two device switches while
   recording (3 segments, session unchanged), volume 0.5 → hardware 0.4995, `device_not_present` refused clean.
2. **OPD 3 and OPD 7 record live audio again** — switched to their C270s by `POST …/audio-input`, peak 0 → 0.017 / 0.013 within a poll,
   config pinned. Their TM20s are diagnosed **dead units** (input_volume 0.57 / 0.50 yet every sample zero — not a mute).
3. The 9 Sep open question is answered: the TM20 exposes input gain via CoreAudio (`kAudioDevicePropertyVolumeScalar`, settable).
4. Day total: 0.1.19, B2-S, 0.1.20, R4-S, 0.1.21 — five accepted builds, three fleet-wide self-updates, zero room visits.

## 3. The ladder from here
1. **Hardware:** two dead TONOR TM20s (OPD 3, OPD 7) — replace or RMA; OPD 5's TONOR swap (owed since 10 Sep) is now a desk paste once the
   mic is plugged in (`set_audio_input`). Cardiology: power it on; it self-updates, then check its TM20 on the card.
2. **B3 kickoff** (addendum first): card "up to date since <t>" after a clean check; `+`→space in device names; config.json rewrite drops
   unknown keys; D11 dedupe masks the engine's silent read; app-side `input_devices` total cap; CoreAudio enumerated twice per poll; D9 tail
   reader looser than the old read; retention deletion after V's archive ruling; `input_device_name` COALESCE staleness; retire
   `install_7fs9pxt8gdcf`; `ended_at_lies` Debugger brief; **R4-S flag: refuse `set_audio_input` unless the listener is an `app_install_`**
   (a browser tab would hold the row forever); **R4-A note: a device lost after a switch stays pinned in config** (same as enrol today);
   fleet row should expose `recording_session_id`; **rename the OPD 5 room label** (carries a doctor's name; repo is public); public-repo
   bus decision.
3. **R2.5 → loudness → tone**, order unchanged; R4 is done.
4. Version scheme (0.1.17–0.1.21 in one day): ratify as-is or add `-rcN`.

## 4. Owed / carried
Mini login password rotation (leaked in clear 20:24 IST, rule 33) · Scribe-MCP connector reconnect (rule 34) · Cardiology power-on · TM20
×2 dead · OPD 5 TONOR swap · OPD 4 / OPD 1 walks (PARKED) · transcript lanes: Room 4.1 24, Cardiology 26, OPD 5 26, OPD 6 23, OPD 3 15,
OPD 7 12 windows waiting — paid runs only on V's order; **OPD 3 / OPD 7 tape before 15:33Z today is digital silence, do not pay for it** ·
Even cert untrusted in Room 4.1 System keychain (harmless) · shared room login password (governance) · `.p12` escrow ·
`feat/room-recorder` retire · Gemini STT disabled · OPD Test listener dead since 7 Sep.

## 5. The programme question
Unchanged: is the audio transcribable? Every reporting room now has a live input and a known gain. Room 4.1 / OPD 5 / OPD 6 have days of
usable tape; OPD 3 / OPD 7 start tomorrow morning on the C270s. Nothing paid has run.

## 6. Kickoff for the next thread (the first hour)
1. Spin up (paste below). Verify: `scribe_system_map` — six listeners on 0.1.21 ids + Cardiology back if powered on; ReadMini refs
   `origin/vinay/release-b1` = `d4821ec`; fleet rows via `scribe` (route is proxy-blocked from Cowork).
2. If Cardiology is on: confirm 0.1.21 took, read its TM20 volume/peak.
3. Write the B3 PRD addendum (§3.2) → V ratifies → B3 kickoffs (server first, then app 0.1.22), same two-session cross-refutation.

## 7. Spin-up paste for the next thread

> Spin up ETA from `docs/handoff/ETA-CARRYOVER-PROMPT-11-SEP-2026-EOD-R4-MASTER.md` on the Mini (mirror in `Daily Dash EHRC/ETA/`). Read it and `ETA-ORCHESTRATOR-MEMORY.md` (rules 1–34) first. Verify live state before trusting either: `scribe_system_map` listeners (tab_id = install id) and `scribe_diff_room` once per room; the Mini's git refs via ReadMini. OPD 4 and OPD 1 are parked — ignore them. Then run carryover §6: Cardiology check if it is on, then the B3 PRD addendum and kickoffs. Orchestrator only — Builder/Refuter/Scout/Researcher per the six-role split; every Claude Code paste in a code block naming its tmux window; verdicts never delegated; passwords never through Claude Code `!`; every prompting SSH command as `ssh -t`.
