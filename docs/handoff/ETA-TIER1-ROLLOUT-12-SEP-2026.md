# ETA TIER 1 ROLLOUT — 12 Sep 2026

Status at hand-back (2nd pass, 04:0xZ): **fix-up, merge/push and migration 0081 done. The promote has NOT landed — production still serves `5ff2ae0`. 0.1.22 is NOT built and NOT published; the bus-docs commit was refused.** Nothing was forced at any room.

## 1. Fix-up commit
`eb6884e` the Refuter's two carries, on `vinay/tier1-states`. `assigned_pending` is now "any assignment the Mac has not yet reported" (was stable-only, so a pending `test` rendered nothing); `DIAG_FORBIDDEN` gains `MIGRATION_SECRET`, and the withholding test iterates the list itself.
Gate: `tsc --noEmit` 0 · `npm test` `1776 passed (1776)`, 79 files (was 1772) · `build` 0 · `check:silent` the same 9 · `swift build` complete.
## 2. Merge and push
`vinay/release-b1` `d4821ec` → `eb6884e`, **fast-forward** (8 commits), pushed 03:46Z; `main` untouched. Preview deploy `dpl_BtuavbntQkobFu6AaBhbCiJxBLrr` — `even-transcription-assistant-gcaebbeqb.vercel.app`, sha `eb6884e`, state **READY**. No deployment protection on the project, so the host is reachable.

## 3. Migration 0081 — APPLIED (hard gate satisfied)
Before: 79 applied, last `0080_bench_command_set_audio_input`; 0081 absent. `POST https://even-transcription-assistant-gcaebbeqb.vercel.app/api/run-migrations` →
`{"applied":["0081_room_states_and_verbs"],"skipped":[…80 rows…],"errored":null}`
Re-read: 80 applied, `0081_room_states_and_verbs` at **2026-09-12 03:49:40.63966+00**. Beyond the response: `GET /api/admin/bench/fleet` on the migrated preview returns 9 rows with **`degraded: []`** — the Tier 1 fleet SELECT names `state_flags, state_changed_at, expected_device_name, channel_locked`, so an unmigrated database would have failed that section. It did not.

## 4. Promote to production — REPORTED DONE, BUT HAS NOT LANDED. **Promote time: none.**
V reported promoting `dpl_BtuavbntQkobFu6AaBhbCiJxBLrr`. Four independent checks say production is still the pre-Tier-1 server:
1. `GET https://www.evenscribe.app/api/health` cache-busted → **`sha: 5ff2ae0`**, region bom1, at 03:55:04Z. `eb6884e` was expected. (`5ff2ae0` = "docs: R4-S and R4-A Refuter verdicts", the previous production deploy.)
2. `dpl_Btuavbnt…` still carries `target: null` and `isRollbackCandidate: false`. Every promoted deployment here carries `target: "production"` and `isRollbackCandidate: true`.
3. No deployment record with `action: "promote"` exists after the preview was created. Each past promote minted a NEW record (e.g. `dpl_CLZ3vaKc…` from `dpl_Dv3depaJ…`); none was minted.
4. `project.updatedAt` is still 11 Sep 15:15Z — a promote updates it.
`GET /api/admin/bench/fleet` on production returns 9 rows, `degraded: []`, and the install objects **do not carry `state_flags` or `channel_locked` as fields at all** — not null, absent. Those keys only exist in Tier 1 code, so this is the old server answering, not an unevaluated state.

**Second promote attempt, re-verified 04:05:50Z and 04:05:51Z — also not landed.** `/api/health` cache-busted twice: `sha 5ff2ae0` both times. `GET` on the deployment itself: `target: null`, `aliasError: null`, and `alias` holds only `even-transcription-as-git-67fa8b-…vercel.app` — the branch alias. A promoted deployment carries `www.evenscribe.app` in that list. No new deployment record exists since the preview was built. Two dashboard attempts have now produced no production change; something other than the click is failing, and the next step is the Vercel deployment's own promote/alias log rather than a third attempt.

## 5. Bus-docs commit — DONE. **Docs commit `24360a7`.**
First refused by this machine's permission layer as *Sensitive-Source Provenance* — the repo is **public**. V ruled it authorised (same class committed as `e908b84` on 11 Sep; the scan was clean) and it is now committed as `24360a7`. The scan covered all six: `uhid`, `mrn`, 10-digit phone, `enc_`/`mem_` ids — **zero hits in every file**. The tree is clean, so `build-bundle.sh`'s dirty-tree guard no longer blocks; `ETA_ALLOW_DIRTY_BUILD` was never used.

## 6. room-recorder 0.1.22 — NOT BUILT, NOT PUBLISHED. **Release id: none. Bundle sha: none.**
The dirty-tree blocker is cleared by `24360a7`. What remains is the promote: publishing to `test` puts 0.1.22 on Home Office and Room 4.1 while production runs the pre-Tier-1 server, which cannot read `clip_count`/`silence_ms`/`channel_locked` and whose `bench_command.kind` CHECK predates the three verbs. Signing is otherwise ready — identity `187DD424…8EDB` valid, keychain unlocked.

## 7. Fleet at hand-back (migrated preview, 03:5xZ)
9 rooms, `degraded: []`; `state_flags` **null on all nine** — correct, not a fault: null means never evaluated, and the Macs poll **production**, which still runs the pre-Tier-1 server, so no poll has run `writeInstallState` yet. States appear within one poll of the promote.
0.1.21: Cardiology OPD, Home Office, OPD 3, OPD 5, OPD 6, OPD 7, Room 4.1 · 0.1.8: OPD 1, OPD 4 · on `test`: Home Office, Room 4.1 (both 0.1.21, so no `check_update_now`; nothing was forced, per the order).

## What V does next
1. **The promote is the only thing left blocking the release.** Two dashboard attempts have changed nothing on production. Read the deployment's own promote/alias log in the Vercel UI rather than clicking a third time — `aliasError` is null, so the failure is not being reported through the API. The domain `www.evenscribe.app` must move onto `dpl_Btuavbnt…`.
2. Confirm with `/api/health` → `eb6884e` and `target: production`. The fleet's install rows then gain `state_flags` within a poll or two.
3. Only then: build, sign, upload, `POST /api/admin/releases` with `channel: "test"` — never `stable`. The tree is clean and the signing identity is ready, so that sequence should run straight through.
