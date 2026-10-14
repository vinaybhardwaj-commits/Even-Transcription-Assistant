# Shim design: deterministic whisper, one-shot re-decode of looped segments, config stamp (minibot, 24 Sep 07:30, design only)

## Facts checked in whisper.cpp e0fd1f67 (the Mini's build), examples/server/server.cpp
- F1. `--no-fallback` is a NO-OP in whisper-server. It is parsed (l.228), but `no_fallback` is never read again; l.949 copies `temperature_inc` straight into the decode params. There is no CLI flag for `temperature_inc`. Fallback is controlled only by the per-request form field `temperature_inc` (default 0.2; 0 = off). **So putting `--no-fallback` in the plist would silently change nothing.** The switch belongs in the request, which the shim already builds.
- F2. The response cannot tell you whether fallback fired. verbose_json `segment.temperature` echoes the REQUEST temperature (l.1121), not the one used, and `compression_ratio` is commented out (l.1125). Only `avg_logprob` and `no_speech_prob` are real. Any record that a re-decode happened has to be written by the shim itself.
- F3. The fallback being removed is itself a loop defence: it re-samples when entropy < 2.4, which is a repetition signal. With it off, the shim's detector is the only one left, and on the Mini the router skips its own collapse when it sees `shim_collapse`.

## A. Deterministic default + re-decode only the looped segment, once
1. Flag `SHIM_DETERMINISTIC` (unset = off, byte-identical to today). When on, the shim sets `temperature=0`, `temperature_inc=0`, `response_format=verbose_json` on every forwarded request. It keeps all other caller fields.
2. Detect per segment, using the detectors that already exist: (a) `_collapse_phrase_loops(text) != text` (a word or phrase repeated 3 or more times), or (b) the segment is the start of a run of consecutive identical segments. Number repeats are already exempt, so a dose read three times is never re-decoded.
3. Re-decode: cut the shim's own 16 kHz WAV at [start - 0.5 s, end + 0.5 s] with ffmpeg (already a dependency), then POST it with the same fields except `temperature_inc=0.2` and no `prompt`. A prompt risks re-seeding the loop.
4. Accept the re-decoded text only if it is non-empty and neither detector fires on it. On accept, replace that segment's `text` and keep the original `start`/`end`. Otherwise keep today's collapsed text. Exactly once per segment, with no recursion.
5. Budgets (env, with defaults): at most 3 re-decodes per request and at most 60 s of re-decoded audio; skip slices under 1 s. whisper-server is serial, so each re-decode delays the queue. Log a `budget_exhausted` event rather than silently skipping.
6. Known cost: the slice is decoded without the preceding text, so words at its edges can come out worse. It is used only where the output is already broken, and step 4 keeps the old text if the re-decode is no better.

## Logging (no transcript text in any log; shim logs are not a PHI store)
- Response JSON: `shim_redecode: [{seg, start, end, reason: "phrase_loop"|"dup_run", accepted, ms, config_hash}]` and `shim_redecode_count`. It is present, as `[]`, whenever the flag is on.
- stderr: one JSON line per attempt with the same fields, plus character lengths (before / collapsed / re-decoded) and `sha256[:12]` of each text, never the text itself.

## B. Config stamp on every transcript
- Static part, computed at shim start and again whenever the pid listening on WHISPER_PORT changes (check at most every 60 s): the running process's argv (macOS: `lsof -tiTCP:$PORT -sTCP:LISTEN` then `ps -o args=`; Linux: `/proc/<pid>/cmdline`), the sha256 of the whisper-server binary at argv[0], the sha256 of the `-m` model (cached by path+size+mtime; hashing 1.6 GB takes about 5-8 s, so it runs in a background thread), the shim's git sha, and the sha256 of `eta_number_words.json`.
- Binary and model hashes, not a commit string, because they describe what is actually running; lab-mover's box, CUDA and CPU builds will hash differently, which is the point.
- Request part: the effective decode fields after the shim's injection: temperature, temperature_inc, beam_size, best_of, language, max_context, response_format.
- Stamp: `whisper_config: {hash, status, static:{...}, request:{...}}`, where `hash = sha256(canonical sorted-key JSON of static+request)[:16]`. ETA stores `whisper_config.hash` on the stt run, which makes parity and regression questions a single join. Re-decoded segments carry their own `config_hash` (temperature_inc differs), so a mixed transcript is visible as mixed.
- Honesty rule: if argv or the model cannot be read, set `status:"unverified"` with the reason, and while hashing, `status:"pending"`. Never guess a hash.

## Rollout
Tests, flag off: output byte-identical to today. Flag on: a known-loop fixture is re-decoded once and logged; a dose-repeat fixture is not re-decoded; the budget caps hold; no text reaches stderr. Ship with the flag off. Enable it on the Mini only in a quiet window (ruling 15), and on the twins first.
