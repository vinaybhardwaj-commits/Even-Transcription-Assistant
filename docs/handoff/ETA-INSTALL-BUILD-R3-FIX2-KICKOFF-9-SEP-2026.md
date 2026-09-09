# ETA Install Build R3 — FIX 2

**Kickoff for Claude Code. Paste this whole file.** Same session, same machine, **same branch**.

Working directory: `~/dev/Even-Transcription-Assistant` on the Mini, branch **`vinay/r3-self-update`**, currently at
**`4a782a1`** (parent `b11518d`). **New commit on the same branch. Do not amend. Do not push. Do not touch `main`.**

Read first: `docs/handoff/ETA-INSTALL-BUILD-R3-FIX1-VERDICT-9-SEP-2026.md` (the review of your Fix 1), then your own
`ETA-INSTALL-BUILD-R3-FIX1-REPORT-9-SEP-2026.md`. The main kickoff and the Fix 1 kickoff still govern everything they
settled. **Read the repo's `CLAUDE.md` first; it is V's and it governs. Commit it with this work (G7).**

**All decisions below are settled. Do not reopen them.** Flag anything the text does not cover; do not decide it.

## Pre-flight

`pwd`, `git remote -v`, `git status --porcelain`, `git rev-parse HEAD`. HEAD must be `4a782a1`. The only untracked files
permitted are `CLAUDE.md` (to be committed, G7) and files under `docs/handoff/`. Anything else: STOP and report.

---

## 0. Rulings on your Fix 1 flags [V-9SEP]

| Flag | Ruling |
|---|---|
| §6.1 `.previous` restored in three places | Accepted as is. Do not rewrite the script. |
| §6.2 `retryHold` 6 h | **Ratified.** |
| §6.3 `handoverGrace` 10 min | **Changed to 30 min.** See G4. |
| §6.4 hold sentence authored by the app | **Accepted as is.** |
| §6.7 `app/api/admin/bench/fleet/route.ts` one line | **Ratified.** The file is now on the editable list. Stopping on an uncompilable middle is not required; a one-line type-forced edit with a flag is the right call. |
| §6.8 the three untracked files | `CLAUDE.md` is now correct and is committed in this build (G7). The two `docs/handoff/` files are the orchestrator's and may be committed with this work or left; either is fine. |
| §6.9 acceptance items unrun | Correct. They run on Home Office after signing, by V. |

---

## G1 — BLOCKER. The publish-typo loop is still unbounded.

Your own comment at `RoomSelfUpdate.swift:276-278` names it: a release whose `version` disagrees with the
`CFBundleShortVersionString` inside its zip swaps "successfully", the new copy still sees `running ≠ offered`, and the
download-swap-restart cycle runs about every 80 s for ever. `RoomEngine.swift:669` counts only `outcome != .ok`, and this
case produces an `.ok` receipt, so the ledger never sees it. **PRD §13.9 item 2 says one retry then hold covers it. It
does not.**

**Fix, app side, before the swap.** After the staged bundle is expanded and has passed the staged codesign check (the
existing step that ends at `RoomSelfUpdate.swift:695`), read `CFBundleShortVersionString` from the staged bundle's
`Contents/Info.plist` (`Bundle(url:)` or `PropertyListSerialization`; never `defaults`). If it is absent or differs from
`release.version`, `stop(.versionMismatch, "the downloaded app calls itself <staged> but the release is named <offered>")`.
`stop()` already writes the receipt and counts the failure, so the existing one-retry-then-hold applies with no further
change. Nothing resident is touched.

- Add `case versionMismatch = "version_mismatch"` to `RoomUpdateOutcome` (`RoomSelfUpdate.swift:161`). Grep the TypeScript
  for the result vocabulary (`checksum_mismatch` is the search term) and add `version_mismatch` wherever the others are
  enumerated or rendered, with the card sentence built from the reason as the others are.
- The check must read the plist from the STAGED path, never from the running bundle.

**Test.** A fixture whose staged `Info.plist` says `0.1.9` while the release says `0.1.8` stops with `version_mismatch`,
writes the receipt with version `0.1.8`, counts one failure, and touches nothing at the resident path. A second identical
offer is attempted once more and then held.

---

## G2 — BLOCKER. One real failure can trigger the hold.

`stop()` counts at `RoomSelfUpdate.swift:596` and writes the receipt. The receipt is deleted only after a successful poll
(`RoomEngine.swift:958-961`). If the process restarts before that poll — reboot, crash, a network outage that caused the
`download_failed` in the first place — `RoomEngine.init` (`:638` → `:669`) counts the same failure again, and a room is
held after one failure with no retry.

**Fix.** In `RoomEngine.init`, count only `receipt.outcome == .swapFailed` — the sole outcome written by the script, which is
the only failure the failing process cannot count itself. Every other outcome is already counted by `stop()`. Update the
comment at `:675-680` to say exactly this.

**Test.** A `download_failed` receipt present at init does not change the ledger; a `swap_failed` receipt present at init
counts one failure.

---

## G3 — Doc corrections. Two files edited outside the contract in Fix 1 now say the typo case is closed.

- `docs/handoff/ETA-ROOM-RECORDER-INSTALL-AND-FLEET-PRD-7-SEP-2026-v1.0.md` §13.9 item 2: replace the last two sentences
  with the truth after G1 — the mismatch is detected on the staged bundle before the swap, recorded as `version_mismatch`,
  and held after one retry like every other failure. Add a §13.10 "Fix 2, 9 September 2026" of at most twelve lines
  listing G1–G7.
- `docs/BUILD-HISTORY.md:317`: correct the same sentence.

Both files are on this kickoff's editable list for these edits only.

---

## G4 — `handoverGrace` is 30 minutes. [V-9SEP]

`RoomSelfUpdate.swift:111`: `30 * 60`. Update the comment at `:107`. Adjust any test that encodes 10 minutes.

---

## G5 — `instant()` must omit, not guess.

`app/api/bench/commands/route.ts:97-102` uses `Date.parse`, which accepts `"12"` as December 2001. Accept only an ISO-8601
instant: `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$`, then `Date.parse`, then NaN → null. Add two
cases to `tests/unit/bench-commands-install-wire.test.ts`: `"12"` → omitted, `"2026-09-09T09:14:00.000Z"` → carried.

---

## G7 — Commit `CLAUDE.md`.

The untracked `CLAUDE.md` at the repo root is now correct for this repo. Stage it by exact filename and include it in this commit. Do not edit it.

## G6 — The F4 FIFO reader gets a timeout.

`RoomSelfUpdateTests.swift:163` blocks for ever if the script dies before the anchor. Open the FIFO non-blocking
(`O_RDONLY | O_NONBLOCK`) and poll for a byte for at most 10 s, or read on a background thread with a 10 s wait; on timeout
`throw SwapHarnessError.windowNeverReached` and kill the process. The green path must be unchanged.

---

## File contract

**Editable:** the main kickoff's §6 list, plus `app/api/bench/commands/route.ts`, `app/api/admin/bench/fleet/route.ts`,
`docs/BUILD-HISTORY.md`, and the PRD for G3 only. Any TypeScript file that enumerates the result vocabulary
(`checksum_mismatch`) may take the one added string. **Everything else in the main kickoff's §6 UNTOUCHED list still
applies, `lib/bench-commands.ts` included.** Do not widen further; flag instead.

## Gates

The same five plus `swift test`. `swift test` over SSH stays unproven, not failed; report its real numbers and say so.
`check:silent`'s 9 pre-existing findings are accepted. Re-run `npm test` and quote the real counts.

## Report

`docs/handoff/ETA-INSTALL-BUILD-R3-FIX2-REPORT-9-SEP-2026.md`: the new sha; G1–G7 each with file:line; the G1 and G2 test
names and their assertions; gates with real output; anything flagged rather than decided. Cap 120 lines.
