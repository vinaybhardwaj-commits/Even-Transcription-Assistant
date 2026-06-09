# ETA · STT Engine Lab — PRD

**Created:** 31 May 2026 · **Owner:** V (Hospital PM) · **Status:** ✅ **COMPLETE — L0–L7 all shipped** (`stt-lab-complete` @ `b70a280`, + Health-tab polish `d815c20`), build green, verified live. 5 ASR engines (deepgram/whisper/sarvam/elevenlabs/ekascribe) + 2-tier scribe (ekascribe vs the virtual `even_pipeline`). A new engine = 1 adapter file + 1 registry row. **Operating TODOs (V):** label gold encounters (activates accuracy/WER), set per-engine `cost_per_min` (cost scoring), scribe tier needs real medical consults, optional `OPENAI_API_KEY` for cloud term extraction. See `ETA-CARRYOVER-PROMPT-31-MAY-2026.md` §4.7.

## 1. Vision
ETA is a **test-bed** for medical transcription at Even Hospital. The goal is to **objectively compare every speech-to-text (STT) engine** — Deepgram, Sarvam, the Mac-Mini Whisper, and **any engine we add later** — across accuracy, speed, cost, and reliability, so we can decide the **best stack** for each part of the pipeline (live caption, final note, diarization) and for each language. The STT Engine Lab is the admin-facing instrument panel + the offline machinery that produces those numbers, and the control panel that lets admins **route** which engine is used where.

Three pillars:
1. **Observe** — run every encounter's audio through *all* registered engines offline and score them (accuracy/speed/cost/reliability/agreement).
2. **Decide** — a leaderboard + health view that ranks engines per stage and per language.
3. **Control** — admin-editable routing (stage × language → engine) that the production paths obey, plus an extensible registry so new engines plug in without code churn.

## 2. Locked decisions (V, 31 May 2026)
- **Accuracy = all four methods, layered:** (a) reference **WER/CER on a gold set**, (b) **medical-term fidelity**, (c) **LLM judge** (relative), (d) **inter-engine agreement** (consensus).
- **Fan-out = auto on every encounter, async after submit** (never blocks the doctor). Paid-engine cost is controlled via per-engine `fanout_enabled` + a daily budget ceiling.
- **Routing granularity = stage × language** (stage ∈ live | note | diarize; language ∈ english | indic | default).
- **Q1 — Judge/extraction model = HYBRID:** per-encounter LLM judge runs on the **Mac-Mini `qwen`** (free, PHI on-LAN, pinned/reproducible); **medical-term extraction uses a cloud LLM but only on the curated gold set** (few calls, bounded PHI exposure, better medical NER). Judge model is a config field.
- **Q2 — Gold reference (ASR tier) = verbatim corrected transcript only** (seeded from best engine + inline audio playback). The clinician's edited note is NOT the WER reference — but see Q4b: it becomes the reference at the **scribe tier**.
- **Q3 — Backfill = ALL existing encounters now** (34 / ~64 min ≈ cents). Window-cap + daily-budget guard retained for when the corpus grows.
- **Q4 — New competitor engines** (full engines in fan-out/scoring/routing, not judges): **ElevenLabs Scribe v2** (top general accuracy, streaming+batch, 90+ langs incl. Indic) and **Ekascribe** (eka.care — medical scribe; see §4.0). **Google Chirp 3 dropped** (V can't use Google Cloud STT for now). API keys for ElevenLabs + Ekascribe **obtained 31 May** (see §11 Credentials).
- **Q4b — TWO evaluation tiers** (Ekascribe forced this): **ASR tier** (audio→transcript, scored vs verbatim gold) AND **scribe tier** (audio→finished clinical note, scored vs the clinician's edited note + LLM rubric), where our own transcribe→LLM pipeline is also a scribe-tier competitor.
- **Q5 — Daily fan-out budget ceiling = $5/day default** (configurable). On breach: pause paid engines, keep local Whisper, defer jobs to next day.

## 3. What already exists (build on, don't rebuild)
- **`transcription_run` table** (migration 0006): one row per engine per encounter — `engine`, `mode` (`live|submit|batch`), `detected_language`, `transcript_original`, `transcript_english`, `latency_ms`, `judge_score`, `is_winner`, `error`. The unused **`batch`** mode is the fan-out hook.
- **`lib/transcribe-compare.ts`**: runs Deepgram + Whisper in parallel + a `qwen` LLM judge (1–10 + winner). Generalize to N engines.
- **`lib/transcribe.ts`** (Deepgram nova-3-medical), **`lib/whisper.ts`** (Mac-Mini whisper.cpp), **`lib/sarvam.ts`** (saaras:v3 transcribe/translate/codemix) — wrap each as an adapter.
- **`/api/health`**: per-service `{ ok, latency_ms }` probes (db, kb, llm, whisper, resend, r2). Extend to probe each STT engine.
- **Diarization EER harness** (`/admin/diarization`, migration 0008 `identification_label`): the model for accuracy-labeling UI; diarization engines keep being scored by **EER**, not WER.
- **Per-encounter "Engines" view** (MT.3) on the encounter detail: the seed for the runs browser.

## 4. Architecture

### 4.0 Two evaluation tiers + engine inventory
The Lab compares engines at two layers, because some products (Ekascribe) are end-to-end scribes, not raw ASR:

| Tier | Input → output | Competitors | Reference / scoring |
|---|---|---|---|
| **ASR** | audio → transcript | Deepgram, Whisper (Mini), Sarvam, ElevenLabs Scribe v2, Ekascribe (`transcript_template`) | verbatim gold → WER/CER + medical-term fidelity + LLM judge + agreement |
| **Scribe** | audio → finished clinical note | **Even pipeline** (chosen ASR → note-gen LLM = the encounter's actual note), Ekascribe (`clinical_notes_template`), future scribes | clinician's edited note → LLM rubric (factual capture, completeness, structure, safety) |

An engine declares which tiers it serves. A pure-ASR engine only appears at the ASR tier; a scribe like Ekascribe appears at **both** (it can emit a transcript and a note). The "Even pipeline" is a virtual scribe-tier competitor whose output is the note we already generate.

**Engine inventory (registry seed):**
- `deepgram` — Deepgram nova-3-medical (cloud, English-strong, medical). ASR.
- `whisper` — Mac-Mini whisper.cpp large-v3-turbo (local, free, PHI on-LAN). ASR.
- `sarvam` — Saaras v3 (cloud, Indic specialist + code-mix, translates). ASR.
- `elevenlabs` — Scribe v2 / v2 Realtime (cloud, top general accuracy, streaming). ASR (live + note). **Key obtained.**
- `ekascribe` — eka.care EkaScribe v2 (cloud, async job API, medical scribe). ASR (`transcript_template`) **and** Scribe (`clinical_notes_template`). **Credentials obtained.**
- ~~`google_chirp`~~ — dropped 31 May (Google Cloud STT unavailable to V for now; can be added later as a pure adapter+row).
- `even_pipeline` — virtual scribe-tier entry = the encounter's generated note. Scribe only.

### 4.1 Engine registry + adapter interface (the extensibility backbone)
**Code:** `lib/stt/adapters/<key>.ts`, each implementing one interface. It supports **synchronous** engines (Deepgram/Whisper/Sarvam) and **async, multi-step/job-based** engines (Ekascribe: presigned-upload → upload → init → poll/result) — the adapter hides the protocol; the offline fan-out worker is already async so a polling adapter is fine.
```ts
export interface SttAdapter {
  key: string;                      // 'deepgram' | 'sarvam' | 'whisper' | 'elevenlabs' | 'google_chirp' | 'ekascribe' | ...
  capabilities: {
    tiers: ('asr'|'scribe')[];      // ASR (transcript) and/or Scribe (finished note)
    stages: ('live'|'note'|'diarize')[];
    languages: ('english'|'indic'|'multi')[];
    streaming: boolean;
    translates: boolean;            // produces English from non-English
    async: boolean;                 // job/poll protocol (e.g. Ekascribe) vs single request
  };
  // ASR tier — may run a multi-step job internally and resolve when done:
  transcribe(audio: Buffer, opts: { contentType: string; language?: string }):
    Promise<{ original: string|null; english: string|null; language: string|null;
              latencyMs: number; costUsd: number|null; error: string|null }>;
  // Scribe tier (optional — only scribe-capable engines implement it):
  generateNote?(audio: Buffer, opts: { contentType: string; language?: string; template?: string }):
    Promise<{ note: unknown; noteText: string|null; latencyMs: number; costUsd: number|null; error: string|null }>;
  health(): Promise<{ ok: boolean; latencyMs: number; error?: string }>;
}
```
A registry (`lib/stt/registry.ts`) maps `adapter_key → SttAdapter` and reads the DB `stt_engine` rows for enable/config. **Adding an engine = one adapter file + one `stt_engine` row** — it then auto-joins fan-out, health, scoring, leaderboard, and routing at whichever tiers it declares, with no schema/UI change. Engines needing credentials (ElevenLabs, Google, Ekascribe) read their keys from env, named in the registry row's `config_json`. **V to obtain API keys:** ElevenLabs, Google Cloud STT, and an Ekascribe key from the Eka Care team.

**DB `stt_engine`** (registry rows):
`id` (slug PK), `display_name`, `adapter_key`, `capabilities_json`, `enabled` (in routing pool), `fanout_enabled` (participates in fan-out), `is_paid`, `cost_per_min_usd`, `config_json` (model name, env var names, thresholds), `sort_order`, `created_at`.

**Extensibility contract:** adding an engine = (1) drop `lib/stt/adapters/<key>.ts`, (2) INSERT one `stt_engine` row. It then auto-joins fan-out, health, all four scores, the leaderboard, and becomes selectable in routing — **no schema change, no UI change**. This is the headline requirement and every design choice below preserves it.

### 4.2 Offline fan-out (mode = batch)
- **Trigger:** on encounter submit (after audio lands in R2), enqueue an `stt_fanout_job` row (`status='pending'`). Doctor path is untouched.
- **Worker:** a Vercel Cron route `POST /api/admin/stt-lab/run-fanout` (every N min) claims a batch of pending jobs, and for each runs the canonical R2 audio through **every `fanout_enabled` engine whose capabilities cover the encounter's stage/language** → writes a `transcription_run` row (`mode='batch'`) per engine with `latency_ms`, `cost_usd`, `error`. Idempotent (dedupe on encounter+engine+mode), resumable, rate/cost-limited.
- **Budget guard:** a daily USD ceiling (config); when hit, paid engines are skipped (local Whisper still runs free) and the job is marked `deferred`.
- **Backfill:** a one-time enqueue of historical encounters (bounded) so the leaderboard has depth on day one.

### 4.3 Scoring (all four methods)
Stored per `transcription_run` (core metrics as first-class columns for fast leaderboard queries; experimental metrics in `metrics_json`). We separate **ASR accuracy** (original-language text) from **translation accuracy** (English) because Sarvam does both.

**(a) Reference WER/CER on a gold set** — *objective, the spine of the comparison.*
- **Gold set:** admins mark a verbatim "truth" transcript for a curated set of encounters via a labeling UI (open encounter → see all engine outputs → correct one into a reference → save). Stored in `stt_gold`.
- **Metric:** standard token-level WER + character-level CER, after normalization (lowercase, strip punctuation, number-word↔digit, collapse whitespace). Computed per engine vs gold, for original-language and (where applicable) English.
- Coverage tracked (how many gold-labeled encounters per language) — accuracy claims are only as strong as the gold set.

**(b) Medical-term fidelity** — *clinical safety weighting.*
- From each gold reference, extract the **critical terms** (drug names, doses/units, findings, negations, allergies) via an LLM extraction + a medical lexicon, stored as `stt_gold.critical_terms_json`.
- Per engine: term **recall** (did the transcript contain each critical term, fuzzy-matched) and **dose-exactness** (numbers/units correct). A missed dose is weighted far above a missed filler word.

**(c) LLM judge (relative)** — *no reference needed, runs on every fan-out.*
- Generalize `transcribe-compare` to N engines: present all engine transcripts to the judge LLM (`qwen` on the Mini, or cloud LLM) → 1–10 quality score + ranking + short reasoning per engine. Stored in `judge_score` (+ reasoning in `metrics_json`).

**(d) Inter-engine agreement (consensus)** — *zero human input, runs on every fan-out.*
- Build a consensus transcript (majority-token voting / medoid by pairwise similarity); each engine's **agreement score** = similarity (1−normalized-edit-distance) to consensus. Flags outliers automatically; a cheap proxy where no gold exists.

**(e) Scribe-tier scoring** — *for end-to-end scribes (Ekascribe, the Even pipeline).*
- Reference = the **clinician's edited final note** for that encounter. An LLM rubric (run on the Mini `qwen`, cloud spot-check optional) scores each scribe's note on: **factual capture** (did the key facts/meds/doses/findings survive), **completeness**, **structure/format fit**, **hallucination/safety** (invented facts penalized hard), and an overall 1–10. Stored on the scribe-tier `transcription_run` row.
- This answers the product-level question: *does an all-in-one medical scribe beat our transcribe-then-summarize stack?* The Even pipeline competes here using the note it already generates.

**Composite score (configurable weights):** per engine, a 0–100 composite =
weighted blend of accuracy (1−WER on gold), medical-term recall, judge score, agreement, speed (normalized latency, lower better), reliability (success rate), and cost (per-min, lower better). Default weights in `config`; admin-tunable. Leaderboard ranks engines **overall + per language bucket + per stage**. This is the "which stack wins" answer.

### 4.4 Health & status
- **Live probe:** `GET /api/admin/stt-lab/health` calls each registered engine's `adapter.health()` → `{ ok, latency_ms }`, green/amber/red.
- **Rolling reliability:** success rate + p50/p95 latency per engine over the last N fan-outs (from `transcription_run`), with sparklines.
- Surfaced top-of-page in the STT Lab so an admin sees system health every login (V's explicit ask).

### 4.5 Routing control (stage × language)
- **DB `stt_routing`:** PK `(stage, language_bucket)` → `engine_id`, `updated_by`, `updated_at`. Stages: `live`, `note`, `diarize`. Buckets: `english`, `indic`, `default`.
- **Production paths read routing instead of hardcoding:** the live hooks, the `finalize-upload`/`process` note path, and the `/process` diarize call resolve the active engine from `stt_routing` (with a **safe fallback** to today's defaults if config is missing or the engine is unhealthy). This is the one refactor that touches the doctor path — phased last, behind fallbacks, and reversible.
- Diarization engines (pyannote) live in the registry with `stage=diarize` and are scored by **EER** (reuse the existing harness), not WER — the routing UI just lets an admin pick the active diarizer too.

## 5. Admin UI — "STT Lab" (new top-level nav)
Tabs:
1. **Leaderboard** — an **ASR/Scribe tier toggle**; per-engine composite + accuracy/speed/cost/reliability columns; filter by language bucket × stage × date range. ASR tier ranks transcript engines; Scribe tier ranks the Even pipeline vs Ekascribe vs future scribes. The decision view.
2. **Health** — live probe + rolling reliability + latency sparklines per engine.
3. **Runs** — browse fan-out results per encounter; side-by-side transcripts with diffs vs gold; per-method scores. (Extends the MT.3 Engines view.)
4. **Gold set** — list of gold-labeled encounters + the labeling/correction UI + coverage stats per language.
5. **Routing** — the stage × language matrix of active production engines (editable, with health badges).
6. **Engines (registry)** — list/enable/disable engines, edit cost/config/`fanout_enabled`, register a new engine (metadata; the code adapter ships with it).

## 6. Data model (new)
- **`stt_engine`** — registry (§4.1).
- **`transcription_run`** (EXISTS) — extend with `stt_engine_id`, `tier` (`asr`|`scribe`), `stage`, `cost_usd`, `wer`, `cer`, `med_term_recall`, `agreement_score`, `note_text`, `note_json`, `metrics_json`. Keep `judge_score`, `is_winner`. ASR rows carry transcripts + WER metrics; scribe rows carry `note_text`/`note_json` + rubric scores (in `metrics_json`).
- **`stt_gold`** — `encounter_id` PK, `reference_original`, `reference_english`, `reference_language`, `critical_terms_json` (cloud-LLM extracted), `labeled_by_admin_id`, `labeled_at`. (Scribe-tier reference = the encounter's clinician-edited note, already stored — no new column.)
- **`stt_routing`** — `(stage, language_bucket)` PK → `engine_id`, `updated_by`, `updated_at`.
- **`stt_fanout_job`** — `encounter_id` PK, `status` (pending|running|done|failed|deferred), `attempts`, `error`, `enqueued_at`, `completed_at`.
- **`stt_lab_config`** — singleton: composite weights, daily budget USD, fan-out concurrency, judge model.

## 7. Cost, privacy & safety
- **Cost:** fan-out on every encounter multiplies paid-API spend. Mitigations: per-engine `fanout_enabled`, a daily USD ceiling (skip paid engines past it; local Whisper always runs free), and visible spend tracking. Tunable from the registry.
- **Privacy:** same medical audio already in R2; no new exposure. Gold references + transcripts are PHI-equivalent → admin-only, audit-logged.
- **Doctor path is sacrosanct:** fan-out + scoring are 100% async/offline; only §4.5 routing touches production, behind fallbacks and reversible.
- **Reliability:** worker idempotent, resumable, rate-limited; a failing engine never blocks others (failure-soft, like `transcribe-compare`).

## 8. Sprint plan (observation before control)
- **L0 — Registry + adapters + health. ✅ SHIPPED** (tag `stt-lab-L0-shipped` @ `61bfb9c`, build green). Migration `0018` `stt_engine` (seeded deepgram/whisper/sarvam enabled; elevenlabs/ekascribe disabled) applied to Neon; `lib/stt/{types,registry}.ts` + `adapters/{deepgram,whisper,sarvam}.ts` (wrap existing libs + real `health()`); `GET /api/admin/stt-lab/health`; admin **STT Lab** nav + `/admin/stt-lab` tabbed page (Health live; other tabs stubbed). Verified live: deepgram/whisper/sarvam all probe ok; page 200.
- **L1 — Offline fan-out (ASR tier). ✅ SHIPPED** (tag `stt-lab-L1-shipped` @ `9523728`, build green, backfill complete). Migration `0019` (transcription_run extended + `stt_fanout_job` + `stt_lab_config`) applied; `lib/stt/fanout.ts` (enqueue/backfill/run-per-encounter idempotent/drain/$5-budget/reset/status); `POST /api/admin/stt-lab/run-fanout` worker; `/process` `after()` hook fans out each new encounter post-response. **Backfilled all 25 encounters with audio:** deepgram 25/25 ✓ (~2.9s), sarvam 25/25 ✓ (~8.5s, batch API), whisper 21/25 ✓ (~8.7s; 4 errored rows captured). **Finding:** Sarvam *sync* API caps at 30s → adapter uses the batch job API (`sarvamBatchTranslate`) for long-form fan-out. No Vercel cron (after() + manual/worker drain; cron optional later).
- **L2 — Reference-free scoring. ✅ SHIPPED** (tag `stt-lab-L2-shipped` @ `b046007`, build green, all encounters scored). `lib/stt/scoring.ts`: inter-engine **agreement** (mean token-Levenshtein similarity to peers; null when <2 non-empty transcripts) + **blinded N-engine LLM judge** on the Mini `qwen` (transcripts shown as A/B/C, no engine names → 1-10 + ranking + reasoning) → writes `agreement_score`/`judge_score`/`metrics_json`/`is_winner` per row. Auto-runs after each fan-out; worker `{score,rescore}` for backfill. **Scored all 25 backfilled encounters** — first leaderboard signal: sarvam judge≈4.6 (16 wins), deepgram≈4.2 (3), whisper≈3.2 (6) on the test-clip set. **Fixes this sprint:** `qwen.ts` now falls back to `OLLAMA_BASE_URL` (LLM_BASE_URL was unset in prod → judge was silently failing); agreement null (not 1.0) for single-engine encounters; `scorePending` uses a `metrics_json.scored_at` done-marker + skips empty/silent clips.
- **L3 — Gold set + objective accuracy. ✅ SHIPPED** (tag `stt-lab-L3-shipped` @ `b397a41`, build green, flow verified). Migration `0020 stt_gold` (verbatim reference + extracted critical terms per encounter). `lib/stt/wer.ts` (normalized WER/CER + medical-term recall); `scoring.ts` `extractCriticalTerms` (**cloud via `OPENAI_API_KEY` if set, else Mini-qwen fallback** — currently qwen since no key), `scoreGold`, `saveGold`, `deleteGold`. Endpoints: GET `/api/admin/stt-lab/gold` (labeled + candidates + per-engine WER leaderboard), GET/PUT/DELETE `gold/[id]`. **Gold set tab**: per-engine WER/CER/term-recall table + encounter picker (labeled/to-label) + labeling editor (engine transcripts to compare, verbatim reference seeded from the best engine, Save+score, Remove-from-gold). Verified: labeling an encounter with sarvam's text → sarvam WER 0, empty deepgram WER 1.0, garbled whisper WER 1.19 (math correct); terms extracted via qwen; leaderboard aggregates. (Smoke-test label removed → gold set starts clean at 0/25.) **Note: add `OPENAI_API_KEY` in Vercel to upgrade term extraction to cloud per the Q1 decision.**
- **L4 — STT Lab dashboard. ✅ SHIPPED** (tag `stt-lab-L4-shipped` @ `37c5f18`, build green, verified). `lib/stt/leaderboard.ts` (per-engine aggregate → 0-100 **composite** with configurable weights from `stt_lab_config.weights_json`; defaults accuracy .30/term .20/judge .20/agreement .10/speed .10/reliability .05/cost .05; language + date filters, Neon-safe value-param WHERE). Endpoints: GET `leaderboard` (lang/since), GET `runs` + `runs/[id]`, GET/PATCH `engines`. **Leaderboard tab** (ASR/Scribe toggle, composite ranking + accuracy/WER/term/judge/agree/latency/reliability/wins/gold-n, filters), **Runs tab** (encounter list + side-by-side engine transcripts w/ scores + gold reference + word-diff highlight vs gold + winner badge), **Engines tab** (enable/fanout toggles + inline cost/min edit). Verified live: deepgram composite 62.5 / sarvam 41.9 / whisper 39.9 (deepgram leads on the no-gold composite via speed+reliability; accuracy weight activates once gold is labeled).
- **L5 — Routing control. ✅ SHIPPED** (tag `stt-lab-L5-shipped` @ `038c4a0`, build green, verified). Migration `0021 stt_routing` ((stage,language_bucket) PK → engine_id; `'auto'`=default) seeded to match current behaviour. `lib/stt/routing.ts resolveRouting` returns an override only if set (≠'auto'), enabled, AND adapter-backed — else null=default; never throws. **`finalize-upload` English note canonical-pick honors `routing(note,english)`** (whisper/deepgram) with fallback to the longer-of-two default. Endpoints GET/PUT `/api/admin/stt-lab/routing`; **Routing tab** matrix (stage×bucket dropdowns + enforcement notes). Verified: matrix seeded right, PUT override sets+restores, STT Lab 200, doctor record route intact (307 login redirect, not 500). **Enforcement status: note/English = enforced server-side; note/Indic = Sarvam (non-English path); live = recorded but advisory (live engine is client-side — deeper wiring deferred); diarize = single engine (pyannote), not routed.** **CONTROL HALF done.** Production unchanged until an admin sets an override.
- **L6 — New ASR engine (extensibility proof). ✅ SHIPPED** (tag `stt-lab-L6-shipped` @ `e00a59d`, build green, fanned out + scored). `lib/stt/adapters/elevenlabs.ts` (POST `/v1/speech-to-text`, `model_id=scribe_v2`, multipart file, `xi-api-key`; transcribes not translates → english set only for en* audio) + registered in ADAPTERS + enabled the registry row via the Engines tab PATCH. **It auto-joined health/fan-out/scoring/leaderboard/routing with ZERO schema or UI change — the extensibility contract proven.** Fanned out across all 25 encounters: ElevenLabs 22/25 ok (~11.5s avg). Leaderboard now 4 engines: deepgram 61.1 / sarvam 47.8 / whisper 44.1 / **elevenlabs 38** (strong judge 4.47, but slowest + no-gold composite leans on speed; accuracy weight will lift it once gold is labeled). Added worker `{dedup:true}` (removed 4 dup rows from concurrent manual draining; not a normal-flow issue). $0 ElevenLabs balance did NOT block — Scribe transcribed fine.
- **L7 — Scribe tier + Ekascribe. ✅ SHIPPED** (tags `stt-lab-L7-shipped` + `stt-lab-complete` @ `b70a280`, build green, verified). `lib/stt/adapters/ekascribe.ts`: client-credentials → cached Bearer; async 4-step job (presigned `/v1/file-upload` → S3 POST → init `/voice/api/v2/transaction/init` → poll `/voice/api/v3/status`); `transcribe()` (transcript_template, ASR tier) + `generateNote()` (clinical_notes_template, scribe tier). **Verified end-to-end from the sandbox: medical clip → a real structured clinical note (CC/HPI/vitals/meds).** Migration `0022` seeds the virtual `even_pipeline` scribe competitor. Scribe-tier fan-out (`runScribeForEncounter`: even_pipeline from `note_json` + ekascribe `generateNote` → `tier='scribe'` rows) + `scoreScribe` (qwen rubric: factual/completeness/structure/safety/overall vs `note_json_edited ?? note_json`) + worker `{scribe:true}`. Leaderboard `tier` param + UI Scribe toggle live; Runs renders scribe notes + rubric. Verified live: even_pipeline rubric 10 (it IS the reference on un-edited notes), ekascribe correctly `template_failure` on a non-medical TV-serial clip (a medical scribe rejects non-clinical audio — honest lab data). **Scribe-tier comparisons get meaningful once V records real consults (+ edits the note = the reference).**

## ✅ STT ENGINE LAB COMPLETE (L0–L7, tag `stt-lab-complete` @ `b70a280`)
Registry + adapters + health · offline fan-out + backfill · agreement + N-engine judge · gold WER/CER + medical-term fidelity · composite dashboard (Leaderboard/Runs/Engines/Gold/Routing/Health) · stage×language routing · 5 ASR engines (Deepgram, Whisper, Sarvam, ElevenLabs Scribe v2, Ekascribe-transcript) + 2-tier scribe (Ekascribe note vs Even pipeline). Adding any future engine = one adapter file + one registry row. **Operating notes:** label gold encounters to activate accuracy weighting; set per-engine `cost_per_min` in the Engines tab for cost scoring/budget; scribe tier needs real medical encounters; term extraction upgrades to cloud by adding `OPENAI_API_KEY`.
- **(later) Local Indic engine** — AI4Bharat IndicConformer on the Mac Mini (PHI on-LAN), once a cloud baseline exists.

## 9. Resolved decisions (V, 31 May 2026)
1. **Judge / medical-term model** → ✅ HYBRID: per-encounter judge on Mini `qwen`; cloud LLM for medical-term extraction on the gold set only.
2. **Gold reference (ASR tier)** → ✅ verbatim corrected transcript only. (Clinician note = scribe-tier reference per Q4b.)
3. **Backfill depth** → ✅ all existing encounters now; window-cap + budget guard kept for the future.
4. **New engines** → ✅ ElevenLabs Scribe v2 (L6) and Ekascribe (L7) as full competitor engines. **Google Chirp 3 dropped** (Google Cloud STT unavailable to V).
4b. **Evaluation tiers** → ✅ two tiers: ASR + end-to-end scribe.
5. **Daily fan-out budget** → ✅ $5/day default, configurable.

**Prerequisites — DONE (31 May):** ElevenLabs + Ekascribe API credentials obtained (§11). No outstanding external blockers; L0–L5 need no keys.

## 11. Credentials (values in the secrets file, NOT here)
Live secret values are stored in `Daily Dash EHRC/ETA/_sprint0-secrets/eta-vercel-env-vars.env` (alongside `SARVAM_API_KEY`, `MIGRATION_SECRET`, etc.) and must be set in Vercel env (Production+Preview, Sensitive) before L6/L7. The adapters read these env var **names**:
- `ELEVENLABS_API_KEY` — ElevenLabs Scribe v2 key (created 31 May, name "ETA STT Lab", **restricted to Speech-to-Text only**). Header: `xi-api-key: $ELEVENLABS_API_KEY`.
- `EKACARE_CLIENT_ID` + `EKACARE_CLIENT_SECRET` — eka.care credential "ETA STT Lab" (created 31 May). **Auth = OAuth client-credentials:** exchange ID+secret for a Bearer access token, then run the v2 job flow (presigned-upload → upload → init{template,model,language} → poll `GET /voice/api/v3/status/{txn_id}`). The L7 adapter handles the token exchange + polling.

> Security note: raw keys are deliberately kept out of this PRD (it lives in iCloud and may be shared). The secrets file is the single source of truth; rotate via the ElevenLabs / eka.care consoles if ever exposed.

## 10. Net
A registry-driven, fully extensible STT comparison lab: every encounter auto-scored across all engines on four accuracy methods + speed + cost + reliability, ranked on a leaderboard, health-monitored, and with admin-controlled stage×language routing — built in 7 phases that put observation before control and never touch the doctor path until the final, reversible routing step.
