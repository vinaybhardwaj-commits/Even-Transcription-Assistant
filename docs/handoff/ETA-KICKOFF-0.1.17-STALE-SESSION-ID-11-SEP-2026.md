# ETA KICKOFF — 0.1.17 "Re-enrol must not leave a stale identity" — 11 Sep 2026

Builder brief for Claude Code on the Mini. Orchestrator: Fable (Cowork). Refuter runs after the Builder, never the same agent. V signs off; nothing publishes to any channel without V.

## Goal
A Mac that is re-enrolled (bootstrap paste) or whose enrolment is superseded must never end up polling as a retired install id. After 0.1.17, the 11 Sep Home Office loop cannot recur: bootstrap → 0.1.8 → self-update → new build reads stale `room-session.json` → 409 RETIRED → dead forever.

## Known facts (verified 11 Sep, HEAD `5dff406` on `vinay/release-b1`)
- `RoomEngine.swift:730-742`: `installID = RoomSessionStore.load(...)?.installID ?? configuration.installID` — the session file outranks `config.json`. Introduced by `0ca7d71` "Keep the room session in a file" (B1.5).
- `RoomConfiguration.applyEnrolment` (~368-386) rewrites `origin`, `roomSlug`, `installID`, `tabID`, clears `etaRoomSession`; does not touch `updateChannel` (comment at 178-186 says this is deliberate) and does not touch `room-session.json`.
- `room-session.json` is written only by `RoomSessionStore.save` (`RoomSessionStore.swift:159-183`) from the running app; the swap script never writes it.
- Bootstrap (`lib/room-install.ts` `bootstrapScriptFor`, ~567) always ships `latestRelease("stable")` = 0.1.8, whose `enrol` predates the session file.
- Server 409: `lib/room-install.ts:881-940` `applyInstallPoll` → `retired_at IS NOT NULL` → `RETIRED`; `app/api/bench/commands/route.ts:150` → HTTP 409. On 409 the app logs "will not poll again" and exits; LaunchAgent `KeepAlive.SuccessfulExit=false` → stays dead.
- Repro on the Mini today: four bootstraps (`install_4vvfu4zfevgu`, `wma5gmcr3rnz`, `976npa2gcmx2`, `539avu7gqzz5`) all died identically. Fixed by hand: `sed` the id in `room-session.json` + `launchctl kickstart -k`. Home Office now Ready on 0.1.13 as `install_539avu7gqzz5`.
- VERSION file: `apps/room-recorder/Packaging/VERSION` (currently 0.1.16). Next = 0.1.17. Unpushed local bumps `b05523d`/`5dff406`; origin is `5cc6931`.

## Exact scope (four changes, app only unless stated)
1. **`enrol` owns the session file.** When `enrol --token … --origin …` succeeds and writes `config.json`, it must also write `room-session.json` with the new `install_id` (and the room session token if the enrol response carries one; otherwise delete the file so the next launch falls through to config and re-fetches). A leftover file from a previous install id must not survive an enrol.
2. **Mismatch means stale.** In `RoomEngine` identity resolution: if `room-session.json.install_id != config.json.install_id`, log `room session install id <a> disagrees with config <b>; config wins, session file rewritten`, use config's id, and rewrite the session file with config's id (keep the token). Only when the two agree, or the file is absent, is behaviour unchanged.
3. **One retry on 409 RETIRED.** If the poll returns RETIRED and the identity came from the session file, discard the file, retry once with config's id. If that also returns RETIRED, stop as today (the Mac genuinely lost the room). Log both outcomes distinctly.
4. **Re-enrol resets the channel.** `applyEnrolment` sets `updateChannel = "stable"`. Update the comment at `RoomConfiguration.swift:178-186` to say why (11 Sep: a preserved `test` turned a repair paste into an unproven self-update). Home Office is put back on `test` by hand afterwards, deliberately.

Out of scope: server-assigned channel on the bench card (write it up as a follow-on in the report, do not build), any change to the swap script, canary, hold or rollback logic, any change to server routes.

## Allowed changes
`apps/room-recorder/**` Swift sources and tests; `apps/room-recorder/Packaging/VERSION` → 0.1.17; CHANGELOG/release note under the app. Nothing under `app/`, `lib/`, migrations, or the bench UI.

## What to verify (Builder runs; Refuter reruns independently)
- Full app test suite passes (was 535, 0 issues at `5dff406`). Report the count.
- New tests, all must fail before the change and pass after:
  a. enrol over an existing `room-session.json` with a different id → file carries the new id.
  b. session file id ≠ config id → engine polls with config id and rewrites the file.
  c. poll returns RETIRED with file-sourced id → exactly one retry with config id; RETIRED again → stop.
  d. `applyEnrolment` leaves `updateChannel == "stable"` regardless of prior value.
- **End-to-end on the Mini (this is the acceptance test):** plant a `room-session.json` with a known retired id (e.g. `install_k54jsz5r4cyz`), build 0.1.17, run it with `--root` pointing at the real RoomRecorder dir, and show in `launchd.log` the "config wins" line followed by a successful poll. `scribe_diff_room home-office-w8fb` must show `listener_state: listening` within 10 s. Do NOT run a fresh bootstrap paste for this — that mints and retires ids on the server.
- Signed build: `codesign --verify --deep --strict` on the bundle; designated requirement unchanged (TCC mic grant must survive — check `spctl`/`codesign -dr -` output matches the 0.1.13 bundle's DR).

## Do not
- Do not publish 0.1.17 to any channel. Build, sign, stage the artifact, stop. V publishes to `test` for Home Office first, then the six partition steps, then Cardiology `test`, then `stable`.
- Do not touch the running Home Office install (currently healthy on 0.1.13) except for the acceptance test above, and restore it afterwards.
- Do not push to origin; leave commits local on `vinay/release-b1` (V's rule: GitHub actions go through Claude Code with V present).
- Do not edit `config.json` on the Mini by hand.

## Output
Write `docs/handoff/ETA-0.1.17-BUILD-REPORT-11-SEP-2026.md` (cap 400 words): commits (sha + one line each), test counts before/after, the four new tests by name with fail→pass evidence, the end-to-end log excerpt (≤ 15 lines), codesign DR comparison, artifact path, and one paragraph "follow-on: server-assigned channel". Reply in chat with only: commit shas, test count, artifact path, and any deviation from this brief.

## Refuter brief (separate agent, after the Builder)
Read the diff only. Rerun the full suite and the four new tests yourself. Reproduce the stale-id loop with the OLD 0.1.13 bundle (`~/Applications/EvenScribe Room Recorder.app.previous` if still 0.1.13) to prove the test actually catches it, then with 0.1.17 to prove the fix. Check that change 3 cannot loop (exactly one retry, no re-read of the file after discard). Check change 1 cannot delete a valid session on a failed enrol. Verdict to V: ACCEPT / REJECT with the failing line. Cap 250 words.
