# ETA Room Recorder — Install and Fleet PRD, Build R3 addendum

**8 September 2026 · §13 of `ETA-ROOM-RECORDER-INSTALL-AND-FLEET-PRD-7-SEP-2026-v1.0.md`**

This addendum amends §7 and §8 of that PRD. It supersedes §7 where the two disagree.
Claude Code appends this file as §13 of the repo copy of the PRD in the same build, and copies
the repo PRD back to the handoff folder, because the handoff copy is stale at §12.3 while the
repo copy runs to §12.11.

Provenance. Written against production sha `46a7475`, migrations through `0077`, branch
`feat/room-recorder` tip `1193083`, stable release `0.1.7`. Every code fact below was read out of
`origin/feat/room-recorder`. The seven commits after `46a7475` touch only the Mac app, its
packaging and its docs, so every server file quoted here is what production runs today.

---

## 13.1 Decisions log

V ratified all eight on 8 September 2026. None is open. The builder must not re-open any of them.

**R3-1 — A detached swap script performs the swap, and it owns the restart.**
The app stages and verifies, writes a swap script, spawns it detached, and exits. The script boots
the LaunchAgent out, swaps the bundles, verifies the resident copy, restores the previous copy if
the verify fails, and bootstraps the agent back. The app never moves its own running bundle.
*Reason.* §7 steps 7 to 9 as written leave the resident path empty if the process dies between the
two moves. launchd then has nothing to start and the room needs a physical visit. This also makes
`.app.previous` a path something reads. §12.7 and §12.8 record four instances of a stated guarantee
that nothing implemented. A saved bundle that no code restores would be the fifth.

**R3-2 — Build R3 ships before any clinic Mac is installed.**
*Reason.* `0.1.7` carries no updater. A clinic Mac pasted before R3 needs a second paste to reach
the first self-updating build, and its row reads "update pending" until someone does it. R3 first
means one paste per room, ever. This overrides §8's stated R3 prerequisite of "R1 and R2 proven on
all four Macs". All five R3 acceptance items run on Home Office, so the prerequisite gates risk,
not evidence.

**R3-3 — The "Tape not advancing" warning is fixed inside Build R3.**
`deriveRow` in `lib/room-install-view.ts` raises that warning for any reachable install whose
`tape_advancing` is false. It applies no test for whether a session is open. Home Office carries the
warning today while healthy. R3 restarts the app on every update and the first poll after a restart
always reports false, so R3 would produce the warning on every update in every room.

**R3-4 — The app exits with code 64 after handing over to the swap script, and writes a log line.**
`KeepAlive` is the dictionary `{"SuccessfulExit": false}`, so launchd restarts the app only on a
non-zero exit. `needs_enrol` and the retired 409 both exit zero on purpose, to stay stopped. Exit 1
already means any error. Code 64 is distinct from both, so an update restart is readable in
`launchd.log` and separable from a crash.
*The non-zero value is the fail-safe.* If the swap script dies before it boots the agent out,
launchd restarts the old app and the room keeps recording on the old version.

**R3-5 — The expected signing identity is a compile-time constant in the app.**
The app pins SHA-1 `187DD424FB866204111113D60C6F88A21D098EDB`, the same value
`Packaging/build-bundle.sh` already pins. The app never takes the expected signer from the server.
*Reason.* A wrong or compromised publish cannot point a Mac at a different signer. The certificate
runs to 4 September 2036, so a rotation inside the life of this module is unlikely. If one happens,
it costs one re-paste per Mac.

**R3-6 — The app reports whether a session is open, as a new poll field.**
The app derives it from its own engine at the moment of the poll. The fleet card uses it to
suppress the tape warning when no session is open.
*Reason.* The existing bench listener state is not usable for this. The OPD 5 listener row has read
`recording: true` since 24 August, fifteen days, with no session open. §5.5's invariant requires a
value read from the machine at poll time.

**R3-7 — A failed update shows on the room row, and only a failed update shows.**
Nothing new appears on the card while updates work. When one fails, the row carries the reason.
*Reason.* §8 acceptance item 5 requires the app to report a corrupted zip. A report that only a
person standing at the Mac can read is not a report, and it breaks the rule that the card reads
server state.
*This is UI, so the mockup gate applies. No kickoff until V approves the mockup.*

**R3-8 — The update channel is per Mac, stored in `config.json`, default `stable`.**
Home Office sits on `test`. Clinic rooms sit on `stable`. The app reports its channel as a poll
field and the card shows it.
*Reason.* R3's whole risk is that one bad publish walks into every room at once. A test channel is
the valve. The `test` channel already exists in the `app_release` schema and has no reader.

---

## 13.2 Recommendations for V to ratify when he reads this

These are smaller than the eight above. Each carries a recommendation. The kickoff waits for V's
word on all four.

**R3-9 — Any answer other than 200 from the release route means do nothing.**
A 404 `NO_RELEASE`, a 401, a timeout, or a network failure all mean the same thing: log it, change
nothing on disk, check again at the next tick. The app never treats a missing release or a missing
blob as a reason to remove software.
*Basis.* §12.2 records that Vercel Blob deletion lags at the edge by about 30 seconds. `latestRelease`
returns null when every release on a channel is withdrawn, so the route will answer 404 in a real
situation, not only a broken one.

**R3-10 — After a deferred check, the app re-checks when the session ends, not six hours later.**
§7 step 3 says the app checks again at the next tick, and the tick is six hours. A clinic day is
close to continuous recording, so an update could wait most of a day after the last patient leaves.
Re-checking at session end costs nothing and closes that gap.

**R3-11 — The plist gains `ThrottleInterval` of 30 seconds, and the swap script refreshes the plist.**
The plist carries no `ThrottleInterval` today, so launchd's default of 10 seconds applies. A bundle
that cannot launch would retry six times a minute forever. The swap script runs the NEW bundle's
`install-launch-agent` verb before it bootstraps the agent back, so a plist change ships with the
app instead of needing a visit.

**R3-12 — One previous bundle is kept, never two.**
`~/Applications/EvenScribe Room Recorder.app.previous` holds exactly one copy. The swap script
removes any earlier one before it saves the current one.

---

## 13.3 §7 as amended

Steps 1 to 6 stand as written in §7. Steps 7 to 10 are replaced.

1. The app calls `GET /api/room-recorder/release?channel=<its own channel>` on launch and every
   6 hours, and again when a recording session ends if the last check was deferred (R3-10).
2. The app compares the returned `version` with its own `CFBundleShortVersionString`. A different
   version is an update, in either direction. This makes withdraw a rollback.
3. If a recording session is open, the app does nothing and checks again at the next tick.
4. The app downloads the zip from the `blob_url` the route returned, into a staging directory
   under the app root.
5. The app computes the sha256 of the downloaded bytes and compares it with the returned `sha256`.
   A mismatch stops the update and reports `checksum_mismatch`.
6. The app expands the zip with `ditto -x -k` into the staging directory and runs
   `codesign --verify --strict --verbose=4 -R 'anchor trusted and certificate leaf = H"187dd424fb866204111113d60c6f88a21d098edb"'`
   against the staged bundle. A mismatch stops the update and reports `signature_mismatch`. The
   requirement string is a compile-time constant (R3-5).
7. **The app writes the swap script into the staging directory, makes it executable, spawns it
   detached from its own process group, writes a log line naming the version it is handing over to,
   and exits with code 64 (R3-1, R3-4).**
8. **The swap script performs these steps in order.**
   1. `launchctl bootout gui/$(id -u)/com.evenscribe.room-recorder`, ignoring failure.
   2. Remove any existing `~/Applications/EvenScribe Room Recorder.app.previous`.
   3. Move the resident bundle to `.app.previous`.
   4. Move the staged bundle to the resident path.
   5. Run `codesign --verify --strict` with the pinned requirement against the resident path. If it
      fails, move `.app.previous` back to the resident path and record `swap_failed`.
   6. Write the result to `<root>/update-result.json`: outcome, version attempted, reason on
      failure, and the time.
   7. Run the resident bundle's `install-launch-agent` verb, so a plist change ships with the app
      (R3-11).
   8. `launchctl bootstrap gui/$(id -u) <plist>`, falling back to `launchctl load`.
9. **launchd starts the resident app. If the swap script died before step 8.1, launchd instead
   restarts the old app on exit 64 and the room keeps recording on the old version.**
10. **The app reads `update-result.json` at startup, reports the outcome in its poll, and deletes
    the file. The new copy reports its `app_version` and `build_sha` on the same poll. The fleet
    card shows the change. This is the only proof that the update landed.**

The rollback paragraph of §7 stands unchanged. An admin marks a release withdrawn in the fleet card
header. `latestRelease` already excludes withdrawn rows and orders by `published_at DESC`, so the
route then returns the previous release that is not withdrawn, and each app sees a different version
at its next check.

**Note on ordering.** `latestRelease` orders by `published_at`, not by version. A release published
later with a lower version number would win. That is the behaviour rollback depends on, and it is
correct. It also means a mistaken publish walks forward, not backward. Withdraw is the only reverse.

---

## 13.4 New and changed contract

### The route, new in R3

| Method and path | Auth | Request | Response 200 | Errors |
|---|---|---|---|---|
| `GET /api/room-recorder/release` | room session JWT | `?channel=stable\|test` | `{ version, sha256, size_bytes, blob_url }` | 404 `NO_RELEASE`, 401 |

The handler reads `latestRelease(channel)` and answers 404 `NO_RELEASE` when it returns null.
`NO_RELEASE` joins the existing `InstallError` taxonomy in `lib/room-install.ts`. The route rejects
any channel outside `stable` and `test`.

### Poll fields, new in R3

Migration `0078`, additive and idempotent, adds five columns to `room_install`.

| Column | Type | The app derives it from |
|---|---|---|
| `session_open` | boolean, nullable | Its own engine state at the moment of the poll |
| `update_channel` | text, not null, default `stable` | `config.json` |
| `last_update_result` | text, nullable | `update-result.json`, one of `ok`, `checksum_mismatch`, `signature_mismatch`, `download_failed`, `expand_failed`, `swap_failed` |
| `last_update_error` | text, nullable | The reason line from `update-result.json` |
| `last_update_at` | timestamptz, nullable | The time in `update-result.json` |

The wire carries twelve poll fields after this build, up from eight. §5.5's invariant holds for all
five: every value is read from the machine, none is typed, and a value the app cannot read is
omitted rather than guessed.

`applyInstallPoll` must COALESCE the four update columns, so a later poll cannot erase the record of
a failure. It must NOT coalesce `session_open`, which is a live reading and has to be able to go
false.

### The fleet card

Two changes, both in `lib/room-install-view.ts` and its component.

1. `deriveRow` raises "Tape not advancing" only when `session_open` is true. When no session is
   open the row says nothing about the tape (R3-3).
2. When `last_update_result` is present and is not `ok`, the row carries one attention line naming
   the reason and the version that failed (R3-7). When it is `ok` or absent, the row shows nothing
   new. The channel appears on the row beside the app version (R3-8).

The existing `"update pending"` word needs no change. It already fires from `app_version` against
`latestRelease.version`.

**The rule stands.** The page never asserts completion from its own actions. The row reports what
the last poll said, and nothing else.

---

## 13.5 Acceptance, amended

The five items of §8 stand, with two additions and one correction.

1. One normal update on Home Office. The fleet card shows the new version after the swap.
2. One withdraw. The same Mac returns to the previous version at its next check.
3. The microphone permission unchanged across both swaps, with no new macOS prompt.
   *§12.10 established this is achievable. TCC binds the grant to the designated requirement, not to
   the cdhash.*
4. An update attempted while a session records. The app defers, and the log shows the deferral.
5. A deliberately corrupted zip. The app stops the update, the resident copy is unchanged, and
   **the fleet card row names the reason.**
6. **A swap script killed between the two moves. The resident path holds a working bundle
   afterwards, and the room polls again without a visit.** This is R3-1's whole reason and it must
   be proven, not argued.
7. **Home Office on the `test` channel and one other room on `stable`. A publish to `test` reaches
   Home Office and reaches no other room.**

Item 3 of §12.11's checklist evidence names install `install_5bt4ue32w3vv`. The 8 September
carryover names `install_gd9tnfgqazvh`. The builder reports which is bound at the time of the R3
run rather than assuming either.

---

## 13.6 Out of scope for R3

1. Any change to the audio wire format.
2. Any change to enrolment, the bootstrap token, or the bootstrap script, except the plist refresh
   of R3-11.
3. Notarization, MDM, and anything needing `sudo`. §10 of the PRD still governs.
4. Update progress on the card. R3-7 ships failures only.
5. Automatic recovery from a bundle that installs cleanly and then cannot run. The `.previous`
   restore of §13.3 step 8.5 covers a failed verify, not a bundle that verifies and crashes.

---

## 13.7 Gates before the kickoff

1. V ratifies R3-9 to R3-12.
2. V approves the visual mockup of the two row changes in §13.4.
3. The builder pulls the branch. The working tree at `~/dev/Even-Transcription-Assistant` is stale
   at `d7df4b1`, which is the commit before the install module began.
4. The changelog entry lands in `docs/BUILD-HISTORY.md` in the same build. §8 of the PRD: a build
   without its changelog entry is not accepted.
