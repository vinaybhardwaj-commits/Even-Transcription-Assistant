# ETA Install Build R3 — self-update, so no change ever needs a walk again

**Kickoff for Claude Code. Paste this whole file.**

Working directory: `~/dev/Even-Transcription-Assistant` on the Mini, branch `feat/room-recorder`, HEAD
`1193083a70a613a3e89f8c52af39ad3dd57f033c` (verified 9 Sep, local and origin agree). **Run this session
from Terminal.app on the Mini's own screen, not over SSH.** Signing needs the unlocked login keychain,
which only a console session has. Verified 8 Sep: signing fails over SSH with `errSecInternalComponent`
and succeeds at the console. Screen Sharing is a console session. SSH is not.

**The governing spec is the Build R3 addendum**,
`docs/handoff/ETA-INSTALL-AND-FLEET-PRD-BUILD-R3-ADDENDUM-8-SEP-2026.md`, which is §13 of
`ETA-ROOM-RECORDER-INSTALL-AND-FLEET-PRD-7-SEP-2026-v1.0.md`. **§13 supersedes §7 where they disagree,
and they disagree about steps 7 to 10.** Read §13 in full before anything else. Then PRD §5.5 (the
reported-fields invariant), §9 (hazards), §12 (R1 and R2 addenda).
`ETA-INSTALL-BUILD-R1-REPORT-7-SEP-2026.md` §3 has the working curl runbook for publish.

Production serves `46a7475`. Migrations run through **0077**. Next is **0078**. `Packaging/VERSION` is
`0.1.7`; this build ships **0.1.8**.

**All design decisions are settled.** R3-1 to R3-8 were ratified by V on 8 September. R3-9 to R3-12 were
ratified by V on 9 September, as written. The mockup state is **C**, named by V on 9 September. Two scope
additions were ratified by V on 9 September and are marked **[V-9SEP]** below. Do not reopen any of them.
Flag genuine gaps in your report; do not decide them silently.

This kickoff, the addendum and the mockup delta are untracked in `docs/handoff/`. Commit all three
unchanged with your work, as R2 did.

---

## 0. Branch and push policy

This repo has no `CLAUDE.md`. This section governs.

- Create branch **`vinay/r3-self-update`** off `feat/room-recorder` at `1193083`.
- **Commit on the branch. DO NOT PUSH. DO NOT TOUCH `main`.** V pushes and merges on his own order.
- Stage by exact filename. No `git add -A`, no `git add .`.
- No commit without a green gate (§8).
- Stop and report on a contradicted premise rather than working around it.

---

## 1. Why this build exists

The app cannot update itself, so every fix needs a person at each Mac, and V is remote with four clinic
rooms recording.

Most of self-update is already built and live: `app_release` (0075), `POST /api/admin/releases` with
server-side sha256 recompute, the withdraw route, `latestRelease()`, the fleet card release header, and
every room reporting `app_version` and `build_sha` on every poll. **The one missing piece is that no room
can ask what version it should be running.** `app/api/room-recorder/` holds only `bootstrap/[token]` and
`enrol`.

R3-2 governs the order: **R3 ships before any clinic Mac is installed again**, so each room takes one
paste, ever, rather than one now and another to reach the first self-updating build.

---

## 2. Ratified decisions carried into this kickoff

Restated so you do not have to hold two documents open. §13.1 and §13.2 of the addendum are authoritative.

| # | Decision |
|---|---|
| R3-1 | **A detached swap script performs the swap and owns the restart.** The app stages, verifies, writes the script, spawns it detached, and exits. **The app never moves its own running bundle.** |
| R3-2 | R3 ships before any clinic Mac is installed. |
| R3-3 | The "Tape not advancing" warning is fixed inside R3. Without the fix, R3's restart makes every update raise a false warning in every room. |
| R3-4 | **The app exits 64** after handing over, and writes a log line. 64 is distinct from 0 (stay stopped) and 1 (any error). The non-zero value is the fail-safe: if the swap script dies before it boots the agent out, launchd restarts the old app and the room keeps recording. |
| R3-5 | The expected signing identity is a **compile-time constant in the app**, SHA-1 `187DD424FB866204111113D60C6F88A21D098EDB`. Never taken from the server. |
| R3-6 | The app reports **`session_open`** as a new poll field, derived from its own engine at poll time. The bench listener's `recording` flag is not usable: OPD 5's row has read true since 24 August with no session open. |
| R3-7 | A failed update shows on the room row, and only a failed update shows. |
| R3-8 | **The update channel is per Mac**, in `config.json`, default `stable`. Home Office sits on `test`. The app reports its channel; the card shows it. This is the valve that stops one bad publish walking into every room. |
| R3-9 | **Any answer other than 200 from the release route means do nothing.** 404, 401, timeout, network failure: log it, change nothing on disk, check again next tick. A missing release is never a reason to remove software. |
| R3-10 | After a deferred check, **re-check when the session ends**, not six hours later. |
| R3-11 | The plist gains **`ThrottleInterval` 30 seconds**, and the swap script runs the NEW bundle's `install-launch-agent` verb before bootstrapping, so a plist change ships with the app. |
| R3-12 | **One previous bundle is kept, never two.** The swap script removes any earlier `.previous` before saving the current one. |
| **[V-9SEP]** | Mockup **state C**: the update-failure sentence sits in the **App cell**, under the version that did not change. |
| **[V-9SEP]** | **Scope addition:** `disk_free_bytes` joins migration 0078 as a sixth column, and the hard-coded `spare_device` query item is removed. §5.6 and §5.7. |
| **[V-9SEP]** | **No configurable check interval.** Acceptance forces a check with `launchctl kickstart -k`. Do not add a knob that would then exist in every clinic room forever. |

---

## 3. Pre-flight. Run all of it. STOP on any mismatch.

```
pwd
git remote -v
git fetch origin
git status --porcelain
git rev-parse HEAD origin/feat/room-recorder
cat apps/room-recorder/Packaging/VERSION
ls db/migrations/ | tail -3
```

Expected: origin `vinaybhardwaj-commits/Even-Transcription-Assistant`; HEAD and
`origin/feat/room-recorder` both `1193083a70a613a3e89f8c52af39ad3dd57f033c`; VERSION `0.1.7`; highest
migration `0077_install_input_device_name.sql`.

`git status --porcelain` should show **only** untracked files in `docs/handoff/`. Anything else dirty:
STOP and report.

Then verify these five facts in the source. **The design rests on them. If any one differs, STOP and
report before writing code.**

| # | Fact | Where this kickoff says it is |
|---|---|---|
| P1 | The LaunchAgent uses `KeepAlive = {"SuccessfulExit": false}`, not `KeepAlive: true`, and carries no `ThrottleInterval` | `Sources/RoomRecorderCLI/main.swift` ~262-275 |
| P2 | `needs_enrol` and the retired 409 both exit **zero** on purpose, to stay stopped; exit 1 already means any error | `main.swift` ~204, ~287-292 |
| P3 | `BenchCommandKind` has exactly four cases and is decoded as `[BenchCommand].self` | `RoomRecorderCore/BenchClient.swift` ~171-176, ~208 |
| P4 | `latestRelease(channel)` returns the newest non-withdrawn release, ordered by `published_at DESC` | `lib/room-install.ts` ~368-382 |
| P5 | `deriveRow` raises "Tape not advancing" from `tape_advancing` alone, with no session test | `lib/room-install-view.ts` |

---

## 4. Grounding. Read these before writing code.

| File | Why |
|---|---|
| `docs/handoff/ETA-INSTALL-AND-FLEET-PRD-BUILD-R3-ADDENDUM-8-SEP-2026.md` | **The governing spec.** §13.3 is the amended step list, §13.4 the contract, §13.5 acceptance, §13.6 out of scope. |
| `docs/handoff/ETA-INSTALL-AND-FLEET-MOCKUP-R3-DELTA-8-SEP-2026.html` | The approved visual. Build **state C**. States A, B and E also ship; state D does not. |
| `docs/handoff/ETA-ROOM-RECORDER-INSTALL-AND-FLEET-PRD-7-SEP-2026-v1.0.md` | §5.5 the reported-fields invariant, §9 hazards, §12 the R1 and R2 addenda. §7 only as superseded by §13. |
| `docs/handoff/ETA-INSTALL-BUILD-R2-KICKOFF-8-SEP-2026.md` | The packaging and signing contract you must not break. |
| `Sources/RoomRecorderCLI/main.swift` | The only entry point. `run`, `install-launch-agent`, every exit path. |
| `Sources/RoomRecorderCore/RoomEngine.swift` | Poll loop, session state, `startCapture`. |
| `Sources/RoomRecorderCore/BenchClient.swift` | Every HTTP call. |
| `Sources/RoomRecorderCore/InstallPollFields.swift` | The poll fields and their invariant. |
| `Sources/RoomRecorderCore/RoomConfiguration.swift` | `config.json` and the `configure` verb's option list. |
| `apps/room-recorder/Packaging/build-bundle.sh` | Signing, the pinned leaf, `release.json`. |
| `lib/room-install.ts` | `latestRelease()`, `applyInstallPoll()`, `readFleet()`, the `InstallError` taxonomy. |
| `lib/room-install-view.ts` | `deriveRow`, the words and the attention lines. |
| `app/api/bench/commands/route.ts` | The auth pattern the new route copies. |
| `db/migrations/0077_install_input_device_name.sql` | House style for a migration. |

---

## 5. What to build

### 5.1 The release route

Create `app/api/room-recorder/release/route.ts`.

| Method and path | Auth | Request | 200 | Errors |
|---|---|---|---|---|
| `GET /api/room-recorder/release` | room session JWT, via `readRoomClaims` | `?channel=stable\|test` | `{ version, sha256, size_bytes, blob_url }` | 404 `NO_RELEASE`, 401 |

- Reads `latestRelease(channel)`. **404 `NO_RELEASE` when it returns null.** `NO_RELEASE` joins the
  existing `InstallError` taxonomy in `lib/room-install.ts`.
- **Rejects any channel outside `stable` and `test`.**
- Not admin-gated, not unauthenticated. `runtime = "nodejs"`, `dynamic = "force-dynamic"`.

### 5.2 The app: check, verify, hand over

New file `Sources/RoomRecorderCore/RoomSelfUpdate.swift`. Keep the logic there; inject it into `RoomEngine`.

Steps 1 to 6 are PRD §7 as written. Steps 7 onward are §13.3.

1. `GET /api/room-recorder/release?channel=<its own channel>` on launch, every 6 hours, **and again when a
   recording session ends if the last check was deferred** (R3-10).
2. Compare the returned `version` with the running `CFBundleShortVersionString`. **A different version is
   an update, in either direction.** That is what makes withdraw a rollback. Do not turn this into `>`.
3. **If a recording session is open, do nothing and check again at the next tick.**
4. Download the zip from `blob_url` into a staging directory under the app root.
5. sha256 the downloaded bytes against the returned `sha256`. Mismatch stops the update and reports
   `checksum_mismatch`.
6. Expand with `ditto -x -k` into the staging directory, then run against the **staged** bundle:
   `codesign --verify --strict --verbose=4 -R 'anchor trusted and certificate leaf = H"187dd424fb866204111113d60c6f88a21d098edb"'`
   Mismatch stops the update and reports `signature_mismatch`. **The requirement string is a compile-time
   constant** (R3-5).
7. **Write the swap script into the staging directory, make it executable, spawn it detached from the app's
   own process group, write a log line naming the version being handed over to, and exit 64.**

**R3-9 governs every failure in steps 1 to 6:** log it, change nothing on disk, check again next tick.

### 5.3 The swap script

Written by the app, run detached, after the app has exited. In this order:

1. `launchctl bootout gui/$(id -u)/com.evenscribe.room-recorder`, ignoring failure.
2. Remove any existing `~/Applications/EvenScribe Room Recorder.app.previous` (R3-12).
3. Move the resident bundle to `.app.previous`.
4. Move the staged bundle to the resident path.
5. Run `codesign --verify --strict` with the pinned requirement against the **resident** path. **On failure,
   move `.app.previous` back to the resident path and record `swap_failed`.**
6. Write `<root>/update-result.json`: outcome, version attempted, reason on failure, and the time.
7. Run the **resident** bundle's `install-launch-agent` verb, so a plist change ships with the app (R3-11).
8. `launchctl bootstrap gui/$(id -u) <plist>`, falling back to `launchctl load`.

**If the script dies before step 1, launchd restarts the old app on exit 64 and the room keeps recording on
the old version.** That is why the exit code is non-zero.

### 5.4 Reporting the outcome

At startup the app reads `update-result.json`, reports the outcome in its poll, and **deletes the file**.
The new copy reports its `app_version` and `build_sha` on the same poll. **The fleet card showing the change
is the only proof the update landed.**

### 5.5 The LaunchAgent

`install-launch-agent` gains **`ThrottleInterval` 30 seconds** (R3-11). `KeepAlive` stays
`{"SuccessfulExit": false}`. Do not otherwise change the plist.

### 5.6 Migration 0078 and the new poll fields

`db/migrations/0078_install_update_fields.sql`, house style of 0077: additive, idempotent,
`ADD COLUMN IF NOT EXISTS`, `COMMENT ON COLUMN` for every column, self-recording insert last.

| Column | Type | Derived from |
|---|---|---|
| `session_open` | boolean, nullable | the app's own engine state at the moment of the poll |
| `update_channel` | text, not null, default `'stable'` | `config.json` |
| `last_update_result` | text, nullable | `update-result.json`: `ok`, `checksum_mismatch`, `signature_mismatch`, `download_failed`, `expand_failed`, `swap_failed` |
| `last_update_error` | text, nullable | the reason line from `update-result.json` |
| `last_update_at` | timestamptz, nullable | the time in `update-result.json` |
| **`disk_free_bytes`** | bigint, nullable | **[V-9SEP]** free space on the volume holding the captures directory, via `URLResourceKey.volumeAvailableCapacityForImportantUsageKey` |

`applyInstallPoll` **must COALESCE the four update columns and `disk_free_bytes`**, so a later poll cannot
erase the record of a failure. It **must NOT coalesce `session_open`**, which is a live reading and has to
be able to go false.

Every one of these obeys PRD §5.5: read from the machine, never typed, **omitted rather than guessed when
the app cannot read it**. Never send 0 or -1 for disk.

The addendum states the wire carries twelve poll fields after this build, up from eight. With
`disk_free_bytes` that arithmetic changes. **List the final wire fields in your report and reconcile the
count.**

### 5.7 Remove `spare_device` [V-9SEP]

`BenchClient.swift` ~447 appends `spare_device=false` as an unconditional literal on every poll. The app has
no spare-microphone concept, so it is a constant standing in for a measurement, which PRD §5.5 forbids.

**Remove the query item entirely.** Sending nothing lets the server's existing COALESCE keep the column. If
the server rejects a poll that omits it, **STOP and report** rather than restoring the literal.

### 5.8 The fleet card. Build state C.

Three row changes in `lib/room-install-view.ts` and `components/admin/BenchInstallFleet.tsx`, plus one from
the scope addition. **Nothing else on the card changes**: not the header, the five-step checklist, the empty
state, Withdraw, Copy install command, Retire, or any column heading.

1. **State A and B, the correction (R3-3).** `deriveRow` raises "Tape not advancing" **only when
   `session_open` is true**. With no session open the Tape cell reads `idle, no session` and the row says
   nothing about the tape. With a session open and the tape not advancing, the row goes to attention exactly
   as it does today.
2. **State C, the failure line (R3-7).** When `last_update_result` is present and is not `ok`, the row
   carries an `update failed` pill beside `installed`, and **one sentence in the App cell, under the
   version**, naming the reason and the version that failed. The mockup's wording is the contract, for
   example: *"Update to 0.1.8 stopped at 09:14. The downloaded file did not match its checksum. This Mac
   still runs 0.1.7 and is still recording."* When the result is `ok` or absent, the row shows nothing new.
3. **State E, the channel (R3-8).** The channel appears on the row beside the app version, as
   `channel stable` or `channel test`, from `update_channel`.
4. **[V-9SEP]** Free disk renders in the **Machine** cell, under the existing lines, as a human-readable
   size. No new column, no control, no colour, no threshold.

The existing `update pending` word needs no change; it already fires from `app_version` against
`latestRelease.version`.

**The rule stands: the page never asserts completion from its own actions.** The row reports what the last
poll said, and nothing else.

### 5.9 Documents that ship with this build

1. **Append the addendum as §13 of the repo copy of the PRD**, then copy the repo PRD back into
   `docs/handoff/`. The handoff copy is stale at §12.3 while the repo copy runs to §12.11.
2. **Add the changelog entry to `docs/BUILD-HISTORY.md` in this same build.** PRD §8: a build without its
   changelog entry is not accepted.

---

## 6. File contract

**Create or edit ONLY these:**

```
app/api/room-recorder/release/route.ts                        (new)
db/migrations/0078_install_update_fields.sql                  (new)
apps/room-recorder/Sources/RoomRecorderCore/RoomSelfUpdate.swift  (new)
apps/room-recorder/Sources/RoomRecorderCore/RoomEngine.swift      (edit)
apps/room-recorder/Sources/RoomRecorderCore/BenchClient.swift     (edit)
apps/room-recorder/Sources/RoomRecorderCore/RoomConfiguration.swift (edit: update_channel)
apps/room-recorder/Sources/RoomRecorderCore/InstallPollFields.swift (edit)
apps/room-recorder/Sources/RoomRecorderCLI/main.swift             (edit: exit 64, ThrottleInterval, startup read of update-result.json)
apps/room-recorder/Packaging/VERSION                              (edit: 0.1.8)
lib/room-install.ts                                           (edit)
lib/room-install-view.ts                                      (edit)
components/admin/BenchInstallFleet.tsx                        (edit)
docs/BUILD-HISTORY.md                                         (edit)
docs/handoff/ETA-ROOM-RECORDER-INSTALL-AND-FLEET-PRD-7-SEP-2026-v1.0.md  (edit: append §13)
tests/unit/*  and  apps/room-recorder/Tests/*                 (new tests, §8)
docs/handoff/ETA-INSTALL-BUILD-R3-KICKOFF-9-SEP-2026.md       (commit unchanged)
docs/handoff/ETA-INSTALL-AND-FLEET-PRD-BUILD-R3-ADDENDUM-8-SEP-2026.md  (commit unchanged)
docs/handoff/ETA-INSTALL-AND-FLEET-MOCKUP-R3-DELTA-8-SEP-2026.html      (commit unchanged)
```

**UNTOUCHED. Do not edit, refactor, reformat or tidy:**

```
apps/room-recorder/Sources/tapewriter/**        the entire capture and tape-writing path
apps/room-recorder/Sources/TapeCore/**          including the dormant archive tree
apps/room-recorder/Sources/RoomRecorderCore/PiecePipeline.swift
apps/room-recorder/Sources/RoomRecorderCore/RoomEnrolment.swift
apps/room-recorder/Encoder/**                   the vendored ffmpeg and its source lock
apps/room-recorder/Packaging/build-bundle.sh    do not touch it at all
db/migrations/0001..0077                        every existing migration
lib/bench-commands.ts                           the four command kinds
lib/bench.ts, lib/bench-window.ts, lib/bench-dual.ts, lib/mic-health.ts
app/api/bench/chunks/route.ts                   the ingest path, frozen by its own header
app/api/bench/upload-url/route.ts
app/api/room-recorder/bootstrap/**  and  enrol/**   §13.6.2, except nothing
app/api/admin/releases/**                       publish and withdraw already work
package.json                                    no new dependencies
vercel.json
```

**Out of scope, from §13.6. Do not build any of it:**
any change to the audio wire format; any change to enrolment, the bootstrap token or the bootstrap script
beyond R3-11's plist refresh; notarization, MDM, anything needing `sudo`; update progress on the card;
**automatic recovery from a bundle that installs cleanly and then cannot run** — step 5.3.5 covers a failed
verify, not a bundle that verifies and crashes.

**Two prohibitions with their reasons, so they are not worked around:**

1. **Do not add a fifth command-bus kind.** `BenchCommandKind` is a plain string enum decoded as
   `[BenchCommand].self`. An unknown `kind` throws a decoding error for the **entire poll response**, so a
   fifth kind breaks every 0.1.7 room's polling rather than being ignored. R3 is a route the app fetches.
2. **Do not add a dependency.** Foundation, CryptoKit and the existing SDK are enough.

---

## 7. Gates and tests

All green before the report:

```
npm run typecheck
npm test
npm run check:silent
cd apps/room-recorder && swift build && swift test
```

House pattern: `vi.mock("@/lib/db", ...)` recording the SQL issued; pure functions tested directly. See
`tests/unit/rooms-live.test.ts`, `tests/unit/measure-job.test.ts`, `tests/unit/room-install-card.test.ts`.

| Test | Asserts |
|---|---|
| release route, nothing published | **404 `NO_RELEASE`**, not 200 |
| release route, newest withdrawn | falls through to the previous non-withdrawn release |
| release route, bad channel | rejected; only `stable` and `test` accepted |
| release route, auth | admin cookie alone does not authorize; room cookie does |
| version comparison | a LOWER returned version is treated as an update, proving withdraw rolls back |
| non-200 handling | 404, 401 and a timeout each leave the disk untouched (R3-9) |
| deferred while recording | with a session open, no download is attempted |
| deferred then session ends | a deferred check re-runs at session end (R3-10) |
| checksum mismatch | nothing staged is swapped; result `checksum_mismatch` |
| signature mismatch | result `signature_mismatch` |
| swap script verify fails | `.previous` is restored and the result is `swap_failed` |
| `.previous` count | exactly one is kept (R3-12) |
| `deriveRow` with no session | no "Tape not advancing" warning (R3-3, state A) |
| `deriveRow` with session open and tape stalled | the warning still fires (state B) |
| `deriveRow` with a failed update | the sentence renders in the **App** cell (state C) |
| `applyInstallPoll` | the four update columns and `disk_free_bytes` COALESCE; `session_open` does not |
| poll omits disk when unreadable | no `disk_free_bytes` item, rather than 0 |
| migration self-records | 0078 contains its own `INSERT INTO schema_migrations` naming version 78 |

---

## 8. SQL and schema honesty

Every SQL string and every assumption about a column you did not read in a migration file is **INFERRED**.
List every SQL statement you write **verbatim** in the report, for validation against the live database
before anything is pushed. Keep the existing property that a failed install-registry write is swallowed so
a recording room never stops.

Migrations 0075 to 0077 exist in the repo. **Whether they are applied in production is not confirmed.** Do
not assume. 0078 must be additive and idempotent so it is safe whatever the applied state is, and the
report must say it has not been run.

---

## 9. Flag, do not improvise

If this kickoff does not settle something, flag it prominently and take the most conservative behaviour.
Likely candidates:

- Where in `RoomEngine`'s lifecycle the update check sits relative to the poll loop.
- How the swap script is templated and escaped, given the app root path contains spaces.
- Whether `--deep` belongs on the codesign checks for this bundle shape.
- Whether the server's install-poll upsert already COALESCEs `spare_device`.
- The exact wording of the state C sentence for the failure reasons the mockup does not show.

---

## 10. Report

Write to `docs/handoff/ETA-INSTALL-BUILD-R3-REPORT-9-SEP-2026.md` and print the path when done.

1. Branch name and commit sha.
2. Pre-flight output, including P1 to P5, each PASS or FAIL with the line you read.
3. Every gate command and its result.
4. `git diff --stat` against `1193083`.
5. Every inferred SQL string, verbatim.
6. R3-1 to R3-12 each confirmed implemented, with file and line. State C confirmed, state D absent.
7. The final list of wire poll fields, with the count reconciled against §13.4's stated twelve.
8. Every deviation and every flag from §9, with what you chose and why.
9. Manual steps V must run: migration 0078, packaging, signing at the console, publish, the acceptance runs.
10. Which install id is bound to Home Office at the time of your run. §12.11 names `install_5bt4ue32w3vv`;
    the 8 September carryover names `install_gd9tnfgqazvh`. **Report which, do not assume either.**
11. Anything you could not verify, named exactly.

---

## 11. Acceptance. §13.5, seven items.

Passing the gates is not acceptance. **Acceptance is one Mac updating itself.**
**Home Office is the only room you may touch, and only when V says.**

1. **One normal update on Home Office.** The fleet card shows the new version after the swap.
2. **One withdraw.** The same Mac returns to the previous version at its next check.
3. **The microphone permission unchanged across both swaps**, with no new macOS prompt. §12.10 established
   this is achievable: TCC binds the grant to the designated requirement, not to the cdhash.
4. **An update attempted while a session records.** The app defers, and the log shows the deferral.
5. **A deliberately corrupted zip.** The app stops the update, the resident copy is unchanged, and **the
   fleet card row names the reason** in the App cell.
6. **A swap script killed between the two moves.** The resident path holds a working bundle afterwards, and
   the room polls again without a visit. This is R3-1's whole reason and it must be proven, not argued.
7. **Home Office on `test` and one other room on `stable`.** A publish to `test` reaches Home Office and
   reaches no other room.

**Forcing a check during acceptance [V-9SEP].** The interval is 6 hours and Home Office is idle most of the
time, so after a publish run `launchctl kickstart -k gui/$(id -u)/com.evenscribe.room-recorder` on Home
Office to trigger the launch-time check. **This is a manual acceptance step, not a feature.** Do not add a
configurable interval.

If item 1 does not happen, the release does not go to the clinic rooms. Report what happened and stop.

---

## 12. After this build

Once R3 is proven in a room, these ship remotely with no visit, as Release B: exact-zero sample counting and
a real peak in `TapeWriter.writeConverted`; disk retention, which nothing enforces today at about 115 MB per
recorded hour; the `tape_advancing` unit mismatch, which compares an index file's byte length against a
sample count; the input device list; the `currentLevels()` reparse of the whole tape index every 1.5
seconds. None belongs in this release.
