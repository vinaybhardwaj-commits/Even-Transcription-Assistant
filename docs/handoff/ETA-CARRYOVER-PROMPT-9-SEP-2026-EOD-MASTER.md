# ETA carryover, 9 September 2026, end of day

**Spin up from this file.** It supersedes `ETA-CARRYOVER-PROMPT-9-SEP-2026-MASTER.md` (the morning
version) and both 8 September masters. Those are kept for detail.

---

## 0. Where to work, and the rules that have held

**The bus is the repo's own `docs/handoff/` on the Mini.** There is no `eta-handoff` folder on either
machine. CDMSS has one; Scribe never did. Mirror copies live in `Daily Dash EHRC/ETA/` on iCloud.

| | |
|---|---|
| Build repo | `~/dev/Even-Transcription-Assistant` on the **Mac Mini** |
| Air's clone | same path on the MacBook, **stale at `d7df4b1`, 23 commits behind. Do not read it.** |
| Share | `/Volumes/MiniDev`, request it each thread. `ReadMini` MCP is the fallback. |
| Origin | `vinaybhardwaj-commits/Even-Transcription-Assistant` |
| Live | `www.evenscribe.app`, Vercel, region `bom1` |

**Anything that signs runs in Terminal.app on the Mini's own screen, never over SSH.** Verified 8 Sep:
signing fails over SSH with `errSecInternalComponent`. Screen Sharing is a console session. SSH is not.
The same fault makes `swift test` report 46 `needsEnrolment` issues over SSH; that gate is unproven over
SSH, not failed.

Rules that have held: verify on production reality, never on the report. Labels derived, never typed. A
stated guarantee is not an implemented one, now five times over. Paid runs only by operator action. No
kickoff with open issues. An approved visual mockup before any UI build.

---

## 1. Live state, 9 September

Production `46a7475`. Migrations applied through `0077` in the repo; **whether 0075 to 0077 are applied in
production is still unconfirmed.** Branch tip `feat/room-recorder` = `1193083`. Stable release `0.1.7`,
published 8 Sep 11:04. Six rooms exist; four clinic rooms plus Home Office run the app.

| Room | id | Microphone | State |
|---|---|---|---|
| OPD 3 | `room_87frpus9` | TONOR TM20 | **clipping AND 45.76% dead air** |
| OPD 5 Dr Salanki | `room_4ggnkg5x` | **C270 webcam** | wrong instrument, still not swapped |
| Cardiology OPD | `room_bh6jtq4t` | TONOR TM20 | quiet but alive, 7 to 10 dB low |
| OPD 7 | `room_qyzghzaf` | TONOR TM20 | correct, use as reference; clips occasionally |
| Home Office | `room_2qe955hy` | TONOR TM20 | V's study. Install `install_gd9tnfgqazvh`, **confirmed server-side 9 Sep**. The acceptance room. |
| OPD 1, OPD 4 Ortho | — | — | rooms exist, no Mac bound |

**Two live faults not in any build.** Transcript lanes are **off** in OPD 3, OPD 5 and OPD 7, so
**0 minutes of 51 h 51 m recorded have ever become words**. And OPD 3 recorded 45.76% of its day as
bit-exact digital zero while every check said healthy.

---

## 2. Where the build stands. Read this before touching anything.

**Build R3, self-update, is BUILT but NOT SIGNED, NOT PUBLISHED, and NOT IN ANY ROOM.**

- Branch `vinay/r3-self-update`, head **`b11518d`**, base `1193083`. Nothing pushed, `main` untouched.
- Kickoff: `ETA-INSTALL-BUILD-R3-KICKOFF-9-SEP-2026.md`
- Report: `ETA-INSTALL-BUILD-R3-REPORT-9-SEP-2026.md`
- **Fix kickoff, issued and awaiting the builder: `ETA-INSTALL-BUILD-R3-FIX1-KICKOFF-9-SEP-2026.md`**

**Verdict given 9 Sep: DO NOT SIGN. Fix first.** An Opus refuter reviewed the diff and the orchestrator
verified the decisive defect by hand.

### The four blockers, restated so the next thread does not have to re-derive them

1. **F1. The six new poll fields never reach the database.** `app/api/bench/commands/route.ts:77-91`
   builds `install` from eleven hard-coded keys and reads none of `session_open`, `update_channel`,
   `last_update_result`, `last_update_error`, `last_update_at`, `disk_free_bytes`. The app sends them,
   `applyInstallPoll` writes them, the route drops them. **Consequence if shipped: `session_open` stays
   NULL, so "Tape not advancing" never fires again in any room. The build would delete a working safety
   check.** This was an orchestrator spec gap: that file was on neither the editable nor the untouched
   list. It is now editable.
2. **F2. Unbounded swap loop.** A repeatable `swap_failed` re-downloads and re-swaps about every 80
   seconds for ever, each cycle crossing the window where no resident bundle exists. Also fires with no
   failure at all if a release's `version` disagrees with the `CFBundleShortVersionString` in its zip.
3. **F3. Staging race.** `RoomEngine.swift:642` unconditionally deletes the staging directory the swap
   script is running out of. `ThrottleInterval` does not protect it: it gates the interval between
   starts, and the app has been up for hours, so launchd respawns on exit 64 immediately.
4. **F4. Acceptance test 6 proves nothing.** It asserts `0.1.7 or 0.1.8` and removes the sleep, so it
   passes identically with no `trap` line. §13.5 item 6 is the one item singled out as needing proof.

Plus four folded rulings: F5 `last_update_version` as a seventh column in 0078 (amend in place, 0078 is
unapplied); F6 suppress `update pending` for a Mac whose channel is not the header's, per mockup state E;
F7 exit 64 as a named constant; F8 escape the version in the `update-result.json` heredoc.

### What was right, so nobody re-reviews it

R3-1 to R3-12 all correctly implemented. File contract held on all 22 paths. The swap script is correct
in all eight sub-steps, verifies against the resident path, restores `.previous`, and all nineteen path
expansions are quoted. The spawn is genuinely detached (`POSIX_SPAWN_SETSID`). R3-9 leaves the disk
untouched on every non-200.

### Accepted as-is, do not reopen

The leading `= ` on `codesign -R` (the kickoff's literal was wrong, `build-bundle.sh` was right).
`--deep` on both codesign checks. The update check at the end of a successful poll. The channel tag in
the Room cell per the mockup. State C marking the row `needs_attention`. The three extra reason
sentences. Channel set by hand edit, no verb. `disk_free_bytes` read in `InstallPollFields.swift`.
`download_failed` for a size mismatch. **The SIGKILL window: accept the trap, do NOT add `renamex_np`;
run acceptance item 6 with `kill`, not `kill -9`.** Poll field count is **14 fields / 17 wire items**,
not §13.4's "twelve".

---

## 3. The full build ladder, R1 to beyond R4

| Build | State | What it is |
|---|---|---|
| **R1** | done 7 Sep | Install module, fleet card, `app_release`, publish and withdraw. |
| **R2** | done 8 Sep | Signed bundle, `enrol` verb, keychain, seven poll fields. |
| **R3** | **built, fix pending, unsigned** | Self-update. The release route, the detached swap script, the per-Mac channel, migration 0078. **The unblocker for everything below.** |
| **THE ONE PASTE** | pending R3 | V goes to the hospital once and pastes the install line in four rooms. Everything app-side must ride it. After this, no room is ever visited again. Take `df -h /` in each room while there; nothing reports free disk until 0.1.8 lands. Decide before going whether OPD 1 and OPD 4 Ortho get installed too. |
| **Release B** | ships remotely once R3 is proven | Exact-zero sample count and a **real peak**, both two lines inside the loop at `TapeWriter.swift:256-260` that already walks every sample. Disk retention: nothing deletes recorded audio, about **115 MB per recorded hour, roughly 1 GB per room per day**. The `tape_advancing` unit fix (it compares an index file's byte length against a sample count). The input device list. The `currentLevels()` reparse of the whole tape index every 1.5 s. |
| **R2.5** | server-side, no app change, runs in parallel | Gap detector on `gap_before_ms != 0` or `duration_ms != 300000`, which catches every unplug and works today. Byte-rate detector against a **fixed** reference, never rolling. A read door for `stt_window_measure`. Fix the mutating `GET /api/admin/measure-windows`. Expose `input_device_name` and `app_version` through the MCP. Add measurement columns to the `listBenchChunks` SELECT at `lib/bench.ts:140`, the choke point that lights up five operator surfaces at once. Per-room energy floor storage. |
| **R4** | after the paste | Room audio control. The app reports every input device and the current input level; the command bus carries set-device and set-level. **Blocked fact to establish first: the TONOR TM20 has a physical gain knob and macOS may not expose gain at all.** Build the read half first and let it answer. |
| **Loudness normalisation** | server-side, any time | One pass per piece before transcription. Will not rescue OPD 3's clipped peaks or find speech in OPD 5's hum. |
| **Active tone self-test** | designed into R4's bus, built LAST | The Mac plays a known tone and the app checks the microphone hears it. Out of hours only. Do not build until the passive layer has run for weeks and earned it. |

**The hard constraint that shapes R4:** a fifth command-bus kind would break every 0.1.7 client. Adding
one to `BenchCommandKind` throws a decoding error for the **entire poll response**, not just that command.
Either R4 rides a fetched route like R3 does, or it waits until every room is past 0.1.7.

**The caution that shapes everything audio:** clipping is destructive. Set gain low enough that the
loudest human never clips, once, and add loudness back in software. Never adjust per doctor.

---

## 4. Measured facts from 9 September. Do not re-derive, do not contradict.

- **OPD 3 clips.** All four consecutive pieces at `max_volume 0.0 dB`, true peak up to **+4.7 dBTP**, 7 to
  51 full-scale samples each. Measured with ffmpeg on the downloaded audio.
- **OPD 3 also has dead air**, 45.76% of its day bit-exact zero. Two independent faults, one of them in
  the same piece (chunk 5: 46.7% zero **and** clipping).
- **The "Max peak" column in the findings record is not a peak.** `sweep/measure_all.py:311`
  `transient_maxpeak` is `np.max` of a 100 ms frame-RMS series. The room-to-room comparison survives; the
  column name does not.
- **Integrated LUFS is unusable on this material.** Twelve windows all returned exactly −70.0 LUFS, the
  EBU R128 absolute gate floor.
- **Exact-zero fraction is the clean discriminator.** Quiet room under 1.5% (OPD 7 measured 0.17 to 0.21%);
  gated stream above 94%. No overlap anywhere in the data.
- **`ArchiveLevelSidecar.quantizedLevels` is DEAD CODE.** Both call chains terminate at
  `PrimaryResidentRuntimeFactory`, which `main.swift:199` never passes. The live per-sample loop is
  `TapeWriter.swift:256-260`. Two thirds of the app (20,598 of 29,730 lines) never runs.
- **`mic_peak` and `mic_avg` are the same variable.** `RoomEngine.swift:2406`
  `BenchLevelPair(peak: rms, average: rms)`, one 1.25 s RMS window from the tape index. No peak is
  computed anywhere in the live path.
- **A byte-rate detector is nearly blind.** `B/s = 708f + 4000(1−f)`. At 1000 B/s it catches only
  `f > 0.91`. An unplug is structurally invisible to any byte method, because the lost time is not inside
  any chunk.
- **The size detector self-poisons.** OPD 3's `mic_size.baseline_bytes_per_ms` learned 0.7079, which is
  the silence floor itself. Never clear a room with `proven_dead_by_size` or `newest`.
- **`scribe_diff_room` must be called once per room, naming the room.** An all-rooms sweep has
  misattributed values between rooms twice in one day.
- **Piece size within about ten percent says nothing about content.** Only a fourfold drop means anything.

---

## 5. Owed, and open

1. **The fix build.** V pastes the FIX1 order, then brings the report to the next thread.
2. **`swift test` at the console**, not over SSH. Currently unproven.
3. **`npm test` re-run on the Mini.** The 1551 passing is the builder's claim; it could not be re-run
   over the share (the tree's `node_modules` is a macOS install).
4. **Are migrations 0075 to 0077 applied in production?** One `GET /api/run-migrations` from the Mini.
5. **A stray untracked `CLAUDE.md` appeared in the repo at 20:19 on 9 Sep from outside the build.**
   Something else wrote into that tree. Two builds must never run in one repo at once. Not committed.
6. **Vercel plan `maxDuration` and function memory** — dashboard only, needed for R2.5's floor job.
7. **`AUDIO_JOIN_URL` and `AUDIO_JOIN_TOKEN` set in production?** Needed only for decode-based measurement.
8. **The `.p12` escrow.** V says it is saved on the Mini. A copy on the Mini is not a spare; if the disk
   dies, keychain and escrow go together, and every room needs microphone re-approval.
9. **Transcript lanes off in OPD 3, OPD 5, OPD 7.** Deliberate, pending pipeline work, but it means the
   original question stays blocked on a switch rather than on evidence.
10. Carried and untouched: the two Neon console checks, the Gemini flips (`GEMINI_STT` unset, health
    reports `gemini_stt_disabled`), the tuning-fork clip, the eleven Cardiology windows, the gold-window
    graduation, `ZZ Verification Probe` (`room_bn49z3zd`) which exists in production and in no document.

---

## 6. The original programme question, still open

**Is this audio transcribable?** Partly answered. OPD 7 almost certainly yes. Cardiology probably, once
normalised. OPD 3 damaged by clipping and holed by dead air. OPD 5 needs the right microphone first.
Nothing paid has run. Every transcription is a paid call and fires only when V asks.

Three cheap things still undone: read the coverage report and refusal ledger (blocked on R2.5's read
door); design the per-room energy floor, since one constant passes 99.44% of OPD 7's frames and 0.067% of
OPD 5's on the same fifteen minutes; and read one Sarvam transcript of a real consult window by eye.

---

## 7. Files

In `docs/handoff/` on the Mini, mirrored to `Daily Dash EHRC/ETA/`:

- `ETA-INSTALL-AND-FLEET-PRD-BUILD-R3-ADDENDUM-8-SEP-2026.md` — **§13, the governing R3 spec.** Supersedes
  PRD §7 steps 7 to 10. R3-1 to R3-8 ratified 8 Sep, R3-9 to R3-12 ratified 9 Sep.
- `ETA-INSTALL-AND-FLEET-MOCKUP-R3-DELTA-8-SEP-2026.html` — the approved visual. **State C ships.**
- `ETA-INSTALL-BUILD-R3-KICKOFF-9-SEP-2026.md`, `-REPORT-`, `-FIX1-KICKOFF-`
- `ETA-ROOM-RECORDER-INSTALL-AND-FLEET-PRD-7-SEP-2026-v1.0.md` — one copy only, runs to §12.11.
- `ETA-INSTALL-BUILD-R1-REPORT-7-SEP-2026.md` §3 — the publish curl runbook.
- `ETA-INSTALL-BUILD-R2-KICKOFF-8-SEP-2026.md` — the signing contract.

In `Daily Dash EHRC/ETA/` only:

- `ETAAUDIOANDSILENCEFINDINGS9SEP2026.md`, `ETAROOMRECORDERSOURCEFINDINGS9SEP2026.md`
- `ETA-ROOM-RECORDER-APP-REFERENCE-9-SEP-2026.md` — how the app works, cited line by line.
- `eta-room-watch-DEAD-AIR-RULES-9-SEP-2026.md`, `eta-room-watch-log.md`

On the Mac: `~/Downloads/ETA-audio-9-sep/` — the measured audio, scripts and spectra. Not in the repo.
