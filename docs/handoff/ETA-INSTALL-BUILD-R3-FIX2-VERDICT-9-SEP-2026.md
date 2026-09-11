# ETA Install Build R3 — Fix 2 verdict

**10 September 2026, 04:45 IST.** Commit reviewed: `7d21f5e` on `vinay/r3-self-update`, parent `4a782a1` (reflog on the
Mini). Report: `ETA-INSTALL-BUILD-R3-FIX2-REPORT-9-SEP-2026.md`. Opus refuter (static, from the Mini diff); G1 and G2
re-read by the orchestrator in the diff.

## Verdict: PASS. `7d21f5e` is the commit to sign as 0.1.8, subject to the console gate below.

| Item | Result | Proof |
|---|---|---|
| G1 staged-version check | **PASS** | `RoomUpdater.bundleShortVersion(at:)` reads `Contents/Info.plist` of the STAGED bundle via `PropertyListSerialization`; Step 6c sits after the `signatureMismatch` return and before the script is written; nil or `≠ release.version` → `stop(.versionMismatch, …)`, which writes the receipt and counts. Nothing resident touched. Tests: 0.1.9-vs-0.1.8 stops, second offer tried once, third held. |
| G1 vocabulary | **PASS** | `case versionMismatch = "version_mismatch"`; `lib/room-install-view.ts` union + sentence map (exhaustive `Record`, so any typed map elsewhere would have failed typecheck); `lib/room-install.ts` `UPDATE_RESULTS`; 0078 comment. |
| G2 init counts only `swap_failed` | **PASS** | `roomUpdateCountStartupReceipt`: `guard let receipt, receipt.outcome == .swapFailed`. Tests cover all five other outcomes, `.ok`, nil. |
| G2 residual | **ACCEPTED, documented** | A `swap_failed` receipt is counted on every init until the poll that deletes it (`RoomEngine.swift:958-961`). Reaching a second count needs the restored 0.1.7 app to die again inside the ~1.5 s before its first successful poll. Fail-safe: 6 h hold on the old version, named on the card, cleared by republish. **Fix owed in Release B:** stamp the ledger with the receipt's `at` and skip a receipt already stamped; flip the test that currently asserts the double count. |
| G3 docs | **PASS** | PRD §13.9 item 2 corrected; §13.10 added (16 lines, cap was 12 — accepted); BUILD-HISTORY corrected. |
| G4 grace 30 min | **PASS** | `handoverGrace = 30 * 60`, comment rewritten, pinned by a test. |
| G5 strict ISO | **PASS** | `ISO_INSTANT` regex before `Date.parse`; `"12"` omitted, `.000Z` and `+05:30` carried. |
| G6 FIFO timeout | **PASS** | `O_NONBLOCK` open, 10 s deadline, SIGKILL + `windowNeverReached`. The builder's `seq 1 200 × sleep 0.05` replaces `sleep 30` in the harness only: bash defers the trap to the end of the current 50 ms slice, still before the second `mv`. Shipped `RoomSwapScript` text unchanged in the diff. |
| G7 CLAUDE.md | **PASS** | 35 lines, Bus = `docs/handoff/`, six gates + console rule, committed unedited. |
| Contract | **PASS** | 15 files, all on the allowed set; `lib/bench-commands.ts` untouched; `app/api/admin/bench/fleet/route.ts` untouched. 0078 took a comment-only change. |
| Gates | typecheck, npm test 67/1572, build, swift build — builder-claimed on the Mini. `swift test` 510/46, the 46 being the pre-existing `needsEnrolment` set — **unproven until run at the console.** |

## Minor, owed list

- G6 window (10 s) equals the reader deadline (10 s); widen the loop to 400 slices when next in the harness.
- `oneBoot()` in the F2 test sets `dittoProducesVersion` twice; cosmetic.
- Version comparison is exact string equality; a stray space in `app_release.version` stops every update fleet-wide, fail-safe and named on the card. `build-bundle.sh` derives `version` from `Packaging/VERSION` (currently `0.1.8`), so publishing from `release.json` cannot typo it; the runbook must never hand-type `version`.
- Server-side publish guard (open the zip, compare `Info.plist`) still deferred.

## Console gate, then sign

In Terminal.app on the Mini's own screen, in order: (1) `swift test` with the plugin/rpath flags from Fix 1 report §5 — expect 510 passed, 0 issues; any `needsEnrolment` at the console is a real failure, stop. (2) `Packaging/build-bundle.sh` — report `release.json` and the `codesign -dv` authority line. (3) Publish per R1 report §3.3 with `version`, `build_sha`, `sha256`, `size_bytes` taken from `release.json`, never typed, to channel **`test`** first. (4) Migration 0078 via `POST /api/run-migrations` before any 0.1.8 poll lands. (5) §13.5 items 1–7 on Home Office, item 6 with `kill`, never `kill -9`. Only after item 7 passes: publish to `stable`.
