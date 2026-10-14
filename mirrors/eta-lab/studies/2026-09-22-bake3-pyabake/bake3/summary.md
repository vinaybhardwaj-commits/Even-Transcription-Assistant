# ETA 3-Arm Transcription/Diarization Bake-off — Summary

Run date: 2026-09-22. 20 real clinic-room bench windows (canonical span 900s / 15min each).
Arms: **A** WhisperAI (transcription) + pyannote.ai precision-3 (diarization) | **B** current Mac Mini production (read-only) | **C** pyannote.ai diarization + Arm B's existing transcripts (hybrid).

No transcript text is included anywhere in this report per instruction.

## WhisperAI direct-API question
**Answer: NO.** No REST endpoint, API key, or SDK was found anywhere in the WhisperAI MCP tool surface or `get_account` metadata. WhisperAI is usable only through this MCP integration (`transcribe_url`/`start_upload` + `get_transcript` polling), not as a direct call from ETA's Vercel backend.

## Models used
- Transcription (hosted): WhisperAI, auto-detect language, default preset.
- Diarization (hosted): pyannote.ai `precision-3`.
- Local (unchanged, Arm B/C): Mini's existing multi-engine ASR (whisper, sravaani, indicconformer) + local diarization.

## Per-arm summary

| Metric | Value |
|---|---|
| WhisperAI (Arm A) quality tally | 11/20 clean, 6/20 hallucination/garble, 3/20 hard failure (45% problem rate) |
| Hallucination pattern | Clusters on Kannada/Tamil/Telugu-majority or near-silent ("thin") windows; clean output clusters on English/Hindi |
| Indic native-script share of local pipeline | 39.7% of spans (en 60.3%); 15/20 windows have substantial (>=3 spans) non-English content |
| Diarization frame agreement (local vs pyannote) | median 0.62, mean 0.66 (n=16 computable / 20) |
| Speaker-count agreement | 20% exact match, 55% within +/-1, mean abs diff 2.4 |
| Doctor-ID hits | 0/20 — blocked: no retrievable enrolled voiceprint to test against (not a pyannote failure) |
| p50 latency | pyannote diarization 20.2s/window; Arm B local ASR 161.4s/window (range 12.2-635.8s); WhisperAI not logged per-window, bounded by 5 calls/min ingest limit |
| $/h | pyannote diarization EUR0.112/h (EUR0.028/canonical window; EUR1.12 actual bake-off cost at 30min/window over-fetch, EUR0.56 projected canonical total); pyannote identify EUR0.096/h not incurred (no voiceprint); WhisperAI cost not exposed via MCP (flat unlimited-minutes plan) |

## Methodology limitations (blocked/reported, per "continue" instruction)
- WhisperAI tested on ~300s sample vs full 900s window — CER/WER via jiwer judged not meaningful; replaced with qualitative hallucination flags.
- pyannote run on 30-min over-fetch, not canonical 15-min span — cost figures given both ways.
- doc-ID check unsatisfiable with available data (all 20 windows).
- WhisperAI 5 calls/min rate limit; 3/20 windows hard-failed at ingestion.

## 5 windows with largest disagreement (timestamps only, IST)
1. `bw_yce79u6r_1789999200000` — 2026-09-21 19:30-19:45 — lowest frame agreement (0.36); also worst WhisperAI garble.
2. `bw_d4t5tvg9_1789986600000` — 2026-09-21 16:00-16:15 — 2nd-lowest frame agreement (0.48); Kannada-heavy, largest speaker-count spread.
3. `bw_maaacrdh_1790058600000` — 2026-09-22 12:00-12:15 — extreme speaker-count mismatch (local=1 vs pyannote=9); near-silent; WhisperAI hallucination.
4. `bw_zyjykmwa_1790057700000` — 2026-09-22 11:45-12:00 — severe WhisperAI hallucination on Kannada-majority content despite OK diarization agreement.
5. `bw_m6nq7upz_1790057700000` — 2026-09-22 11:45-12:00 — WhisperAI hallucination; frame agreement not computable (coverage gap).

## Recommendation: HYBRID (Arm C) for diarization; keep local ASR; do not switch transcription to WhisperAI
- pyannote diarization is cheap, fast, and resolves speaker counts better than local in several cases, but ~62% median frame agreement means it's a diarization upgrade, not a doc-ID fix (doc-ID stays blocked pending voiceprint enrollment).
- WhisperAI's 45% problem rate concentrates on Kannada/Tamil/Telugu content, ~40% of ETA's real language mix — switching primary transcription would regress quality on nearly half the caseload.
- WhisperAI has no direct API, so adopting it keeps ETA dependent on this MCP/agent layer rather than a first-party backend call.
- Net: move diarization to pyannote.ai (Arm C); keep the Mini's local multi-engine ASR; revisit WhisperAI if Indic accuracy improves and a real programmatic API appears.

See `results.json` (same directory) for full machine-readable detail.
