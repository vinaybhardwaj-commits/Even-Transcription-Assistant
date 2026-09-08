# ETA / Evenscribe — Build History

A milestone chronology of how the app was built (May–June 2026). Per-bug detail is in
[`../content/ETA-BUG-LOG.md`](../content/ETA-BUG-LOG.md); the scoped reliability backlog is in
[`ETA-BACKLOG-SCOPED.md`](ETA-BACKLOG-SCOPED.md); session-by-session handoffs are the
`ETA-CARRYOVER-*` docs. Commit shas referenced throughout are in repo history.

## v1 — core record → note → email (late May 2026)
PIN auth (clinician slug + 4-digit PIN, JWT, lockout) · `MediaRecorder` capture with IndexedDB +
in-memory failsafe · presigned R2 upload · streamed `/process` pipeline (cleanup → qwen note →
llama CDS with pgvector KB retrieval + citation-critique) · inline note edit · Resend send with
svix delivery webhooks · admin console (clinicians, recipients, encounters, LLM traces, health,
launch-readiness) · service-worker PWA with killswitch. Migrations 0001–0005.

## Multilingual transcription (30 May)
Sarvam Saaras v3 for Indic languages: live code-mixed rolling transcript + submit-time batch
STT-translate to English; English path (Deepgram) unchanged; `transcription_run` + detected-language
storage; leading-hallucination/ad guard. Migration 0006.

## Speaker diarization v2.1 (30–31 May)
Mac-Mini pyannote `/diarize` + `/enroll`; voice enrollment wizard; submit-time diarization +
voiceprint naming; speaker-tagged transcript; admin Speakers timeline + diarization EER harness.
Migrations 0007–0009.

## v2.0 — note types × clinician types (31 May)
5 note types (clinic, general medical, operative, dietetic, physiotherapy) × 3 clinician types
(physician, dietitian, physiotherapist), each with its own schema/prompt/viewer/editor/email.
`clinician` became the sole identity table and the legacy `doctor` table was dropped. CDS gated by
note type. Migrations 0010–0016.

## Voiceprint retention A/B (31 May)
Retain every voice sample (audio + embedding) in `voice_sample`; accumulate + retrain centroids;
passive capture of matched-clinician samples above a confidence gate. Migration 0017.

## STT Engine Lab L0–L7 (31 May – 1 Jun)
Engine registry + adapter interface (new engine = 1 file + 1 row); offline fan-out queue; reference-
free scoring (inter-engine agreement + blinded LLM judge); gold WER + medical-term fidelity;
composite leaderboard; stage×language routing; ASR engines Deepgram/Whisper/Sarvam/ElevenLabs +
a Scribe tier (audio→note vs the `even_pipeline` reference). Migrations 0018–0023.

## Reliability hardening + testing harness (2 Jun)
Proactive 3-reviewer audit (logged as B19) → fixed data-loss + a 20-item reliability backlog across
5 tiers (crypto PINs, Sarvam/Whisper/Deepgram robustness, atomic fan-out claim, dup-email guard,
Resend webhook hardening, stuck-`processing` reaper on an hourly cron, Tier-4 live-path flags).
Test harness: `smoke.mjs` canary, `check:silent` gate, vitest unit suite, Playwright e2e (incl. the
B18 IndexedDB-blocked regression). New admin surfaces: published `/buglog`, encounter audio
play/download, self-serve Admins management, System Map. Migrations 0024–0025.

## Field fixes + scribe swap + CI repair (6 Jun)
- Activated Tier-4 flag #17 (live-buffer trim).
- **Discovered CI had never actually run** (no lockfile → failed at Setup Node on every run); fixed so typecheck + vitest + silent-gate genuinely execute (B21).
- Retired EkaScribe (too costly; row disabled, code kept) and added **`elevenlabs_scribe`** as the showcased scribe competitor (ElevenLabs ASR → Even note-gen). Migration 0026.
- **Dr-Ankit field bugs (B22):** live Sarvam `http_413` payload wedge → byte-capped the live window (`lib/live-window.ts`); service-worker "FetchEvent.respondWith … Load failed" → SW returns a real network error on cache-miss+offline and **no longer proxies non-GET** (so the long `/process` stream isn't SW-wrapped); client auto-recovers a dropped `/process` stream (idempotent route). Added vitest regressions for both (live-window byte cap + SW non-GET bypass).

## IndicConformer STT (13 Jun) — code-ready
AI4Bharat IndicConformer-600M (local Mac-Mini Indic ASR) wired into the STT Engine Lab as
`indicconformer` (ASR) + `indicconformer_scribe` (IndicConformer → Even note-gen), migration 0027.
Indic-only, submit-time fallback (not live, not English — per the 93%-English bucket scan). Fanout
is OFF until the Mac-Mini exposes `indic.llmvinayminihome.uk` (Pattern B); then it A/B's against
Sarvam/Whisper/etc. on the Indic slice. See `IndicConformer-Integration-Handoff.md`.

## Install and fleet, Build R1 — server, routes and the Bench card (7 Sep 2026)
Room Recorder installs on a clinic Mac with **one Terminal paste**, and `/admin/bench` gains a
third card saying which Mac runs which room. Ships nothing to a Mac; the app itself is Build R2.

- **Migration 0075** — `app_release`, `room_bootstrap_token`, `room_install`, with the partial
  unique index that makes "one active enrolled install per room" a database fact rather than a
  convention. Three columns beyond PRD §4.1 (`first_seen_at`, `tape_poll_streak`,
  `tape_advancing_since`) because §6 asks for state the listed columns cannot hold — flagged, not
  smuggled.
- **Eight routes** (PRD §4.2): publish / list / withdraw releases, mint a bootstrap token, serve
  the §4.4 script, spend the token for a 365-day room session, read the fleet, retire an install.
  All admin routes also take `Bearer MIGRATION_SECRET`, the stt-admin pattern, so the whole
  acceptance runs from curl.
- **Nothing is typed.** `POST /api/admin/releases` streams the Blob object, recomputes `sha256`
  and `size_bytes`, and refuses `SHA_MISMATCH` before any row exists. The same digest goes into
  the script that `shasum` checks on the Mac.
- **Poll additions** (§4.3): seven optional fields on `GET /api/bench/commands`. A poll without
  `install_id` issues no `room_install` SQL at all, which is why the browser kiosk is untouched;
  a poll from a retired install gets `409 RETIRED` (§4.5 rule 3) and stops.
- **The Install and fleet card** (§6, D11/D13): rows per room polled every 20 s, a five-step
  checklist polled every 3 s. The page never asserts completion from its own actions — step 1,
  "Command copied", is the only page-driven step and never reads "Installed".
- **Nightly cleanup** rides `/api/admin/measure-windows`, the only genuinely nightly cron, rather
  than adding a schedule.
- **No feature flag.** The empty release table is the gate: with no row the card reads "No release
  published yet" and every install button is off.

Gate: 1498 unit tests green (was 1443), typecheck clean, production build green. Migration 0075
is **not run** — V applies it through `/api/run-migrations`.

## Current state
Migrations 0001–0074 applied, 0075 written and awaiting V; all backend services green; CI green
on typecheck + vitest. `npm run check:silent` currently reports 9 pre-existing findings in the
encounter `/process` and note-composer paths — unrelated to any recent build and untouched by
them, recorded here because the line below used to claim the gate was green.

This chronology lapsed after 13 June: Builds 1 to 4 (Aug–Sep 2026) carry their changelogs in
their commit messages rather than here. See `git log` and the `docs/handoff/` kickoffs for those.
See `ETA-OPEN-ITEMS.md` for pending-V items and `../content/ETA-BUG-LOG.md` for the parked
security P0s (B19).

## Install and fleet, Build R2 — the signed bundle and the app side of the paste (8 Sep 2026)
X1 closed: in-house identity `EvenScribe Room Recorder Code Signing 1`
(SHA-1 `187DD424FB866204111113D60C6F88A21D098EDB`, cert SHA-256
`903EDCE6…BB281643`, valid to 4 Sep 2036), created and trusted at the Mini's console.

- **Packaging** — `apps/room-recorder/Packaging/build-bundle.sh` assembles, signs and zips the
  bundle per §5.1/§5.2, pinning the identity by SHA-1 and verifying against the same requirement
  string R3 will use. Preflight TRIAL-SIGNS a disposable file, because `find-identity -v` succeeds
  over SSH while `codesign` does not — a check that only looks like one is worse than none.
- **`enrol` verb** (§5.3) — posts the token, stores the session in the keychain, writes a config
  holding no token. Reads nothing from stdin, because it runs inside `curl | bash`.
- **Keychain item** (§5.4) — service `com.evenscribe.room-recorder.room-token`.
- **Poll fields** (§4.3/§5.5) — seven fields, each measured at the moment of the poll; anything
  unreadable is omitted rather than defaulted, so the server's COALESCE keeps the last true value.
  `tab_id` becomes `app_<install_id>`. A 409 RETIRED stops the app, and `KeepAlive` became
  `SuccessfulExit:false` so launchd honours that stop instead of thrashing.
- **Migration 0076** — the `room_bootstrap_token.install_id` foreign key §4.1 specified and 0075
  omitted. Not run.
- **X2** — the vendored encoder ships with its LGPL notices bundled.

Deployment target is set explicitly to macOS 15.0; the toolchain on the build Mac defaults to
`macosx28.0`, which would not launch on the clinic Macs.

**Fix, same day, first real run of the script:** `swift build --product a --product b` builds only
`b`. SwiftPM's `--product` is single-valued and silently keeps the last one, so the run died at
the assemble step with `room-recorder was not built` after happily building `tapewriter`. The
build step now runs one invocation per product.

**Second fix, same run:** the `production_ready` flip rewrote
`Contents/Resources/Licenses/build-provenance.json` *after* the bundle was signed and *after* the
verify step passed. `Contents/Resources/` is a sealed resource, so the zip built from that bundle
carried a broken signature while the build reported green — the one output the script's own header
says must never exist. The provenance write now sits between the helper signatures and the bundle
signature, and the script additionally unpacks the finished zip and verifies *those* bytes against
the pinned requirement, deleting the zip if they fail.

**Test suite, same day:** §12.5 item 1 is closed without Xcode — CLT 27.0 ships `Testing.framework`
and `swift test` resolves it. Compiling the suite for the first time exposed two stale
`pollCommands` call sites in `RoomBenchContractTests.swift` that `148d04d` missed when it made
`install:` required; the six sites it did update were protocol conformances. Both now pass
`install: nil` rather than the parameter gaining a default, because a default would let a future
caller drop the seven fields silently. 451 tests in 39 suites pass.

## Install and fleet, R2 follow-up — the device the room records from (8 Sep 2026)
The first Home Office paste installed cleanly and then died on `RoomConfigurationError error 6`,
after the enrol token was spent and the old agent had been booted out. `residentDefault` was
filling `deviceUID` — an AUDIO device UID, passed to `tapewriter --device` and sealed into the
archive index — from the `hw.uuid` sysctl, which macOS 26/27 removed.

- **`stableDeviceUID()` and the `hw.uuid` path are deleted**, not repaired. Nothing needs a machine
  identifier; `install_id` is server-minted. `IOPlatformUUID` via IOKit is the route if one is ever
  wanted.
- **Enrol takes the system default audio input** and stores its UID. No argument, no prompt, no
  refusal when several inputs exist.
- **A re-enrol keeps the room's existing device.** The rule lives in `RoomConfiguration
  .applyEnrolment`, which deliberately does not touch `deviceUID`, and is enforced by a test rather
  than a comment.
- **`input_device_name` is an eighth poll field** (migration `0077`, not run) — measured on every
  poll, omitted when the device is not attached so COALESCE keeps the last true name. The fleet row
  shows it under the mic state, because a room can be `authorized` and still be listening to the
  wrong microphone.
- **Error codes are not declaration order.** Swift bridges cases with associated values first, so
  `error 6` was `invalidDeviceUID`, not `unsafeRoot`. `RoomInstallDeviceTests` pins the mapping.

459 Swift tests in 40 suites; 62 server unit tests.

## Install and fleet, R2 follow-up 2 — the session had no reader (8 Sep 2026, 0.1.2)
The re-paste enrolled and never polled: `{"state":"offline","last_error":"missingSessionCookie"}`
with a valid 365-day session sitting in the keychain. §5.4's guarantee was half-built — `enrol`
wrote the item and nilled the config field, and nothing ever read it back. `RoomKeychain.load()`
was already being called for `installID` and the session it returned was discarded.

- **`RoomEngine.load` hydrates the session from the keychain**, where the client is constructed, so
  every entry point gets an authenticated client rather than only `run`.
- **No session is a loud refusal**, not a retry: status `needs_enrol` (a distinct state, not
  `offline`), a stderr explanation, and exit ZERO so `KeepAlive { SuccessfulExit: false }` does not
  restart it for ever. The client is never constructed, so there is no unauthenticated poll loop.
- **`saveConfiguration` strips the session**, making "config never holds it" structural instead of
  dependent on every writer remembering. `login` now writes the keychain too.
- **Tests cover the READ.** The suite covered `enrol` writing the item; nothing covered reading it.
  One pre-existing test asserted the opposite guarantee — that `config.json` contains
  `eta_room_session` — and moved with the ruling.

463 Swift tests in 41 suites. Third instance of "a stated guarantee is not an implemented one";
see PRD §12.7 for the list.

## Install and fleet, R2 follow-up 3 — the same bug twice (8 Sep 2026, 0.1.3)
0.1.2 carried the keychain-read fix and still polled `missingSessionCookie`. `RoomEngine.load`
hydrated the session and handed it to `remoteFactory`; the CLI's `run` passed
`remoteFactory: { _ in bench }` — a factory that ignores its argument — with `bench` built from
`loadConfiguration()`. The correct value was computed, passed, and discarded.

- **`RoomEngine.startingConfiguration` is now the single source** of a starting configuration:
  disk + keychain session, or a `needs_enrol` refusal. `load`, `run` and `markConsult` all use it.
  `markConsult` had the identical defect and would have posted unauthenticated.
- **`login` is the one exemption**, marked `SESSION_EXEMPT` in source — it is the verb that obtains
  a session, so it starts without one by definition.
- **A source-level guard** fails on any client built from a bare on-disk configuration. Its first
  version did NOT discriminate: it matched the word `startingConfiguration` in the comment above
  the offending line and passed with the bug reintroduced. It now strips comments before applying
  the rule, and is verified to fail with 0.1.2's bug restored and pass on revert.

466 Swift tests in 41 suites. Fourth instance of "a stated guarantee is not an implemented one" —
this time the guarantee was implemented AND tested, and the test asserted the half that worked.

## Install and fleet, R2 — microphone (8 Sep 2026, 0.1.4)
Builder-driven paste cycles on Home Office. Steps 2 and 5 turn DONE on the first poll and all eight
poll fields arrive, which establishes §9 hazard 2. Step 3 does not turn.

- **`tapewriter`'s embedded `CFBundleIdentifier` did not match its code-signing identifier**
  (`com.evenscribe.tapewriter` vs `com.evenscribe.room-recorder.tapewriter`). Aligned.
- **The bundled app now requests microphone access at startup.** The helper was doing the asking;
  it is a bare Mach-O child and TCC attributes the request to the responsible process, which is the
  app — and the app had never asked.
- **§9 hazard 1 remains UNESTABLISHED.** After a successful `tccutil reset`, the app is denied
  immediately with no dialog. Enabling it by hand in System Settings did not take effect either.
  See PRD §12.9, including the risk this raises for D1 and R3.

## Install and fleet, R2 — the resident app becomes a real NSApplication (8 Sep 2026, 0.1.5)
`room-recorder run` was a plain command-line binary under launchd. It polled fine and could never
obtain a microphone: `requestAccess` returned false immediately, no dialog was drawn, and macOS
recorded a denial. TCC has to attach its dialog to something, and a process with no run loop and no
application identity gives it nothing.

- **`ResidentApplication`** runs an `NSApplication` with `.accessory` activation policy — a run loop
  and an application identity, still no Dock icon, no menu bar, no window. §5.2's `LSUIElement`
  promise is now true of the process and not only of the plist.
- **The microphone is requested from `applicationDidFinishLaunching`**, after the run loop exists.
  Asking before it existed is why the old answer came back instantly and negative.
- **The engine starts whatever the answer is.** A refused room must still poll, so the card can say
  `denied` and send someone to System Settings; refusing to start would turn a fixable permission
  into a Mac that looks dead.
- R3 wants this shape anyway: a self-update needs an app identity to replace, and D1 binds the
  microphone grant to that identity.

**Root cause of §9 hazard 1, same day (0.1.6):** the bundle is signed `--options runtime`, and the
hardened runtime refuses the microphone to a process without
`com.apple.security.device.audio-input`. It carried no entitlements at all. The refusal happens
INSIDE the process — `requestAccess` returns denied immediately, no dialog is drawn, and `tccd` is
never asked; its log has nothing to say about the app. That is why resetting TCC and switching the
app on by hand in System Settings both changed nothing, and why neither the app-side request nor
the `NSApplication` shape fixed it on their own. The app and `tapewriter` are now signed with the
entitlement, `ffmpeg` deliberately is not, and `build-bundle.sh` FAILS the build if the entitlement
is absent from the signed bytes.

**tape_advancing was measuring the wrong number (0.1.7):** `currentDurableSampleIndex` returned
`segment.nextSample`, the PIECE-CUTTING cursor, which is assigned once every five minutes when a
piece is encoded. `tapeIsAdvancing` compares it between polls four seconds apart, so it reported
false on almost every poll and §6 step 4 — which needs two consecutive polls — could essentially
never turn done. Home Office recorded for ten minutes, wrote 20 MB of durable audio, and the card
still read `tape=false/streak=0`. It now reads the durable frontier from the index tapewriter
appends to: a record lands there only once its audio is durable, so the file growing IS §5.5's
durable sample index growing, at one `stat` per poll.
