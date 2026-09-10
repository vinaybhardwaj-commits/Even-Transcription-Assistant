# ETA Install Build B1 — the launch canary, report

**10 September 2026.** Branch `vinay/release-b1`, cut from `vinay/r3-self-update` at `2e4cf37`; one new commit on it,
not pushed, not amended, `main` and `feat/room-recorder` untouched. **Commit: the single new commit on this branch
(`git log --oneline -1`); a commit cannot quote its own sha.** Pre-flight: `pwd` correct, origin
`vinaybhardwaj-commits/Even-Transcription-Assistant`, `HEAD 2e4cf37`, branch `vinay/r3-self-update`, nine untracked
files all `docs/handoff/*.md` — matched, so `git checkout -b vinay/release-b1`.

## B1-1 — the watchdog in the swap script

`RoomSelfUpdate.swift`: canary path `:140`, `canaryWindow = 180` `:149`, `canarySlice = 2` `:153`, wire type
`RoomUpdateCanary` `:313`. In `render`: variables `:1048-1055`, arming `:1143-1174`, loop `:1188-1218`, the last look
`:1220-1233`, rollback `:1235-1262`. The reason sentence goes through the existing `jsonStringBody` path (`:1018`) and
quotes `canaryWindow` rather than a second copy of 180; the version restored is appended in shell. `.previous` is
touched nowhere on the success path; the handover marker is kept. Rendered, verbatim — **comment lines and the
unchanged 8.7/8.8 pair elided, marked `[…]`**:

```bash
PREVIOUS_VERSION="$(/usr/bin/plutil -extract CFBundleShortVersionString raw "${PREVIOUS}/Contents/Info.plist" 2>/dev/null | /usr/bin/tr -cd 'A-Za-z0-9._+-')"
if [ -z "$PREVIOUS_VERSION" ]; then
  say "the previous bundle would not say what version it is; the canary records null"
  PREVIOUS_JSON=null
else
  PREVIOUS_JSON="\"${PREVIOUS_VERSION}\""
fi
/bin/cat > "${CANARY}.tmp" <<JSON
{
  "version": "${VERSION_JSON}",
  "previous": ${PREVIOUS_JSON},
  "armed_at": "$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')"
}
JSON
/bin/chmod 600 "${CANARY}.tmp" 2>/dev/null
/bin/mv -f "${CANARY}.tmp" "$CANARY" 2>/dev/null
say "armed the canary for ${VERSION}"
[…] 8.7 install-launch-agent, 8.8 bootstrap_agent — unchanged from R3 […]
say "waiting up to ${CANARY_SECONDS}s for ${VERSION} to poll"
CANARY_WAITED=0
while [ "$CANARY_WAITED" -lt "$CANARY_SECONDS" ]; do
  if [ ! -f "$CANARY" ]; then
    say "${VERSION} acknowledged the canary after ${CANARY_WAITED}s"
    exit 0
  fi
  /bin/sleep "$CANARY_SLICE"
  CANARY_WAITED=$((CANARY_WAITED + CANARY_SLICE))
done
OLD_VERSION="$(/usr/bin/grep '^  "previous"' "$CANARY" 2>/dev/null | /usr/bin/head -n 1 | /usr/bin/cut -d '"' -f 4 | /usr/bin/tr -cd 'A-Za-z0-9._+-')"
if [ -z "$OLD_VERSION" ]; then OLD_VERSION=unknown; fi
if [ ! -f "$CANARY" ]; then
  say "${VERSION} acknowledged the canary after ${CANARY_WAITED}s"
  exit 0
fi
say "${VERSION} did not poll within ${CANARY_SECONDS}s — rolling back"
/bin/launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null
say "booted the agent out"
/bin/mv -f "$RESIDENT" "${RESIDENT}.failed" 2>/dev/null
say "moved ${VERSION} aside"
/bin/rm -rf "${RESIDENT}.failed"
say "deleted ${VERSION}"
/bin/mv -f "$PREVIOUS" "$RESIDENT" 2>/dev/null
say "restored ${OLD_VERSION}"
record swap_failed "\"${CANARY_REASON}${OLD_VERSION}\""
say "recorded swap_failed"
/bin/rm -f "$CANARY"
bootstrap_agent
say "rolled back to ${OLD_VERSION} and bootstrapped"
exit 1
```

**The second `if [ ! -f "$CANARY" ]` is not in the kickoff and it is not decoration.** The loop takes its last look one
slice BEFORE the window closes — at 178 s, not 180 — and then sleeps through the rest, so the first cut of this rolled
back any app that acknowledged in the final two seconds, which is exactly where a slow cold launch on a busy clinic Mac
lands. §14.2.3 says "if still present **at** 180 s"; this is 180 s. It sits immediately before the `bootout`, with only
a `say` between, so the window in which an acknowledgement can arrive and be ignored is as small as shell allows.
`CANARY_REASON` renders as `'the new version did not poll within 180 s; restored '`; `bash -n` on the whole rendered
script passes. Two mechanical departures from the kickoff's letter are flagged below (the `tr` filter, `grep|cut`).

## B1-2 — the app acknowledges

`RoomEngine.swift`: `roomCanaryAcknowledge(root:)` `:2810`, called at `:970-984` — the first statement after
`pollCommands` returns, ahead of the superseded check (B1-D3 counts a superseded answer as success) and well ahead of
the receipt delete at `:1002`. On a returned version it logs `canary passed for <version>` and clears
`RoomUpdateHandover`; the marker-clear-on-receipt in `init` is gone, `:673-684`, sweep and grace unchanged. The helper
deletes even when it cannot decode, returning nil — an undecodable canary left on disk would have the watchdog roll
back a version that was polling perfectly well.

## B1-4, B1-5, B1-3, B1-6

**B1-4:** `RoomSelfUpdate.swift:385` `countedReceiptAt`, CodingKey `counted_receipt_at` `:399`;
`roomUpdateCountStartupReceipt` `:489-505` returns nil **without writing** when `receipt.at ==
previous?.countedReceiptAt`, else records and stamps. `roomUpdateRecordFailure` `:451-464` carries the stamp forward on
the same version and drops it on a different one — without the first, any `stop()` on the same version would wipe the
stamp and reopen the double count; the second is safe because a different version resets the count to one anyway.
**B1-5:** `enrolmentReader:` injected at all 42 `RoomEngine.load(` call sites (40 in
`RoomEngineResidentCaptureTests.swift`, 2 in `RoomEngineRecoveryBarrierTests.swift`) against a `private let
enrolledForTests` stub copied from `RoomSessionFromKeychainTests`; no production change; `ArchiveKeyLifecycleP1Tests`
untouched, see flag 1. **B1-3:** `main.swift:175-197`, in `case "run"`, before `startingConfiguration` and so before
`RoomEngine.load`, writes `room-recorder: break-on-launch present; exiting 1` to stderr and `exit(1)`; nothing else in
that file changed. **B1-6:** `Packaging/VERSION` → `0.1.11`; `build-bundle.sh:103-104` carries the new message with the
trial-signing check itself unchanged, `bash -n` passing. See flag 8 before that message ships.

## Tests

Ten new in `RoomSelfUpdateTests.swift`, one flipped; names are in the diff, the evidence that is not is here by line.
The harness rewrites `CANARY_SECONDS=180`→4 and `CANARY_SLICE=2`→1 as it already rewrites `/bin/sleep 3`, and refuses
to run if either anchor is missing. `:712` acked after 1 s → exit 0 in 2.4 s, resident new, `.previous` present, and
the file the script wrote decodes to `version 0.1.11` / `previous 0.1.7` / a plausible `armed_at`. `:747` acked at
3.5 s of a 4 s window — after the loop's last iteration — still exits 0 with an `ok` receipt. `:771` timeout →
resident 0.1.7, `.previous`, `.failed` and canary all gone, receipt `swap_failed` / `…did not poll within 180 s;
restored 0.1.7`, last two launchctl verbs `bootout` then `bootstrap`, all seven §14.2.3 log lines. `:819` FIFO
rendezvous between `rm -rf …failed` and `mv "$PREVIOUS"`, SIGTERM there, rescue restores and bootstraps; `:852` is the
same kill with the trap stripped, asserting the resident path is EMPTY. `:1298` marker and canary survive `init`, one
poll clears both, `canary passed for 0.1.11` logged; `:1339` is B1-D5 alone. `:1367` two real `RoomEngine.load`s, one
receipt, one failure, no hold; `:1167` is the flipped one (same receipt → nil, nothing written; a later `at` still
counts to the hold). `:704` pins B1-D1's number. `:1410` `breakOnLaunchExitsOne` is **a `Process` test of the built
binary** (`swift test` rebuilds it) — exit 1 and the exact stderr line — not a unit of a guard function.

**Both new script tests were shown to fail against the code they guard.** Test 3 with `withoutTheRescueTrap: true`,
then restored; and `:747` against the loop before the last look existed — which is how that defect was caught:

```
✘ …RoomSelfUpdateTests.swift:809:5: Expectation failed: fixture.version(of: fixture.resident) == "0.1.7"
✘ Test aScriptKilledInsideTheRollbackRestoresThePreviousBundle() failed after 3.246 seconds with 6 issues.
✔ Test aScriptKilledInsideTheRollbackRestoresThePreviousBundle() passed after 2.975 seconds.
✘ …RoomSelfUpdateTests.swift:767:5: Expectation failed: result.outcome == .ok
✘ Test theWatchdogTakesAnAcknowledgementInTheFinalSlice() failed after 5.281 seconds with 5 issues.
✔ Test run with 520 tests in 42 suites passed after 17.365 seconds.
```

## Gates

`npm run typecheck` clean, no output. `npm run build` completed, full route table, middleware 34.2 kB. `npm test`
`Test Files  67 passed (67)` / `Tests  1572 passed (1572)`. `npm run check:silent` `Found 9 silent-failure handler(s)`
— the accepted pre-existing nine, all under `app/`, none in the contract, none fixed. `swift build` `Build complete!`.
`swift test` over SSH **`✔ Test run with 520 tests in 42 suites passed after 17.365 seconds.`**, 0 issues, against a
baseline at `2e4cf37` of 510 / 46; `RoomSelfUpdateTests` was then run three more times alone (54 tests, green each
time) because six of them are timing-sensitive. It needs the Fix 1 §5 flags on this machine (`-Xswiftc -plugin-path
…/plugins/testing` and the two `-Xlinker -rpath`) or the bundle cannot load `Testing.framework` — unchanged from R3.
The server is untouched; typecheck, `npm test` and build were run anyway. No bundle was built and nothing was signed.

## Files changed, SQL, schema

`Packaging/{VERSION,build-bundle.sh}`, `Sources/RoomRecorderCLI/main.swift`,
`Sources/RoomRecorderCore/{RoomEngine,RoomSelfUpdate}.swift`,
`Tests/TapeCoreTests/{RoomSelfUpdateTests,RoomEngineResidentCaptureTests,RoomEngineRecoveryBarrierTests}.swift`,
`docs/BUILD-HISTORY.md`, plus the kickoff and this report. Nothing outside the contract moved; staged by exact
filename; the other seven untracked `docs/handoff/` papers left untracked.

**No SQL was written and nothing server-side changed (B1-D6).** One INFERRED assumption stands, carried from R3 rather
than introduced here: the rollback receipt reaches the fleet row through the existing poll fields, so
`last_update_result` must accept `swap_failed`, `last_update_version` the failed version, and `last_update_error` the
free text `the new version did not poll within 180 s; restored 0.1.11`. All three shipped in 0078 and already carry R3
values in production; I have no database here to confirm it.

## Flags — what the kickoff did not settle

1. **`ArchiveKeyLifecycleP1Tests.key03…` needed no change.** All 46 baseline issues are `needsEnrolment` in exactly two
   files (44 + 2); that test never calls `RoomEngine.load` and was already green. B1-5 names it, so I flag the
   discrepancy rather than edit a file with nothing wrong with it.
2. **A three-minute network outage after a swap rolls back a healthy build.** B1-D3 makes a returned poll the proof, so
   a room whose link is down for the window loses a good version and takes a ledger failure for it (two of those is the
   6 h hold). §14.3's accepted-residual list does not mention this case. Not a code defect — a residual that is now
   reachable, and it belongs on the owed list or in §14.3.
3. **`previous` is filtered through `tr -cd 'A-Za-z0-9._+-'` into the canary JSON, and read back with an anchored
   `grep '^  "previous"' | cut -d '"' -f 4`, not `sed`.** It comes off a plist on disk and has not been through the
   Swift escaper — a quote in it would produce a canary the app cannot decode — and `jsonStringBody` is not reachable
   from shell for a value shell reads. A `sed` backreference inside a Swift multi-line literal is string interpolation
   and does not compile. The anchor matters because a server-supplied version could itself contain `"previous"`.
4. **`RoomEngine.load` gained a defaulted `log:` parameter**, last in the list, no call site changed, so the
   `canary passed for` line is assertable without capturing process-wide stderr from a parallel suite.
5. **Two tests are beyond the six listed** — `theRollbackKillIsNotSurvivedWithoutTheRescueTrap` and
   `theWatchdogTakesAnAcknowledgementInTheFinalSlice`. The first makes F4's "prove it can fail" permanent; the second
   is the regression test for the last-look defect above. Drop either if the Refuter would rather.
6. **A rescue inside the rollback leaves the canary file behind.** The restored old version deletes it on its first poll
   and logs `canary passed for <the version that failed>` — a misleading log line and nothing more; the receipt is
   already the rescue's own. Not fixed: `rescue()` is not mine to change.
7. **§14.3's residual is unchanged**: a script that dies inside the 180 s (reboot, `kill -9`) leaves no watchdog. And
   the check-then-bootout gap is now milliseconds rather than two seconds, but it is not zero and cannot be.
8. **The B1-6 message contradicts the repo's own `CLAUDE.md`.** It tells the operator to unlock the login keychain and
   sign over SSH; `CLAUDE.md` says anything that signs runs in Terminal.app on the Mac's own screen, never over SSH.
   The kickoff ordered this text verbatim and the R3 acceptance verdict (finding 4) proves it works, so I wrote it as
   ordered — but one of those two documents now needs correcting, and that is not mine to choose.
9. `RoomUpdateCanary.write(root:)` is public and has **no production caller** — the script writes the real canary in
   shell. It exists for the fixtures and for symmetry with the receipt; the doc comment says so at `:339`.
10. **This report is over the 150-line cap.** A third of it is the verbatim block the kickoff asks for; I cut prose
    rather than evidence or flags.

## Manual steps for V, and subagents

None to run: nothing to migrate, no bundle built, nothing signed — signing and publishing stay with the Orchestrator.
One Opus reviewer, read-only, over the working-tree diff against the kickoff contract and the rendered shell. It found
the last-look defect and the anchored-grep case; both are fixed above and both now have tests. Advisory only — the
external Refuter still runs.
