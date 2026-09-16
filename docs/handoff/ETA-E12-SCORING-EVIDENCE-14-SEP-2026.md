**All 13 share one reason, verbatim: `malformed_scores`.** The 30 new failures from a retry that ran while I worked have the same reason (V4). All-time: 43 of 43 failed rows.

# ETA-E12 — segment-scoring evidence · 14 Sep 2026 · Researcher (Builder pane)
Evidence only: no diagnosis, no fix, nothing changed. Raw material, all queries run inside `BEGIN READ ONLY … ROLLBACK`:
- `scratch/E12-QUERIES-AND-OUTPUT-14-SEP-2026.txt` (every SQL statement and its output);
- `scratch/E12-SERVICE-LOG-14-SEP-2026.txt` (redacted service log excerpt and health probe).

Source read at `fe021a3`.

## Fact 1 — why each of the 13 failed
- **Reason:** `room_span_emotion.state='failed'`, `reason='malformed_scores'` on all 13: 11 on `…89100000`, 1 on `…81900000`, 1 on `…83700000`.
- **Window `error`:** `emotion_zero_scored` on `…81900000` and `…83700000`; NULL on `…89100000` (state `ok`).
- **`failure_history`:** `[]` on all three.
- **`timing_json` `wall_ms`:** 13,718 / 13,803 / 73,820.
- **`warmup_json`:** `{"ok": false, "inference_s": null, "loaded_before": false}` on all three.
- **What `malformed_scores` means in code** (`lib/emotion/client.ts:95-112`): it is written only when a result item arrived with `ok: true` but its `labels` were missing or a label was not a number in [0, 1], or `duration_s` / `inference_s` was not a number. An item with `ok ≠ true` would store the service's own error text instead (`client.ts:99`).
- **Stored fields on failed rows:** `duration_s`, `inference_s`, `labels_json` and all seven label columns are NULL, so segment lengths below come from `segment_end_ms − segment_start_ms`.

## Fact 2 — what distinguishes the 2 that scored (window `…89100000`)
- **Runs:** its 13 segments are **two runs, both `speaker_idx 0`**, from 2 `no_match` turns.
  - Run A: 290.7 s, split into **10 chunks of 29.07 s**.
  - Run B: 82.9 s, split into **3 chunks of 27.64 / 27.64 / 27.64 s**.
- **The 2 scored are the last chunk of each run:**
  - A chunk 9 of 10 (clip 267.49–296.56 s): `inference_s` 10.25, `neutral` 0.277.
  - B chunk 2 of 3 (clip 771.41–799.05 s): `inference_s` 0.71, `happiness` 0.257.
- **The 11 failed** are every earlier chunk of those same two runs: same speaker, same lengths, one call.
- **Write order:** rows written 20:15:42.080–43.031 in chunk order.

## Fact 3 — the single-segment windows
- **`…81900000`:** 1 turn → 1 run → 1 segment of **0.50 s**, speaker 0, chunk 0 of 1, `malformed_scores`.
- **`…83700000`:** 1 turn → 1 segment of **0.38 s**, speaker 0, chunk 0 of 1, `malformed_scores`.
- **Same recorded reason as the 11**, but on segments about 60 times shorter (0.38–0.50 s against 27.6–29.1 s). Whether it is the same underlying failure is **UNVERIFIED**.
- **Attempts burned:** both have `attempts` 1, state `failed`. `finish` sets `emotion_zero_scored` when planned > 0 and no row scored (`lib/jobs/kinds/emotion-window.ts:189-202`, `lib/emotion/store.ts:231-240`).

## Fact 4 — the 54-vs-166 numbers: **not a contradiction; verified**
- **`segments_planned`** is the plan: `planSegments` over **non-straddle** runs (`emotion-window.ts:117-120,195`; `store.ts:81-86` says `planned` "is the plan … not a row count").
- **`segments_skipped`** is counted from rows: one per **straddle turn**, written in `prepare` before warm-up (`emotion-window.ts:126`).
- **`bw_z3gpbh6e`'s turns** (`room_turn_speaker`, its diarize run): 317 = **166 `straddle` + 151 `no_match`**.
- **Recomputed** with the planner's rules (2 s merge gap, target min(cap−1, 30) s) from the `cue` turn bounds: 151 → **54 runs → 54 planned**, and **166 skipped**, an exact match. All four other windows recompute exactly too.
- **Not an artefact of the auth failure:** attempt 2 (V4) wrote the same 54 / 166.

## Fact 5 — what the service said (logs carry no timestamps; order and counts only)
`uk.llmvinayminihome.emotion`, PID 85074. `server.out.log` from its last restart:
- **Startup:** `available_ram_mb≈2320.7 (threshold 3500.0)` · `wavlm deferred (lazy load on first request)` · `emotion2vec deferred …` · `default_model=wavlm`.
- **Segments calls:** **11** × `POST /inference/wavlm/segments` → **200**. That equals the recorded `calls` 2 + 2 + 2 + 5. The one `401 Unauthorized` is before the restart marker.
- **Model load:** `loading wavlm Aniemore/wavlm-emotion-v1-crosslingual subfolder='int8' on mps ...` then `wavlm ready in 9.2s`. It appears **once**, between the 1st and 2nd POST of the third job.
- **Per-segment lines since restart: 0.** No `[emotion] unscorable …` line, no error line.

`server.err.log` since PID 85074 started: **0 tracebacks**, 5 × `UserWarning: Support for mismatched key_padding_mask and attn_mask is deprecated`.

`GET 127.0.0.1:8086/health` (my one read-only probe, ~20:26): `ok true, loaded true, device mps, max_duration_s 60.0, min_speech_s 1.5, silence_rms 0.008`, `wavlm` subfolder `int8`.

Also: `~/eta-emotion/app.py` was modified today at 11:46 (backup `app.py.bak-vad-20260914114433`).

Matching log lines to jobs is by order and call count only: **UNVERIFIED**.

## Fact 6 — the cap
No scored or failed segment exceeds 60 s (`over_cap` 0).
- **Longest failed:** 29.07 s (`…89100000`); 13.09 s in V4's retry.
- **Longest scored:** 29.07 s; 26.72 s in V4.
- **Cap everywhere:** `cap_s` 60 on every row, planning target 30 s.

## V1–V4
- **V1 PASS.** Every number is from a query or log line in the two scratch files, or from source at `fe021a3`.
- **V2 PASS.** Fact 5 reports log lines and health fields as written; conclusions sit only in Facts 1–4, 6 and the hypotheses.
- **V3 PASS.** No code, env, flag, plist or row changed; no restart; no job submitted, retried or cancelled. The retry below was run by the cron. One read-only `/health` probe and read-only DB polls.
- **V4 PASS — jobs that completed while I worked, separate from the kickoff's four:**
  - **`bw_6jwz5r79_1789290000000`** (20:20:18): `no_segments`. 1 turn, `straddle`, 623.9 s → 0 planned, 1 skipped, 0 calls.
  - **`bw_z3gpbh6e_1787556600000` attempt 2** (rows 20:25:18–20:27:01, window row 20:27:32): **`ok`, planned 54, scored 24, failed 30 (all `malformed_scores`), skipped 166**, 5 calls. `warmup_json` `ok:false, loaded_before:true`. `failure_history` now holds attempt 1 (`…unauthorised`).
  - **By length on that retry:**
    - **failed:** 12 under 1.5 s, 11 at 1.5–3 s, 5 at 3–10 s, 2 at ≥ 10 s; median 1.85 s.
    - **scored:** 0 under 1.5 s, 2 at 1.5–3 s, 16 at 3–10 s, 6 at ≥ 10 s; median 5.46 s.
    - **speakers:** failed rows span 3, scored rows 2.
  - **All-time now:** spans 26 scored, 43 failed, 167 skipped. Windows 2 `ok`, 2 `failed`, 1 `no_segments`.

## Hypotheses, unverified
- The service may return `ok:true` without labels for audio it judges unscorable. `/health` now exposes `min_speech_s 1.5` and `silence_rms 0.008`, most failures are short, and every 1 s warm-up reports `ok:false`. But 11 failures were 29 s chunks, and that is not explained.
