# ETA-D4 DEPLOY RUNBOOK — Sunday 27 Sep 2026 — train 5907cbc (FINAL, ruling 459.5)

Written by scribe 26 Sep ~17:30 IST. Deploy+rollback sections = the #3598 steps as posted and
under eta-refuter's PASS — NOT modified here. The Home Office SELFTEST pre-check section is the
ruling-459.5 addition. Untracked doc per kickoff convention; nothing in this file commits or
moves the train sha.

**What ships:** 5907cbc (branch `vinay/train-watchdog-candidate2`) onto `vinay/s1-auto-drain`
(= PRODUCTION). Exactly 5 commits over current production 1e75667, all scribe's:
87cc477 → 9d773bb → 4328235 → 8c49e93 (Room Watchdog alert path: outbox in the same statement
as the state, read door, heartbeat — ruling 128(a) — plus eta-refuter #422 follow-ups) →
5907cbc (command-poll route: keep the Mac's exact-zero ratio — byte-identical to the route fix
ALREADY LIVE in production via 1e75667; per eta-refuter #3763 nit (a), D4's actual delta is the
watchdog outbox + heartbeat: 9 files, 757+/20-, migration 0119 included — the zero_ratio fix is
NOT pending).

**Current production:** 1e75667, deployment `dpl_8r91ub6H82QjNrz2ziCEXmFP8H8S` (READY 13:31 IST
25 Sep, refuter smoke 924/924).
**Rollback chain:** `dpl_8r91ub6H82QjNrz2ziCEXmFP8H8S` (1e75667) → `dpl_64VgFHbt76toqZkUMqR4EEovvgTy`
(a92ebae) → `dpl_Peb1X1w527GCcKjGTzRWvZQ7iqxM` (73868e4) — deeper than the first hop is Fable's call only.

**Do-not-forget (FABLE 439):** D4 ships FIRST, 07:00-07:30, AFTER PARITY-389's hard stop — the
GO reads fleet's stop post, so the stop must LAND before the GO. SELFTEST is speech-only, ZERO
patient audio. Fallback rig room = Cardiology OPD ONLY if Fable accepts the r423 clinic-hours-STT
trade — never assumed.

---

## 1. Preconditions (tonight, all Fable-gated — any one missing = the ship waits)

| # | Condition | Owner | State at writing |
|---|---|---|---|
| 1 | eta-refuter PASS on these exact deploy+rollback steps (#3598) | eta-refuter | **PASS posted #3763 (D4(a))** — premises re-derived; nits (a) folded above |
| 2 | `SCRIBE_MCP_TOKENS_EXTRA` set in the VERCEL DASHBOARD — env is baked at BUILD, so it must land BEFORE the push (a push without it ships without the tokens) | Fable/V (scribe's connector is 403 on env) | UNVERIFIED — Fable confirms |
| 3 | Token hashes from herdr-kit's hash-only JSON: relay entry prefix `1c249772`, night-feeder `920fcbbe` (both scopes `["read"]`) recorded against the dashboard values | herdr-kit/Fable | recorded |
| 4 | `WHISPER_BULK_URLS`: the r394 removal (whisper-box only) rides this push — needs Fable's dashboard edit BEFORE the push; if unconfirmed, the push ships with the documented both-hostnames value (behavior unchanged from today) and the removal waits for the next push | Fable | live value unreadable (403) — Fable confirms |
| 5 | Migration 0119 by hand, on the Mini, with the Mini's secret file and the refuter-reviewed SQL, on Fable's order WITH the train, BEFORE the promote. Additive: on rollback the migration STAYS | minibot | pending Fable's order |
| 6 | PARITY-389 stop post landed (tonight GO ~21:15-21:30, hard stop 07:25-07:30) | fleet | pending tonight |

## 2. Deploy sequence (Sunday 07:00-07:30, only after the PARITY stop post lands; every step gated on Fable's explicit GO naming this push)

1. **Pre-flight** (scribe, from my own worktree — never the shared checkout):
   - `origin/vinay/s1-auto-drain` still `1e75667`; `git log origin/vinay/s1-auto-drain..origin/vinay/train-watchdog-candidate2`
     = exactly the 5 recorded commits, all mine; reverse range empty (fast-forward holds).
   - eta-refuter PASS on the steps + the sha recorded on the bus.
   - Full gate green on the exact sha:
     `CI_HOST=vinay@100.109.129.118 ~/dev/eta-wt-etalab-153/yoga-test.sh <worktree> --build`
     — BOTH `typecheck` and `typecheck:tests` (node_modules symlinked to the shared nm-cache).
   - Preconditions 1-6 above all green.
2. **Migration 0119** lands (minibot, by hand) — BEFORE the promote.
3. **Push** from my own worktree: `git push origin HEAD:refs/heads/vinay/s1-auto-drain` →
   PREVIEW build (`target: null`). A preview does NOT ship — production stays on 1e75667 until promoted.
4. **Promote:** `npx -y vercel promote <new dpl_...>` from the `-ow` worktree. The `-y` is NOT
   optional (without it npx's "Ok to proceed?" blocks forever and looks like a slow build).
   Promote CREATES a new production deployment (preview env values would be wrong — hence the
   dashboard-first rule in preconditions 2/4).
5. **Smoke** (scribe, immediately post-promote):
   - `/api/health` → 200 + the new sha.
   - `scribe_health` → ok, `service_pools invalid=[]`, no new runtime errors.
   - A level-log count for what changed: with the route fix live, CAPTURING rows in the level
     log now carry `zero_ratio` (pre-fix: 0 of capturing rows carried it — herdr-kit's check 2
     measured the drop). Count > 0 on any capturing row by mid-morning; the SELFTEST window
     provides exactly such rows.
   - Watchdog outbox: first outbox rows / heartbeat lines visible in fleet's watch (87cc477/9d773bb:
     outbox in the same statement as the state, dropped messages logged, stale threshold pinned).
6. **Report** on the bus: sha, both dpl ids, smoke results, migration row counts (minibot),
   pre-check outcomes (§4).

## 3. Rollback (ANY smoke failure — promote the old deployment id; migration stays)

1. `npx -y vercel promote dpl_8r91ub6H82QjNrz2ziCEXmFP8H8S` — production returns to 1e75667.
   The 0119 migration is additive and STAYS. Post the rollback on the bus immediately.
2. NO second attempt without a fresh Fable order naming it.
3. Deeper hops (`dpl_64VgFHbt76toqZkUMqR4EEovvgTy` a92ebae, then
   `dpl_Peb1X1w527GCcKjGTzRWvZQ7iqxM` 73868e4): Fable's call only.
4. The SELFTEST window (§4) runs regardless — it does not depend on the new build; any pre-check
   failure is flagged to Fable before 09:00.

## 4. HOME OFFICE SELFTEST PRE-CHECK (07:35-08:55, room_2qe955hy) — the ruling-459.5 ADDITION

Baseline recorded 26 Sep ~17:22 IST (read-only): `room_2qe955hy` / slug `home-office-w8fb` /
"Home Office"; hostname "Vinay's Mac mini" — the production Mini itself (D6); app 0.1.24;
input device TONOR TM20 Audio Device; session closed; `state_flags=[]`; polling fresh;
**both switches already OFF** (`transcript_enabled=false`, `visits_enabled=false` — the r340
STOP-ALL state; nothing in this plan turns them on).

Pre-check at 07:35, BEFORE any stimulus (scribe, read-only):

1. **FLAGS CLEAR:** `room_install` row for room_2qe955hy → `state_flags=[]` and `last_seen_at`
   fresh (< 5 min). ANY flag (DEVICE_MISSING / ENCODER_STALLED / KIOSK_OFFLINE /
   PIECES_STALLED / NOT_DELIVERING) = pre-check FAIL → stop, report to Fable at once; fallback
   room needs Fable's explicit acceptance of the r423 trade (see header).
2. **BOTH SWITCHES LISTED:** the room's two switches — `transcript_enabled` and
   `visits_enabled` — listed with their live state in the pre-check log (expected false/false).
3. **SELFTEST RUNS 07:35-08:55:** speech-only stimuli, ZERO patient audio (Sunday, clinic
   closed). The rig's own run plan is the SELFTEST workstream's (diar-lab lead per spec 7e55ef3);
   this runbook owns only the pre-check and the confirmations around it.
4. **SWITCH-OFF BY 09:00:** confirm both switches OFF at the 09:00 read (`transcript_enabled=false`
   AND `visits_enabled=false`). If either is found ON, report to Fable for the flip order — a
   switch flip is an admin write, never sent unruled by scribe.

## 5. Sunday timeline (box clock, IST)

| Time | Step | Owner |
|---|---|---|
| tonight ~21:15-21:30 | PARITY-389 GO; hard stop 07:25-07:30 | fleet |
| ~07:25-07:30 | PARITY stop post LANDS → D4 GO reads it | fleet → Fable |
| after stop post, ≤07:30 | pre-flight → 0119 → push (preview) → promote → smoke | scribe + minibot (GO: Fable) |
| 07:35 | HO pre-check: flags clear + both switches listed (§4.1-4.2) | scribe (read-only) |
| 07:35-08:55 | SELFTEST run, speech only, zero patient audio | SELFTEST workstream |
| by 09:00 | switch-off CONFIRMED (§4.4) | scribe reads; Fable rules any flip |
| 09:00+ | post-D4 report on the bus | scribe |

If the PARITY stop post has NOT landed by 07:30, the deploy waits for Fable's word — no
self-initiated judgment calls. Every production action above is Fable-gated by name.
