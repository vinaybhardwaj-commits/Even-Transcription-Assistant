# Even-Transcription-Assistant — project facts for the Builder

The standing rules are in `~/.claude/CLAUDE.md`. This file adds only what is specific to this repo.

## Identity
- Programme: ETA (bus prefix `ETA-`; builds are numbered `ETA-INSTALL-BUILD-R<N>-<TYPE>-<D>-<MON>-<YEAR>.md`)
- Product: EvenScribe — ambient OPD recording, transcription, and note generation for Even physicians
- Live at: `evenscribe.app`
- Clone: `/Users/vinaybhardwaj/dev/Even-Transcription-Assistant`
- tmux session: `scribe`

## Bus
- The repo's own `docs/handoff/` on this Mac. Kickoffs arrive there untracked; commit them with the work.
- Reports go to the path the kickoff names, in the same folder. Mirrors live in iCloud; you never write those.
- The orchestrator's `ETA-CARRYOVER-PROMPT-*-EOD-MASTER.md` and `ETA-ORCHESTRATOR-MEMORY.md` may appear untracked; leave them.

## Gate (all must be green before any commit)
- `npm run typecheck`
- `npm test` (vitest)
- `npm run build`
- `npm run check:silent` — 9 findings pre-existing at `1193083` are accepted; say so, do not fix files outside the contract
- `cd apps/room-recorder && swift build`
- `cd apps/room-recorder && swift test` — over SSH the login keychain is locked, so `needsEnrolment` issues mean UNPROVEN, not failed; say which
- Signing over SSH works once V has unlocked the keychain himself (`security unlock-keychain` then `security set-key-partition-list -S apple-tool:,apple: -s` on `~/Library/Keychains/login.keychain-db`, password at the prompt). Never script the unlock; never ask for the password.

## Data
- No live database in this sandbox. Every SQL string and schema assumption is INFERRED — list verbatim in the report.
- Audio, transcripts, and encounter rows carry patient and doctor identity. Never print transcript text, note text, or patient labels. Counts, ids, and timings only.
- The Mac Mini also hosts the local Whisper and diarization services this app calls; do not start, stop, or reconfigure them without an order.

## Secrets (names only)
- As named in the kickoff. Never read `.env*` into the transcript.

## Deploy
- Vercel; preview on branch push, production on merge to `main`. You do not deploy; the Orchestrator watches it.
