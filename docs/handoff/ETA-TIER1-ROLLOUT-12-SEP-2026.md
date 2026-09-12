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

## 4. Promote to production — DONE. **Promote 2026-09-12T04:07:30Z (deployment record created); V reports it completing 04:08:50Z — 80 s apart, the record's birth vs. the alias switching over.**
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
**Two rooms are not polling — raised here because `state_flags` cannot be read for them.** At 04:15Z the other seven polled 1–5 s ago; **OPD 7 last polled 03:57:09Z (18 min) and Cardiology OPD 04:02:59Z (12 min)**, both BEFORE the 04:07:30Z promote. Their null flags are a SYMPTOM, not a Tier 1 fault: a Mac that does not poll never runs `writeInstallState`, and the promote did not cause it — they went quiet first. This is the offline/`kiosk_not_listening` layer, not the named states, and it wants a look independently of this release.

**Room 4.1 reports `update_channel: stable` (assigned_channel null).** It read `test` at 03:55Z and `stable` at 04:10Z, so it moved during this window — not by anything done here. **0.1.22 therefore reaches Home Office only.** Nothing was forced and no channel was assigned: moving a Mac onto `test` is a decision for V, not the Builder.

## What V does next
1. **Rule on Room 4.1.** If it is meant to be a `test` room, assign it `test` (the card's pending line now renders for a `test` assignment — that was this pass's fix-up). Until then only Home Office will take 0.1.22.
2. Home Office picks 0.1.22 up on its next 6 h check or session end. 0.1.21 has no `check_update_now`, so nothing can or should be forced.
3. **Look at OPD 7 and Cardiology OPD** — they stopped polling before the promote and have been silent 18 and 12 minutes against a fleet that polls every few seconds. Their `state_flags` stay null until they poll.
4. `stable` stays at 0.1.21 until the partition steps.

## 8. 0.1.22 on Home Office — swap CONFIRMED; acceptance 3/5 did NOT run
**The swap.** V ended the session via MCP at 04:30:09Z. `update.log`, verbatim: `2026-09-12T04:30:10Z room-recorder-swap: swapping to 0.1.22` → `valid on disk` / `satisfies its Designated Requirement` / `explicit requirement satisfied` → `04:30:13Z armed the canary for 0.1.22` → `04:30:13Z swapped to 0.1.22 and bootstrapped` → `04:30:13Z waiting up to 180s for 0.1.22 to poll` → **`04:30:15Z 0.1.22 acknowledged the canary after 2s`**. One second from session end to check: B2-D2's "every session end is a check", working exactly as written, with nothing forced.
Running bundle `CFBundleShortVersionString`/`CFBundleVersion` = **0.1.22**; LaunchAgent pid **13857** (was 21396) — a new pid, so the swap relaunched it; `runs = 1`, never exited, state `ready`. Server agrees: `app_version 0.1.22`, `session_open false`, channel `test`.
**Seam 1 verified live in production** (read-only, through the MCP door): `scribe_diff_room` on Home Office returns `room_state: { state:"finished", …, "flags":[], "drift_since":null }` — the Tier 1 fields are on the door, and `[]` means evaluated and well.

**Why the three verbs did not run.** Both write paths are shut to the Builder:
- `POST /api/admin/bench/command` → **HTTP 401 `AUTH_REQUIRED "Sign in required"`**. `benchAdminGuard` (`lib/bench.ts:75`) reads an admin cookie and verifies an admin JWT; it has no migration-secret path, unlike `installAdminGuard` on the assign-channel route. The migration secret is not an admin session.
- MCP `scribe_room_command` is **not exposed by the Scribe connector** — its manifest is stale (its `scribe_diff_room` description is still the pre-Tier-1 text, while the server itself returns the new fields).
So `report_diag`, `check_update_now` and `restart_engine` were never queued; no command row was written. I did not go looking for admin credentials. Acceptance items 3, 4 and 5 remain **UNPROVEN**, as the Refuter already had them.
Note for whoever runs them: item 5's second half ("restart_engine refused while a session is open") needs a session open on Home Office, i.e. a real recording started for the test.

## 9. Acceptance 3/4/5 — RUN ON HOME OFFICE (0.1.22), ALL PASS
Issued by curl against `POST /api/mcp` (`scribe_room_command`), not the MCP client — its manifest is stale. Home Office only; no other room touched.
**(4) `report_diag`** `cmd_u6a8fhve`, **ack 3 s** (bound 20 s). `app_version 0.1.22`, `build_sha d516204`, `input_devices` 2 (TONOR TM20, Microsoft Teams Audio), `disk_free_bytes 79410707561`, **`log_lines` exactly 100**, 0 needing redaction. `config` carries 11 keys and **`etaRoomSession` is not among them**. `ffmpeg version 9.0.1 … (exit 0)`; `tapewriter: unknown command: --version (exit 1)` — seam 13 as built. **Grep of the raw 18,754-byte response for `eta_room_session`, `etaRoomSession`, `SCRIBE_MCP_TOKEN`, `MIGRATION_SECRET`: empty.**
**(3) `check_update_now`** `cmd_dz75cy34`, sent 04:48:15Z, **ack 2 s**, `{ok:true, deferred:false, checked_at:"2026-09-12T04:48:17.500Z"}` — 2 s after the send, so the six-hour interval was bypassed (last check 04:30). **No `offered_version`**: the room already runs the newest `test` release. `update.log` stayed at 274 lines — an up-to-date check runs no swap script and therefore writes no line, so there is no update.log line to quote; the ack's `checked_at` is the proof.
**(5a) `restart_engine` idle** sent 04:48:43Z, ack `{ok:true, restarting:true}`. `launchd.log`: `restart requested by the desk` → `restarting for the desk: exit 75, launchd relaunches`. launchctl: `last exit code = 75: EX_TEMPFAIL`, `runs = 2`, **pid 13857 → 19106**, back on **0.1.22**. Listener `listening` again with `age_ms 523` by 04:48:54Z — **gap ≤ 11 s**, inside the 15 s target.
**(5b) `restart_engine` refused while recording** `scribe_start_recording` 04:50:21Z → `bs_abpega2v` (ack 04:50:26.866Z). `restart_engine` without `force` at 04:50:36Z → **`ok:false, status:"failed", error:"session_open"`**, `session_id bs_abpega2v`; **pid unchanged at 19106**, so the refusal held and nothing exited. `scribe_stop_recording` 04:50:54Z (ack 04:51:00.789Z).
**End state:** Home Office idle, `state: ready`, 0.1.22, pid 19106, `update.log` 274 lines. Acceptance items 3, 4 and 5 move from UNPROVEN to PASS; items 1 and 2 already passed.
