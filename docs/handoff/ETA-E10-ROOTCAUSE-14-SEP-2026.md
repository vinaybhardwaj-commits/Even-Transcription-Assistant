# ETA-E10 — root cause of the two breaks · 14 Sep 2026 · Builder (Debugger brief)
Source at `fe021a3` (`lib`, `app` and `vercel.json` are identical to HEAD). Evidence is the Mini's own logs plus one read-only probe. **Both of my read-only Neon queries were denied by this session's permission layer** ("Production Reads"). I did not retry or work around that, so Break 2 stops at a named decision tree (§2). Nothing changed.

## 1. Break 1 — `whisper_unavailable` is a silent room, mislabelled as an outage
**Cause.** Whisper answered all 25 drains. It found **no speech** in 21 windows and returned HTTP 200 with an empty `text`:
- `lib/whisper.ts:323-325` turns a 200 with no text into `{ ok: false, error: "empty_transcript" }`, and it is not retryable (`:185-190`).
- `roomWindowSegment` (`lib/stt/room-drain.ts:737-744`) treats **every** `!full.ok` as `whisper_unavailable`, calls `recordFailure`, and the job fails `room_window_failed: whisper_unavailable`.
- So "the room was quiet" and "Whisper is down" wear one name. The underlying string, `whisper_unavailable: empty_transcript`, is written to `stt_subject_job.last_error` (`room-drain.ts:401`). I could not read it: denied.

This is the **K5 rule, missing on the third path.** The sync tool (`lib/mcp/tools/bench.ts:1786-1795`) and `transcribe-range` (`lib/jobs/kinds/transcribe-range.ts:205-224`, "A QUIET ROOM IS NOT A FAILED READ") both short-circuit `EMPTY_TRANSCRIPT` to success. The `room_window` job path, built in C1b, did not inherit it. `room-drain.ts:534` names this defect class itself: "the sync path handled a case the job path had dropped."

**Evidence** (raw in `scratch/E10-*-14-SEP-2026.*`):
1. **The tunnel reaches the shim, and the shim answered every call.** `/etc/cloudflared/config.yml` maps `whisper.llmvinayminihome.uk → localhost:8081`. The shim log for 16:00–19:59 has **69 `POST /inference`, all HTTP 200**, with no 5xx, timeout or 4xx on `/inference`. The only 404s are one `GET /inference` and one `GET /health` (16:19, 19:04), neither from the drain.
2. **The drain's rhythm is visible.** From 16:55 there is one pair every 5 minutes (the `*/5` tick), 4–5 s apart: the 30 s language probe, then the full window. A 900 s window returning ~4 s after its probe means Whisper had nothing to decode. The two slow pairs, 18:20:57→18:21:37 and 18:35:47→18:36:14, are windows with speech.
3. **Whisper's VAD says so directly.** whisper-server runs `--vad --no-speech-thold 0.7 --suppress-nst` (launchd plist). Its stderr gives each request's audio length and VAD speech-segment count. From the first full-window call of the run: **27 full-window calls (894–900 s): 23 with 0 speech segments, 4 with speech** (13 seg/10.0 s, 10 seg/7.9 s, 1 seg/0.4 s, 2 seg/1.6 s). Two of the zeros are the ticks at 18:55:53 and 19:00:55, **after** E9's 18:53 end (§4.1). **Inside the run: 25 calls, 21 silent, 4 with speech — E9's 21 failed / 4 done exactly.**
4. **Direct probe, read-only**, through the shim with the client's exact form fields. 8 s of silence: **HTTP 200, text length 0, 0 segments.** Control, whisper.cpp's public `jfk.wav`: HTTP 200, 109 characters, 2 segments. That is the bytes `whisper.ts:323` maps to `empty_transcript`.

**Why 4 and not 25 (V2).** The cause is per window, from the audio, not from weather:
- A window with speech succeeds; a window without fails. Silence is deterministic, so a silent window fails every time.
- A failed attempt sends the window back to `closed` (`room-drain.ts:414`). Newest-first auto-drain picks **the same window** again on the next tick.
- So **21 = 7 windows × `DRAIN_MAX_ATTEMPTS` 3**, which matches the 7 new `failed` windows holding a clip. The VAD sequence has that shape: the zeros come in runs of three, starting with three consecutive 894 s calls.
- A tunnel or concurrency cause would scatter failures across windows and would show non-200s at the shim. There are none.
- The same fact explains why **no refusal was ever recorded**: `drainRoomWindow` returned `enqueued` each time and the job failed later, after the cooldown's write.

**The brief's three leads, each by evidence.**
- (1) Probe path: **not it.** The drain never calls a health endpoint. `whisper_unavailable` comes from the `/inference` result, and every `/inference` got 200.
- (2) Concurrency: **not it.** No refusals and no 5xx at the shim, and failures follow audio content, not the timing of the six diarize jobs (diarize runs on 8001, not Whisper).
- (3) Tunnel: **not it.** Every drain call reached the shim and was answered.

**Minimal fix (named, not built).** At `room-drain.ts:737`, before `recordFailure`, branch on exactly `full.error === EMPTY_TRANSCRIPT`. Finish the window as the K5 silent outcome that `bench.ts:1786-1795` already defines:
- one `stt_silence` cue, a complete marker with `segment_count` 0, zero turns, window `transcribed`;
- **no routed-engine call and no attempt consumed**;
- every other error (`http_*`, `timeout_*`, `network:`) stays `whisper_unavailable`.

The 7 parked windows then need a manual re-drain. Their `stt_subject_job` rows are at `attempts`=3 / `failed`, so whether `drainRoomWindow` accepts `failed` needs checking first.

**Cost of getting it wrong.**
- (a) **Continue a silent window into the engine step instead of finishing it:** each silent 900 s window goes to route (≈200 s of Mini time for nothing) or to Sarvam, **the one paid engine**, and then to diarize and emotion. The measured share is 21 of 25 windows.
- (b) **Finish it with no `stt_silence` cue:** the day view cannot tell "nothing said" from "never looked at", the exact distinction K5 exists for.
- (c) **Make `empty_transcript` retryable, or catch every `!ok`:** the first doubles Whisper calls for the same answer; the second hides a real outage behind "silent".
- (d) **Fix it at Whisper by dropping `--vad`:** brings back the loop/hallucination-on-silence problem M4–M7 measured.

## 2. Break 2 — emotion never enqueued: the source has no gate; the runtime cause is narrowed, not proven
**Every condition between a diarize row and an enqueued job (V3):**
1. **Cron.** `vercel.json` has `/api/admin/emotion-windows` at `*/5`.
2. **Auth.** GET needs `Bearer CRON_SECRET` or `Bearer MIGRATION_SECRET` (`app/api/admin/emotion-windows/route.ts:40-45`). Identical to `drain-windows` and `diarize-windows`, which both fired, so auth is not the difference.
3. **Flag.** `emotionEnabled()` → `parseFlag("EMOTION_ENABLED")`: `"1"` is truthy (`lib/flags.ts:12`); unset or falsy returns `enabled:false` with HTTP 200 (`enqueue.ts:31-34`); an unrecognised value throws.
4. **Secret.** `EMOTION_SEGMENTS_SECRET` must be non-blank (`lib/emotion/client.ts:35-36`), or it **throws** `EMOTION_ENABLED is on but EMOTION_SEGMENTS_SECRET is not set` (`enqueue.ts:38`). The route returns `PIPELINE_FAILED` (`route.ts:36`) and writes no row.
5. **Exhausted count** (`:40-44`): a read only, it gates nothing.
6. **Busy.** Any `emotion_window` job `queued`/`running` skips the tick (`:46-51`). There are none.
7. **Scan** (`:53-66`): `d.state='ok'`, `d.last_run_id IS NOT NULL`, **`w.clip_r2_key IS NOT NULL` on `bench_window`** (not the diarize row's copy), and no emotion row / older run / failed with attempts < 3. `LIMIT 1`.
8. **Submit.** `emotion_window` is registered (`lib/jobs/kinds/index.ts:20`), scope `invoke` is passed (`enqueue.ts:76`), `parseArgs` needs only `window_id`, then `insertJob`.

No attempt bound, age bound or consent gate exists in this path. The consent memo's gate is not in code at `fe021a3`.

**Narrowed.** Only three conditions yield "no job and no failure row": the cron not invoking, (3) the flag not live, or (4) the secret missing. Evidence points to (4), but the proof is on Vercel, which I cannot read:
- The C3 memo made setting `EMOTION_SEGMENTS_SECRET` in Vercel a **manual step for V** (`ETA-C3-OPEN-ITEMS-MEMO-13-SEP-2026.md:83-86`) and predicted exactly this: "the enqueue refuses loudly once `EMOTION_ENABLED` is on".
- Nothing on the bus records the step being done.
- The carryover's "rotate `EMOTION_SEGMENTS_SECRET`" item does not show it was ever in Vercel either.

**Decisive check for whoever holds Vercel.** Runtime logs for `/api/admin/emotion-windows`, 16:40–18:53 IST, read the first line that matches:
- `PIPELINE_FAILED … EMOTION_SEGMENTS_SECRET is not set` → **(4)**.
- `[emotion] EMOTION_ENABLED is off` → **(3)**.
- no invocations at all → cron not registered.
- `[emotion] enqueued 0` → the scan: rerun it on Neon, checking `bench_window.clip_r2_key` for the 5 rows.

**Minimal fix.**
- (4): V sets `EMOTION_SEGMENTS_SECRET` for Production to the Mini's current value (rotated first, per the carryover), then redeploys. No code.
- (3): redeploy with the variable scoped to Production.

**Cost of getting it wrong.**
- **Set a secret that differs from the Mini's:** enqueue passes and every job then fails at scoring with a 401 → `emotion_refused`, burning 3 attempts per window.
- **Set it on Preview only:** nothing changes.
- **Separately, no DB trace:** a cron that answers non-2xx every tick leaves no row anywhere, which is why this was invisible for two hours. A persisted enqueue-refusal record would have shown it on the first tick. That is a design call, not this round's.

The brief's one manual `emotion_window` job would discriminate (3) from (4) — the job fails `emotion_disabled` or `emotion_not_configured` at `emotion-window.ts:88-89`. It needs a production write I have neither credentials nor permission for, so **I did not submit it.**

## 3. Verify
- **V1 PASS.** `room-drain.ts:743`, testing `transcribeWithWhisper(...).ok` on the full window. `whisper.ts:323-325` makes a 200 with empty text `ok:false`.
- **V2 PASS.** Per-window silence predicts 4 of 25, the 7×3 = 21 shape, and 200s at the shim. A cause that fails all 25 is ruled out by the 4 speech windows.
- **V3 PASS** on source (§2, all 8 conditions). The runtime cause of Break 2 is **UNVERIFIED**, pending the Vercel log line.
- **V4 PASS.** No code, flag, env, migration, `vercel.json`, room row, job or service touched. One read-only 8 s silence probe and one control to the shim. `git status` shows only untracked bus files.

## 4. Found, not explained by either break
1. **The drain ran past 18:53.** Two more probe+full pairs, at 18:55:53 and 19:00:55, both silent. A deployment rollover lag is likely. If they were attempts 1–2 on an 8th window, that window sits `closed` with 2 of 3 attempts used. Worth one query.
2. **The first failing window was 894 s, not 900.** A window only closes when its span is fully covered (`bench-window.ts:23-27`), yet the joined clip was 6 s short, three times. Unexplained.
3. **Why is `room_2qe955hy`'s newest backlog silent?** Unverified without Neon. A kiosk capturing an empty room (the K1 pattern) would do it. Mic levels on `bench_chunk` for the 7 windows would settle it, without text.
4. whisper-server loads its VAD from `models/for-tests-silero-v6.2.0-ggml.bin` (885,098 bytes). It detects speech correctly on the control. The "for-tests" name suggests a test fixture rather than the release model — identity not verified, not changed.

Subagents: none.
