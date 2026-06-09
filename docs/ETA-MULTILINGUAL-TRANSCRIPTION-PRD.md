# ETA — Multilingual Transcription & Multi-Engine Testbed PRD

**Status:** DRAFT for decision-locking · **Created:** 29 May 2026 · **Owner:** V
**Repo:** `vinaybhardwaj-commits/Even-Transcription-Assistant` @ `1a97ef6`
**Companion:** `ETA-CARRYOVER.md`, `ETA-V2-PRD.md` (this is a v1-line feature, not a v2 note-type item)

---

## 0. Resolution log (29 May 2026 — API probed live with the real key)

**Probe findings (all tested against the live Sarvam API + Mac Mini Whisper):**
- **Whisper is unusable for Indian languages.** On a real Kannada clip, Whisper `translate` hallucinated (*"I have to use the language."*) and `transcribe` produced romanized junk. → The English note **must** come from Sarvam, not Whisper.
- **Sarvam is excellent both ways** and **accepts our browser webm/opus directly** (HTTP 200, clean English) — no transcoding / no ffmpeg on Vercel needed.
- **Sync REST caps at 30 s of audio** (400 beyond). Longer audio → Batch API (async, up to 1 hr) — but we avoid batch (see below).
- **Live WebSocket can't be called from the browser**: auth is an `Api-Subscription-Key` **header** (browsers can't set WS headers), it needs **PCM/WAV** frames (not webm), and there is **no ephemeral-token mechanism**. Vercel can't host a WS relay either. A Cloudflare Worker *could* relay — but we chose a simpler path.

**Final locked approach:**
- **English encounters: unchanged.** Deepgram stays the live engine; Sarvam never touches an English encounter.
- **Live native-script panel (non-English): NEAR-LIVE ROLLING REST.** During recording, a rolling process sends the recent ≤30 s audio window to Sarvam REST (`transcribe`) from the Vercel server every few seconds; the live panel switches to it when Deepgram is silent / a non-English `language_code` comes back. ~3–8 s lag, NOT word-by-word. **No WebSocket, no relay, no new infrastructure, key stays server-side.** (True streaming via a Cloudflare Worker relay is a possible later upgrade.)
- **English note (non-English): submit-time.** The accumulated original-language transcript → English via Sarvam (`translate`), then into note-gen + CDMSS + email. Original-language transcript preserved (D4).
- **Ships together** (MT.0 + MT.1 + MT.2), all from Vercel.
- **D8 (ephemeral token) is SUPERSEDED** — infeasible; replaced by server-side rolling REST (no browser auth needed at all).

---

## 1. Why this exists

V tested a real **Kannada** patient encounter on the live tool. The live transcript stayed blank and the final note came out in **Kannada**. Investigation showed the v1 pipeline is **English-only by construction** — there is no language handling or translation anywhere.

Two product goals come out of that:

1. **Live transcription must show the original Indian-language script** (Kannada, Hindi, any Indian language) as the patient/clinician speaks — the words forming on screen in their own script.
2. **The final note (and CDMSS + referral email) must be in English** — an English translation saved alongside the preserved original-language transcript.

And one platform goal V set explicitly:

3. **This is a test-bed.** Keep Deepgram and Whisper, add new engines, and be able to **compare and contrast** every ASR engine/API side by side on the same audio.

---

## 2. Current state (grounded in code, 29 May 2026)

| Component | File | Reality |
|---|---|---|
| Live engine | `lib/use-deepgram-live.ts` | Hard-wired `model: nova-3-medical`, `language: en-IN`. **English-only.** Deepgram does NOT support Kannada (confirmed; it covers Hindi/Tamil/Telugu/Bengali/Marathi/Gujarati). For Kannada it returns ~nothing → blank live panel. |
| Batch ASR | `lib/whisper.ts` | whisper.cpp `large-v3-turbo` on Mac Mini, auto-detect language, **transcribe only** (no `task=translate`; a comment deliberately avoids forcing `en` to keep code-switching). Multilingual incl. Kannada. Runs as 10s cumulative passes (`lib/use-whisper-rolling.ts`) — batchy, ~10s lag, not word-by-word. |
| Canonical transcript pick | `app/[slug]/api/encounters/[id]/finalize-upload/route.ts` | Picks the longer of client-sent `deepgram_transcript` / `whisper_transcript` (Whisper wins only if ≥1.2× longer) → `encounter.transcript_raw`. No language awareness. |
| Note + CDMSS | `app/[slug]/api/encounters/[id]/process/route.ts` | Reads `transcript_raw` → `generateNote()` (`qwen2.5:14b`, English-structured prompt, **no language instruction**) → `runCdmssPipeline()`. Sets `transcript_clean = transcript_raw`. |
| Compare harness | `lib/transcribe-compare.ts` | `runTranscriptionCompare()` (Deepgram + Whisper parallel + qwen 1-10 judge) **EXISTS but is never called.** References a `transcription_comparisons` table / "migration v36" that **does not exist here** (ETA migrations stop at 0005). Effectively dead/aspirational code carried over from the OPD app. |
| Trace UI | `components/llm-trace/*`, `lib/llm-trace/stage-explainers.ts` | Already has a `transcribe-compare` surface + `TRANSCRIBE_MILESTONES` placeholders. Scaffolding present, unwired. |
| Schema | `db/schema.ts` `encounter` | `transcript_raw`, `transcript_clean`, `note_json`, `note_json_edited`, `cdmss_json`. **No per-engine transcript storage, no language column.** |

**Takeaway:** the capture path works (Whisper transcribed the Kannada fine). The gaps are (a) no live engine for Indian languages, (b) no translation step, (c) the comparison harness is unwired and there's nowhere to store per-engine results.

---

## 3. Target architecture

```
RECORD (live)                         SUBMIT (batch compare + note)
─────────────                         ─────────────────────────────
mic → MediaRecorder ─┬─ Deepgram WS ──→ live English (when English)        every ENABLED engine runs on
                     │                                                      the full canonical R2 audio:
                     ├─ Sarvam WS  ───→ live native script (Indian langs)     • Deepgram (batch)
                     │                  ← original script shown live          • Whisper large-v3-turbo
                     ├─ Whisper roll ─→ (optional secondary live)             • Sarvam (transcribe + translate)
                     │                                                        • [later] local streaming (WhisperLive
                     └─ IndexedDB (crash recovery)                              / AI4Bharat IndicConformer)
                                                                              ↓
                                                                       qwen2.5:14b JUDGE scores 1-10,
                                                                       picks winning transcript
                                                                              ↓
                                                          original-language transcript  → preserved + shown
                                                          English translation of winner → transcript_raw
                                                                              ↓
                                                                  generateNote() [ENGLISH] → CDMSS → email
```

**Live phase = original script.** **Note = English.** **Every engine logged + judged for the testbed.**

---

## 4. Engine roster

| Engine | Where | Live? | Languages | Translate? | Role |
|---|---|---|---|---|---|
| **Deepgram nova-3-medical** | Cloud (US) | ✅ streaming | English (+ some Indic, NOT Kannada) | no | English live + medical tuning; baseline |
| **Whisper large-v3-turbo** | Mac Mini (in-network) | ⚠️ batch 10s | 100 incl. Kannada/Hindi | via `task=translate` | Batch accuracy + cheap English translation source |
| **Sarvam Saaras v3** | Cloud (India) | ✅ streaming WS | 11 Indian langs incl. Kannada + English | ✅ built-in | **NEW** — live Indian-language script + translation. Primary fix for goal 1+2 |
| **WhisperLive / AI4Bharat IndicConformer** | Mac Mini (in-network) | ✅ streaming | multilingual / 22 Indian langs | separate | **LATER** — fully in-network live Indian-language engine for the comparison |

Cost note: Sarvam ≈ ₹30/hr (~$0.35/hr) transcribe or transcribe+translate — negligible for a testbed; comparable to Deepgram. Data: Sarvam is India-based, DPDP/SOC2/ISO — better residency posture than the US Deepgram already in use. Fully-local engines remain the strongest-privacy option for eventual production.

---

## 5. Live transcription design (LOCKED — Deepgram-first, Sarvam fallback)

**Goal: the English experience is identical to today; non-English gets a live native-script panel; the doctor never picks a language and the workflow is unchanged.**

- **Deepgram stays the live engine** (`nova-3-medical`, as today). For an English encounter the doctor sees exactly what they see now.
- **Sarvam streams in parallel** from record start (server-minted ephemeral token; raw `SARVAM_API_KEY` never reaches the browser).
- **One visible live panel.** It shows Deepgram by default and **switches to Sarvam when Deepgram stays silent/empty while Sarvam is producing text** (the signature of non-English speech, since Deepgram returns ~nothing for Kannada). Switch should be quick (a few seconds of detection) and seamless.
- Whisper rolling stays for crash-recovery/secondary capture; not the primary display.
- All engines (Deepgram, Whisper, Sarvam) feed the **submit-time comparison** (§6) regardless of which drove the live panel.

*UX impact: zero new steps; English unchanged; Kannada/Hindi live box that was blank now shows native script.*

## 6. Submit-time design

1. On submit, the canonical audio is already in R2. `/process` (or a new `/transcribe-compare` step before note-gen) runs **every enabled engine** on the full audio in parallel.
2. Each engine yields `{ transcript, language, latency_ms, translation? }`.
3. The **qwen judge** (revive `runTranscriptionCompare`, extend 2→N engines) scores each 1-10 and picks a winner.
4. **Original-language** winning transcript → preserved (shown in live/record + admin views).
5. **English** text → `transcript_raw` (Sarvam translation, or Whisper `task=translate`, or the winner if already English) → feeds `generateNote()` + CDMSS + email.
6. `generateNote()` prompt gains an explicit "input may be Hindi/Kannada/code-switched; **always output English**" backstop.

## 7. Data model

New table (proposed `transcription_run`) — one row per engine per encounter, for testbed analytics:

```
transcription_run(
  id, encounter_id FK, engine TEXT,        -- 'deepgram' | 'whisper' | 'sarvam' | 'whisperlive' | 'indicconformer'
  mode TEXT,                               -- 'live' | 'batch'
  detected_language TEXT,
  transcript_original TEXT,
  transcript_english TEXT,                 -- null if engine doesn't translate
  latency_ms INT, judge_score NUMERIC,
  is_winner BOOL, error TEXT, created_at
)
```

Plus on `encounter`: `detected_language TEXT`, `transcript_original TEXT` (English stays in `transcript_raw`). Migration `0006_multilingual_transcription.sql`.

## 8. UI changes

- **Record screen:** language/engine selector (D2); primary live panel shows original script; optional second engine panel for comparison.
- **Encounter detail / admin trace:** wire the existing `transcribe-compare` surface — a comparison table (engine × transcript × language × latency × score × winner), plus the original-language transcript and the English translation.
- **Email/note:** English, unchanged downstream.

---

## 9. Decisions — ALL LOCKED 29 May 2026

| # | Decision | LOCKED |
|---|---|---|
| D1 | Engine roster | Deepgram + Whisper(batch) + **Sarvam streaming** now; local streaming engine (WhisperLive / IndicConformer) later when V is back at the Mac Mini |
| D2 | Live engine selection | **Auto-detect, Deepgram-first (REFINED 29 May — protect the English experience).** Deepgram stays the live engine exactly as today; Sarvam runs in parallel from record start; the single visible live panel shows Deepgram by default and **switches to Sarvam only when Deepgram is silent/empty while Sarvam is producing text** (i.e. non-English detected). English encounters are byte-for-byte unchanged; Kannada/Hindi get the live native script. No language picker. Whisper + (the non-shown) engines also feed the submit-time comparison |
| D3 | Note language | **English always** |
| D4 | Preserve original | **Yes** — store + show original-language transcript (record/admin views; not in the note body) |
| D5 | Which transcript feeds the note | **Judge-winner → English translation → note** |
| D6 | Per-engine storage | **New `transcription_run` table** for testbed analytics |
| D7 | Concurrent live engines | **Single primary live panel** for v1 (Sarvam). Dual-live side-by-side is a possible fast-follow, not v1 |
| D8 | Sarvam browser auth | **Server-minted ephemeral token** (mirror the `deepgram-token` route); raw `SARVAM_API_KEY` never reaches the browser |
| N | Original-language in note | **English note, original stored only** — original-language transcript preserved + viewable, not shown in the note body |
| F | First ship | **Sarvam end-to-end: MT.0 + MT.1 + MT.2** (schema + batch translation→English note + live original-script panel). N-engine compare harness (MT.3) follows |

## 10. Open questions — RESOLVED

All resolved 29 May 2026 (see §9). No open product questions remain. Implementation-level details to settle during build: Sarvam streaming WS auth/token TTL (probe the API first), and the exact `transcription_run` columns once we see Sarvam's real response shape.

## 11. Phased plan (proposed)

- **MT.0 — Schema** (`0006`): `transcription_run` table + `encounter.detected_language` + `transcript_original`. ~0.5 day.
- **MT.1 — Sarvam batch + translation:** `lib/sarvam.ts`, wire into a submit-time compare; English translation → note; backstop prompt line. Ship the actual Kannada fix. ~1-2 days. *(No Mac Mini needed.)*
- **MT.2 — Sarvam live streaming:** ephemeral-token route + browser WS client + original-script live panel + language selector (D2). ~2-3 days.
- **MT.3 — Revive + extend the compare harness:** `runTranscriptionCompare` 2→N, persist `transcription_run`, wire the trace `transcribe-compare` surface + admin comparison view. ~2 days.
- **MT.4 — Local streaming engine** (WhisperLive or AI4Bharat IndicConformer) as a 4th engine — when V is back at the Mac Mini (new service + tunnel, same pattern as the diarize service). ~separate.

## 12. Pending V action

- **Get a Sarvam API key** — sign up at sarvam.ai → create API key → hand it over (goes in Vercel env `SARVAM_API_KEY`, server-side only; browser gets ephemeral tokens). This is the only blocker for MT.1.

## 13. Risks

- Sarvam Kannada→English **translation quality** on clinical content — validate on V's real encounter before trusting. (Whisper translate is a cross-check.)
- Sarvam **public docs don't detail API retention / no-train** — fine for demo; get a DPA before production PHI.
- **Live streaming on Mac Mini (MT.4)** — Apple-Silicon latency may be "nearly live," and NeMo/IndicConformer setup could be as fiddly as the pyannote saga. Cloud Sarvam de-risks the demo.
- Adding a submit-time N-engine pass **adds latency** at submit — keep engines parallel; judge is one extra qwen call.

---

**Next step:** V reviews, we lock D1-D8 + the §10 open questions, then build starting MT.0/MT.1.
