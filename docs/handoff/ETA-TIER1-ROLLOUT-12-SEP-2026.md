# ETA TIER 1 ROLLOUT — 12 Sep 2026

Status: **COMPLETE.** 0081 applied, production promoted to `eb6884e`, Slice A live, bus docs committed, 0.1.22 published to `test`. Nothing was forced at any room. One thing to note: **Room 4.1 now reports `stable`, so 0.1.22 reaches Home Office only** — see §7.

## 1. Fix-up commit
`eb6884e` the Refuter's two carries, on `vinay/tier1-states`. `assigned_pending` is now "any assignment the Mac has not yet reported" (was stable-only, so a pending `test` rendered nothing); `DIAG_FORBIDDEN` gains `MIGRATION_SECRET`, and the withholding test iterates the list itself.
Gate: `tsc --noEmit` 0 · `npm test` `1776 passed (1776)`, 79 files (was 1772) · `build` 0 · `check:silent` the same 9 · `swift build` complete.
## 2. Merge and push
`vinay/release-b1` `d4821ec` → `eb6884e`, **fast-forward** (8 commits), pushed 03:46Z; `main` untouched. Preview deploy `dpl_BtuavbntQkobFu6AaBhbCiJxBLrr` — `even-transcription-assistant-gcaebbeqb.vercel.app`, sha `eb6884e`, state **READY**. No deployment protection on the project, so the host is reachable.

## 3. Migration 0081 — APPLIED (hard gate satisfied)
Before: 79 applied, last `0080_bench_command_set_audio_input`; 0081 absent. `POST https://even-transcription-assistant-gcaebbeqb.vercel.app/api/run-migrations` →
`{"applied":["0081_room_states_and_verbs"],"skipped":[…80 rows…],"errored":null}`
Re-read: 80 applied, `0081_room_states_and_verbs` at **2026-09-12 03:49:40.63966+00**. Beyond the response: `GET /api/admin/bench/fleet` on the migrated preview returns 9 rows with **`degraded: []`** — the Tier 1 fleet SELECT names `state_flags, state_changed_at, expected_device_name, channel_locked`, so an unmigrated database would have failed that section. It did not.

## 4. Promote to production — DONE. **Promote time 2026-09-12T04:07:30Z.**
`dpl_6K9SZodcbyb9ypGwY1fQnc5kEVCf` — `target: production`, `action: promote`, `originalDeploymentId: dpl_BtuavbntQkobFu6AaBhbCiJxBLrr`, sha `eb6884e`, `isRollbackCandidate: true`. A Vercel promote mints a NEW deployment record rather than mutating the original, so `dpl_Btuavbnt…` correctly still reads `target: null` — checking only that record is how two earlier passes read the promote as missing. `/api/health` cache-busted ×3: `sha eb6884e`, region bom1, ok true. Two earlier checks at 03:55Z and 04:05:50Z read `5ff2ae0` because they genuinely preceded the promote.

## 5. Bus-docs commit — DONE. **Docs commit `24360a7`.**
First refused by this machine's permission layer as *Sensitive-Source Provenance* — the repo is **public**. V ruled it authorised (same class committed as `e908b84` on 11 Sep; the scan was clean) and it is now committed as `24360a7`. The scan covered all six: `uhid`, `mrn`, 10-digit phone, `enc_`/`mem_` ids — **zero hits in every file**. The tree is clean, so `build-bundle.sh`'s dirty-tree guard no longer blocks; `ETA_ALLOW_DIRTY_BUILD` was never used.

## 6. room-recorder 0.1.22 — BUILT, SIGNED, PUBLISHED TO `test`. **Release `rel_xbzk5e4r7re6`.**
The dirty-tree blocker is cleared by `24360a7`, so `Packaging/build-bundle.sh` ran clean (no `ETA_ALLOW_DIRTY_BUILD`). Manifest: **version `0.1.22`, build_sha `d516204`, sha256 `cead6082ff57114f4e4bacdedf40a13cdc99ea157031c67fa8789e432340d1b5`, size_bytes `4036424`**, signed by `187DD424…8EDB` (`Authority=EvenScribe Room Recorder Code Signing 1`, CDHash `74a51a8a…`), audio-input entitlement present, unpacked zip re-verified. The zip is at `apps/room-recorder/.build/release-bundle/`.
Blob: `https://p2rwhyh5dghotpi6.public.blob.vercel-storage.com/room-recorder/EvenScribe-Room-Recorder-0.1.22.zip`. `POST /api/admin/releases` with `channel:"test"` → **HTTP 201**, `rel_xbzk5e4r7re6`, published 04:11:10.358Z by `migration_secret`.
**sha256/size matched on the server's own recomputation, not an echo**: `createRelease` fetches the blob, hashes it, and throws `SHA_MISMATCH` on any disagreement in either field, so 201 is itself the proof. Row `sha256 cead6082…40d1b5`, `size_bytes 4036424` — identical to the local zip (`shasum -a 256`, `stat`).
**`stable` untouched**: latest stable is still `0.1.21` / `rel_6wudscmm73ff` from 11 Sep 15:27:56Z. Nothing was published to it.

## 7. Fleet after the promote (production, 04:10Z) — Slice A LIVE
`state_flags` and `channel_locked` are now present as fields (they were absent before, which is how the un-promoted server was identified). 9 rows, `degraded: []`.
**7 of 9 already evaluated to `[]`** — looked at and well: Home Office, OPD 1, OPD 3, OPD 4, OPD 5, OPD 6, Room 4.1. **2 still null** — Cardiology OPD and OPD 7 had not polled yet; null means never evaluated and flips within a poll.
**Room 4.1 reports `update_channel: stable` (assigned_channel null).** It read `test` at 03:55Z and `stable` at 04:10Z, so it moved during this window — not by anything done here. **0.1.22 therefore reaches Home Office only.** Nothing was forced and no channel was assigned: moving a Mac onto `test` is a decision for V, not the Builder.

## What V does next
1. **Rule on Room 4.1.** If it is meant to be a `test` room, assign it `test` (the card's pending line now renders for a `test` assignment — that was this pass's fix-up). Until then only Home Office will take 0.1.22.
2. Home Office picks 0.1.22 up on its next 6 h check or session end. 0.1.21 has no `check_update_now`, so nothing can or should be forced.
3. Watch the two null rooms flip to `[]`, and watch for the first real flag.
4. `stable` stays at 0.1.21 until the partition steps.
