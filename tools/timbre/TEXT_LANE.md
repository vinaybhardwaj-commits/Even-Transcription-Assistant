# Timbre text lane

Voice-only valence on batch 1 was weak. This lane scores **masked patient text** with Jev and compares it with voice dimensions. It does not import `lib/jev`, does not write `jev_decision`, and does not read `ETA_JEV_ENABLED`. Production Jev is unchanged.

Jev sees text only. The request body is `{model, state, questions}` and `state` is `{"window_text": "<masked>"}`. There is no audio field.

## Switch

`score` refuses to run unless `TIMBRE_TEXT_LANE` is `1`, `true`, `yes`, or `on`. Unset is off. Any other value is an error, not off.

`mask` and `from-stt` are local. They do not call Jev.

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

# 3. Score. Refuses without the switch. Cache key is the masked text, prompt, model, question set.
TIMBRE_TEXT_LANE=1 TYPESAFE_API_KEY=... python -m tools.timbre.text_lane score \
  --in masked.jsonl \
  --out scores.jsonl \
  --cache tools/timbre/text-cache \
  --cost-log scores.cost.jsonl

# Stand-in, no key and no network:
TIMBRE_TEXT_LANE=1 TIMBRE_JEV_MOCK=1 python -m tools.timbre.text_lane score \
  --in masked.jsonl --out scores.jsonl --cache tools/timbre/text-cache

# 4. Voice vs text vs late fusion. Opt-in; omit --fusion and the report is the voice report.
python -m tools.timbre.evaluate \
  --labels labels.csv \
  --features results/features.parquet \
  --out results/eval.json \
  --fusion \
  --text-scores scores.jsonl \
  --voice-model audeering_msp_dim.v1
```

Stdout of every command is counts. `masked.jsonl` contains masked text: keep it on the operator machine and do not commit it. `text-cache/` and `*.cost.jsonl` are gitignored.

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
- `Mr` / `Mrs` / `Ms` / `Miss` / `Shri` / `Smt` / `Sri`, and "my name is" / "patient name is" → `[PATIENT_NAME]`

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
