# Timbre text lane

Voice-only valence on batch 1 was weak. This lane scores **masked patient text** with Jev and compares it with voice dimensions. It does not import `lib/jev`, does not write `jev_decision`, and does not read `ETA_JEV_ENABLED`. Production Jev is unchanged.

Jev sees text only. The request body is `{model, state, questions}`. For `timbre-text-v1`, `state` is `{"window_text": "<masked>"}`. For `timbre-text-v2`, the same key is the masked native-script text, and `window_gloss` is added only when an English gloss is present. There is no audio field.

## Switch

`score` refuses to run unless `TIMBRE_TEXT_LANE` is `1`, `true`, `yes`, or `on`. Unset is off. Any other value is an error, not off.

`mask`, `from-stt`, and `attribute` are local. They do not call Jev.

## What you need for a real call

| variable | role |
|---|---|
| `TIMBRE_TEXT_LANE=1` | this lane's switch |
| `TYPESAFE_API_KEY` | Vinay's ZDR TypeSafe account. Same key ETA's client sends as `Authorization: Bearer`. Never commit it. |
| `ETA_JEV_MODEL` | optional. Default `jev-1.13.0`, the pin in `lib/jev/client.ts`. |
| `ETA_JEV_TIMEOUT_MS` | optional. Default `15000`, same as the production client. |

Zero data retention is the TypeSafe account, not a JSON field. The production client does not send a `zdr` flag, and this lane does not add one.

`TIMBRE_JEV_MOCK=1` answers locally with model `jev-mock` and opens no socket. A mock cache entry is not reused for a real model.

Cost uses the production input-token rate, `42e-9` USD per token (`lib/jev/counters.ts`). Output tokens are counted and not billed. The cost log is JSONL of hashes, counts, status, and dollars. It never contains the transcript.

## Operator commands

From the repo root, with the harness dependencies installed:

```bash
# 1. Mask an operator file (CSV or JSONL: window_id plus text / masked_text / patient_text).
python -m tools.timbre.text_lane mask \
  --in windows.csv \
  --out masked.jsonl

# 2. Or build that file from a Scribe STT export (see below), then mask.
python -m tools.timbre.text_lane from-stt \
  --in stt.jsonl \
  --out masked.jsonl

# 3. Cut long mixed rows to the patient, using a diarization timeline and/or Nemotron frames.
python -m tools.timbre.text_lane attribute \
  --in stt.jsonl \
  --out patient.jsonl

# 4. Score. Refuses without the switch. Default question set is timbre-text-v1.
#    v2 scores the native text; a gloss column is an aid. Cache key is the masked
#    text, prompt, model, and question set (v2 also includes the masked gloss).
TIMBRE_TEXT_LANE=1 TYPESAFE_API_KEY=... python -m tools.timbre.text_lane score \
  --question-set timbre-text-v2 \
  --in patient.jsonl \
  --out scores-v2.jsonl \
  --cache tools/timbre/text-cache \
  --cost-log scores.cost.jsonl

# v1, for the comparison below. Omit --question-set and the set is timbre-text-v1.
TIMBRE_TEXT_LANE=1 TYPESAFE_API_KEY=... python -m tools.timbre.text_lane score \
  --question-set timbre-text-v1 \
  --in masked-english.jsonl \
  --out scores-v1.jsonl \
  --cache tools/timbre/text-cache \
  --cost-log scores-v1.cost.jsonl

# Stand-in, no key and no network:
TIMBRE_TEXT_LANE=1 TIMBRE_JEV_MOCK=1 python -m tools.timbre.text_lane score \
  --question-set timbre-text-v2 \
  --in patient.jsonl --out scores-v2.jsonl --cache tools/timbre/text-cache

# 5. Voice vs text vs late fusion. Opt-in; omit --fusion and the report is the voice report.
#    --text-scores is the primary file (v2 when comparing). --text-scores-v1 is the English run.
python -m tools.timbre.evaluate \
  --labels labels.csv \
  --features results/features.parquet \
  --out results/eval.json \
  --fusion \
  --text-scores scores-v2.jsonl \
  --text-scores-v1 scores-v1.jsonl \
  --voice-model audeering_msp_dim.v1
```

Stdout of every command is counts. `patient.jsonl` and `masked.jsonl` contain masked text: keep them on the operator machine and do not commit them. `text-cache/` and `*.cost.jsonl` are gitignored.

Fast tests, from the repo root (no network, mock Jev, synthetic text only):

```bash
python -m pytest -c tools/timbre/pytest.ini -m 'not slow' tools/timbre/tests -q
```

`--voice-cols col_a,col_b` overrides `--voice-model`. With no direct arousal/valence/dominance columns, the scalar functionals of that model are the voice dims.

## Question set `timbre-text-v1`

One `systemOne` call per window, six questions, the same three wire types as `lib/jev/types.ts`:

| id | type | score field |
|---|---|---|
| `timbre_valence` | score, 5 levels | `valence` 1–5 |
| `timbre_arousal` | score, 5 levels | `arousal` and `distress` (one scale) |
| `timbre_engaged` | noul | `engaged` bool, true at probability ≥ 0.5 |
| `timbre_resistant` | noul | `resistant` |
| `timbre_unresolved_doubt` | noul | `unresolved_doubt.value` |
| `timbre_doubt_reason` | choice | `unresolved_doubt.reason` |

Reasons are a closed set: `none`, `symptom_unexplained`, `plan_unclear`, `contradiction_in_account`, `question_left_open`, `cannot_tell`. A choice outside that set is dropped (the raw string is not stored) and the reason becomes `cannot_tell` when the doubt itself is true. When the doubt is false the reason is `none`.

`confidence` is the minimum of the five score/noul confidences. A noul confidence is `max(p, 1-p)`, as in `lib/jev/confidence.ts`. A missing answer is status `incomplete`. Nothing is filled in.

Retries follow the production client: 429 and 529, up to 3 attempts, backoff `250 * 2^(n-1)` ms plus up to 100 ms of jitter. 401 and 422 are not retried. Timeouts and connection errors are retried the same three times (the production client does not retry a timeout; a batch window should survive one blip). Provider bodies are not put on the error string.

## Masking

There is no general PHI masker in this repo (the surgery-review tool is in eta-lab and is pilot-only). `phi_mask.py` is the local stand-in:

- email → `[EMAIL]`
- Aadhaar (12 digits), PAN, and a labeled UHID / MRN / ABHA / patient id → `[ID]`
- Indian mobile numbers → `[PHONE]`
- a labeled date of birth → `[DOB]`
- age 90 or older → `[AGE]`
- a labeled pin code, house number, or street → `[ADDRESS]`
- `Mr` / `Mrs` / `Ms` / `Miss` / `Shri` / `Shrimati` / `Smt` / `Sri` / `thiru` / `thirumathi`, the native titles ಶ್ರೀ / శ్రీ / श्री / திரு (and the longer ಶ್ರೀಮತಿ forms), and "my name is" / "patient name is" / ಹೆಸರು / नाम / பெயர் / పేరు → `[PATIENT_NAME]`
- a name immediately before `avare`, `garu`, `ji`, ಅವರೆ, గారు, जी, or ஜி → `[PATIENT_NAME]`. `ji` is an honorific, not a language mark. A clinical word in the stop list (`pain avare`) is left.

Devanagari, Kannada, Tamil, and Telugu digits are folded to ASCII before the digit patterns, and the tag replaces that same span, so a Kannada or Telugu mobile and a Devanagari Aadhaar match. Age cues include ವರ್ಷ, ವಯಸ್ಸು, वर्ष, साल, வயது, ఏళ్లు, and సంవత్సరాలు. Age 90 or older is `[AGE]`; a younger age stays.

`Dr` plus a name is left, matching the rule that physician names stay. A name with no cue is not guessed. Spans that are already those tags are not rewritten.

After masking, a phone, email, Aadhaar, or PAN that is still visible is status `residual_phi` and is not sent.

## Scribe STT export

`from-stt` does not open the database. It reads a JSON object, a JSON array, or JSONL that an operator exported.

Production shape, from the code this helper follows:

- Turn text is `text`, or a cue `payload.text`, with `start_ms` / `end_ms`. That is the `stt_turn` cue in `lib/room-access/readers/turns.ts`.
- `room_turn_speaker.role` is `clinician` or `unattributed`. Unattributed is not the patient.
- Patient vs not comes from `speakers[].type` (`DiarizeSpeaker.type` in `lib/diarize.ts`: `clinician`, `patient`, `attender`, `nurse`, `other`) joined on `speaker_idx`, or from an explicit turn role/type `patient`.
- A turn whose role or speaker type is `clinician` is dropped even if the other field says patient (the voiceprint wins).
- `transcript_english` / `transcript_original` with no speaker list is `not_patient_attributed` and is not used. That string is every voice in the window.

```json
{
  "window_id": "bw_example",
  "speakers": [
    {"idx": 0, "type": "clinician"},
    {"idx": 1, "type": "patient"}
  ],
  "turns": [
    {"speaker_idx": 1, "role": "unattributed", "start_ms": 0, "end_ms": 800, "text": "..."}
  ]
}
```

`turns`, `transcript_segments`, and `segments` are all accepted as the turn list.

## Fusion

`--fusion` adds a `fusion` object to the evaluation report. It does not change the per-model table.

Usable primary rows (not `not_patient`, not `unusable`, not a hidden repeat) are inner-joined to the voice columns and the text scores. Rows with a non-finite dimension are dropped. The three conditions are scored on that same set:

- `voice_only` — voice dimensions
- `text_only` — `text_valence`, `text_arousal`, `text_engaged`, `text_resistant`, `text_unresolved_doubt`, `text_confidence`
- `late_fused` — those columns concatenated

Arousal and valence: ridge, `alpha=1`, out of fold. Flags `engaged`, `anxious`, `resistant`, `words_ne_tone`: logistic, out of fold, macro-F1. Folds are `GroupKFold` on `room|date`, the same splitter as the rest of `evaluate.py`. Each condition reports Spearman and Lin's CCC for arousal and valence, and macro-F1 for the flags.

The doubt reason code is stored on the score file and is not a fusion feature.

## Where native text and timings live

`attribute` does not open the database. It reads an operator JSON or JSONL export. The fields it understands are the ones the app already stores:

| source | native text | times | who spoke |
|---|---|---|---|
| `stt_turn` cue (`lib/room-access/readers/turns.ts`) | `payload.text`, the ASR language, not English | `payload.start_ms` / `payload.end_ms` | join `room_turn_speaker` on `(window_id, source_ref)`. Role is `clinician` or `unattributed`. Unattributed is not the patient. |
| router result (`lib/stt/eta-router.ts`, `lib/stt/adapters/route.ts`) | `transcript_native`, stored as `transcript_original` | segment `start`/`end` or `start_ms`/`end_ms`; word lists when the engine returned them | none, on the whole-window string |
| translation | `transcript_english` | the same segments | none |
| diarization (`lib/stt/speaker-clusters.ts`) | none | `room_diarize_window.segments_json`: `{start_ms, end_ms, speaker_idx}` relative to the clip | `DiarizeSpeaker.type`: `clinician`, `patient`, `attender`, `nurse`, `other` |
| Nemotron | none | per-frame probabilities. Production objects are 90,003 × 8 with a header `frame_ms` of 80. `resolve_frame_step` adopts 10 ms when 90,003 frames over 900 s say so. Column `i` is NeMo `speaker_i`. `slots.map_slots` names the doctor and the patient. | exclusive frame at probability ≥ 0.5 |

IndicConformer, SraVaani, and Sarvam write the native script first. English is a later translation. Scoring v1 on that translation is what flattened valence. v2 scores the native string.

## Speaker attribution

`attribute` keeps patient text and drops the rest.

- A turn labelled clinician or doctor is dropped whole. The voiceprint wins over a patient diarization type, the same rule as `from-stt`.
- With no timeline, an explicit patient label keeps the turn (`turn_label`, confidence factor 0.85). A whole-window `transcript_native` / `transcript_english` with no speaker is `not_patient_attributed` and the text is empty.
- With a timeline, word timestamps assign each word (`word_timestamps`, factor 1). A span whose winning role owns at least 90% is kept whole (`segment_timestamps`, factor 0.9). Otherwise tokens are split by character-proportional time (`proportional`, factor 0.5).
- A role wins a span only when it is the unique owner of at least half the span. Ties and silence are unknown and are not kept.
- Nemotron frames override diarization where the matrix covers time. Diarization fills the gaps. Overlap and silence are unknown. Pass `doctor_slot` and `patient_slot` together, or an ETA doctor claim / embeddings so `map_slots` can name the columns. An ambiguous slot decision ignores Nemotron. Header `frame_ms` is resolved against `duration_s` before the frames are painted, so a production 80 ms header does not smear a 10 ms file.
- Times are milliseconds from the same origin as the timeline. If the earliest text start is more than one second past the timeline's end, every start is rebased by that earliest start.
- `coverage_pct` is 100 × patient weight / all considered weight (duration, or characters when a row has no duration). It is 0 unless status is `ok`.
- `attribution_confidence` is the duration-weighted purity of the patient pieces, times the method factor, times the slot-mapping confidence. It is reported only on `ok` rows.

The output text is masked patient native. If the native string is empty, the masked gloss is the text and `basis_language` is `gloss`. A gloss is kept only for patient spans. `language` and `code_mixed` come from the local script detector (`lang.py`), on the unmasked patient text, before the mask. Statuses: `ok`, `no_patient_speaker`, `not_patient_attributed`, `no_turns`.

Stdout is counts (`windows`, `ok`, the other statuses, `residual`, `mean_coverage_pct`, `mean_attribution_confidence`). The JSONL is the operator file.

## Question set `timbre-text-v2`

`timbre-text-v1` is unchanged and is still the default, so a v1 cache key does not move. v2 adds a preface: score `window_text` in the language that was spoken; `window_gloss` is an English dictionary, not the source, because a translation flattens valence.

The six affect questions are the same types and the same score fields. Three more questions are asked and are not part of `confidence`, and a missing answer is not `incomplete`:

| id | type | stored as |
|---|---|---|
| `timbre_language` | choice `kn` `hi` `ta` `te` `en` `code_mixed` `other` | `jev_language` |
| `timbre_code_mixed` | noul | `jev_code_mixed` |
| `timbre_basis_language` | choice `native` `gloss` | `jev_basis` |

Evaluation does not bucket on those answers. `language` and `code_mixed` on the score row are the local detector. `basis_language` is the lane's decision: `native`, `native+gloss` when a gloss was attached, `gloss` only when the native string was empty, or `none`. A Jev language guess is stored beside the local one and does not replace it.

`TIMBRE_JEV_MOCK=1` still answers the affect questions locally as `jev-mock` and does not invent language answers. The detector fills `language` anyway.

## Language in the fusion report

When the joined cohort has a label `lang`, a score `language`, or a `code_mixed` flag, `fusion` gains `language_min_n` (20) and `by_language`. Each bucket has `n`, `validation` (`ok` when `n >= 20`, otherwise `not validated`), and the same three conditions. Metrics are still computed for a small bucket so the operator can see them. Do not cite a bucket marked `not validated`.

The bucket is `code_mixed` when the score says so. Otherwise the label `lang` wins, then the score `language`, else `unknown`. A language token that is not a short code (`^[a-z0-9_+]{1,32}$`) is stored as `other`, so a sentence cannot enter the report.

`--text-scores-v1` scores the v1 file on the same labels and voice columns and adds `fusion.versions`:

- `v1` / `v2`: question set, `n`, conditions, and `by_language` when present
- `delta_v2_minus_v1`: v2 minus v1 for text-only and late-fused valence and arousal Spearman and CCC

The primary `--text-scores` file is the v2 run when that comparison is the point. The two files are separate so a window id is not asked twice in one file.
