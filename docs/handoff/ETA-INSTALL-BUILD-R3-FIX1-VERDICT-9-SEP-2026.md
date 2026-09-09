# ETA Install Build R3 — Fix 1 verdict

**9 September 2026, 22:40 IST.** Commit reviewed: `4a782a1` on `vinay/r3-self-update`, parent `b11518d`, confirmed
from the Mini's `.git` refs and reflog (one commit, not amended). Report: `ETA-INSTALL-BUILD-R3-FIX1-REPORT-9-SEP-2026.md`.
Reviewed by an Opus refuter (static, diff from the Mini tree) and the decisive items re-read by the orchestrator in the
live source on the Mini.

## Verdict: DO NOT SIGN `4a782a1`. Fix 2 first, then sign. The remaining work is small.

| Item | Result | Proof |
|---|---|---|
| F1 route reads all seven fields, omit-not-guess | **PASS** | `app/api/bench/commands/route.ts:119-126`; `bigint` `:88-91` rejects 0 and non-digits; `instant` `:92-98` nulls on NaN |
| F1 test drives the route | **PASS** | `tests/unit/bench-commands-install-wire.test.ts:38` imports the route, `:74-84` asserts on the object handed to `pollCommands` |
| F1 0.1.7 poll unharmed | **PASS** | six COALESCE at `lib/room-install.ts:918-924`; `session_open` non-COALESCE is pre-existing ratified behaviour |
| F2 `swap_failed` loop bounded | **PASS** | ledger on disk keyed by version; `failuresBeforeHold = 2`; guard `RoomSelfUpdate.swift:581`; cleared on version match `:574` |
| **F2 publish-typo loop** | **FAIL** | `RoomEngine.swift:669` counts only `outcome != .ok`; a `version ≠ CFBundleShortVersionString` swap yields an `.ok` receipt, so nothing is counted and the ~80 s download-swap-restart loop still runs unbounded. The code's own comment (`RoomSelfUpdate.swift:276-278`) names the case. PRD §13.9 item 2 and `docs/BUILD-HISTORY.md:317` claim it closed. |
| **F2 one retry then hold** | **FAIL (fail-safe)** | `stop()` counts at `:596` and writes the receipt; the receipt is deleted only after a successful poll (`RoomEngine.swift:958-961`). A restart before that poll makes `init` (`:638` → `:669`) count the same failure again → hold after one real failure. |
| F3 marker before spawn, honoured, cleared | **PASS** | write `RoomSelfUpdate.swift:608`, spawn `:610`, clear on spawn failure `:612`; `RoomEngine.swift` sweep guard and clear |
| F4 anchor between the two moves, four specific assertions | **PASS** | anchor is the second `mv` line, injected with `SwapHarnessError.anchorMissing`; assertions resident==0.1.7, executable, `.previous` gone, receipt `swap_failed`, `launchctl bootstrap`. The 0.365 s green is the race won (SIGTERM before `sleep` forks); when lost, bash defers the trap until `sleep 30` returns, still before the second move. Sound either way. |
| F5 seventh column, separator gone | **PASS** | `0078:55`; `UPDATE_ERROR_SEPARATOR`/`attemptedVersion` deleted and asserted absent |
| F6 per-row channel, no release → no word | **PASS** | `lib/room-install.ts:1036-1055`, `lib/room-install-view.ts:121`, header still `releases.stable` |
| F7, F8 | **PASS** | `handoverExitCode` at both exit sites; `jsonStringBody` escapes `\` first, `"`, control chars; shell copies bytes |
| Contract | **FLAGGED** | `app/api/admin/bench/fleet/route.ts:46` one line, forced by the type — **ratified**. PRD §13.9 (41 lines) and `docs/BUILD-HISTORY.md` edited outside any list — corrected in Fix 2, and both lists now name them. |
| Gates | typecheck, npm test (67/1568), build, swift build — builder-claimed on the Mini, not re-runnable from the Air. `swift test` at the console — **unproven**, V's hand, same console session that signs. |

## Rulings [V-9SEP]

- `retryHold` **6 h** — ratified as built.
- `handoverGrace` **30 min**, not 10 — change in Fix 2.
- The hold sentence appended to the reason by the app — **accepted as-is**; it states a fact the app counted.
- `app/api/admin/bench/fleet/route.ts` one-line edit — ratified; file is now editable.
- Fix 2 scope: the two F2 defects, the two doc corrections, grace 30 min, strict ISO parse in `instant()`, a 10 s timeout on the F4 FIFO reader.
- Not reopened: everything §0 of the Fix 1 kickoff ruled; the SIGKILL window; `renamex_np`.

## Minor, carried on the owed list, not in Fix 2

- `RoomEngine.swift:661` clears the handover marker on any pending receipt without a version check; unreachable while a receipt is pending because `check()` runs only after the poll that deletes it.
- `bigint()` accepts 19 digits, which can exceed int64 before the `::bigint` cast.
- The `.previous` restore is expressed in three places in the swap script; consistent today, left as is (script already reviewed).
- A server-side guard at publish (open the zip, compare `Info.plist` to `version`) would stop the typo at the source; deferred to the publish runbook, not this build.

## Next

Fix 2 kickoff: `ETA-INSTALL-BUILD-R3-FIX2-KICKOFF-9-SEP-2026.md`. After its report passes review: `swift test` at the console, sign and publish 0.1.8 at the console, then §13.5 items 1–7 on Home Office.
