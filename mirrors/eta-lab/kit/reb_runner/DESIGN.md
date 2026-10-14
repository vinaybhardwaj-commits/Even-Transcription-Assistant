# REB step 3 — RUNNER design (reb, 27 Sep 2026)

W47 build order step 3: "fan-out worker that claims (window, layer, engine) tasks from a shared
queue... claim-once, works across box, c3 and HF Spaces; lease + retry; nothing lost if a worker
dies." This doc records the decisions made while building the first working piece (box-local whisper)
so the same shape extends cleanly to the other engines/machines.

## Decided

1. **Fan out by window, not engines-per-window** (Fable 15:22). A claim covers one WHOLE window for a
   given queue (e.g. `box-whisper` claiming window W means "run all 3 whisper passes for W"), not one
   claim per (window, engine). Run several instances of a driver to parallelize across windows;
   claim-once keeps them from duplicating work. This also keeps `manifest.lock` contention low (the
   wrangler-lock finding, bus #4669): a window's writes mostly come from ONE worker at a time per
   queue, not many workers hammering it simultaneously.
2. **The box is the SOLE process that calls `write_track()`** (settled reconciling hf-fleet's GPU
   smoke test, bus #4654/#4675). Remote workers (c3, HF Jobs) compute an engine's output and hand back
   a result; only box-side code ever mutates a window's `manifest.json`. This matches hist-bulk's
   existing `node_route.py` pattern (a node computes and returns, never manages the shared store) and
   avoids needing a distributed lock across machines — for now, `run_box_whisper.py` runs the whole
   thing (compute + write) in one process since whisper IS box-local; a c3/HF variant will split
   "compute on that machine" from "write on box" once built (see Not built yet).
3. **Claim-once queue** (`task_queue.py`): O_EXCL claim files + an append-only `state.jsonl`, reusing
   hist-bulk's proven shape (`studies/2026-09-24-hist-bulk/runner.py`), plus a lease timeout hist-bulk
   didn't need (the order explicitly asked for "lease + retry; nothing lost if a worker dies" —
   hist-bulk's claims persist until a person resets them between epochs; REB's don't need a person).
   A claim past its lease is atomically stealable (guarded by a per-claim `.lock` so two stealers can't
   both think they won, and by a per-claim token so a stale worker can never touch a claim it no longer
   holds — see the fencing fix from eta-refuter-2/3's review, git log). `release()` lets a worker give
   up a claim early for immediate retry after a clean failure, without waiting out the lease.
   `is_done()` means "was 'done' EVER logged for this (queue_name, window_id)" — **this means a
   deliberate re-run of an already-done window needs a NEW `queue_name`, not just re-calling `claim()`
   on the same one** (eta-refuter-2, post-PASS note #4852). There's no "force re-run in place" API by
   design: append-only tracks already handle a genuine re-run at the `write_track()` level (a changed
   config gets a new file); the queue's job is only "has this exact unit of work ever finished," and
   conflating that with "let me redo it anyway" would reopen the fencing hole the token exists to close.
4. **Whisper writer + LID convention** (`engines/whisper.py`), adopting lid-debug's #4735 proposal as
   final: whisper.cpp's language-ID only scores the first 30s of whatever it's given, so the writer
   chunks each window at <=30s and calls whisper once per chunk (not once per window) — this is
   REQUIRED for LID coverage across a window, and means 3 whisper variants no longer match the sizing
   report's single-whole-file-call RTF numbers exactly (the runner makes more, shorter calls); expect
   this writer's real throughput to be measured separately once it's run at volume. Every segment
   carries `extras.lid = {detected, p, probs, scored_ms}`; track `config` records
   `language/response_format/temperature/temperature_inc` (+ `prompt`/`prompt_source` for the cap2
   variant, which still uses the sizing pass's placeholder vocabulary — no real CAP-2 asset exists yet).
5. **A track-status visibility bug was found and fixed while building this** (router-fix/lid-debug
   #4751/#4752): `Window.tracks(latest_ok=True)` used to silently drop an engine that had only ever
   failed. Now: latest-ok is the evidence, a later failure is attached as `.superseded_by` rather than
   hiding the good run, and a never-succeeded engine's failure is visible instead of indistinguishable
   from "never run." Branch `reb/tracks-status-visibility`, refuter-2 review pending as of this commit.

## Engine placement (current, supersedes the sizing report's original CPU-bound plan)

| layer | engine(s) | machine | evidence |
|---|---|---|---|
| stt | whisper (auto/forced-en/cap2) | box T4 | sizing report; `run_box_whisper.py` built |
| stt | IndicConformer (5 heads) + SraVaani | **HF L4 GPU Job, together** | hf-fleet real validation: 18.7x RTF, $0.0427/tape-hour (bus #4731) — moved SraVaani off c3 onto the SAME HF job as IndicConformer, since that's now the proven cheap combined path; not built yet |
| diar | pyannote.ai (hosted API) | none (API-bound, not machine-bound) | Fable's ruling (bus #4535 addendum); not built yet, needs `run_real.sh` for the real per-window calls (real patient audio to a paid external vendor) |
| diar | local pyannote twin + Nemotron (optional shadow) | HF GPU, never box | Fable's ruling; not built yet |
| emotion | wavlm crosslingual, per speaker turn (whole-window fallback if no diar track) | HF L4 GPU Job | Fable's T-REB order (28 Sep); built — `engines/emotion_wavlm.py` + `hf_emotion_manifest.py`/`hf_emotion_job.py`/`hf_emotion_collect.py`, following point 2's box-writes/HF-computes split; not yet run against real audio, awaiting hf-fleet coordination on the audio staging path |
| acoustics | production vad_segments, reference VAD, frame stats | cheap, any CPU | sized (Silero ~53x on box CPU); not built yet |
| terms | medasr / parakeet-med / whisper-arca-lora | **unsized, unplaced** | Fable FYI 14:38 (W50): layer went live scope; no RTF numbers exist yet for any of these 3 engines — needs its own sizing pass before it can be placed here |
| translate | Gemini 3.8 Flash (text->EN, audio->EN) | OpenRouter, ZDR | not sized, not built; needs `run_real.sh` when exercised |

## Not built yet (in rough priority order)

1. c3 dispatch (ssh-based, matching hist-bulk's node-transport abstraction) for whichever engines end
   up there — currently nothing is assigned to c3 (SraVaani moved to the HF combined job).
2. HF Jobs dispatch for IndicConformer+SraVaani (adapt hf-fleet's `run_reb_gpu_smoke.py` minus its
   manifest-writing half — it should return/upload just its own track files; box pulls and writes them).
3. The pyannote.ai hosted-API diar writer (needs `run_real.sh`).
4. The optional shadow diar/emotion writers on HF once hf-3..7 resume (currently paused).
5. A window catalog / enumeration step (step 4's job, not step 3's) that produces the
   `{window_id, ist_date, room_id, wav_path, manifest_stub}` descriptors `run_box_whisper.py` expects.
6. terms layer sizing (3 unmeasured engines) before it can be placed anywhere.
7. Re-measure whisper's real per-window throughput under the <=30s-chunked calling convention (the
   sizing report's whisper RTF numbers were single-whole-file calls, not chunked).
8. `task_queue.renew()` (heartbeat) exists but nothing calls it yet. Measure a real multi-pass window's
   wall time against the 30-min default lease before assuming it's fine at step-3 scale (eta-refuter-2,
   post-PASS note) — wire renew() in only if that measurement shows a real risk, not preemptively.
9. `MirrorPendingError`s are recorded on the `done` state line (`mirror_pending=[...]`) but nothing
   sweeps them for a retry yet (eta-refuter-3, post-PASS note: "name who sweeps it"). Needs an owner
   once `REB_R2_MIRROR` is actually turned on for real traffic.

## Files

`kit/reb_runner/{task_queue.py, engines/whisper.py, run_box_whisper.py}` + `tests/*` — 26/26 tests
across kit/reb + kit/reb_runner, all offline except one manual real-whisper-server smoke check during
development (not part of the committed suite). PASSED by both eta-refuter-2 and eta-refuter-3
(independent reviews, both probed the fixes rather than just re-running the test files).

`kit/reb_runner/{engines/emotion_wavlm.py, hf_emotion_manifest.py, hf_emotion_job.py,
hf_emotion_collect.py}` + `tests/test_emotion_engine.py`/`test_hf_emotion_manifest.py` (tone, 28 Sep,
Fable's T-REB order) — emotion layer, wavlm crosslingual per speaker turn. Same box/HF split as
whisper (point 2): `hf_emotion_manifest.py` (box-side, reads the local REB root only) picks the
windows + turns; `hf_emotion_job.py` (HF-side, no REB root access) computes and hands back track
bodies against audio hf-fleet/reb stage there; `hf_emotion_collect.py` (box-side) is the only one of
the three that calls `write_track()`. 11/11 tests offline (model + audio slicing faked); not yet run
against real audio — the manifest/job pair is queued for review before a real HF run.
