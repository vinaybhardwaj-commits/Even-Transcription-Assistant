# ETA Install Build R3 — build report

**9 September 2026. Written by Claude Code at the end of the R3 build session.**

Governing spec: `ETA-INSTALL-AND-FLEET-PRD-BUILD-R3-ADDENDUM-8-SEP-2026.md`, now appended as §13 of
the repo PRD. Kickoff: `ETA-INSTALL-BUILD-R3-KICKOFF-9-SEP-2026.md`.

> **Read §3 and §8 before pushing.** Two of the gate commands are RED, both of them identically red
> at the base commit and neither caused by this work; and the seven §13.5 acceptance items have all
> still to be run on a Mac. Nothing here has been proven in a room.

---

## 1. Branch and commit

| | |
|---|---|
| Branch | `vinay/r3-self-update` |
| Base | `1193083a70a613a3e89f8c52af39ad3dd57f033c` on `feat/room-recorder` |
| Commit | The single commit on this branch, which carries this file. `git rev-parse vinay/r3-self-update` — a commit cannot quote its own sha from inside itself. |
| Pushed | **No.** Nothing was pushed. `main` was not touched. |
| Version | `Packaging/VERSION` `0.1.7` → **`0.1.8`** |

---

## 2. Pre-flight

### 2.1 Repository state — all matched

```
pwd                          /Users/vinaybhardwaj/dev/Even-Transcription-Assistant
git remote -v                origin  https://github.com/vinaybhardwaj-commits/Even-Transcription-Assistant.git
git fetch origin             (clean, no output)
git status --porcelain       ?? docs/handoff/ETA-INSTALL-AND-FLEET-MOCKUP-R3-DELTA-8-SEP-2026.html
                             ?? docs/handoff/ETA-INSTALL-AND-FLEET-PRD-BUILD-R3-ADDENDUM-8-SEP-2026.md
                             ?? docs/handoff/ETA-INSTALL-BUILD-R3-KICKOFF-9-SEP-2026.md
git rev-parse HEAD           1193083a70a613a3e89f8c52af39ad3dd57f033c
  origin/feat/room-recorder  1193083a70a613a3e89f8c52af39ad3dd57f033c
cat Packaging/VERSION        0.1.7
ls db/migrations | tail -3   0075_room_install.sql
                             0076_bootstrap_token_fk.sql
                             0077_install_input_device_name.sql
```

Expected origin, both shas equal, VERSION `0.1.7`, highest migration `0077_install_input_device_name.sql`,
and **only** untracked files in `docs/handoff/`. **All matched. PASS.**

### 2.2 The five facts — P1 to P5

| # | Verdict | The line read |
|---|---|---|
| **P1** | **PASS** | `main.swift:271` — `"KeepAlive": ["SuccessfulExit": false],`. Not `KeepAlive: true`. `grep -n ThrottleInterval main.swift` returned nothing before this build: the plist carried none. |
| **P2** | **PASS** | `main.swift:292` — `exit(0)` in `catch RoomEngineError.needsEnrolment`. `main.swift:204-205` — `// A clean return is the retired case (§4.5 rule 3): stop, and stay stopped.` / `return 0`. `main.swift:296` — `exit(1)` in the generic `catch`, and `main.swift:209` `return 1`. Before this build `main.swift` contained exactly two `exit(` calls, 0 and 1; **64 was unused.** |
| **P3** | **PASS** | `BenchClient.swift:171-176` — `public enum BenchCommandKind: String, Codable, Sendable {` with exactly four cases: `startDay`, `pauseDay`, `resumeDay`, `endDay`. `BenchClient.swift:208` — `commands = try values.decodeIfPresent([BenchCommand].self, forKey: .commands) ?? []`. |
| **P4** | **PASS** | `lib/room-install.ts:368` — `export async function latestRelease(channel: "stable" \| "test" = "stable")`, whose body is `WHERE channel = ${channel} AND withdrawn_at IS NULL` / `ORDER BY published_at DESC` / `LIMIT 1`. |
| **P5** | **PASS** | `lib/room-install-view.ts:443` — `} else if (!i.tape_advancing) {` raising `"Tape not advancing. The room is not putting audio on the day tape."` at line 446. The only other condition on that branch is last-seen recency; **there was no session test.** |

No mismatch. The build proceeded.

---

## 3. Gates

Run at the end of the build, from `~/dev/Even-Transcription-Assistant`.

| Command | Result | Same at base `1193083`? |
|---|---|---|
| `npm run typecheck` | **GREEN** — exit 0, no output | — |
| `npm test` | **GREEN** — 66 files, **1551 tests, all passed** (was 64 files / 1513 before) | — |
| `npm run build` | **GREEN** — compiled; `ƒ /api/room-recorder/release` registered as a dynamic route | — |
| `npm run check:silent` | **RED** — exit 1, 9 findings | **YES — identical 9 findings, exit 1, at `1193083`** |
| `cd apps/room-recorder && swift build` | **GREEN** — `Build complete!` | — |
| `cd apps/room-recorder && swift test` | **RED** — 492 tests / 42 suites, **46 issues across 44 tests** | **YES — the identical 44 test names and 46 issues at `1193083`** |

### 3.1 `npm run check:silent` — pre-existing, none of it mine

All 9 findings are in files this build's contract forbids touching and did not touch:
`app/[slug]/api/encounters/[id]/finalize-text/route.ts`, `.../finalize-upload/route.ts`,
`.../process/route.ts` (×5), `app/[slug]/note/NoteComposerClient.tsx` (×2). Verified by stashing
the whole diff and re-running: **9 findings and exit 1 at the base commit too.** This build adds
zero new silent-failure handlers. R2 was evidently committed under the same 9.

### 3.2 `swift test` — a LOCKED LOGIN KEYCHAIN, and it is the same fault the kickoff warns about for signing

**Every one of the 46 issues is `RoomEngineError.needsEnrolment`**, or an expectation downstream of
it. The cause is measured, not guessed:

```
$ security show-keychain-info ~/Library/Keychains/login.keychain-db
security: SecKeychainCopySettings ...: User interaction is not allowed.

$ security find-generic-password -s com.evenscribe.room-recorder.room-token
  "svce"<blob>="com.evenscribe.room-recorder.room-token"     ← the item EXISTS
  "acct"<blob>="room-session"
  "mdat"<timedate>= 20260908053720Z
```

The keychain **item is there**; the keychain is **locked**, so `RoomKeychain.load()` cannot read the
secret, `RoomEngine.startingConfiguration` throws `.needsEnrolment`, and the 44 tests that build a
real `RoomEngine` without injecting an `enrolmentReader` fail. This is the same console-versus-SSH
condition the kickoff records for `codesign` (`errSecInternalComponent`) — **this session is not a
console session with an unlocked login keychain.**

**Proof it is not this build's doing:** with the entire diff stashed, `swift test` at `1193083`
produces the *identical* set — same 44 test names, same 46 issues. Diffed both ways, both empty:

```
comm -13 base-names.txt mine-names.txt   → (empty)
comm -23 base-names.txt mine-names.txt   → (empty)
```

**All 26 new tests in `RoomSelfUpdateTests` pass.** The suite went 466 → 492 tests with the issue
count unchanged at 46.

**To make this gate green, V:** run `swift test` from Terminal.app on the Mini's own screen (or
unlock the login keychain first). No code change is needed.

### 3.3 A toolchain fault I hit, and the flags that work around it

`xcode-select -p` is `/Library/Developer/CommandLineTools` and there is no `Xcode.app`. SwiftPM does
not pass the nested swift-testing plugin directory to the frontend, so from a clean `.build` the
test target fails to compile with `plugin for module 'TestingMacros' not found`. **This is also true
at the base commit** — it is a toolchain gap, not a source problem. `swift test` works with:

```bash
cd apps/room-recorder && swift test \
  -Xswiftc -plugin-path -Xswiftc /Library/Developer/CommandLineTools/usr/lib/swift/host/plugins/testing \
  -Xlinker -rpath -Xlinker /Library/Developer/CommandLineTools/Library/Developer/Frameworks \
  -Xlinker -rpath -Xlinker /Library/Developer/CommandLineTools/Library/Developer/usr/lib
```

**My fault, stated plainly:** the pre-existing `.build` directory held artefacts that made a bare
`swift test` work; while diagnosing I deleted it, and a bare `swift test` has not worked since — on
this branch or on the base. Installing Xcode, or keeping the flags above, is the fix. No source file
is involved.

---

## 4. `git diff --stat` against `1193083`

```
 apps/room-recorder/Packaging/VERSION                                    |   2 +-
 apps/room-recorder/Sources/RoomRecorderCLI/main.swift                   |  40 ++-
 apps/room-recorder/Sources/RoomRecorderCore/BenchClient.swift           |  40 ++-
 apps/room-recorder/Sources/RoomRecorderCore/InstallPollFields.swift     |  96 +++++++-
 apps/room-recorder/Sources/RoomRecorderCore/RoomConfiguration.swift     |  28 ++-
 apps/room-recorder/Sources/RoomRecorderCore/RoomEngine.swift            | 209 +++++++++++++++-
 apps/room-recorder/Tests/TapeCoreTests/RoomBenchContractTests.swift     |   9 +-
 components/admin/BenchInstallFleet.tsx                                  |  48 +++-
 docs/BUILD-HISTORY.md                                                   |  57 +++++
 docs/handoff/ETA-ROOM-RECORDER-INSTALL-AND-FLEET-PRD-7-SEP-2026-v1.0.md | 270 +++++++++++++++++++++
 lib/room-install-view.ts                                                | 195 ++++++++++++++-
 lib/room-install.ts                                                     |  97 +++++++-
 12 files changed, 1061 insertions(+), 30 deletions(-)
```

New files (untracked before the commit):

```
app/api/room-recorder/release/route.ts
db/migrations/0078_install_update_fields.sql
apps/room-recorder/Sources/RoomRecorderCore/RoomSelfUpdate.swift
apps/room-recorder/Tests/TapeCoreTests/RoomSelfUpdateTests.swift
tests/unit/room-release-route.test.ts
tests/unit/room-install-update.test.ts
docs/handoff/ETA-INSTALL-BUILD-R3-KICKOFF-9-SEP-2026.md              (committed unchanged)
docs/handoff/ETA-INSTALL-AND-FLEET-PRD-BUILD-R3-ADDENDUM-8-SEP-2026.md (committed unchanged)
docs/handoff/ETA-INSTALL-AND-FLEET-MOCKUP-R3-DELTA-8-SEP-2026.html    (committed unchanged)
docs/handoff/ETA-INSTALL-BUILD-R3-REPORT-9-SEP-2026.md               (this file)
```

Everything on the kickoff §6 UNTOUCHED list is untouched. `Packaging/build-bundle.sh` was **read and
not edited**; `package.json` gained no dependency; migrations 0001–0077 are unchanged; no fifth
command-bus kind exists.

---

## 5. Every inferred SQL string, verbatim

**§8 of the kickoff: every one of these is INFERRED and must be validated against the live database
before anything is pushed.** Migrations 0075–0077 exist in the repo but **whether they are applied in
production is not confirmed**, and **0078 has not been run anywhere**.

### 5.1 Migration `db/migrations/0078_install_update_fields.sql` — NOT RUN

```sql
ALTER TABLE room_install
  ADD COLUMN IF NOT EXISTS session_open       boolean,
  ADD COLUMN IF NOT EXISTS update_channel     text NOT NULL DEFAULT 'stable',
  ADD COLUMN IF NOT EXISTS last_update_result text,
  ADD COLUMN IF NOT EXISTS last_update_error  text,
  ADD COLUMN IF NOT EXISTS last_update_at     timestamptz,
  ADD COLUMN IF NOT EXISTS disk_free_bytes    bigint;
```

Followed by one `COMMENT ON COLUMN room_install.<name> IS '...'` for each of the six, and:

```sql
INSERT INTO schema_migrations (version, name)
VALUES (78, '0078_install_update_fields')
ON CONFLICT DO NOTHING;
```

Additive and idempotent throughout. No `DROP`, no `ALTER COLUMN`, no constraint, no index, no row
rewrite — safe whatever the applied state of 0075–0077 turns out to be.

### 5.2 `applyInstallPoll` — the changed UPDATE (`lib/room-install.ts`)

Unchanged clauses elided; **the six added lines are the last six of the SET list**:

```sql
UPDATE room_install
   SET last_seen_at   = now(),
       first_seen_at  = COALESCE(first_seen_at, now()),
       app_version    = COALESCE(${f.app_version}::text,   app_version),
       build_sha      = COALESCE(${f.build_sha}::text,     build_sha),
       hostname       = COALESCE(${f.hostname}::text,      hostname),
       hardware_model = COALESCE(${f.hardware_model}::text, hardware_model),
       os_version     = COALESCE(${f.os_version}::text,    os_version),
       input_device_name = COALESCE(${f.input_device_name}::text, input_device_name),
       mic_state      = COALESCE(${f.mic_state}::text,     mic_state),
       never_sleep    = COALESCE(${f.never_sleep}::boolean, never_sleep),
       launched_by    = COALESCE(${f.launched_by}::text,   launched_by),
       launch_agent_loaded = CASE
         WHEN ${f.launched_by}::text IS NULL THEN launch_agent_loaded
         ELSE ${f.launched_by}::text = 'launchd'
       END,
       tape_advancing = COALESCE(${f.tape_advancing}::boolean, tape_advancing),
       tape_poll_streak = CASE
         WHEN ${f.tape_advancing}::boolean IS NULL THEN tape_poll_streak
         WHEN ${f.tape_advancing}::boolean THEN tape_poll_streak + 1
         ELSE 0
       END,
       tape_advancing_since = CASE
         WHEN ${f.tape_advancing}::boolean IS NULL THEN tape_advancing_since
         WHEN ${f.tape_advancing}::boolean THEN COALESCE(tape_advancing_since, now())
         ELSE NULL
       END,
       session_open   = ${f.session_open}::boolean,
       update_channel = COALESCE(${f.update_channel}::text, update_channel),
       last_update_result = COALESCE(${f.last_update_result}::text, last_update_result),
       last_update_error  = COALESCE(${f.last_update_error}::text,  last_update_error),
       last_update_at     = COALESCE(${f.last_update_at}::timestamptz, last_update_at),
       disk_free_bytes    = COALESCE(${f.disk_free_bytes}::bigint, disk_free_bytes)
 WHERE install_id = ${f.install_id}
   AND retired_at IS NULL
RETURNING install_id
```

`session_open` is written **raw**, not COALESCEd — §13.4 requires it, and R3-3 depends on it. The
other five COALESCE so a failure cannot be erased by the next poll.

### 5.3 `readFleet` — the install SELECT gains six columns

```sql
SELECT install_id, room_id, created_at, enrolled_at, session_expires_at, launched_by,
     hostname, hardware_model, os_version, input_device_name, app_version, build_sha,
     first_seen_at, last_seen_at, mic_state, launch_agent_loaded,
     tape_advancing, tape_poll_streak, tape_advancing_since, never_sleep, retired_at,
     session_open, update_channel, last_update_result, last_update_error,
     last_update_at, disk_free_bytes
  FROM room_install
 ORDER BY created_at DESC
 LIMIT 500
```

### 5.4 `retireInstall` — the same six added to RETURNING

```sql
UPDATE room_install
   SET retired_at = now()
 WHERE install_id = ${installId} AND retired_at IS NULL
RETURNING install_id, room_id, created_at, enrolled_at, session_expires_at, launched_by,
     hostname, hardware_model, os_version, input_device_name, app_version, build_sha,
     first_seen_at, last_seen_at, mic_state, launch_agent_loaded,
     tape_advancing, tape_poll_streak, tape_advancing_since, never_sleep, retired_at,
     session_open, update_channel, last_update_result, last_update_error,
     last_update_at, disk_free_bytes
```

Added so the returned row has the same shape `InstallView` now declares.

### 5.5 The release route issues no SQL of its own

It calls `latestRelease(channel)`, which is **unchanged** — the existing
`SELECT ... FROM app_release WHERE channel = ${channel} AND withdrawn_at IS NULL ORDER BY published_at DESC LIMIT 1`.

**No other SQL was written or changed in this build.**

---

## 6. R3-1 to R3-12, each confirmed implemented

| # | Where | Note |
|---|---|---|
| **R3-1** | `RoomSelfUpdate.swift:301` `spawnDetached`, `:307` `POSIX_SPAWN_SETSID`; script rendered at `RoomSelfUpdate.swift:560`+ | The app stages and verifies only. It spawns `/bin/bash <staging>/swap.sh` into a **new session** via `posix_spawn`, then exits. `RoomUpdater.stage` never touches `residentBundleURL` — proved by `aCleanStagingEndsInADetachedSpawnAndAHandover`. |
| **R3-2** | — | Sequencing, not code. R3 is built and ready before any clinic Mac is installed again. |
| **R3-3** | `lib/room-install-view.ts:608` — `} else if (!i.tape_advancing && sessionOpen === true) {` | `=== true`, not truthiness: `session_open` is null on every install below 0.1.8 and null must not raise an alarm. Tape cell wording at `:503-510`. |
| **R3-4** | `main.swift:225` `return 64`; `RoomEngine.swift:187` `case handedOverToUpdate`, `:931` set, `:770` doc | 64 is distinct from 0 (stay stopped) and 1 (any error), and its non-zero-ness is the fail-safe. A log line is written to stderr at `main.swift:213-221` before returning. |
| **R3-5** | `RoomSelfUpdate.swift:39` `pinnedLeafSHA1`, `:50-51` `pinnedRequirement` | Compile-time constants. The route's 200 carries **no signer** — asserted by `tests/unit/room-release-route.test.ts` ("returns the four contract fields and NO signer"). |
| **R3-6** | `RoomEngine.swift:706` `sessionIsOpen`, `:868` `sessionOpen: sessionIsOpen` | Derived from the engine's own `phase` at the moment of the poll — the same expression that decides `recording_session_id`, so the two cannot disagree. The bench listener's `recording` flag is not consulted. |
| **R3-7** | `lib/room-install-view.ts:513` `updateNote`, `:539` `update_note`; `BenchInstallFleet.tsx` App cell | One sentence, in the **App cell**, only when `last_update_result` is present and is not `ok`. `ok` and absent show nothing. |
| **R3-8** | `RoomConfiguration.swift:178` `updateChannel`; reported at `RoomEngine.swift:869`; shown at `room-install-view.ts` `channel_label` | Per Mac, in `config.json`, default `stable`, surviving a re-enrol (`theChannelSurvivesAReEnrolment`). |
| **R3-9** | `RoomSelfUpdate.swift:395` and `BenchClient.fetchRelease` | Every non-200 — 404, 401, decode failure, timeout, dead network — becomes `nil`, which logs and changes nothing on disk. Proved by `aNon200LeavesTheDiskCompletelyUntouched`. |
| **R3-10** | `RoomSelfUpdate.swift:210-213` `isDue(now:sessionJustEnded:)`; transition detected in `RoomEngine.checkForUpdateIfDue` | A deferred check re-runs at session END, not six hours later. Proved by `aDeferredCheckReRunsWhenTheSessionEnds_notSixHoursLater`. |
| **R3-11** | `main.swift:303` `"ThrottleInterval": 30`; `RoomSelfUpdate.swift:678` script step 8.7 | The script runs the **resident (new)** bundle's `install-launch-agent --root "$ROOT"` before bootstrapping. Proved by `theNewBundleWritesThePlistBeforeTheAgentIsBootstrapped` — the log shows `0.1.8 install-launch-agent`, never `0.1.7`. |
| **R3-12** | `RoomSelfUpdate.swift:643` — `/bin/rm -rf "$PREVIOUS"` before the first move | Proved by `exactlyOnePreviousBundleIsKept`, which runs two swaps and asserts the directory holds exactly `…app` and `…app.previous` and nothing else. |

**Mockup state C confirmed; state D absent.** The failure sentence is rendered in the **App cell**
only (`BenchInstallFleet.tsx`, App `<td>`), and `deriveRow` deliberately does **not** push it onto
`attention` — which is where every other row line renders, i.e. the Last seen / Actions area state D
would have used. The test `puts the sentence in the App cell and NOT in the attention list — state D
does not ship` pins this. States A, B and E ship.

---

## 7. The final wire poll fields, and the count reconciled

`InstallPollFields.queryItems()` now emits **17 items**, in this order:

| # | Field | New in R3? |
|---|---|---|
| 1 | `install_id` | |
| 2 | `app_version` | |
| 3 | `build_sha` | |
| 4 | `mic_state` | |
| 5 | `tape_advancing` | |
| 6 | `never_sleep` | |
| 7 | `launched_by` | |
| 8 | `hostname` | machine fact |
| 9 | `hardware_model` | machine fact |
| 10 | `os_version` | machine fact |
| 11 | `input_device_name` | |
| 12 | `session_open` | **R3** |
| 13 | `update_channel` | **R3** |
| 14 | `last_update_result` | **R3** |
| 15 | `last_update_error` | **R3** |
| 16 | `last_update_at` | **R3** |
| 17 | `disk_free_bytes` | **R3 [V-9SEP]** |

The bench poll also carries `tab_id`, `prev_poll_at`, `recording_session_id`, `paused`, `mic_peak`,
`mic_avg` — the listener's own fields, not install poll fields. **`spare_device` is no longer among
them** (§5.7).

### The reconciliation §5.6 asked for

**§13.4 says "the wire carries twelve poll fields after this build, up from eight." That arithmetic
does not come out, and it did not come out before V's sixth column either.**

- "Eight" is §4.3's eight: `install_id`, `app_version`, `build_sha`, `mic_state`, `tape_advancing`,
  `never_sleep`, `launched_by`, `input_device_name`. The three machine facts
  (`hostname`, `hardware_model`, `os_version`) are explicitly *not* among the eight, which is why the
  pre-R3 wire carried **11 items** while §4.3 called it eight fields.
- §13.4 then adds **five** columns. 8 + 5 = **13**, not twelve. The addendum is off by one on its own
  numbers.
- V's 9 September addition makes it six. 8 + 6 = **14 poll fields**, or **17 wire items** counting
  the three machine facts.

**So: 14 poll fields, 17 wire items.** Nothing was dropped from the eight; one non-field literal
(`spare_device`, which was never one of the eight) was removed. **Flagged for V** — §13.4's sentence
should read fourteen, and the report cannot make twelve true under any consistent counting.

---

## 8. Deviations and flags

Everything below is a decision the kickoff did not settle, taken conservatively and named here
rather than made silently.

### 8.1 The `codesign -R` requirement string carries a leading `= ` — a deliberate deviation

§13.3 step 6 quotes the argument as `'anchor trusted and certificate leaf = H"187dd…"'`.
**`Packaging/build-bundle.sh` has always passed `"= anchor trusted and certificate leaf = H\"…\""`**,
with the `= ` — and the addendum itself records that form was verified on 8 September to
discriminate (pinned to a different leaf it fails). `codesign -R` treats an argument as requirement
*source text* when it opens with `=` and otherwise may read it as a **path to a compiled
requirement**, so the kickoff's literal risks a check that silently passes everything.

**Chosen: the packaging script's proven form**, `RoomSelfUpdate.pinnedRequirement`
(`RoomSelfUpdate.swift:50`). Pinned by a test. **V should confirm.**

### 8.2 `--deep` IS on both codesign checks — §9's third bullet, answered from precedent

The bundle carries two separately signed helpers under `Contents/Helpers` (`ffmpeg`, `tapewriter`).
`build-bundle.sh` already runs `codesign --verify --strict --deep -R "<pinned>"` against the
**unpacked zip** — the same bundle shape, unpacked the same way with `ditto -x -k`, which is exactly
what the app verifies. So `--deep` is used on the staged check and on the swap script's resident
check. This is precedent, not a guess.

### 8.3 The window between the two moves is narrowed by a trap, NOT closed — READ THIS

Acceptance item 6 requires that a swap script **killed between the two moves** leaves a working
bundle resident and the room polling without a visit. **The ratified step order in §13.3 step 8 does
not by itself achieve that**: after 8.1 boots the agent out, if the process dies between
`mv RESIDENT → PREVIOUS` and `mv STAGED → RESIDENT`, the resident path is empty, launchd has been
booted out, and nothing recovers. Exit 64's fail-safe covers dying *before* 8.1, not this.

**What was built:** the script installs `trap rescue INT TERM HUP QUIT`
(`RoomSelfUpdate.swift:620-628`). If it is interrupted with the resident path empty and `.previous`
present, it moves `.previous` back, records `swap_failed`, and bootstraps the agent in again. The
test `aScriptKilledDuringTheSwapLeavesAWorkingBundleAtTheResidentPath` sends a real `SIGTERM` to a
real running script and asserts an executable bundle is resident afterwards.

**What is NOT covered: `kill -9`.** SIGKILL is not trappable. The residual window is two directory
renames on one volume — microseconds — but it is not zero.

**FLAG FOR V.** Closing it completely needs an atomic exchange (`renamex_np` with `RENAME_SWAP`),
which shell cannot perform and which would mean a small new verb in the app. That is a change to a
ratified decision and I did not make it. **When running acceptance item 6, use `kill` (SIGTERM), not
`kill -9`** — and if you want item 6 to hold under SIGKILL too, that is a follow-up to ratify.

### 8.4 The version travels inside `last_update_error`, because no column holds it

The mockup's contract sentence names the version that failed — "Update to **0.1.8** stopped at
09:14." **§13.4 fixes the R3 columns at five, V's addition made six, and none of them is the version
an update was attempting.** Rather than invent a seventh column against a ratified list, the app
writes `"<version> — <reason>"` into the field §13.4 calls "the reason line", and
`lib/room-install-view.ts` reads it back off the same separator (`UPDATE_ERROR_SEPARATOR`,
`RoomUpdateResult.errorSeparator` — kept identical on both sides, in the same build).

A line that does not match degrades to a shorter **true** sentence ("Update stopped at 09:14. …")
with no version, never a crash and never an invented version. Pinned by a test.
**FLAG: V may prefer a seventh column, `last_update_version`. Cheap to add later; additive.**

### 8.5 Where the update check sits in the lifecycle — §9's first bullet

**Chosen: at the end of a successful poll iteration**, after the receipt has been delivered and after
that tick's commands have been applied (`RoomEngine.swift:920-933`). Three reasons: the receipt is
already reported, so a handover cannot discard an unreported failure; `sessionIsOpen` is the
freshest reading the engine has, so a session that ended on this very poll is visible to R3-10; and a
room that cannot reach the server never reaches the line at all, which is R3-9's "do nothing" for
free. **The cost:** "on launch" means "on the first successful poll", about 1.5 s in, not at process
start. Stated because it is a real, if small, departure from §13.3 step 1's wording.

### 8.6 The reason sentences the mockup does not show

The mockup gives two, and they are used verbatim: `checksum_mismatch` → "The downloaded file did not
match its checksum." and `signature_mismatch` → "The downloaded app was not signed by Even." The
other three are **mine**, written to the same shape (plain, past tense, no instruction — nothing here
is something an operator can act on from a screen):

- `download_failed` → "The download did not finish."
- `expand_failed` → "The downloaded file could not be unpacked."
- `swap_failed` → "The new version did not verify once it was in place, so the previous one was put back."

An outcome this build has no words for still renders, naming the code. **V to ratify the three.**

### 8.7 The mockup and the kickoff disagree about where the channel goes

Kickoff §5.8.3 says the channel appears "beside the app version". **The approved mockup puts the
`channel stable` / `channel test` tag in the Room cell with the pills** (state A, C and E markup) and
uses the App cell's dim line for `test channel` on a test-channel Mac. **Followed the mockup**, since
§4 calls it "the approved visual": tag in the Room cell, and the App cell's dim line reads
`test channel` instead of `latest 0.1.8` for a Mac on `test`.

### 8.8 `update pending` on a test-channel Mac — a contradiction I did not resolve silently

§5.8 says "The existing `update pending` word needs no change." **But the card's release header and
`update pending` both compare against `latestRelease("stable")`, so Home Office on `test` running
`0.1.9-test` will wear `update pending` for ever** — and the mockup's state E draws Home Office with
**no** such pill. **Followed the kickoff and left `update pending` untouched**, and made only the
App-cell dim line channel-aware (8.7). **FLAG: V should decide whether `update pending` should be
suppressed for a Mac whose channel is not the header's.**

### 8.9 State C marks the row for attention

The mockup draws state C's row as `<tr class="attn">`. §5.8.2 does not say whether the row state
changes. **Chosen: `deriveRow` returns `needs_attention` when an update failed, WITHOUT adding a line
to `attention`** — so the row is highlighted as drawn, and the sentence renders once, in the App
cell, rather than a second time where attention lines go.

### 8.10 The tape warning goes quiet on every pre-0.1.8 room

R3-3 is implemented as `session_open === true`, exactly as §5.8.1 words it. **Consequence: a room
still on 0.1.7 reports `session_open` as absent for ever and therefore never raises "Tape not
advancing" again**, until it self-updates. Given R3-2 (R3 ships before any clinic Mac is installed)
and that the warning it raised on an idle room was false anyway, this is the right trade — but it is
a real change in behaviour for any room left on 0.1.7 and is named here.

### 8.11 There is no verb to set the channel; it is a hand edit

`configure` writes a whole fresh configuration, so it cannot be used to re-channel an already-enrolled
Mac without destroying its config. **No `--update-channel` option was added** — the kickoff's
main.swift edit list does not include one, and [V-9SEP] rules against adding knobs that would then
exist in every clinic room. **Home Office reaches `test` by editing `config.json`** — see §9.3. A
typo in that edit leaves the Mac on `stable` rather than refusing to start (`RoomConfiguration.swift`,
tested).

### 8.12 `disk_free_bytes` is read in `InstallPollFields.swift`, not `MachineFacts.swift`

`MachineFacts.swift` is **not on the kickoff §6 editable list**. Free space is also a fact about one
*directory* (the captures volume), which only the engine knows, whereas `MachineFacts` measures the
machine. The reader is `InstallPollFields.freeBytes(onVolumeHolding:)`, called from `RoomEngine` with
`capturesURL`. Uses `volumeAvailableCapacityForImportantUsageKey` as V specified — not
`volumeAvailableCapacityKey`, which under-reports by whatever macOS holds as purgeable and would make
a healthy Mac look near full. **Returns nil, never 0.**

### 8.13 One existing test file was edited, unavoidably

`apps/room-recorder/Tests/TapeCoreTests/RoomBenchContractTests.swift` — the test
`pollUsesExactNativePrimaryQueryAndNoSpareLane` pins the poll query **exactly**, and asserted
`"spare_device": "false"`. §5.7 orders that item removed, so the assertion had to change with the
wire it pins. It now asserts `query["spare_device"] == nil`, which is the stronger guard. This is the
only pre-existing test touched.

### 8.14 `run()` returns Void; the outcome is a property

`RoomEngine.run()` was first changed to return `RoomEngineExit`, which put an unused-result warning on
a dozen existing test call sites and invited a sweep through test files the contract does not open.
**It returns Void as before, and `exitReason` (`RoomEngine.swift:768`) carries the answer** for the
one caller that wants it.

### 8.15 §5.9.1's premise did not hold: there is only ONE PRD copy

The kickoff says to append §13 to "the repo copy" and then copy it into `docs/handoff/`, because "the
handoff copy is stale at §12.3 while the repo copy runs to §12.11". **There is exactly one PRD file
in this repository — `docs/handoff/ETA-ROOM-RECORDER-INSTALL-AND-FLEET-PRD-7-SEP-2026-v1.0.md` — and
it already ran to §12.11.** `find` confirms no second copy. **§13 was appended to that one file**;
the copy-back step is a no-op and nothing was duplicated.

### 8.16 A `CLAUDE.md` appeared in the working tree during this session — NOT committed

The kickoff states "This repo has no `CLAUDE.md`. This section governs." That was true at pre-flight
(`git status --porcelain` showed only the three `docs/handoff/` files). **An untracked `CLAUDE.md`
appeared at 20:19 today, written by something outside this build** — I did not create it. It names a
different gate list (`npm test`, `npm run typecheck`, `npm run build`) and some `<CONFIRM:>`
placeholders.

**It is not in the file contract and was NOT staged or committed.** It is still sitting untracked in
the working tree for V to deal with. Its gate list did prompt me to run `npm run build`, which passes
(§3). **V: decide what that file is and whether it belongs in the repo.**

### 8.17 §9's fourth bullet — answered from the source, not assumed

**"Whether the server's install-poll upsert already COALESCEs `spare_device`."** It does, and
`spare_device` lives on `bench_listener`, not `room_install`:

- `app/api/bench/commands/route.ts:60-61` — an absent `spare_device` becomes `null`.
- `lib/bench-commands.ts:219` — `undefined` becomes `null`.
- `lib/bench-commands.ts:248` — `spare_device = COALESCE(EXCLUDED.spare_device, bench_listener.spare_device)`.

**So omitting the item keeps the column and the poll is not rejected.** §5.7's "if the server rejects
a poll that omits it, STOP and report" does not trigger. Verified in the source before the line was
deleted.

---

## 9. Manual steps V must run

Nothing below has been done. All of it needs the Mini's own screen, per the kickoff's console rule.

### 9.1 Migration 0078

**Not run anywhere.** Apply `db/migrations/0078_install_update_fields.sql` to production before the
0.1.8 build reaches any Mac — the app starts sending six new query items immediately, and without the
columns `applyInstallPoll` will fail (the write is already swallowed so a recording room never stops,
but nothing will be recorded). Validate §5's SQL against the live schema first, and confirm whether
0075–0077 are in fact applied.

### 9.2 Package and sign, at the console

```bash
cd ~/dev/Even-Transcription-Assistant/apps/room-recorder
./Packaging/build-bundle.sh          # VERSION is already 0.1.8
```

**From Terminal.app on the Mini's own screen, not over SSH** — signing fails over SSH with
`errSecInternalComponent`. The script fails the build if the audio-input entitlement is missing and
verifies the unpacked zip against the pinned leaf.

### 9.3 Put Home Office on the `test` channel

There is no verb for this (§8.11). On Home Office, with the app stopped:

```bash
launchctl bootout gui/$(id -u)/com.evenscribe.room-recorder
# edit ~/Library/Application Support/EvenScribe/RoomRecorder/config.json
#   add:  "update_channel": "test",
# keep the file at 0600 — the app verifies its permissions and refuses otherwise
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.evenscribe.room-recorder.plist
```

The value survives a re-enrol. A typo leaves it on `stable`.

### 9.4 Publish

Per `ETA-INSTALL-BUILD-R1-REPORT-7-SEP-2026.md` §3's curl runbook, `POST /api/admin/releases` with
the `release.json` the packaging script wrote. **Publish 0.1.8 to `test` first** (acceptance item 7),
and only to `stable` once item 1 has happened on Home Office.

### 9.5 Force a check during acceptance

The interval is 6 hours and is not a knob. After a publish, on Home Office:

```bash
launchctl kickstart -k gui/$(id -u)/com.evenscribe.room-recorder
```

This restarts the app, which checks on its first successful poll (§8.5). **A manual acceptance step,
not a feature.**

### 9.6 The seven acceptance items — §13.5

**None has been run. Home Office is the only room to touch, and only when V says so.** In order:

1. One normal update on Home Office; the card shows the new version after the swap.
2. One withdraw; the same Mac returns to the previous version at its next check.
3. Microphone permission unchanged across both swaps, no new macOS prompt.
4. An update attempted while a session records — the app defers, and `update.log` shows the deferral.
5. A deliberately corrupted zip — the update stops, the resident copy is unchanged, and **the fleet
   card row names the reason in the App cell**.
6. A swap script killed between the two moves — **use `kill` (SIGTERM), not `kill -9`; see §8.3.**
7. Home Office on `test` and one other room on `stable`; a publish to `test` reaches Home Office and
   no other room.

**If item 1 does not happen, the release does not go to the clinic rooms.**

Useful during acceptance: the swap script logs to
`~/Library/Application Support/EvenScribe/RoomRecorder/update.log`, and the receipt it writes is
`update-result.json` in the same directory (deleted by the app after the poll that carries it).

---

## 10. Which install is bound to Home Office

**`install_gd9tnfgqazvh`** — the 8 September carryover value, **not** §12.11's `install_5bt4ue32w3vv`.

Evidence, read on this Mac during the build:

```
~/Library/Application Support/EvenScribe/RoomRecorder/config.json
  "install_id" : "install_gd9tnfgqazvh"
  "tab_id"     : "app_install_gd9tnfgqazvh"
  "room_slug"  : "home-office-w8fb"
  "device_uid" : "AppleUSBAudioEngine:...:TONOR TM20 Audio Device:20200918:1"

keychain item com.evenscribe.room-recorder.room-token   "mdat" = 20260908053720Z
```

This agrees with the R3 mockup's state E, which draws Home Office as `install_gd9tnfgqazvh`.

**Caveat, stated because it matters:** `config.json`'s install id is a convenience — the code's own
comment says the keychain is the authority, and the keychain secret is unreadable here (§3.2). The
**server** is the authority for which install is *bound*, and I did not query production. So: local
evidence is unambiguous and consistent, but this is not a server-side confirmation.

---

## 11. What I could not verify

Named exactly, none of it worked around.

1. **`swift test` green.** 46 issues remain, all from the locked login keychain, identical at the base
   commit. Needs a console session. (§3.2)
2. **`npm run check:silent` green.** 9 pre-existing findings in files this contract forbids touching,
   identical at the base commit. (§3.1)
3. **Migration 0078 against a real database.** Never run. Every SQL string in §5 is INFERRED.
4. **Whether 0075, 0076 and 0077 are applied in production.** Not confirmed; 0078 is written to be
   safe either way.
5. **All seven acceptance items.** None run. In particular **item 6 is proven only under SIGTERM**, by
   a test that runs the real script; the SIGKILL window is open and flagged. (§8.3)
6. **That `codesign` accepts the pinned requirement on a real signed bundle.** The tests stub
   `codesign`. The string matches what `build-bundle.sh` has used successfully, but the app's
   invocation has not been run against real signed bytes. (§8.1)
7. **That the swap actually preserves the microphone grant** (acceptance item 3). §12.10 establishes
   TCC binds to the designated requirement rather than the cdhash, so it should — but "should" is not
   "did".
8. **That `posix_spawn` with `POSIX_SPAWN_SETSID` survives launchd terminating the job.** Correct by
   construction and by the man page; not observed on a real Mac under a real `bootout`.
9. **The server-side binding of Home Office's install id.** (§10)
10. **What `CLAUDE.md` is and who wrote it.** (§8.16)

---

## 12. One line to V

The code is complete against §13 and every ratified decision, the TypeScript gates and both builds are
green, and 26 new Swift tests plus 38 new TypeScript tests pass — but **nothing has been proven in a
room**, the two red gates are red for reasons that predate this branch, and **the SIGKILL window in
§8.3 is a genuine gap in the ratified design that only you can close.**
