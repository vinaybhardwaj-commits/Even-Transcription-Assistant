# STT-STACK-PARITY: lab and bulk transcription must use the PROVEN production stack (Fable, 24 Sep 11:50 IST)

V: the only stack proven on our OPD conversations is **OpenAI Whisper + IndicConformer + SraVaani** (the production "route" engine). Nothing mined, bulk-processed or labelled may use a reduced stack.

## Facts (Fable, verified 11:48)
- Production code: `lib/stt/adapters/route.ts` + `lib/stt/eta-router.ts` → `ETA_ROUTER_URL` (Mini router :8083, git 5e841f0, Gemini 3.8 Flash fuse; SraVaani backend `ETA_SRAVAANI_URL` on the **Yoga** :8085). `lib/stt/adapters/indicconformer.ts` → `INDICCONFORMER_BASE_URL` (Mini eta-indic :8082, git 643e4e1, rnnt decoding). Whisper → the shim :8081 → whisper.cpp large-v3-turbo.
- The twins (TWINS-STATUS.md) cover ONLY whisper-server + shim, diarize, emotion. **There is no twin of IndicConformer, SraVaani or the router.**
- So: (a) whisper-only lab transcripts are NOT the proven stack, and (b) daytime bulk jobs still call the Mini's IndicConformer and router, because there are no *_BULK_URLS for them.

## Orders
1. **lab-mover: twin the other three services, exactly as production runs them.**
   - Services: eta-indic (IndicConformer @643e4e1 + the same model files/checksums, rnnt), SraVaani (from the Yoga :8085, same model/revision), eta-router (@5e841f0, requirements PINNED from the Mini's `pip freeze`; same fuse model and fallback; the OpenRouter key via key file, never printed).
   - Placement: box (T4) and gcp-l4 first, and the new hist-gpu nodes when they are up. Router backends point at the twins, never at the Mini/Yoga.
   - Parity is scored WITHOUT loading the Mini in clinic hours: compare the twins' output with the STORED production outputs for ≥10 archived windows (per engine: text similarity, language tags, and the fused result).
     - Report pass/fail and the diffs.
     - A router-level mismatch caused by the fuse model's non-determinism is reported separately (run production twice on the same input, from stored data if it exists).
   - eta-refuter-2 refutes parity.
2. **scribe:**
   - (a) Before 12:30, confirm in code which services a BULK-routed job calls. If IndicConformer/router stay on the Mini, daytime bulk concurrency stays ≤3 (ruling 56's ≤6 is suspended) so live rooms are protected.
   - (b) Build `INDICCONFORMER_BULK_URLS` + `ETA_ROUTER_BULK_URLS` routing (same pattern as the service-pools a30186c: default off, served_by recorded). Refuter PASS → tonight's post-20:30 train.
3. **hist-miner / hist-bulk:**
   - NO transcription until the full-stack twins pass parity. When they transcribe, they run the PRODUCTION `lib/stt` code path (route engine) through a lab harness with env pointed at the twins. No hand-rolled whisper calls.
   - Until then: Metabase truth mapping, chunk inventory, encounter bounds, and the job queue.
4. **Surgery v3 at 16:00 is unaffected.** Its consults come from transcripts that production already made with the full stack (21–24 Sep). Historical items join the set only after parity passes.
5. The **conductor** puts "STT stack = Whisper + IndicConformer + SraVaani (route); no reduced stack for anything V will read or anything we measure" on the board as a standing rule.

## Addendum 11:58: the guards must travel with the stack (V asked)
Parity covers every guard below. Each is named in the parity report with the running version (sha256 of the file the running process loaded, NOT just the git head: check the process start time vs the file mtime).
1. **whisper-server decode guards:** `--no-speech-thold 0.7 --suppress-nst`, and `max_context=0` on every request. Already twinned byte-identical (TWINS-STATUS).
2. **whisper-shim anti-loop / hallucination collapse:** sticky-word + phrase-loop collapse, near-dup segment drop, and the 772-word number lexicon (so doses are never collapsed). Already twinned (shim @50fcc4e + eta_number_words.json; only the bind address differs).
3. **Router guards (NOT yet twinned):** `collapse_phrase_loops` and the **English hallucination guard** in router_server.py (it refuses Conformer/SraVaani Indic-script output on English-only audio: `refused_reason: english_hallucination_guard`). Also the shared `_call_backend` guard (D1/D2 pools) and any patch_router_guard*.py changes actually loaded into the running process. Twin the EXACT running code.
4. **App-side guards (lib/):** transcript-guard.ts (hallucination/ad blocklist, leading-noise strip, sanitizeEnglish/sanitizeOriginal), transcript-quality.ts (degenerate-loop unique-ratio), and the fuse-transcript.ts artifact removal. The hist harness MUST run these same functions from the production commit, not a reimplementation.
5. The recorder's capture-side echoCancellation was applied at recording time, so it is already in the audio. Nothing to reapply.

The parity test includes a hallucination set: ≥5 archived windows where production's guards fired (silence, English-only audio with Indic engines, loop cases). The twins must fire the same guards.
