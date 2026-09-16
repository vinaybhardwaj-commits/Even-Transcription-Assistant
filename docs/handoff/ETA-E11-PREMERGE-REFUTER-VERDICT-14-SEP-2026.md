**DO NOT MERGE.** Item (b), a mandatory ruling, pins the cue-write check's *presence*, not its *behaviour*. The E11(b) test feeds the silent branch a brain answer that `writeWindowCues` cannot return for a silence. Two plausible rewrites of the check survive every E11 test, and on the most likely real failure (the batch refused, the marker accepted) each one finishes a silent window `transcribed`/`done`, with no record in the day. That is the exact R3 hole (b) was ordered to close. **The code at `ccd12b0` is correct.** The fix is test-only and small (§5).

# ETA-E11 — PRE-MERGE REFUTER VERDICT · 14 Sep 2026 · pane `ETA-Refuter`
**Reviewed the SHA, not a tree:** `ccd12b035470562fe291b8e189b46e1804c9f2ae`, from an isolated `git clone --shared`, with `git ls-remote` returning the same sha.
- **sha256 at the commit:** `339650c7…211e` `lib/stt/room-drain.ts` · `3fc6837d…610a` `e11-silent-room-window.test.ts` · **`555856ea…c10a`** `e11-silent-room-window-real-client.test.ts`.
- The report's third pin reads `…e10a`: a one-character typo. The committed file is what I tested.

## 1. Gate, rerun by me (raw: `scratch/E11-PREMERGE-REFUTER-gate-and-mutations-14-SEP-2026.log`)
- `npm run typecheck` → exit 0.
- `npm test` → exit 1, `Tests 4 failed | 2527 passed | 94 skipped (2625)`. The 4 are the Docker REQUIRED PROOF guards, unrun.
- `ETA_ALLOW_SKIP_E2E=1 npm test` → exit 0, `2531 passed | 94 skipped`.
- `npm run check:silent` → `Found 9 silent-failure handler(s)`, the accepted 9.
- `npm run build` → exit 0.
- **`swift build` → `Build complete!`** and **`swift test` → `✔ Test run with 600 tests in 48 suites passed`**, both in a fresh `apps/room-recorder/.build` inside the clone. This confirms the Builder's F5: the TestingMacros break belongs to the main clone's `.build`, not to the code. The earlier `lockFailed` issue did not recur.
- **All gate numbers match the Builder's exactly.**

## 2. The 20 mutations, rerun by me: 20 of 20 caught, the Builder's per-mutation counts reproduced exactly
- **Source mutations** (both E11 files):

| Mutation | Tests failed |
|---|---|
| `===` → `.includes()` | 7 |
| → `.startsWith()` | 3 |
| → `.endsWith()` | 3 |
| → case-folded | 1 |
| → `!full.ok` | 18 |
| M3, attempt consumed | 3 |
| R3, check removed | 1 |
| (c), `false` removed | 1 |
| M4, never skips engine | 6 |
| M5, flag not set | 6 |
| M6, marker 0 → 1 | 1 |
| M7, silent branch removed | 7 |
| M8, sync-tool branch removed | 1 |
| M9, `transcribe_range` branch removed | 1 |

- **Sweep evasions:** each of the six (new `lib/` caller, `whisperAdapter`, a new call in `measure-job.ts`, `services/`, POST `${WHISPER_BASE_URL}/inference`, `adapterFor("whisper")`) fails THE SWEEP, 1 test each.
- Harness: `scratch/E11-PREMERGE-REFUTER-mutate-14-SEP-2026.py.txt`. Exact-string edits matched once each, restored with a sha256 check, and the probe files removed.
- **Disclosure:** my first pass mis-parsed "all tests failed" runs as evasions. I fixed the parser and reran; the numbers here are from the rerun.

## 3. The three attacks
**A. Are F2's constructed near-misses a real guard, or a comfort? A REAL GUARD, of the rule, not of today's behaviour.**
- **Test:** I deleted the near-miss block and reran the four comparison mutants.
  - `.includes()` is still caught (2 failed) and `.endsWith()` still caught (1), both by the real client's own output (`http_500: empty_transcript`, the non-JSON 200).
  - **`.startsWith()` and case-folding SURVIVE, 0 failed.** The control, the block deleted with no mutation, fails 0.
- **Those two mutants behave identically to `===` over every string `lib/whisper.ts` emits today.** No real error starts with the constant or case-folds to it.
- **So the near-misses are the only thing pinning exact equality, and what they pin against is real.** I added one plausible producer to the client, `empty_transcript_unparseable` for a 200 whose body is not JSON. The real-client file stayed **16 of 16 green**: its "covers every error the client can produce" test is a hand-kept prefix list and cannot notice a new producer. The near-misses (`${EMPTY_TRANSCRIPT}_v2`, `…: detail`) are exactly the guard for that future.
- **Caveat worth one line in the file:** that test's name overclaims. It asserts coverage of five listed prefixes, not of the client.

**B. Can the (file, signal) count be defeated by a reader that uses none of the five signals? YES — four ways, each run in the clone.** THE SWEEP passes (0 failed):
- **NS1 `ADAPTERS.whisper.transcribe(...)`.** `lib/stt/registry.ts:16` exports the adapter record itself. **This is inside the ruling's own words, "include importers of the adapter"**, and it is how dynamic engine lookup (`ADAPTERS[key]`) is naturally written. No file uses it today.
- **NS2 `routeTranscribe(...)`** from `lib/stt/eta-router`: the router decodes with Whisper on the Mini.
- **NS3 a self-call to the app's own `…/api/transcribe/whisper-chunk` route.** It inherits that route's "empty is a failure" semantics, which is the bug class itself.
- **NS4 a signal-bearing caller under a new top-level directory** (`workers/`). Roots are a list, not "every tracked file". Today no tracked file outside the five roots holds a signal.

Two more defeats that **carry** a signal the stripper removes. Both evade when the import is a namespace import (`import * as W`); with a named import the import line keeps the count honest, and those forms were caught:
- **NS5b:** `const ACCEPT = "audio/*"` before `W.transcribeWithWhisper(...)`, with any later `*/`. The block-comment regex eats real code from the `/*` inside the string.
- **NS6b:** a class `#private` field line is dropped as a `#` comment.

**Existing code:** raw and stripped counts differ only where signal names sit in prose block comments; no current call site is hidden. The Builder's F3 names wrapper modules and string-built URLs; NS1, NS2 and NS4 are concrete and not in F3.

**C. Does R3's cue-write test pin the behaviour, or only its presence? PRESENCE.**
- **E11(b)'s fake brain returns `{complete:false, window_recorded:false, failed:2, turn_write_error}`.** For a silence batch, which is one `stt_silence` turn, the real `writeWindowCues` (`lib/mcp/tools/bench.ts:1484-1555`) can only return `failed: 1`. Its most likely failure is K4's: the turn batch refused, the marker-only request accepted → `complete:false, **window_recorded:true**, failed:1`.
- **My probe drives the REAL `writeWindowCues` and `postTurnBatch`, faking only `fetch`** (`scratch/E11-PREMERGE-REFUTER-cue-shapes-probe.test.ts.txt`). On `ccd12b0` both real shapes end `cues_refused`, 1 attempt, window `closed`, subject not done. **The code is right.**
- **The check under rewrites** (E11 files / real-shape outcome):

| Check becomes | E11 files | Real outcome |
|---|---|---|
| removed (R3) | caught | both shapes → `transcribed`, done=1 |
| **`!counts.window_recorded`** | **SURVIVES, 0 failed** | **batch-refused/marker-accepted → `transcribed`, done=1, 0 attempts** |
| **`counts.failed > 1`** | **SURVIVES, 0 failed** | **both shapes → `transcribed`, done=1** |
| `counts.turn_write_error` | survives | equivalent on both real shapes (harmless) |

- Both surviving rewrites are what a tidy-up of "did the write land?" would produce. Each silently re-opens R3 on real brain failures, and (b) was mandatory precisely to stop that.

## 4. Items (a)–(d) against the ruling
- **(a) MET.** The real client, only `fetch` faked, a 500 with body `empty_transcript`, every current producer, and near-misses for `startsWith`. The hand fixture is gone. Caveat under §3A.
- **(b) NOT MET in substance.** The assertion the ruling names exists, but against an impossible input; §3C.
- **(c) MET.** `room-drain.ts:981` states `silent_window: false` after `...progress`. The stale-`true` test catches its removal (1 failed).
- **(d) MET as specified, with named defeats.** Call sites counted, five roots, adapter / `/inference` / `WHISPER_BASE_URL` covered, a new site in a classified file caught. `ADAPTERS` is an adapter import the signal list misses; §3B.

## 5. To merge — test-only, for `scribe`
1. **(b):** have E11(b)'s brain answer the real K4 shape `{complete:false, window_recorded:true, failed:1, turn_write_error}`, or drive the real `writeWindowCues` through faked `fetch` as the probe does, covering **both** shapes. Rerun `!counts.window_recorded` and `counts.failed > 1`; both must fail.
2. **(d):** add `\bADAPTERS\b` as a sixth signal, and sweep `git ls-files` for every tracked source file, not a root list. NS2, NS3 and the stripper defeats are the shared-classifier round's, as already ruled; say so in the file.
3. **Optional:** rename (a)'s capture test to what it asserts — "one scenario per listed producer".

## 6. What the brief should have told me
- **The merge target.** `main` is stale and production runs this branch (carryover §1). What a merge changes in deploy terms is unstated.
- **Whether `swift test` was expected to build.** It does in a fresh `.build` (600 passed), so F5's waiver can be withdrawn once the main clone's `.build` is rebuilt.

Nothing fixed, pushed, merged or deployed. `lib/emotion/` and `lib/stt/` in the main tree untouched. Clone-only probes, removed. Subagents: none.
