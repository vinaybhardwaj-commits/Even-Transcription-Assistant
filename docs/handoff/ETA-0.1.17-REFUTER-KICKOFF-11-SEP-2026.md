# ETA REFUTER KICKOFF — 0.1.17 "stale session id" — 11 Sep 2026, 11:35 IST

Refuter brief for a FRESH Claude Code session on the Mini (Opus). Not the session that built `5a36727`. Orchestrator: Fable
(Cowork). V signs off; nothing publishes to any channel from this session.

## Goal
Decide ACCEPT / REJECT for commit `5a36727` (0.1.17) against `ETA-KICKOFF-0.1.17-STALE-SESSION-ID-11-SEP-2026.md`, by
rerunning every gate yourself and by proving the 11 Sep loop is caught by the new tests and closed by the build.

## Known facts (verified 11 Sep)
- Repo `~/dev/Even-Transcription-Assistant`, branch `vinay/release-b1`, HEAD `5a36727` (local, unpushed; origin `5cc6931`).
  Parent `5dff406` = 0.1.16 bump; `5cc6931` = accepted 0.1.13 code.
- Builder's report: `docs/handoff/ETA-0.1.17-BUILD-REPORT-11-SEP-2026.md` — 543 swift tests / 44 suites, npm 1572, four new tests
  in `RoomStaleIdentityTests.swift`, e2e on Home Office at 03:00:21Z, artifact
  `apps/room-recorder/.build/release-bundle-0.1.17/EvenScribe-Room-Recorder-0.1.17.zip` (sha256 `26156d0e…b176`), built with
  `ETA_ALLOW_DIRTY_BUILD=1`. **Do not trust any of it; rerun.**
- The loop: bootstrap ships 0.1.8 → `config.json` gets the new id, `room-session.json` keeps the old → 0.1.13-line build reads the
  file first (`RoomEngine.swift` identity resolution, from B1.5 `0ca7d71`) → polls as the retired id → 409 RETIRED → exits, and
  `KeepAlive.SuccessfulExit=false` keeps it dead. Four Home Office bootstraps died this way on 11 Sep.
- Home Office today: `install_539avu7gqzz5`, `test`, 0.1.13 from `~/Applications`, listening. Leave it that way when you finish.
- `.app.previous` on the Mini is 0.1.8, not 0.1.13. A 0.1.13 comparator must come from `git worktree add /tmp/rr-0113 5cc6931`
  and an UNSIGNED `swift build -c release` run with `--root` pointing at a scratch dir — never at the real RoomRecorder dir.
- Signing over SSH needs `security unlock-keychain ~/Library/Keychains/login.keychain-db` first (rule 4/19). You should not need
  to sign: verify the existing artifact, do not rebuild it.
- Room JWT carries no install id; a retired poll is HTTP 409 with `RETIRED` in the body (`app/api/bench/commands/route.ts:150`).

## Exact scope (read-only on the tree; scratch dirs only)
1. `git diff 5dff406..5a36727 --stat` and read the full diff. Confirm only the eight files under `apps/room-recorder/` moved and
   nothing under `app/`, `lib/`, `db/`, bench UI.
2. Rerun: `swift test` (with the repo's documented CLT plugin flags) — report the count; `npm test`; `npm run typecheck`;
   `npm run build`. Report every number and exit code.
3. Prove the four new tests fail at `5dff406` and pass at `5a36727`: run them by name in the `/tmp/rr-0113`-style worktree at
   `5dff406` (expect fail) and at HEAD (expect pass). Name each with its failing assertion line.
4. Reproduce the loop with the OLD code: 0.1.13 comparator (`5cc6931`, unsigned) launched with `--root /tmp/rr-scratch` where you
   planted a `config.json` naming `install_539avu7gqzz5` and a `room-session.json` naming `install_k54jsz5r4cyz`. Expect: polls as
   `k54jsz5r4cyz`, logs the 409 RETIRED stop. Then the same scratch with the 0.1.17 build (unsigned, from HEAD): expect the
   `config wins, session file rewritten` line, then a successful poll (`status.json` ready, no RETIRED line, and
   `scribe_diff_room home-office-w8fb` unchanged — you are polling as the SAME id Home Office already uses, so the listener row
   must simply stay listening). Do NOT run a bootstrap paste; it mints and retires ids on the server.
5. Adversarial reads of the three mechanisms:
   - **Change 3 cannot loop.** Exactly one RETIRED retry; the latch is never cleared; no re-read of the session file after
     discard; a RETIRED on a config-sourced id retries zero times. Quote the lines.
   - **Change 1 cannot delete a valid session on a failed enrol.** A failed `enrol` (network error, 4xx) must leave both
     `config.json` and `room-session.json` as they were. Quote the lines; write a throwaway test if none exists and report it
     (do not commit it).
   - **Change 4** — `applyEnrolment` sets `updateChannel = "stable"` unconditionally; confirm the comment at
     `RoomConfiguration.swift:178-186` now says why. Confirm nothing else resets the channel (a `test` Mac must stay `test`
     across ordinary launches and self-updates).
6. Artifact: `codesign --verify --deep --strict` on the zip's app; `codesign -dr -` designated requirement must equal the
   0.1.13 bundle's (`identifier "com.evenscribe.room-recorder" and certificate leaf = H"187dd424…8edb"`); print the CDHash — the
   partition step needs it. Confirm `Info.plist` says 0.1.17 and the binary embeds the `config wins` string (`strings | grep`).
7. Report the dirty-build flag: `git status --porcelain` at HEAD — list what is dirty and whether any of it is under
   `apps/room-recorder/` (if yes, the artifact's bytes are not described by `5a36727` and the verdict must say so).

## Do not
- Do not push, publish, sign, or touch `~/Applications`, the LaunchAgent, `config.json`, or `room-session.json` on the Mini.
- Do not run a bootstrap paste anywhere. Do not commit anything.
- Do not delegate the verdict; do not accept the Builder's numbers without rerunning.

## Output
Write `docs/handoff/ETA-0.1.17-REFUTER-VERDICT-11-SEP-2026.md`, cap 250 words: verdict line first (ACCEPT / REJECT + the failing
line if REJECT), then test counts (before/after, yours), the four tests' fail→pass evidence, the loop repro result (old vs new,
≤ 8 log lines each), the three adversarial-read answers with line refs, codesign DR + CDHash, the dirty-tree finding. Reply in
chat with only the verdict line, the CDHash, and any deviation from this brief.
