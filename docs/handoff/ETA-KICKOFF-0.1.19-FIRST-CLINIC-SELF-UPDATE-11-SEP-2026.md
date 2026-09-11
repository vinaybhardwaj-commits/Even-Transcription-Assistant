# ETA KICKOFF — 0.1.19 "The first clinic Mac swaps unattended" — 11 Sep 2026, 16:35 IST

Builder brief for Claude Code on the Mini (Sonnet). Refuter (Opus, a FRESH session — never the builder) runs after.
Orchestrator: Fable (Cowork). Nothing publishes to any channel without V. Passwords never go through Claude Code `!` (rule 24):
anything that prompts runs in a real Terminal window (tmux Ctrl-b c) and the agent reads what it wrote.

## Goal
Prove the self-update path on a clinic Mac end to end. 0.1.18 put the leaf-only verifier on every clinic Mac by re-enrolment
paste; no clinic Mac has yet SWAPPED unattended. 0.1.19 is the smallest possible release — a version bump and two text lines —
so that the only thing under test is the swap. Acceptance = Room 4.1 goes 0.1.18 → 0.1.19 through `update.log` with nobody
touching it, then the other five clinic Macs follow from `stable`. That closes Install & Fleet PRD §13/§14/§15 on the fleet.

## Known facts (verified 16:25–16:30 IST, `scribe_system_map`, per-room `scribe_diff_room`, ReadMini)
- HEAD on the Mini = local `vinay/release-b1` `faafd04` (0.1.18 verdict, docs only) on top of `964e426` (0.1.18, ACCEPT 13:23).
  **`origin/vinay/release-b1` on the Mini reads `964e426`** — `faafd04` is NOT on origin despite the carryover; harmless, docs only.
  Pushing stays with V (server unchanged; rule 10 does not bite — no migration in this release).
- `apps/room-recorder/Packaging/VERSION` = `0.1.18`. Next version string: **0.1.19** (rule 11: each channel needs its own upload key;
  `(version, channel)` and `blob_url` are unique including withdrawn rows).
- `apps/room-recorder/Packaging/build-bundle.sh:231` reads, verbatim:
  `# ─── Verify, pinned to our anchor ────────────────────────────────────────────────────────────`
  The two `-R` literals at `:236` and `:273` are already leaf-only (`= certificate leaf = H"$(…tr 'A-Z' 'a-z')"`) — the heading is
  the last stale word; the 0.1.18 report flagged it and left it per the script rule.
- `apps/room-recorder/CHANGELOG.md` (224 B) has one entry: `- **0.1.18** — self-update verifier no longer requires the Mac to trust
  the signing certificate; leaf pin unchanged.`
- 0.1.18 gate: `swift test` → `Test run with 544 tests in 44 suites passed` (CLT plugin flags; bare `swift test` cannot load
  `TestingMacros`); `npm test` 1572 passed. Artifact 0.1.18: sha256 `54c24dd5…84c9`, CDHash `4dbb2359…8212`,
  DR `identifier "com.evenscribe.room-recorder" and certificate leaf = H"187dd424…8edb"`.
- Releases live: `stable` 0.1.18 `rel_2wkm4erfbysh`, `test` 0.1.18 `rel_nr39q24q9v9n`. Retired: `test` 0.1.17, `stable` 0.1.8.
- `RoomSelfUpdate.swift`: `pinnedRequirement = "= certificate leaf = H\"\(pinnedLeafSHA1)\""` (leaf `187dd424fb866204111113d60c6f88a21d098edb`);
  `checkInterval` 6 h (`:70`), `launchAgentLabel = "com.evenscribe.room-recorder"` (`:74`), `update.log` under the app root
  (`:99`), `canaryWindow` 180 s (`:163`), `handoverExitCode` 64. Update checks run on first poll after launch, at session end, and
  every 6 h (rule 17). A check during an open recording logs `update to <v> deferred: a recording session is open` (`:794`) and
  re-arms at session end (`deferredWhileRecording && sessionJustEnded`, `:559`).
- Swap-script literals (`:1128`, `:1234`/`:1262`): `swapping to ${VERSION}` … `${VERSION} acknowledged the canary after ${CANARY_WAITED}s`.
  `explicit requirement satisfied` is codesign's own `--verbose=4` line (seen in the Room 4.1 exit=0 run), not the app's.
- App root on every Mac: `$HOME/Library/Application Support/EvenScribe/RoomRecorder` (config.json, room-session.json, launchd.log,
  update.log). Bundle: `$HOME/Applications/EvenScribe Room Recorder.app`.
- Fleet (all 0.1.18, listening, ids as in carryover §1): Home Office `install_539avu7gqzz5` `test` idle; Room 4.1 `install_d3sy3ufas8jv`
  (`room_ymch4bxu`, ehrc-discussion@100.109.240.30) `stable` recording since ~14:00; OPD 6 `install_d2nkvqcnqb7k`; OPD 5
  `install_e3yjw3ut698x`; OPD 3 `install_fc2jt2zs4x8v` (mic level 0, 0.71 B/ms — input-level item still owed, not this build's);
  Cardiology `install_pgrped6322ss`; OPD 7 `install_6m45w69ux7tj`. OPD 4 / OPD 1 PARKED — do not touch.
- Signing needs the login keychain unlocked in the session that runs `build-bundle.sh` (rule 4): V runs
  `security unlock-keychain ~/Library/Keychains/login.keychain-db` in a real Terminal window; `set-key-partition-list` was
  refused on 11 Sep and signing worked anyway. Preflight signs a disposable file and dies loudly if not.

## Exact scope (three edits, packaging + notes only — no Swift, no tests, no server)
1. `apps/room-recorder/Packaging/VERSION` → `0.1.19`.
2. `apps/room-recorder/Packaging/build-bundle.sh:231` heading → `# ─── Verify, pinned to our leaf ─…` — same character, same total
   line width as today (pad the `─` run to keep 96 columns). One line; nothing else in the script moves.
3. `apps/room-recorder/CHANGELOG.md` → add above the 0.1.18 line:
   `- **0.1.19** — no functional change; first release offered to a clinic Mac through the leaf-only self-update path.`
One commit on `vinay/release-b1`, subject `room-recorder: 0.1.19 — first clinic self-update`. Commit this kickoff, the build
report and the Refuter verdict with it (rule 8: they land untracked in `docs/handoff/`; the pre-flight must expect exactly those).

## Allowed changes
The three files above and the three `docs/handoff/` files named here. Nothing else. No push.

## What to verify (Builder runs; Refuter reruns)
- `git diff 964e426..HEAD --stat` shows exactly: `VERSION`, `build-bundle.sh` (1 line), `CHANGELOG.md`, plus `docs/handoff/*` — quote it.
- `swift test` with the CLT plugin flags used on 11 Sep: report the count (544 at `964e426`; expect 544, no new tests).
- Build + sign: `Packaging/build-bundle.sh "$PWD/.build/release-bundle-0.1.19"` from `apps/room-recorder`, after V has unlocked the
  keychain in a Terminal window. If the tree is dirty only in `CLAUDE.md` / `docs/handoff/`, `ETA_ALLOW_DIRTY_BUILD=1` is
  acceptable — say so and quote `git status --short`.
- On the produced bundle, print with exit codes (rule 18):
  `codesign --verify --strict --deep --verbose=4 -R '= certificate leaf = H"187dd424fb866204111113d60c6f88a21d098edb"' "<app>"; echo exit=$?` → 0;
  `codesign -dr - "<app>"` → DR identical to 0.1.18; `codesign -dv --verbose=4 "<app>" 2>&1 | grep CDHash`;
  `plutil -extract CFBundleShortVersionString raw "<app>/Contents/Info.plist"` → `0.1.19`;
  `strings "<app>/Contents/MacOS/room-recorder" | grep -c 'anchor trusted'` → 0;
  `shasum -a 256 <zip>` equals `sha256` in `release.json`; print `size_bytes`.
- Stage the artifact and STOP. Do not publish. Do not touch any room, any LaunchAgent, any config.json, Home Office included.

## Do not
- Do not publish 0.1.19 to any channel; V orders it after the Refuter's ACCEPT.
- Do not push; do not edit anything under `Sources/`, `Tests/`, `app/`, `lib/`, migrations, or the bench UI.
- Do not run a bootstrap paste anywhere (each one mints and retires an install id).
- Do not put a password, token or `.env.local` value in any transcript, file or `!` line.

## Output
`docs/handoff/ETA-0.1.19-BUILD-REPORT-11-SEP-2026.md`, cap 200 words: commit sha + subject; `--stat`; test count; the six
codesign/plutil/strings/shasum lines with exit codes; artifact path, sha256, size_bytes, CDHash; dirty-tree finding; deviations.
Chat reply: commit sha, test count, CDHash, sha256, artifact path — deviations only beyond that.

## Refuter brief (fresh Opus session, after the Builder — never the agent that built it)
Read `git diff 964e426..HEAD` only. Confirm exactly three product files moved and the `build-bundle.sh` change is one comment line
(`git diff 964e426..HEAD -- apps/room-recorder/Packaging/build-bundle.sh` shows one `-`/`+` pair, both starting `# ───`). Rerun the
suite yourself (report count). Rebuild nothing; verify the staged artifact yourself: unpack the zip with `ditto -x -k` to a temp dir,
rerun the leaf-only `codesign --verify --strict --deep -R …` (exit code), `codesign -dr -` equals the 0.1.18 DR, CDHash matches the
report, `Info.plist` says 0.1.19, `strings` has no `anchor trusted`, sha256 of the zip equals `release.json`. Adversarial: did anything
besides the three files change (`git diff 964e426..HEAD --stat` includes only them + `docs/handoff/`)? Is `release.json.version`
`0.1.19` (a mislabelled bundle is the endless-update case, RoomSelfUpdate step 6c)? Verdict ACCEPT / REJECT + failing line, cap 150
words, to `docs/handoff/ETA-0.1.19-REFUTER-VERDICT-11-SEP-2026.md`.

## Rollout after ACCEPT (V orders each step; Fable reads the evidence; written here so the Builder knows what it must not do)
1. **Publish 0.1.19 to `test`** (Claude Code on the Mini, `.env.local` sourced, new blob key). Home Office is on `test`: force its check
   with `launchctl kickstart -k gui/$(id -u)/com.evenscribe.room-recorder`, watch `update.log` for `swapping to 0.1.19` → codesign's
   `explicit requirement satisfied` → `0.1.19 acknowledged the canary after Ns`; `scribe_diff_room home-office-w8fb` listening.
   This proves the offer is well-formed. It proves nothing about a clinic Mac.
2. **Room 4.1 to `test` — only when nobody is in the room (V decides the moment).** Over SSH in a Terminal window
   (`ssh -t ehrc-discussion@100.109.240.30`, password at the prompt), in this order:
   a. `scribe_stop_recording room_ymch4bxu` from Cowork first (ends the day cleanly, tape closed; `stop` needs the listener alive).
   b. `launchctl bootout gui/$(id -u)/com.evenscribe.room-recorder`
   c. `plutil -replace update_channel -string test "$HOME/Library/Application Support/EvenScribe/RoomRecorder/config.json"`
   d. `launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/com.evenscribe.room-recorder.plist"` — the first poll after launch
      runs the check; no session is open so nothing defers.
   e. `sleep 15; tail -5 "$HOME/Library/Application Support/EvenScribe/RoomRecorder/update.log"; echo exit=$?` and repeat until
      `0.1.19 acknowledged the canary` appears (≤ 180 s + swap time). Then
      `plutil -extract CFBundleShortVersionString raw "$HOME/Applications/EvenScribe Room Recorder.app/Contents/Info.plist"` → `0.1.19`,
      `tail -2 …/launchd.log`, and from Cowork `scribe_system_map` → Room 4.1 listener `app_install_d3sy3ufas8jv` (the id must NOT change —
      a self-update is not an enrolment) with a fresh `last_poll_at`. Fleet row `0.1.19 / ok`.
   f. `scribe_start_recording room_ymch4bxu` if the room still has hours left; otherwise leave it for the morning.
   If `update.log` shows `update to 0.1.19 stopped: …` or the canary rolls back, STOP — that is a Debugger (Opus) job on the log, not a
   retry. The old bundle is back at `.previous` and launchd restores it.
3. **Publish 0.1.19 to `stable`** (second blob key). The other five take it at their next check — first poll after launch, session end,
   or 6 h. Do NOT `kickstart -k` a room that is recording. Verify by `scribe_system_map` + `update.log` over SSH per room when idle.
4. **Exit:** six clinic rows `0.1.19 / ok`, install ids unchanged, nobody in a room during any swap. Then Room 4.1 stays on `test` as
   the fleet's canary room (V's call to move it back).
