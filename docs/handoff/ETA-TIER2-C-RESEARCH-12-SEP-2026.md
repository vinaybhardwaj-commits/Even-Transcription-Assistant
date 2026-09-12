# ETA — Tier 2 Slice C — Research findings

Date: 12 Sep 2026
Role: Researcher (read-only). No file in the repo was edited; nothing was built, committed or pushed.
Repo: `/Users/vinaybhardwaj/dev/Even-Transcription-Assistant`, branch `vinay/release-b1`.
Local HEAD at time of research: `2afb75e`. **Production SHA is `df42143`** (confirmed live via the
Scribe system map, `health.sha`). Local HEAD is two commits ahead of production and both are
documentation/hygiene commits (`809a593`, `2afb75e`); no source file differs for the questions below.

Every answer is marked VERIFIED (with a `file:line` or a response actually captured on this Mini) or
UNVERIFIED. Nothing below is taken from a manual or a prior research document.

## Method and safety notes

- Live services were probed **read-only**. Nothing was restarted, reconfigured or stopped.
- No recording room was touched. At probe time 8 of 10 rooms were actively recording, so every clip
  was kept short.
- The probe clip is `whisper.cpp/samples/jfk.wav` — 11.0 s, 16 kHz mono PCM, public-domain speech.
  **No clinic audio, no patient audio and no PHI was used or transmitted.**
- The >60 s clip for item 8 is that same clip concatenated 6× to 66.0 s, built in the session
  scratchpad. Derived boundary clips of 59 s and 61 s were cut from it.
- No transcript text, note text or patient label is reproduced anywhere in this document.

### Local service topology (VERIFIED — `ps -eo pid,command`, `lsof -nP -iTCP -sTCP:LISTEN`)

| Port | Process | Source |
|---|---|---|
| 8001 | uvicorn `server:app` | `/Users/vinaybhardwaj/eta-diarize/server.py` |
| 8080 | `whisper-server` (whisper.cpp) | model `ggml-large-v3-turbo.bin`, `--vad`, `--no-speech-thold 0.7`, `--suppress-nst` |
| 8081 | `whisper-shim.py` | `/Users/vinaybhardwaj/.local/bin/whisper-shim.py` |
| 8082 | `indic_server.py` | `/Users/vinaybhardwaj/eta-indic/indic_server.py` |
| 8083 | uvicorn `router_server:app` | `/Users/vinaybhardwaj/eta-router/router_server.py` |
| 8086 | `app.py` | `/Users/vinaybhardwaj/eta-emotion/app.py` |

---

## 1. diarize — the real request shape for `POST /diarize` and `POST /enroll`

**Status: VERIFIED** (source read + successful live calls captured).

### Why the earlier probe failed

The probe sent `clinician_centroids=[]` as the only form field. Reproduced exactly:

```
POST http://127.0.0.1:8001/diarize  -F 'clinician_centroids=[]'
-> http=422  content-type=application/json  time=0.023 s
{"detail":[{"type":"missing","loc":["body","audio"],"msg":"Field required","input":null},
           {"type":"missing","loc":["body","encounter_id"],"msg":"Field required","input":null}]}
```

The cause is `eta-diarize/server.py:129-135`: both `audio` and `encounter_id` are declared with a
bare Ellipsis default, i.e. **required**. FastAPI rejects the request during validation before the
handler body runs.

```python
# /Users/vinaybhardwaj/eta-diarize/server.py:128-135
@app.post("/diarize")
async def diarize(
    audio: UploadFile = File(...),
    encounter_id: str = Form(...),
    clinician_centroids: str = Form("[]"),
    manual_relabels: str = Form("[]"),
    batch_threshold: float = Form(0.70),
):
```

**Correction to the premise as reported:** the failing response *was* JSON (`application/json`), and
it came back in **23 ms**, not 1.0 s. If a non-JSON body in ~1.0 s was genuinely observed, that was a
different call than the one described — most likely made through the public tunnel rather than to
`127.0.0.1:8001`, where an edge/proxy layer can substitute an HTML error page. **UNVERIFIED:** I did
not probe the tunnel hostname, so I cannot confirm the tunnel's error body shape.

### `POST /diarize` — correct request

`multipart/form-data`, five fields:

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `audio` | file | **yes** | — | Any container ffmpeg can decode. Written to a `.webm`-suffixed temp file, then `torchaudio.load` with an ffmpeg CLI fallback (`server.py:76-95`). A 16 kHz mono WAV works. |
| `encounter_id` | string | **yes** | — | Echoed back verbatim in the response. Not validated. |
| `clinician_centroids` | string | no | `"[]"` | A **JSON string**, not a repeated form field. Parsed by `json.loads` at `server.py:166`. |
| `manual_relabels` | string | no | `"[]"` | JSON string. Parsed and **discarded** — `_ = json.loads(manual_relabels)` at `server.py:286`. v0 applies relabels in Vercel. |
| `batch_threshold` | float | no | `0.70` | Cosine-similarity floor for accepting a clinician match (`server.py:218`). |

Each element of `clinician_centroids` must be an object with exactly these keys
(`server.py:167-174`): `clinician_id`, `full_name`, `centroid_base64`. The centroid is decoded with
`np.frombuffer(base64.b64decode(...), dtype=np.float32)` — a raw little-endian float32[192] buffer,
768 bytes, base64-encoded. It is **byte-identical to the `embedding_base64` returned by `/enroll`**
(`server.py:106-108`, and the comment at `:122-124`).

A missing key in any centroid object raises `KeyError` inside the handler and surfaces as a 500, not
a 422 — the shape is not schema-validated. **UNVERIFIED:** I did not send a malformed centroid to
confirm the 500, to avoid noise in the service log.

### `POST /diarize` — ACTUAL response captured

Call: 11.0 s WAV, `encounter_id=research-probe-tier2c`, empty centroids.
Result: **`http=200`, `application/json`, 16.76 s wall** (~1.5× realtime), `latency_ms: 16741`.

Top-level keys (7), with observed types:

```
encounter_id        string
speakers            array
transcript_segments array
overlap_windows     array
aggregates          object
latency_ms          number
model_versions      object
```

One `speakers[]` element, verbatim (embedding truncated here only):

```json
{"idx":0,"total_speech_sec":7.37,"first_heard_at_sec":0.32,"manually_relabeled":false,
 "embedding_base64":"KSz+wQZBj8E3Aw7C…<1024 chars>","label":"Patient","type":"patient",
 "source":"heuristic"}
```

`embedding_base64` is **1024 characters** = 768 bytes = float32[192], as expected.
A speaker matched to an enrolled clinician additionally carries `clinician_id` and `confidence`, and
`type:"clinician"`, `source:"auto"` (`server.py:219-225`). The `_cluster_id` field is internal and is
stripped before the response (`server.py:282-283`).

**One span** of `transcript_segments[]` — this is the shape Slice C would consume:

```json
{"start_ms":317,"end_ms":2207,"speaker_idx":0,"overlap":false}
```

All five spans captured: `(317,2207) (3270,3777) (3895,4367) (5380,7557) (8147,10476)`, all
`speaker_idx:0`, all `overlap:false`. Note there is **no text on a span** — the spans are timing +
speaker index only; alignment with Whisper text happens in Vercel (`server.py:256`).

`overlap_windows[]` was `[]` (single speaker). Its element shape is `{"start_ms":int,"end_ms":int}`
(`server.py:156-159`).

`aggregates` and `model_versions`, verbatim:

```json
{"clinician_sec":0,"patient_sec":7.37,"attender_sec":0,"nurse_sec":0,"other_sec":0,"overlap_sec":0}
{"diarization":"pyannote/speaker-diarization-3.1","osd":"pyannote/segmentation-3.0",
 "identification":"speechbrain/spkrec-ecapa-voxceleb"}
```

### Role assignment is heuristic and order-dependent — flag for the spec

Clusters are sorted by total speech descending (`server.py:191`) and labelled by a first-match
cascade (`server.py:218-252`): clinician if cosine ≥ `batch_threshold`; else the **first** cluster
with ≥ 5 s becomes `Patient`; else ≥ 30 s becomes `Attender N`; else < 30 s with < 4 segments becomes
`Nurse`; else `Other {idx}`. With no centroids supplied, the longest-speaking cluster is always
labelled `Patient` — which is what happened in this probe. Slice C must not read `type:"patient"` as
evidence of a patient when the centroid list is empty.

### `POST /enroll` — request and ACTUAL response

`multipart/form-data`, two fields (`server.py:310-311`):

| Field | Type | Required | Default |
|---|---|---|---|
| `audio` | file | **yes** | — |
| `clinician_id` | string | no | `""` |

Captured, 11.0 s WAV, **`http=200`, 0.49 s**:

```json
{"ok":true,"clinician_id":"research-probe","embedding_base64":"XwW+wHDd4cGsp0fB…<1024 chars>",
 "dim":192,"model":"speechbrain/spkrec-ecapa-voxceleb"}
```

With `clinician_id` omitted, also `http=200`, and `clinician_id` comes back `null`
(`server.py:349`, `clinician_id or None`). Confirmed live.

**Error contract differs from `/diarize` — flag for the spec.** `/diarize` raises `HTTPException`
and returns real 4xx codes. `/enroll` returns **HTTP 200 with `{"ok":false,"error":…}`** for every
failure: `empty_audio` (`:314`), `decode_failed` (`:325`), `audio_too_short` (< 0.5 s, `:334`),
`embed_failed` (`:337`), `unexpected_dim_N` (`:346`). A client that checks only the status code will
record a failed enrolment as a success. Any `/enroll` caller must branch on the `ok` field.

---

## 2. whisper `/inference` with `response_format=verbose_json` — per-segment timings?

**Status: VERIFIED** (live response captured). **Yes — and it also returns per-word timings.**

The app already sends this format: `lib/whisper.ts:255` appends `response_format=verbose_json`,
alongside `temperature=0.0`, `beam_size=1`, `best_of=1` (`lib/whisper.ts:267-269`) and an optional
`language` (`:281`). Endpoint is `${WHISPER_BASE_URL}/inference` (`lib/whisper.ts:235`).

Call replicating those fields against `127.0.0.1:8080` with the 11.0 s clip:
**`http=200`, 1.36 s wall** (0.12× realtime).

### Exact top-level keys (8)

```
task                          string   "transcribe"
language                      string   "english"
duration                      number   11.0
text                          string   (full transcript)
segments                      array    len=2
detected_language             string   "english"
detected_language_probability number   0.984870195388794
language_probabilities        object   {en,de,es,ru,fr,pt}
```

`language_probabilities` verbatim (a 6-entry top-N, not the full 99-language distribution):

```json
{"en":0.984870195388794,"de":0.0027270540595054626,"es":0.0027906489558517933,
 "ru":0.0018678378546610475,"fr":0.0019922710489481688,"pt":0.0012386629823595285}
```

The last three keys (`detected_language`, `detected_language_probability`,
`language_probabilities`) are **not** part of OpenAI's `verbose_json` contract — they are additions
in this whisper.cpp build. Slice C may rely on them **only** against this Mini's binary.

### Exact segment shape (9 keys)

```
id            number
text          string
start         number   (seconds, float)
end           number   (seconds, float)
tokens        array of number
words         array of object
temperature   number
avg_logprob   number
no_speech_prob number
```

Segment `[0]` verbatim, text elided:

```json
{"id":0,"text":"<elided>","start":0.32,"end":6.33,
 "tokens":[400,370,11,452,7177,6280,11,1029,406,437,428,1941,393],
 "words":[ … 13 entries … ],
 "temperature":0.0,"avg_logprob":-0.03738771006464958,"no_speech_prob":3.117578070699345E-11}
```

Both segments: `id 0 → start 0.32, end 6.33`; `id 1 → start 6.33, end 10.37`. There is **no `t0`/`t1`
pair** — timings are the float-seconds `start`/`end` only.

### Per-word timings are present — the significant finding

Each `words[]` entry has four keys:

```json
{"word":" And","start":0.01,"end":0.2,"t_dtw":-1,"probability":0.9464415311813354}
```

`t_dtw` is `-1` on every word in the capture, i.e. DTW token-level alignment is **off** in this
build's invocation; the `start`/`end` values are the decoder's own word timestamps.

Two cautions for the spec:

1. Word timings are **not** clamped to their parent segment. Segment 0 spans `0.32 → 6.33`, but its
   first word starts at `0.01` and its last captured word ends at `4.44`. Any code that assumes
   `segment.start <= word.start` will be wrong on the first word of a segment.
2. `no_speech_prob` came back in Java/E-notation (`3.117578070699345E-11`). This is valid JSON and
   `JSON.parse` handles it, but a hand-rolled or regex-based number parser will not.

---

## 3. `lib/stt/registry.ts` — adapter interface, registered engines, `resolveRouting("room")`

**Status: VERIFIED** for the code; the live routing table is VERIFIED separately via the Scribe
operator door.

### A. The interface an adapter must satisfy

`registry.ts:4` imports the type; it is declared in `lib/stt/types.ts:47-58`:

```ts
// lib/stt/types.ts:47-58
export interface SttAdapter {
  key: string;
  capabilities: SttCapabilities;
  transcribe(audio: Buffer, opts: { contentType: string; language?: string; longForm?: boolean; mode?: "transcribe" | "translate" }): Promise<SttTranscribeResult>;
  generateNote?(audio: Buffer, opts: { contentType: string; language?: string; template?: string }): Promise<SttNoteResult>;
  health(): Promise<SttHealth>;
}
```

Required: `key`, `capabilities`, `transcribe`, `health`. **`generateNote` is the only optional
member.** Supporting types:

- `SttCapabilities` (`types.ts:7-14`): `{ tiers: SttTier[]; stages: SttStage[]; languages: SttLang[]; streaming: boolean; translates: boolean; async: boolean }`
- `SttTier = "asr" | "scribe"`; `SttStage = "live" | "note" | "diarize" | "room"`; `SttLang = "english" | "indic" | "multi"` (`types.ts:3-5`)
- `SttTranscribeResult` (`types.ts:16-35`): `{ original: string|null; english: string|null; language: string|null; latencyMs: number; costUsd: number|null; engineVersion?: string|null; error: string|null }`
- `SttNoteResult` (`types.ts:37-43`): `{ note: unknown; noteText: string|null; latencyMs: number; costUsd: number|null; error: string|null }`
- `SttHealth` (`types.ts:45`): `{ ok: boolean; latencyMs: number; error?: string }`

**Note for Slice C:** `transcribe` returns a *flat* result — one `language`, one string. There is no
per-segment channel in this interface. Any per-segment engine/lang output (item 4) cannot be carried
through `SttAdapter` as it stands; it needs either an interface change or an out-of-band write.

### B. Engines registered today — 9, all unconditional

`ADAPTERS` is built at `lib/stt/registry.ts:15-25` from nine top-level static imports
(`registry.ts:5-13`). **No registration is env-gated**; `adapterFor(key)` is a plain lookup,
`ADAPTERS[key] ?? null` (`registry.ts:27-29`).

| key | adapter file |
|---|---|
| `deepgram` | `lib/stt/adapters/deepgram.ts` |
| `whisper` | `lib/stt/adapters/whisper.ts` |
| `sarvam` | `lib/stt/adapters/sarvam.ts` |
| `elevenlabs` | `lib/stt/adapters/elevenlabs.ts` |
| `ekascribe` | `lib/stt/adapters/ekascribe.ts` |
| `elevenlabs_scribe` | `lib/stt/adapters/elevenlabs-scribe.ts` |
| `indicconformer` | `lib/stt/adapters/indicconformer.ts` |
| `indicconformer_scribe` | `lib/stt/adapters/indicconformer-scribe.ts` |
| `gemini` | `lib/stt/adapters/gemini.ts` |

Gating happens *inside* adapters at call time, on env var **names** (values never read here):
`DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY`, `EKACARE_CLIENT_ID`/`EKACARE_CLIENT_SECRET`, `GEMINI_STT`
(+`GCP_SA_KEY`), `SARVAM_API_KEY`, `WHISPER_BASE_URL`, `INDICCONFORMER_BASE_URL`.
`elevenlabs-scribe.ts` and `indicconformer-scribe.ts` read no env var directly.

**Live `stt_engine` has 10 rows, not 9** (Scribe operator door). The extra row is `even_pipeline`
("Even pipeline (ASR → LLM note)", `virtual: true`, `enabled: true`) — it has **no code adapter**.
`ekascribe` is the only disabled row, which is why the store reports `engines_enabled: 9`.

### C. `resolveRouting` — the signature is not what the question assumed

**There is no single-argument `resolveRouting("room")` anywhere in the repo.** It takes two required
arguments:

```ts
// lib/stt/routing.ts:11-14
export type Stage  = "live" | "note" | "diarize" | "room";
export type Bucket = "english" | "indic" | "default";
export async function resolveRouting(stage: Stage, bucket: Bucket): Promise<string | null>
```

`"room"` is the **stage**. The only call site pairing it with a bucket:

```ts
// lib/stt/room-drain.ts:488
const engineId = await resolveRouting(DRAIN_STAGE, bucketFor(decided));
```

where `DRAIN_STAGE = "room" as const` (`room-drain.ts:96`) and `bucketFor` returns `"english"` or
`"indic"` only (`room-drain.ts:212-214`) — never `"default"`.

Inputs it reads: the two arguments, and three DB reads. **No env vars, no config constants.**

Decision path (`routing.ts:15-31`): look up `(stage, bucket)` in `stt_routing`; if that row is
missing or its `engine_id` is the literal `'auto'`, fall back to `(stage, 'default')`; if that is
also missing or `'auto'`, return `null`. Otherwise require **both** `stt_engine.enabled = true` and
`adapterFor(engine_id) !== null`, else return `null`. Any thrown error is swallowed → `null`
(`routing.ts:29-31`). `null` means "no override, use built-in default logic" — the caller treats it
as a hard stop:

```ts
// lib/stt/room-drain.ts:488-492
const adapter = engineId ? adapterFor(engineId) : null;
if (!engineId || !adapter) {
  const attempts = await recordFailure(windowId, "no_engine", `stage=room bucket=${bucketFor(decided)}`);
  return { ...out, step: "no_engine", attempts };
}
```

### What it decides for `"room"` TODAY — live table (VERIFIED, Scribe operator door)

```
stage=room  bucket=english -> engine_id "sarvam"   (updated_at 2026-08-23 02:23:40+00)
stage=room  bucket=indic   -> engine_id "sarvam"   (updated_at 2026-08-23 02:23:40+00)
```

`sarvam` is `enabled: true` and has a code adapter, so **`resolveRouting("room", …)` returns
`"sarvam"` for both buckets** — the room stage is single-engine today, with no language split in
effect.

There is **no `(room, 'default')` row** in the live table (the six rows are `live`/`note`/`room` ×
`english`/`indic`). The fallback branch at `routing.ts:20-22` therefore has nothing to find: if
either room row were deleted or set to `'auto'`, `resolveRouting` would return `null` and every room
window would fail `no_engine`. That is a single-point-of-failure worth a spec note.

### Two mismatches worth flagging

1. **Capability/routing mismatch.** `sarvam`'s live `capabilities_json.stages` is `["live","note"]`
   — it does **not** declare `"room"`. Yet it is the engine the room stage routes to. `resolveRouting`
   checks only `enabled` and adapter existence; **it never consults `capabilities`**
   (`routing.ts:24-27`). The one engine declaring `stages:["room",…]` is `gemini`, whose live health
   is `ok:false, error:"gemini_stt_disabled"` and whose `fanout_enabled` is `false`.
2. **`even_pipeline` is routable-but-unadapted.** It is `enabled: true` in `stt_engine` with no entry
   in `ADAPTERS`. If any routing row were pointed at it, `resolveRouting` would silently return
   `null` (the `adapterFor` guard), producing `no_engine` rather than a clear configuration error.

---

## 4. `transcription_run` — columns, per-segment persistence, leaderboard read

**Status: VERIFIED against repo source. UNVERIFIED against the live database** — there is no DB in
this sandbox, and I could not confirm which migrations have actually been applied.

### A. Full column list

The drizzle model (`db/schema.ts:269-295`) declares 22 columns:

`id` text PK · `encounter_id` text NOT NULL FK→encounter(id) ON DELETE CASCADE · `engine` text NOT
NULL · `mode` text NOT NULL · `detected_language` text · `transcript_original` text ·
`transcript_english` text · `latency_ms` integer · `judge_score` numeric(4,2) · `is_winner` boolean
NOT NULL DEFAULT false · `error` text · `tier` text NOT NULL DEFAULT 'asr' · `stt_engine_id` text ·
`cost_usd` numeric(10,5) · `wer` double precision · `cer` double precision · `med_term_recall` double
precision · `agreement_score` double precision · `note_text` text · `note_json` jsonb ·
`metrics_json` jsonb NOT NULL DEFAULT `'{}'::jsonb` · `created_at` timestamptz NOT NULL DEFAULT now().
Index `idx_transcription_run_encounter` on `(encounter_id, created_at)`.

Base DDL: `db/migrations/0006_multilingual_transcription.sql:20-33` (13 columns); extended by
`db/migrations/0019_stt_fanout.sql:9-19`.

### **`db/schema.ts` is STALE — flag this loudly**

Eleven further columns exist only in raw SQL migrations and were **never added to the drizzle
model**, yet live code reads and writes them by name:

| column | type | source |
|---|---|---|
| `subject_type` | text NOT NULL DEFAULT `'encounter'`, CHECK IN (`'encounter'`,`'bench_window'`) | `0058_run_subject_add.sql:65-66,94-98`; `0059_run_subject_agree.sql:23-27` |
| `subject_id` | text NOT NULL (after backfill) | `0058_run_subject_add.sql:68-69,92` |
| `encounter_id` | **NOT NULL dropped** → nullable, CHECK `subject_type <> 'encounter' OR encounter_id IS NOT NULL` | `0060_run_encounter_nullable.sql:23,25-29` |
| `initiated_by` | text | `0072_evidence_spine.sql:62-63` |
| `initiated_via` | text, CHECK IN (`'mcp'`,`'admin_route'`,`'cron'`) NOT VALID | `0072_evidence_spine.sql:64,74-84` |
| `engine_version_reported` | text | `0072_evidence_spine.sql:65` |
| `audio_r2_key` | text | `0072_evidence_spine.sql:66` |
| `audio_byte_start` | bigint | `0072_evidence_spine.sql:67` |
| `audio_byte_end` | bigint | `0072_evidence_spine.sql:68` |
| `audio_sha256` | text | `0072_evidence_spine.sql:69` |
| `receipt_complete` | boolean GENERATED ALWAYS … STORED | `0072_evidence_spine.sql:86-102` |

`lib/stt/room-drain.ts:585-635` inserts `subject_type, subject_id, initiated_by, initiated_via,
engine_version_reported, audio_r2_key, audio_byte_start, audio_byte_end, audio_sha256` directly.
Anyone generating types or a migration from `db/schema.ts` will drop these columns. This is a real
trap for Slice C and is **outside my contract to fix** — reporting only.

### B. Can per-segment engine + lang be persisted without a migration? — **Yes**

**The column is `metrics_json`** — `jsonb NOT NULL DEFAULT '{}'::jsonb` (`db/schema.ts:291`;
`db/migrations/0019_stt_fanout.sql:18`). It is the one unstructured, freely-extensible column.

What is written there today (every write site):

- `lib/stt/room-drain.ts:596-631` — window drain. Keys: `probe_language, probe_seconds, probe_engine,
  full_window_language, language_sent, sarvam_language, segment_count, activity, whisper_probe_ms,
  whisper_probe_attempts, whisper_full_ms, whisper_full_attempts, whisper_model_reported,
  audio_seconds, clip_r2_key, window:{start_ms,end_ms,source_mic}`.
- `lib/stt/scoring.ts:119` — merges `{judge_rank, judge_reasoning, agreement_n, scored_at}`.
- `lib/stt/scoring.ts:231,308,345` — merges judge/translate scoring metadata.
- `lib/stt/translate-bakeoff.ts:51` — merges a translate-tier scoring `meta`.
- `lib/stt/fanout.ts:296` — removes `scored_at` on reset (`metrics_json - 'scored_at'`).
- `lib/stt/measure-job.ts:195-206` — **reads** `full_window_language` and `sarvam_language` back out.

Every existing key is a scalar or a small flat object, merged with the `||` operator. **Crucially,
`segment_count` is stored but the segment array itself is not** (`room-drain.ts:578` computes
`full.segments`, and only its length reaches `metrics_json`). So a new top-level key such as
`metrics_json.segments = [{start_ms, end_ms, engine, lang}, …]` would **not collide** with anything
written today, and the existing merge idiom
`COALESCE(metrics_json,'{}'::jsonb) || $meta::jsonb` supports it with **no migration**.

**No per-segment table exists.** `transcription_segment` / `transcriptionSegment` appear nowhere in
the repo. The nearest analogue is the generic `cue` table
(`db/migrations/0042_brain_tables.sql:62-68`: `id, room_day_id, type, payload jsonb, at, created_at`),
which already carries per-turn ASR output as `type='stt_turn'` (`room-drain.ts:639-660`) — but it is
keyed by `room_day_id` and time, with **no FK to `transcription_run.id`**, so it cannot answer
"which engine produced segment N of run X".

Caveat for the spec: `metrics_json` is a single jsonb blob rewritten by several independent writers
via `||`. Adding a large per-segment array makes every one of those merges rewrite the whole array.
The key name and shape are a **design decision for the Orchestrator**, not mine to settle.

### C. How the leaderboard reads it — two different leaderboards

These are **not** variants of one query; they read different tables and are called by different
routes.

**(i) `computeLeaderboard`, `lib/stt/leaderboard.ts:48-130` — reads `transcription_run`.**

```sql
-- lib/stt/leaderboard.ts:58-92 (INFERRED; verbatim from the template literal)
SELECT tr.engine,
       MAX(eng.display_name) AS display_name,
       COUNT(*)::int AS runs,
       COUNT(*) FILTER (WHERE tr.error IS NULL)::int AS ok,
       ROUND(AVG(tr.latency_ms) FILTER (WHERE tr.error IS NULL))::int AS avg_latency_ms,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY tr.latency_ms) FILTER (WHERE tr.error IS NULL) AS p95_latency_ms,
       ROUND(AVG(tr.judge_score)::numeric, 2)::float8 AS avg_judge,
       ROUND(AVG(tr.agreement_score)::numeric, 3)::float8 AS avg_agreement,
       COUNT(*) FILTER (WHERE tr.wer IS NOT NULL)::int AS gold_n,
       ROUND(AVG(tr.wer)::numeric, 3)::float8 AS avg_wer,
       ROUND(AVG(tr.cer)::numeric, 3)::float8 AS avg_cer,
       ROUND(AVG(tr.med_term_recall)::numeric, 3)::float8 AS avg_term_recall,
       COUNT(*) FILTER (WHERE tr.is_winner)::int AS wins,
       MAX(eng.cost_per_min_usd)::float8 AS cost_per_min
  FROM transcription_run tr
  LEFT JOIN encounter e ON e.id = tr.encounter_id
  LEFT JOIN stt_engine eng ON eng.id = tr.engine
 WHERE tr.mode = 'batch' AND tr.tier = ${tier}
   AND ( ${subjectKind} = 'all' OR tr.subject_type = ${subjectKind} )
   AND ( ${bucket} = 'all' OR (...) OR (...) )
   AND ( ${sinceVal}::int IS NULL OR tr.created_at >= NOW() - ((${sinceVal})::int || ' days')::interval )
 GROUP BY tr.engine
 ORDER BY tr.engine
```

**GROUP BY is `tr.engine`** (`leaderboard.ts:90`) — one row per engine string. A weighted 0-100
`composite` is then blended in JS (`leaderboard.ts:105-124`) from `stt_lab_config.weights_json`
merged over `DEFAULT_WEIGHTS`. Called **only** from
`app/api/admin/stt-lab/leaderboard/route.ts:11,26`.

**(ii) `buildLeaderboard`, `lib/stt/window-leaderboard.ts:54-87` — touches no table at all.** The
file header states "PURE. No database, no fetch." (`window-leaderboard.ts:4`). It groups already-fetched
rows in JS by `engine_key` (`:63`). Its SQL lives in the caller,
`app/api/admin/stt-leaderboard/route.ts:66-74`, and reads **`stt_window_score`**, not
`transcription_run`:

```sql
-- app/api/admin/stt-leaderboard/route.ts:66-74 (INFERRED)
SELECT s.engine_key, f.family,
       (s.metrics_json->>'wer')::float8 AS wer,
       (s.metrics_json->>'cer')::float8 AS cer
  FROM stt_window_score s
  LEFT JOIN stt_engine_family f ON f.engine_key = s.engine_key
 WHERE s.metrics_json ? 'wer'
```

Its only GROUP BY is on the companion refusal query,
`GROUP BY engine_key, reason_code` (`route.ts:81-83`).

**Direct consequence for Slice C:** the `transcription_run` leaderboard groups by **engine per run**.
If per-segment engine/lang lands inside `metrics_json.segments`, this leaderboard **will not see it**
— a run whose segments used three engines still aggregates under its single `tr.engine` value.
Scoring per-segment-engine requires either a new query that unnests the JSON, or the
`stt_window_score` path. That is a spec decision, and it is the single biggest structural finding in
this item.

---

## 5. `stt_gold` — keying, counts, and whether any Indic corpus exists

**Status: schema VERIFIED. Counts UNVERIFIED — and this is the item that most affects the plan.**

### A. Columns (`db/migrations/0020_stt_gold.sql:6-16`)

```sql
CREATE TABLE IF NOT EXISTS stt_gold (
  encounter_id        text PRIMARY KEY REFERENCES encounter(id) ON DELETE CASCADE,
  reference_original  text,
  reference_english   text,
  reference_language  text,
  critical_terms_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  terms_model         text,
  labeled_by_admin_id text,
  labeled_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
```

The drizzle mirror (`db/schema.ts:320-329`) matches exactly, and no later migration alters the table
(`grep "ALTER TABLE stt_gold"` → no hits). Unlike `transcription_run`, this model is **not** stale.

### B. How windows are keyed — they are not windows

**The primary key is `encounter_id`, and it is the only key.** There is no window id, no start/end
offset, and no hash. One gold row = one *whole encounter*. Writes are upserts:
`ON CONFLICT (encounter_id) DO UPDATE` (`lib/stt/scoring.ts:257`).

The codebase states the consequence itself, in `db/migrations/0072_evidence_spine.sql:201`:
*"Separate from stt_gold, whose PK IS encounter_id with an FK to encounter — which is why a room
window could never be a gold subject there."* A room/bench window **cannot have a row in
`stt_gold` at all**. That is why `stt_gold_window` was added
(`0072_evidence_spine.sql:181-191`), keyed on `window_id`, with columns `window_id, reference_text,
source, seed_engine_family, produced_by, verified_by, verified_at, status, covered_ms, window_ms,
silence_spans_json, created_at`. **`stt_gold_window` has no language column whatsoever.**

### C. Language labelling — a column exists, but it is unconstrained free text

`reference_language text` (`0020_stt_gold.sql:10`, `db/schema.ts:325`): nullable, no default, **no
CHECK, no enum, no normalisation anywhere in the code.** It is written verbatim from admin input —
`app/api/admin/stt-lab/gold/[id]/route.ts:44` takes `body.referenceLanguage` and passes it to
`saveGold`, which writes `${opts.referenceLanguage ?? null}` (`lib/stt/scoring.ts:254-255`).
Nothing computes or validates it. There is no code-mix flag, no script field, and no tags array.
`critical_terms_json` holds `[{term,type}]` medical terms, not language data.

So even where a label exists, `"Kannada"`, `"kn"`, `"kannada"` and `"Kannada+English"` are all equally
legal and would not group. **A bake-off cannot filter on this column reliably without a
normalisation step or a CHECK constraint** — that is a spec decision.

### D. Seed data in the repo — **none**

Searched `fixtures/`, `scripts/`, `tests/`, `docs/` and the whole tree for any CSV/JSON/SQL that
populates `stt_gold`. **There is none.** `fixtures/` holds only
`fixtures/health-probe-0.5s-16k-mono.webm` and `fixtures/warehouse/synthetic-19-aug.json`, neither
STT-gold related. The only `INSERT INTO stt_gold` in the repo is the runtime admin upsert
(`lib/stt/scoring.ts:254`). Repo-side count of gold rows labelled Indic / Kannada / Hindi / Tamil /
Telugu / Malayalam / Marathi / Bengali / code-mixed / Hinglish: **0, because there is no data file to
count.**

A conditional seed for the *different* table `stt_gold_window` exists at
`0072_evidence_spine.sql:259-282`: up to 5 rows from one Cardiology session, `ON CONFLICT DO
NOTHING`, guarded on live `transcription_run` rows existing. Actual inserted count is 0–5,
**UNVERIFIED**. It carries no language label either.

### E. Every insert path

Exactly one: `lib/stt/scoring.ts:254`, inside `saveGold()` (`:239`), reached from
`PUT /api/admin/stt-lab/gold/[id]` (`app/api/admin/stt-lab/gold/[id]/route.ts:38-63`, admin auth,
non-viewer, `:41-42`). i.e. **a human labelling one encounter by hand in the admin UI.** Deletion is
`lib/stt/scoring.ts:271` via `DELETE` on the same route (`:78`).

### F. Live counts — BLOCKED, and what I could establish

The Scribe operator door tool that carries per-subject `has_gold` and `detected_language`
(`scribe_list_stt_runs`) was **denied by the PII classifier**. I did not attempt to work around it.

What I did establish live (`scribe_store_stats`, 2026-09-12):

```
encounters: total 105, today_ist 0
bench:      sessions 202 (196 ended, 6 recording), chunks 4237 verified (6.76 GB), consult_marks 29
stt:        engines_enabled 9
brain:      room_days_today 8, cues_today 2
```

Because `stt_gold.encounter_id` is a PK with an FK to `encounter`, **`stt_gold` has at most 105
rows** — that is a hard upper bound, not a count. The actual number, and how many carry any Indic
`reference_language`, remain **UNVERIFIED**. See "What I could not settle" at the end.

### Read for the spec

Independent of the exact count, three structural facts already decide a lot:

1. Gold is **encounter-grained, not window-grained**. A window-level bake-off cannot use `stt_gold`;
   it must use `stt_gold_window`, which has **no language column at all**.
2. The only language label in the system is unconstrained free text that no code validates.
3. There is **no seeded corpus in the repo** — every gold row that exists was hand-typed by an admin.

Taken together, the bake-off does not have a ready Indic corpus, and **labelling is very likely the
first task** — but the precise size of the gap needs the one blocked query.

---

## 6. `room_turn_speaker` — schema, row count, and what writes it

**Status: schema and write path VERIFIED in source. Row count UNVERIFIED.**

### A. Schema — SQL only, no drizzle model

`grep "roomTurnSpeaker\|room_turn_speaker" db/schema.ts` → no hits. It exists only as raw SQL:

```sql
-- db/migrations/0074_room_diarize.sql:138-148
CREATE TABLE IF NOT EXISTS room_turn_speaker (
  window_id   text NOT NULL,
  source_ref  text NOT NULL,
  speaker_idx integer NOT NULL,
  cluster_id  text,
  /** How many milliseconds the claim rests on — a 60/40 turn is visible as one. */
  overlap_ms  integer NOT NULL DEFAULT 0,
  room_day_id text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (window_id, source_ref)
);
```

Composite PK `(window_id, source_ref)`. No FKs are declared (deliberate — see the sibling-table
comment at `:108-110`). Indexes `idx_room_turn_speaker_cluster (cluster_id)` and
`idx_room_turn_speaker_day (room_day_id)` (`:155-156`). `source_ref` is the turn's natural key,
`{session_id}|{start_ms}|{end_ms}|{speaker}` (per migration 0050).

### B. Every reference in the repo

| Location | Kind |
|---|---|
| `db/migrations/0074_room_diarize.sql:138,150-156` | definition + indexes |
| `lib/stt/diarize-job.ts:377` | **WRITE (the only one)** |
| `tests/unit/room-diarize-job.test.ts:316` | test — asserts the migration text contains the CREATE TABLE |
| `docs/handoff/ETA-SCRIBE-UPGRADE-PLAN-11-SEP-2026.md:40` | doc |
| `docs/handoff/ETA-TIER2-SPEC-SLICE-C-…-12-SEP-2026.md:44,71,112` | doc (spec, unbuilt) |
| `docs/handoff/ETA-AUDIT-B-…-11-SEP-2026.md:235-237` | doc |

**There is no READ anywhere in `app/` or `lib/`.** Nothing consumes this table today — note
generation included.

### C. A write path EXISTS, but it ships dark

```sql
-- lib/stt/diarize-job.ts:376-380  (INFERRED SQL #7 — idempotent per (window, turn))
INSERT INTO room_turn_speaker (window_id, source_ref, speaker_idx, cluster_id, overlap_ms, room_day_id, created_at)
VALUES (${w.id}, ${b.source_ref}, ${b.speaker_idx}, ${byIdx.get(b.speaker_idx) ?? null}, ${b.overlap_ms}, ${w.room_day_id}, NOW())
ON CONFLICT (window_id, source_ref) DO NOTHING
```

Caller chain: Vercel cron `*/5 * * * *` (`vercel.json:20-23`, path
`/api/admin/diarize-windows`) → `GET|POST /api/admin/diarize-windows`
(`app/api/admin/diarize-windows/route.ts:32,69`) → `runRoomDiarizePass()`
(`lib/stt/diarize-job.ts:95`) → `writeClusters()` (`:194`) → `bindTurns()` (`:195`, `:336`) →
the INSERT.

**Both gates are off by default:**

1. `SPEAKER_CLUSTERS_ENABLED` — `diarize-job.ts:106`, `if (!clustersEnabled())` returns early with
   zero DB calls. `tests/unit/room-diarize-job.test.ts:76-88` asserts this is the shipped state.
2. `SPEAKER_MATCH_THRESHOLD` — `diarize-job.ts:115-122`, refuses when unset or invalid (unless
   `dry=1`, which stops before clustering anyway, `:189`).

So the honest answer is: **code exists and is unit-tested against a mocked DB; whether it has ever
executed against production is UNVERIFIED.** The live system map's `env_set` block does not report
either variable — but that block is a fixed allowlist of names, so absence there is **not** evidence
they are unset. I am not inferring either way.

The unbuilt Slice C spec (`ETA-TIER2-SPEC-SLICE-C-…:44`, decision D16) proposes a *second*,
job-kind-based diarize path and describes `room_turn_speaker` as a table "that nothing currently
writes for this path". That is consistent with what I found — it refers to that new path, not a
contradiction of the existing cron writer.

### D. Row count

**UNVERIFIED.** No live DB in this sandbox; no doc or fixture records a count; the operator-door tool
that could have shown per-window data was PII-blocked.

---

## 7. `POST /route/job` — async shape, polling, and whether it beats our own windowing

**Status: VERIFIED** (source read + a real job submitted, polled and completed).

### Request — JSON body, not multipart

This differs from `POST /route`, which is multipart. `/route/job` reads a JSON body
(`router_server.py:663-683`):

| Field | Type | Required | Default |
|---|---|---|---|
| `audio_url` | string | **yes** | — | 400 `{"ok":false,"error":"audio_url required"}` if absent/empty |
| `candidates` | string | no | `ETA_DEFAULT_CANDIDATES` = `"en,kn,hi,ta,te"` | comma-separated |
| `translate` | bool | no | `true` |
| `window_s` | number | no | `ETA_WINDOW_S` = `180` |

`audio_url` is fetched server-side with `requests.get(..., stream=True)` (`router_server.py:551-557`)
— it must be an HTTP(S) URL the Mini can reach; a local path or `file://` will not work. A
non-JSON body returns 400 `{"ok":false,"error":"invalid JSON body"}`.

### Submit response — ACTUAL

```
POST /route/job {"audio_url":"…/clip11s.wav","translate":false,"candidates":"en,kn,hi"}
-> http=200, 0.093 s
{"ok":true,"job_id":"197594b9280440afa97db3fd380b6303"}
```

Two keys only. `job_id` is a 32-char hex uuid4. The work runs on a daemon thread
(`router_server.py:680-681`); jobs are JSON files under `~/eta-router/jobs`, TTL
`ETA_JOB_TTL_SEC` = 3600 s, cleaned opportunistically on each submit (`:682`).

### Polling endpoint — `GET /route/job/{job_id}`

Unknown id → **404** `{"ok":false,"error":"unknown job_id"}` (`router_server.py:685-691`).

The poll payload carries the **same 12 keys in every state** — they are pre-seeded at job creation
(`router_server.py:562-566`), so a consumer can read the same shape while running:

```
ok  job_id  state  progress  dominant_language  language_timeline
transcript_native  transcript_english  segments  engine_versions  sec  error
```

Running (captured):

```json
{"state":"running","progress":{"done":0,"total":1},"sec":0.0,"ok":true,"error":null,
 "segments":[],"language_timeline":[],"dominant_language":null}
```

Done (captured, **14.36 s for an 11.0 s clip** ≈ 1.3× realtime with `translate:false`):

```json
{"state":"done","progress":{"done":1,"total":1},"sec":14.36,"ok":true,"error":null,
 "dominant_language":"en","transcript_english":null}
```

`state` ∈ `queued` | `running` | `done` | `failed` (`:562`, `:607`, `:612`). On failure:
`state:"failed"`, `ok:false`, `error` = a repr truncated to 300 chars (`:612-613`).
`progress` is `{done, total}` in **outer windows**, updated after each one (`:599-606`).

A `segments[]` element and a `language_timeline[]` element, verbatim:

```json
{"start_s":0.3,"end_s":10.6,"lang":"en","engine":"whisper","text":"<elided>"}
{"start_s":0.3,"end_s":10.6,"lang":"en","engine":"whisper","chars":109}
```

`engine_versions`: `{"whisper":"large-v3-turbo","indicconformer":"600M","sravaani":"SraVaani-1.0"}`.

### A real gap: `segmentation` is dropped by the async path

`POST /route` (sync) returns a `segmentation` object —
`{method, max_window_s, overlap_s, n_segments}` (`router_server.py:509-511`), where `method` is
`"fixed-window"` or the VAD method. **The job payload has no `segmentation` key at all**: `run_job`
never copies it into the job dict (`:562-566`, `:599-606`). Confirmed on the captured response.
So a `/route/job` consumer cannot tell whether VAD or the fixed-window fallback produced the spans.
If Slice C needs that provenance, it is a **change request against the router**, not something the
current API can supply.

### How the router actually windows (`router_server.py:56-65, 195-215, 460-518, 560-598`)

Two levels:

- **Outer:** ffmpeg time-split into `window_s` chunks (default **180 s**), purely for incremental
  progress; each is processed under a semaphore, one at a time.
- **Inner:** per chunk, Silero VAD picks spans (`ETA_USE_VAD=1`); on any failure it falls back to
  fixed **30 s** windows with **1 s** overlap (`SEG_SEC=30`, `OVERLAP_SEC=1`, `plan_segments`
  at `:200-207`). Spans run concurrently through a `ThreadPoolExecutor` bounded by `MAX_INFLIGHT`.

Per span it selects a language among the candidates and an engine, then optionally translates each
span via Ollama.

### My read: yes, better than our own windowing beyond 30 s — with two conditions

**Recommendation: adopt `/route/job` for audio longer than 30 s, rather than extending our own
windowing.** The reason is not the async plumbing — it is that the router solves a problem our
windowing does not attempt.

1. **It is VAD-first, not clock-first.** Our room drain cuts on a fixed clock. The router cuts on
   speech boundaries and only falls back to a fixed grid when VAD fails. Clock-cut windows slice
   mid-word, and every slice is a transcription error at the seam. This matters more, not less, as
   audio gets longer, because the seam count grows linearly.
2. **It already emits exactly what item 4 wants.** `language_timeline` is per-span
   `{start_s, end_s, lang, engine, chars}` — per-segment language *and* per-segment engine, already
   computed. Building that ourselves means reimplementing per-span language selection across five
   candidate languages and three engines. That is the single strongest argument here: **items 4 and 7
   are the same problem, and the router has already solved it.**
3. **Measured cost is better than budgeted.** 14.36 s for 11.0 s of audio = **1.3× realtime** with
   `translate:false`, against the ~3.5× realtime assumption. The gap is translation: with
   `translate:true` every non-English span makes a serialised Ollama call. **UNVERIFIED:** I did not
   measure a translate-enabled or a multi-window job, and 11 s is a single-span job that never
   exercises the outer split — so this figure is a floor, not a throughput model.

The two conditions:

- **`audio_url` must be reachable.** The job pulls the audio itself. Our clips live in R2, so this
  means a presigned URL with a TTL longer than the job. That is a real integration cost and a
  security decision (a presigned URL to clinical audio, fetched over the tunnel) that the
  Orchestrator must rule on. It is the main argument *against*.
- **No callback, no idempotency key.** Polling only, jobs vanish after 3600 s, and resubmitting the
  same audio creates a second job with a new id and duplicate work. Any caller needs its own
  poll loop, its own TTL discipline, and its own dedupe.

For audio **under 30 s** the sync `POST /route` is the better call — one span, no job file, no
polling, and it returns the `segmentation` block the async path drops.

---

## 8. emotion with input longer than 60 s — 400, truncate, or silent success?

**Status: VERIFIED** (source read + real clips tested). **It returns a hard HTTP 400. It does not
truncate and does not silently succeed.**

### The limit is 60 s live, but 120 s in the code

```python
# /Users/vinaybhardwaj/eta-emotion/app.py:53
MAX_DURATION_S = float(os.environ.get("EMOTION_MAX_DURATION_S", "120"))
```

The **code default is 120**. The **live process reports 60.0** — `GET /health` returns
`"max_duration_s": 60.0`, so `EMOTION_MAX_DURATION_S` is set to 60 in this deployment. Anyone reading
only the source will get this wrong by a factor of two. The spec must cite the runtime value, and
ideally the service should be asked for it via `/health` rather than hard-coded.

### Measured behaviour — 66.0 s clip

All three endpoints, identical:

```
POST /inference                  -> http=400, 0.494 s
POST /inference/emotion2vec      -> http=400, 0.388 s
POST /inference/wavlm            -> http=400, 0.352 s
{"ok":false,"error":"audio longer than max_duration_s=60.0","duration_s":66.0}
```

The rejection is at `app.py:729-738`, on an `ffprobe` duration measured **after** ffmpeg
normalisation but **before** any model runs — which is why it costs ~0.4 s rather than a full
inference.

### Boundary (VERIFIED by test): the comparison is a strict `>`

```
59 s clip -> http=200
61 s clip -> http=400
```

Consistent with `if dur_probe > MAX_DURATION_S` (`app.py:730`). A clip of exactly 60.0 s passes.

### The truncation branch is unreachable — a latent trap

`app.py:745-747` contains real truncation logic:

```python
if duration_s > MAX_DURATION_S:
    audio = audio[: int(MAX_DURATION_S * SR)]
    duration_s = float(len(audio)) / SR
```

But it sits **after** the 400 return at `:730-738`, so on the `/inference*` paths it is dead code —
anything long enough to trigger it has already been rejected. It could only fire if
`ffprobe_duration` and `read_mono_float32` disagreed across the boundary (e.g. ffprobe 59.9 s,
decode 60.1 s), in which case the service would silently truncate instead of erroring. **Do not
design against truncation**: the observable contract is a 400.

### Success shape, for contrast (11.0 s clip)

```json
{"ok":true,"model_key":"wavlm","model":"Aniemore/wavlm-emotion-v1-crosslingual","device":"mps",
 "labels":{"anger":0.8796,"disgust":0.0271,"enthusiasm":0.0304,"fear":0.0029,
           "happiness":0.0240,"neutral":0.0308,"sadness":0.0051},
 "top":[…5 entries, descending…],"duration_s":11.0,"inference_s":1.044,"subfolder":"int8"}
```

Two models are loaded and selectable (`/health`): `wavlm`
(`Aniemore/wavlm-emotion-v1-crosslingual`, int8, 7 labels) — the default — and `emotion2vec`
(`emotion2vec/emotion2vec_plus_large`, 9 labels including `unknown` and `other`).

### Latency: cold start is 40×, warm is fine

The **first** 11 s call took `inference_s: 39.629`. Immediately repeated: `inference_s: 1.044`.
`emotion2vec` warm: `1.001`. So warm cost is ~1.0 s for 11 s of audio (≈0.09× realtime), and the
39.6 s figure is a one-off warm-up. **Any latency budget in the spec must state warm vs cold**, and
anything user-facing should keep the models warm — a cold call is 40× the warm cost.

### Consequence for Slice C

Clinical windows longer than 60 s **must be split by the caller**. The service will not do it. Since
the rejection is duration-based and cheap, the cleanest pattern is to window to ≤ 60 s up front
rather than probe-and-retry. Whether emotion windows should align with the diarize spans from item 1
or with the router's VAD spans from item 7 is a **design fork the kickoff must settle** — I am not
deciding it.

---

## Flags for the Orchestrator — things the spec should change

1. **`resolveRouting` takes two arguments, not one** (`stage`, `bucket`). Any spec text saying
   `resolveRouting("room")` is wrong and will not compile.
2. **Room routing is single-engine today**: both buckets → `sarvam`. There is **no `(room,'default')`
   fallback row**, so deleting or `'auto'`-ing either room row fails every room window with
   `no_engine`.
3. **`sarvam` does not declare `stages:["room"]`** yet serves the room stage; `resolveRouting` never
   checks `capabilities`. Either the capability data or the check is wrong.
4. **`even_pipeline` is enabled in `stt_engine` with no code adapter** — routable in the table,
   silently `null` in code.
5. **`db/schema.ts` is stale for `transcription_run`** by 11 columns that live code reads and writes
   (`subject_type`, `subject_id`, the whole `0072` receipt block, `receipt_complete`). Generating
   types or a migration from the drizzle model will drop them.
6. **Per-segment engine/lang needs no migration** — `metrics_json` takes it — **but the
   `transcription_run` leaderboard groups by `tr.engine` and will not see it.** Per-segment scoring
   needs a new query or the `stt_window_score` path. This is the biggest structural finding.
7. **Gold is encounter-grained.** `stt_gold`'s PK is `encounter_id`; a window can never have a row.
   `stt_gold_window` exists for windows and has **no language column at all**.
8. **`reference_language` is unvalidated free text** — no CHECK, no enum, no normalisation. A
   bake-off cannot filter on it reliably as it stands.
9. **No gold corpus is seeded in the repo.** Every gold row was hand-typed by an admin.
10. **`room_turn_speaker` has a writer but no reader**, and the writer is behind two env gates that
    are off by default.
11. **`/route/job` drops the `segmentation` block** the sync `/route` returns. If provenance
    (VAD vs fixed-window) matters, that is a router change request.
12. **Emotion's live cap is 60 s, but the code default is 120 s.** Cite the runtime value.
13. **Emotion cold start is ~40× warm** (39.6 s vs 1.0 s for the same 11 s clip).
14. **`/enroll` returns HTTP 200 on failure** with `ok:false`. `/diarize` returns real 4xx. Callers
    must branch on `ok`, not on status.
15. **Whisper word timings can precede their parent segment's start** (word `0.01` inside a segment
    starting `0.32`).

## Verbatim SQL and external-schema assumptions (all INFERRED — no live DB)

Every SQL string below was read from source, not executed. The Orchestrator must validate each
against the live database.

1. `lib/stt/routing.ts:17` — `SELECT engine_id FROM stt_routing WHERE stage = ${stage} AND language_bucket = ${bucket} LIMIT 1`
2. `lib/stt/routing.ts:20` — `SELECT engine_id FROM stt_routing WHERE stage = ${stage} AND language_bucket = 'default' LIMIT 1`
3. `lib/stt/routing.ts:25` — `SELECT enabled FROM stt_engine WHERE id = ${eng} LIMIT 1`
4. `lib/stt/leaderboard.ts:58-92` — the `GROUP BY tr.engine` aggregate quoted in full in item 4C.
5. `app/api/admin/stt-leaderboard/route.ts:66-74` — the `stt_window_score` select quoted in item 4C.
6. `app/api/admin/stt-leaderboard/route.ts:81-83` — refusal counts, `GROUP BY engine_key, reason_code`.
7. `lib/stt/diarize-job.ts:376-380` — the `room_turn_speaker` insert quoted in full in item 6C.
8. `lib/stt/scoring.ts:254-257` — `INSERT INTO stt_gold (…) … ON CONFLICT (encounter_id) DO UPDATE …`
9. `lib/stt/scoring.ts:271` — `DELETE FROM stt_gold …`
10. `lib/stt/fanout.ts:296` — `metrics_json - 'scored_at'`
11. `lib/stt/room-drain.ts:585-635` — the `transcription_run` insert naming `subject_type,
    subject_id, initiated_by, initiated_via, engine_version_reported, audio_r2_key,
    audio_byte_start, audio_byte_end, audio_sha256`.

Table/column shapes for `stt_routing`, `stt_engine`, `stt_window_score`, `stt_engine_family`,
`stt_lab_config` are inferred from these template literals alone.

## What I could not settle, and what I need

**Items 5 and 6 lack their live counts.** The Scribe operator-door tool that carries per-subject
`has_gold` and `detected_language` (`scribe_list_stt_runs`) was denied by the PII classifier. I did
not attempt to work around the denial.

To close them, one of:

- V runs the counts himself and pastes them back. Suggested, identity-free:
  ```sql
  SELECT count(*) AS gold_rows,
         count(*) FILTER (WHERE reference_language IS NOT NULL) AS labelled,
         count(*) FILTER (WHERE lower(reference_language) ~ '(kannada|kn|hindi|hi|tamil|ta|telugu|te|malayalam|ml|marathi|mr|bengali|bn|indic|mixed|hinglish)') AS indic_ish
    FROM stt_gold;
  SELECT lower(reference_language) AS lang, count(*) FROM stt_gold GROUP BY 1 ORDER BY 2 DESC;
  SELECT count(*) FROM stt_gold_window;
  SELECT count(*) AS rows, count(DISTINCT window_id) AS windows FROM room_turn_speaker;
  ```
  These return counts and language labels only — no identifiers, no transcript text.
- Or the Orchestrator grants the PII-gated tool for this one read.

Until then: `stt_gold` ≤ 105 rows (FK bound), exact count and Indic share **UNVERIFIED**;
`room_turn_speaker` row count **UNVERIFIED**.

## Subagents used

- Researcher (Sonnet) — `lib/stt/registry.ts`, `types.ts`, `routing.ts`: adapter interface,
  registered engines, `resolveRouting` inputs and branches. Item 3.
- Researcher (Sonnet) — `transcription_run` columns across `db/schema.ts` and `db/migrations/*.sql`,
  `metrics_json` write sites, both leaderboard read paths. Item 4.
- Researcher (Sonnet) — `stt_gold`, `stt_gold_window`, `room_turn_speaker` schemas, seed-data search,
  and the complete reference classification for the write path. Items 5 and 6.

All three were read-only and edited nothing. Their line citations were spot-checked by me against
the working tree before publication (10 of 10 correct). Items 1, 2, 7 and 8 — the live probes — and
all Scribe operator-door calls were done by me directly.
