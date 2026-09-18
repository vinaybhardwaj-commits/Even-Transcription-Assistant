# ETA-E15 — the VAD model's identity, and the audio levels that stopped · 14 Sep 2026 · pane `scribe3`

Read `ETA-E13-WE-CANNOT-TELL-A-QUIET-ROOM-FROM-A-DEAD-MIC-14-SEP-2026.md` first.

Two questions, one theme: **the system decides "there was no speech here" and we currently have no way
to check that decision.** Tonight that decision became permanent — a silent window is now `transcribed`
and never re-picked. Both questions are read-only.

## QUESTION 1 — is the VAD model the real one?

`whisper-server` runs `--vad --no-speech-thold 0.7 --suppress-nst` and loads its voice-activity model
from **`models/for-tests-silero-v6.2.0-ggml.bin`**, 885,098 bytes.

That filename says *test fixture*. If it is one, then a fixture's speech threshold is what decided,
permanently and invisibly, that 21 of 25 clinical windows contained nothing.

- Establish what that file actually is: its checksum, where it came from, whether whisper.cpp ships a
  release VAD model under a different name, and whether a release model is present on this Mini or
  available to it.
- The E10 Debugger's control run showed it **does** detect speech correctly on whisper.cpp's public
  `jfk.wav`. So it works. The question is whether it is *calibrated* for a quiet consulting room, not
  whether it functions at all — **do not conclude "it works" from the control.**
- **Do not change it, do not download anything, do not restart whisper.** Report what it is.

## QUESTION 2 — why did audio levels stop being recorded?

`bench_chunk.peak_level` and `.avg_level`: **140 of 5,311 chunks all time carry a value.** 136 are from
25 Aug, 2 from 26 Aug, 2 from 9 Sep. **Zero on every clinic day since 10 Sep — 3,688 chunks.**

- Find where levels are computed and sent. **Both clients are in scope**: the browser kiosk
  (`lib/use-room-recorder.ts` and around it) and the native Room Recorder
  (`apps/room-recorder/…`, Swift). They cut audio differently, so they may differ here too.
- Find where the API stores them (`app/api/bench/chunks/route.ts` and its writer).
- **Pin the break as tightly as the evidence allows**: is the client no longer computing them, no
  longer sending them, or is the API no longer storing them? Git history between 26 Aug and 10 Sep is
  the obvious place; a schema change, a refactor, or a dropped field in a payload type are all
  candidates.
- Say whether restoring it is small or not, and name the files. **Do not fix it.**

## WHY THIS MATTERS — so the report is aimed right

A silence cue that carries "peak 0.0000 across the whole window" is a **dead-microphone alarm**. One
that carries "peak 0.31, no speech segments" is an **empty room**. Same cue, two very different clinical
meanings, and one number separates them. We currently record neither.

## ALLOWED

Read-only SQL. Reading source and git history at any commit. Reading files, checksums and logs on the
Mini. Read-only health probes. Scratch files under `docs/handoff/scratch/`.

## DO NOT

- Do **not** change code, config, models, flags, env vars, plists or room rows.
- Do **not** restart any service, whisper included.
- Do **not** download or replace any model file.
- Do **not** touch `lib/stt/room-drain.ts` (`scribe` is editing tests there) or `lib/emotion/`
  (`ETA-Refuter` is root-causing there).
- Do **not** listen to or quote audio, transcript text, speaker names or clinical content.
- Do **not** propose a rollout. Name the fix and its size; the decision is mine.

## VERIFY — PASS / FAIL / UNVERIFIED

- V1 You identified what `for-tests-silero-v6.2.0-ggml.bin` is, by evidence, not by its name.
- V2 You pinned whether the levels break is client-side or API-side. If you cannot, say which
  evidence would settle it.
- V3 You checked **both** recorder clients, not just one.
- V4 You changed nothing and restarted nothing.

## OUTPUT

`docs/handoff/ETA-E15-VAD-AND-LEVELS-14-SEP-2026.md`

1. Line 1: is the VAD model a test fixture — YES / NO / UNVERIFIED.
2. Line 2: where the levels break is — client, API, or UNVERIFIED.
3. The evidence for each.
4. The size of each fix and the files it would touch.
5. V1–V4, and anything you found that neither question covers.

**Cap: 90 lines.**

## KNOWN FACTS

- Whisper: launchd `uk.llmvinayminihome.whisper` (PID 1813) and `whisper-shim` (1816). 8080 serves
  `/health` and 404s `/healthz`; 8081 is the opposite. It answered 69 of 69 `POST /inference` with 200
  during tonight's run — **it is healthy and that is not in question.**
- Tonight's run: 25 drains, 21 windows with zero VAD speech segments, 4 with speech
  (13 seg/10.0 s, 10 seg/7.9 s, 1 seg/0.4 s, 2 seg/1.6 s).
- The only levels we have, 25 Aug, `room_2qe955hy`: median peak **0.0079**, max 0.5371.
- The Mini is tight on memory: 20% free of 24 GB, ollama at 9.6 GB. Do not start Docker.
- Neon string at `/Users/vinaybhardwaj/dev/Neon Database Connection String.rtf` — read, use, never print.
