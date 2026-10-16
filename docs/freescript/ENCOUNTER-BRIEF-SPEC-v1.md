# ENCOUNTER-BRIEF-SPEC-v1: the Encounter Brief, FreeScript's new input layer

Status: draft for the lead, 16 Oct 2026. Documents only; no production code changes with this spec.
Repo base: `origin/main` at `40df6eda`. The frozen runner `59739ddb` is an ancestor of it, so every code fact below holds for the runner too unless marked otherwise.
Companion: `docs/freescript/ENCOUNTER-BRIEF-OPEN-QUESTIONS.md` (decisions that need the lead; cited here as `OQ-n`).
PDQI-9 scoring is a separate spec and is only referenced here.

Legend. A code fact carries `path:line`. **UNVERIFIED** marks anything I could not confirm in the repo: live coverage numbers, the behaviour of code outside this repo, or an inference from field names. Numbers quoted from the 16 Oct review pack and V's direction are taken as given and are not re-derived.

No patient data, consult uids or doctor names appear in this spec, its fixtures or its tests.

---

## 1. Goal and non-goals

**Goal.** Turn everything ETA knows about one consult into one evidence-linked input object, the Encounter Brief, so that FreeScript (Stage A, the mapper and Stage B) drafts a better note and better doctor-confirm medicine prompts, as scored by PDQI-9 and by agreement with the doctor's posted Pulse Rx, without breaking any safety floor.

**What the brief must fix, from the 16 Oct evidence:**

| problem | evidence | brief lever |
|---|---|---|
| Counselling and the "why" are dropped | counselling weighted recall 66%, how-to-take 75%, warning 75% | §7 doctor's-words layer, §8.4 advice budget |
| Unknown-speaker turns can carry an order today | `mapper.py:571-579` treats an all-unknown span as doctor-spoken; `validate.py:436` lets an `unknown` decision speaker pass with `speaker_uncertain` | §6 fusion, §8.3 brief-mode order gate |
| Merged-speaker turns (sarvam-mayura) hide doctor speech | 7 of 30 blind consults had more than half their doctor turns unlabelled | §5.1 merged-turn detection, §6.2 Nemotron backbone |
| FreeScript reads 4 of about 10 layers | review pack §7; `ingest.py:363` "parts, acoustics and diar_nemotron are not read" | §5 adapters |
| Red flags occasionally missed | 1 unsafe in 28 (a missing red flag) | §7 `warning` and `contingency` kinds get a must-carry rule |

**Non-goals for v1.** No change to `gp_extraction` keys (Pulse drops unknown keys, `docs/eta2freescript/FINISHED-RX-SPEC.md:21`). No change to the medicine-name catalogue or the brand redaction defect (separate lanes). No coverage backfill. No affect layer in phase 1. No new posting route. No PHI gating beyond what the runner already has (`phi_guard.py` stays as is).

---

## 2. What FreeScript reads today (code map, runner `59739ddb`)

1. **Input.** Folder mode: `load_consult` (`ingest.py:216`). Bundle mode: `load_bundle` (`ingest.py:359-419`). Text = `tracks.translate` (English) plus `tracks.stt` (native), joined by `_segments` and `_native_span` (`ingest.py:94-138`). Roles = the first non-null of `role_llm`, `role_judge`, `role_caa` (`ingest.py:406-418`, `ROLE_SLOTS` at `ingest.py:33`). Roles join onto turns by exact key, then largest same-speaker overlap, then `extras.map`, then `unknown` (`ingest.py:171-197`).
2. **Stage A input** is one rendered string: `T<i> [S<spk>|<role>] (mm:ss) text`, with `NATIVE[lang]: ... | ENGLISH: ...` where a native span joined (`ingest.py:425-436`). The role is shown only when it came from the role track. Plus `{{ROLE_CONTEXT}}` (`pipeline.py:69-77`). Prompt `stageA-v2` (`__init__.py:4`, `prompts/stageA-v2.md`).
3. **Guard** uses `Turn.role` for doctor dose precedence and numeric support (`guard.py:118-170`, `NON_DOCTOR` at `guard.py:21`).
4. **Mapper** uses `Turn.role` for the hold-back rule: an order is kept out when `basis != said`, there is no decision turn, or the decision turn is by a non-doctor (`mapper.py:854-855`). An all-`unknown` span counts as doctor-spoken (`mapper.py:571-579`). Speaker confidence is `role_track` or the Stage A `speaker_roles` confidence (`mapper.py:491-500`). Advice is capped at 5 items and 300 characters (`mapper.py:50-51`, `mapper.py:301-315`).
5. **Stage B** sees `gp_extraction`, flags and combination brands only (`pipeline.py:125-130`), prompt `stageB-v9` (`__init__.py:5`).
6. **Validator**: v0.3 schema with `additionalProperties: false` at the top level, on `generator`, `ProvenanceItem`, `Evidence` and `GPLlmExtraction` (`schema/eta-freescript-artifact.v0.3.schema.json`). `speaker_source` enum is `role_track | diarisation | model_inferred` (`schema/build_v03.py:101`). Provenance flags are a closed enum (16 values). FRX-P2 allows an order decision speaker `unknown` with `speaker_uncertain` (`validate.py:434-437`).
7. **Not read**: `diar_nemotron`, `diar_sarvam`, `parts`, `acoustics`, Jev, Clef, audio features (`ingest.py:363`; review pack §7). Specialty is passed as null.

Consequence for the design: the least invasive seam is the `Consult` object. The brief can (a) set `Turn.role` and `role_source` from fused attribution, (b) add one rendered block to the Stage A prompt, (c) tighten the mapper's order gate in brief mode only, and (d) feed the doctor's priorities to the advice and plan builders and to Stage B. Nothing else in the runner needs to change.

---

## 3. Layers: what exists, what the brief uses, in which phase

Coverage is from the review pack, §7 (3,490 consults since 9 Sep). Shapes are from the repo.

| # | layer | source in repo | shape (verified) | coverage | phase |
|---|---|---|---|---|---|
| L1 | STT, Sarvam saaras v3 | bundle slot `stt`, `mirrors/eta-lab/kit/reb/consult_bundle.py:24` | segments `{t0_ms, t1_ms, text, lang, speaker}` | 2,341 | 1 |
| L2 | Translation | slot `translate` (saaras v3 or mayura v1), `consult_bundle.py:25`; `translate_gapfill` `:26` | segments `{t0_ms, t1_ms, text, speaker}` | 2,437 ok or n.a. | 1 |
| L3 | Role track | slots `role_llm`, `role_judge`, `role_caa`, `consult_bundle.py:29-31` | segments `{t0_ms, t1_ms, speaker, role}`, extras `{map, attender_present, two_consults, diar_partial}` | 2,260 | 1 |
| L4 | Nemotron diarization | slot `diar_nemotron`, `consult_bundle.py:28` | segments `{t0_ms, t1_ms, speaker}`; labels `speaker_N` from the writer; extras `{n_speakers, model_rev}`; no confidence, no overlap field | 1,601 | 1 |
| L5 | Sarvam diarization | slot `diar_sarvam`, `consult_bundle.py:27` | `{t0_ms, t1_ms, speaker}` as read by `role_map.py:151`; writer not in the mirror, **UNVERIFIED** | 1,373 | 1 (cross-check only) |
| L6 | Jev C4 | `encounter_catalog.jev`, `db/migrations/0169_encounter_catalog_c4.sql:18-21` | per consult `{sets:[{set_id, set_sha, band, label, model, at, state}]}`; no spans, no probabilities in C4; full rows in `jev_decision` | 562 | 1 (consult-level signals) |
| L7 | Clef affect C4 | `encounter_catalog.clef_affect`; view `affect_consult_latest` (`db/migrations/0155_timbre_affect.sql:162-227`) | lanes `arousal`, `valence` (median, open, mid, close and raw), `coverage`; per-window rows in `affect_window` | 697 | 1 records only; used in 2 |
| L8 | Clef-omni role decision | `tools/timbre/role_clef.py` | per clip `{doctor_slot, patient_slot, decided, reason_code}`; thresholds p(doctor) >= 0.6 with margin 0.2 (`role_clef.py:35-53, 99-111`); no per-slot probabilities kept | not exposed in the catalog; **UNVERIFIED** count | 1 (voter) |
| L9 | Doctor voiceprint per diarized speaker | `lib/diarize-nemotron/identity.ts:183-196` (`pulse_room` rule cos >= 0.65, margin >= 0.05); tables `diarize_nemotron_speaker` (`db/migrations/0141_diarize_nemotron_identity.sql:38`); `tools/timbre/slots.py:17-42` (same thresholds per clip) | per speaker label `spkN`: `clinician_id`, `match_confidence`, `losing_score` | **UNVERIFIED** | 1 (arm (c)) |
| L10 | Parts tagger (Clef plus Jev) | slot `parts`, `mirrors/eta-lab/kit/reb/parts_lane.py:1-8` | 30 s bins `{t0_ms, t1_ms, part, score, source, confidence}`, part in history, exam, order, medicine, followup, advice; provisional | **UNVERIFIED** | 1 (section prior, optional) |
| L11 | Acoustics | slot `acoustics` | `{t0_ms, t1_ms, value, extras{metric}}` | **UNVERIFIED** | not used |
| P1-P5 | Audio features: `timbre-odyssey`, `timbre-e2v` (emotion2vec, inferred from the name), `talktime`, `flags`, `clef` | `lib/room-access/readers/catalog-consult.ts:483-552` | rows per speaker or role: `{speaker, role, feature, stat, value, iqr, n_turns, seconds, reliability, model...}`; status `ok, absent, not_available, error` | **0** | 2, default off |
| P6 | WavLM | Python extractors only, `tools/timbre/extractors/odyssey_wavlm.py`, `wavlm_aniemore.py`; no catalog slot | n/a | 0 | 2, default off |

**Two findings that change the build plan.**

- **F1. The 16 Oct role voters are not in this repo.** No code fuses the LLM role layer, Jev cues and Clef-omni into a 3-way vote, and no code implements arm (c) as defined (voiceprint match plus independent Clef and Jev top-doctor-like ranking). Clef-omni role output exists (L8), and the 0.65 and 0.05 thresholds exist in two voiceprint gates (L9), but the voiceprint path and the Clef path are exclusive, not combined (`tools/timbre/pipeline.py:815-825`). There is no Jev question set that ranks speaker labels as doctor-like: the Jev sets in `jev/question-sets/` are chair-affect, doubt, encounter-end, pitch-detect, pitch-uptake, smoke, stt-pick, stt-quality and u10-timeline. The measurement that produced "37/60 to 15/60" was therefore run outside this repo (**UNVERIFIED** where; OQ-1). Phase 0 (§12) lands that code as a stored per-consult layer before the brief can rely on it.
- **F2. Jev and Clef in C4 are consult-level.** Neither carries per-segment spans (`0169`; `catalog-sync.ts:78-195`). They can set consult-level context (boundary, STT quality, affect trajectory) but cannot by themselves attribute a span. Per-span role evidence comes only from L3, L4, L8 (per slot) and L9 (per label).

---

## 4. Data model: `eta.encounter_brief.v1`

One JSON document per consult, built on the box, written next to the other run outputs with umask 077, never posted (§9.4). It holds short normalised statements because Stage A needs them, so it is handled exactly like `encounter.json` and `stageA.raw.txt` today.

### 4.1 Envelope

```json
{
  "schema": "eta.encounter_brief.v1",
  "brief_id": "sha256 of (consult_uid, builder.code_sha256, config_hash, input sha256s)",
  "consult_uid": "<uid>",
  "built_at": "ISO-8601 UTC",
  "mode": "brief | brief_dw | brief_dw_affect",
  "builder": {"version": "1.0.0", "code_sha256": "...", "config_hash": "...", "stage_w_prompt_sha256": "... | null"},
  "clip": {"t0_ms": 0, "t1_ms": 0, "duration_ms": 0},
  "inputs": [{"layer": "stt|translate|role|diar_nemotron|diar_sarvam|jev_c4|clef_affect_c4|clef_omni_roles|voiceprint|parts|feat:*",
              "engine": "...", "version": "...", "sha256": "...", "status": "used|absent|invalid|disabled|failed",
              "reason": "token | null"}],
  "speakers": [ ... §4.2 ... ],
  "spans": [ ... §4.3 ... ],
  "items": [ ... §4.4 ... ],
  "doctor_words": [ ... §4.5 ... ],
  "conflicts": [ ... §4.6 ... ],
  "consult_context": { ... §4.7 ... },
  "affect": null,
  "quality": {"n_spans": 0, "doctor_attributed_ms": 0, "unattributed_ms": 0, "merged_turns": 0,
              "attribution_sources": {"voters_3of3": 0, "arm_c": 0, "none": 0},
              "order_eligible_items": 0, "order_blocked_items": 0},
  "degraded": ["token", "..."],
  "fallback": {"used": false, "reason": null}
}
```

`degraded` lists the named reasons the brief is weaker than designed (for example `no_diar_nemotron`, `no_clef_omni`, `no_voiceprint`, `merged_turns_present`, `role_track_not_llm`). A degraded brief is still used; only the conditions in §9.2 trigger fallback.

### 4.2 Speakers (one per decided label)

```json
{"label": "B0", "nemotron_labels": ["speaker_1"], "stt_labels": ["0"], "speech_ms": 0,
 "decided_role": "doctor|patient|attender|staff|translator|other|unknown",
 "attribution": {"source": "voters_3of3|arm_c|none", "confidence": 0.0,
                 "votes": {"role_layer": {"engine": "llm-roles|text-judge|caa-labels", "role": "...", "share": 0.0},
                           "jev": {"role": "...|null", "top_doctor_like": true, "status": "ok|absent"},
                           "clef_omni": {"role": "...|null", "top_doctor_like": true, "status": "ok|absent|undecided", "reason_code": "..."}},
                 "voiceprint": {"is_logged_in_doctor": true, "cos": 0.0, "margin": 0.0, "status": "match|abstain|absent"}},
 "flags": ["overlaps_doctor", "doctor_like_unmatched", "translator_candidate"]}
```

`B<n>` labels are brief-local and carry no identity. `translator` is a new brief-only role (the REB vocabulary has none, `ingest.py:31`); in the artifact it maps to `other` (§8.3). Clinician ids and patient names never enter the brief: `is_logged_in_doctor` is a boolean.

### 4.3 Spans (the time backbone)

```json
{"span_id": "s12", "t0_ms": 0, "t1_ms": 0, "speaker": "B0", "turn_idx": [14, 15],
 "role": "doctor|patient|attender|staff|translator|other|unknown",
 "order_capable": true,
 "attribution_source": "voters_3of3|arm_c|translator_support|none",
 "confidence": 0.0,
 "flags": ["overlap", "merged_turn", "boundary_quarantined", "label_conflict", "translation_number_mismatch"],
 "conflict_ids": ["c3"],
 "translates_span": null}
```

- `turn_idx` points into `Consult.turns`, so every existing citation (`source_turns`, `decision_turn`) still resolves.
- `order_capable` is true only when `role == doctor` and `attribution_source` is `voters_3of3` or `arm_c`, and no blocking conflict is attached (§6.6). It is the one bit the order gate reads.
- `translates_span` names the doctor span a translator span restates (§6.5).

### 4.4 Items (the content, by prescription section)

```json
{"item_id": "i31",
 "section": "complaints|history|exam|diagnosis|medications|investigations|advice_counselling|plan|follow_up",
 "kind": "symptom|duration|history|drug_history|allergy|exam_finding|vital|diagnosis|drug|regimen_slot|test|referral|procedure|instruction|counselling|warning|lifestyle|how_to_take|contingency|follow_up|explanation",
 "statement": "short English statement, <= 200 chars",
 "speaker": {"role": "doctor", "source": "voters_3of3"},
 "evidence": [{"span_id": "s12", "turn_idx": 14, "t0_ms": 0, "t1_ms": 0, "lang": "kn", "has_native": true}],
 "confidence": 0.0,
 "firmness": "firm|hedged|conditional|question|null",
 "status": "active|superseded|retracted",
 "supersedes": null, "superseded_by": null,
 "emphasis": {"repeats": 0, "explicit_marker": false, "translator_restated": false, "score": 0.0},
 "priority": null,
 "order": {"is_order": true, "eligible": true, "blocked_reason": null},
 "why_item_ids": [],
 "engine_conflicts": ["c3"],
 "phase2": {"affect_priority_boost": null}}
```

Rules on items:

- **Evidence is mandatory.** No `evidence` entry, no item. Each pointer is a span id plus a turn index; quotes are not copied into the brief, they are resolved from the turn at render time.
- **Orders** are `kind` in drug, test, referral, procedure (and a dose, strength, frequency or duration on a drug). `order.eligible` is true only when at least one evidence span is `order_capable` and the order's decision span is one of them. Otherwise `blocked_reason` is one of `unattributed`, `non_doctor`, `translator_only`, `label_conflict`, `boundary`, `superseded`.
- **No patient-side order.** A drug the patient names is `drug_history` at most, never `drug`.
- `section` is the FreeScript heading the item belongs to; `kind` is finer. `medications` items render as doctor-confirm prompts, never as "the Rx" (§8.5).

### 4.5 Doctor's words (phase 1b; null in mode `brief`)

```json
{"dw_id": "w4", "kind": "instruction|counselling|explanation|warning|lifestyle|how_to_take|contingency|follow_up",
 "statement": "<= 200 chars", "because": "<= 160 chars | null",
 "about_item_ids": ["i31"], "spans": ["s12", "s19"],
 "firmness": "firm|hedged|conditional", "status": "active|superseded",
 "superseded_by": null, "repeats": 2, "explicit_emphasis": true, "priority": 1, "must_carry": false}
```

`must_carry` is true for every `warning` and every `contingency` that names an emergency or a return condition. §7 defines extraction.

### 4.6 Conflicts

```json
{"conflict_id": "c3",
 "kind": "role_disagreement|label_split|boundary_mismatch|overlap|translation_number_mismatch|native_vs_english_drug|reversal|merged_turn|two_consults",
 "engines": ["role_llm", "clef_omni"], "span_ids": ["s12"], "item_ids": ["i31"],
 "detail": "token string, no text",
 "resolution": "final_position_wins|held_unattributed|kept_both|quarantined",
 "blocks_order": true}
```

### 4.7 Consult context (consult-level signals only)

```json
{"language": "kn", "english_source": "mt:sarvam-mayura-v1",
 "attender_present": true, "two_consults": {"flag": false, "gap_at_s": null}, "diar_partial": false,
 "jev": {"stt_quality": "token|null", "timeline_kind": "token|null", "end_signal": "token|null", "walk_in": "token|null"},
 "clef_affect": {"arousal_median": null, "valence_median": null, "scorable_pct": null},
 "parts": [{"t0_ms": 0, "t1_ms": 0, "part": "advice", "confidence": "high|low"}],
 "specialty": null}
```

The `jev` tokens are copied as labels from C4 sets that exist (stt-quality, u10-timeline). Which `set_id`s to read is a config list, not code (OQ-9). `clef_affect` is recorded in phase 1 and read by nothing.

A JSON Schema file `tools/eta2freescript/schema/eta-encounter-brief.v1.schema.json` (generated like `schema/build_v03.py`) is part of phase 1a, with `additionalProperties: false` throughout and closed enums as above.

---

## 5. Per-layer adapters

Each adapter is a pure function `adapt_<layer>(slot_or_row, clip) -> AdapterResult` with `status` (`used|absent|invalid|failed`), a reason token, a sha256 of the input, and normalised data. No adapter raises for bad data; it returns `invalid` with a reason. Only the builder decides what a missing layer means (§9.2). Every time is shifted with the existing `_shift` (`ingest.py:295-351`, defined at `:309`) so all layers share the tape clock.

### 5.1 L1 STT and L2 translation: `adapt_text`

- **Reuse** `_segments`, `_native_span` and the turn build from `load_bundle` unchanged. The brief never rebuilds turns: it consumes `Consult.turns`, so turn indices are identical in both modes.
- **Adds:**
  - `merged_turn` flag: a turn longer than `MERGED_TURN_MS` (config, proposed 25 s) whose span overlaps two or more Nemotron speakers each holding at least 20% of it. Proposed thresholds are **UNVERIFIED** against data (OQ-6).
  - `translation_number_mismatch`: a turn whose native span and English text disagree on any number after the existing numeral normalisation (`guard.numerals`, `guard.py:43`). It is recorded as a conflict and blocks the order only when the number belongs to a drug or test item.
- **Failure modes:** no text layer, so `load_bundle` already raises and the runner fails as today. English only, with no native: `has_native` is false and medicine safety behaves as today. `translate_gapfill` exists in the Python `SLOTS` but not in the TypeScript reader (`reb-bundle.ts:12-22`), so it is **UNVERIFIED** whether bundles on the box carry it; the adapter reads it only if `load_bundle` already did.

### 5.2 L3 role track: `adapt_role`

- Input: the role slot `load_bundle` chose (`ingest.py:406-418`). Output: per STT label a role distribution `{role: share of speech_ms}`, plus `extras` flags.
- **Voter 1 is the LLM role layer.** When the slot used is `role_judge` or `role_caa`, the vote is still cast but marked `engine`, and the brief adds `role_track_not_llm` to `degraded`. Whether a non-LLM role track may count as voter 1 for 3/3 is OQ-2; the default is yes, because today's runner already treats them as equivalent.
- **Failure modes:** absent, so no voter 1 and 3/3 is impossible; only arm (c) can attribute. A segment role outside `REB_ROLES` becomes `unknown` (as `ingest.py:184`). One consult in the blind 30 had every turn `unknown`; that yields zero voter-1 doctor votes and no 3/3.

### 5.3 L4 Nemotron: `adapt_nemotron` (the backbone)

- Input: `tracks.diar_nemotron.track.segments` `{t0_ms, t1_ms, speaker}`. Labels are `speaker_N` from the writer (`clip_lane_engines.py:61-65` per the bundle scout) but `"9"` in the fixture, so the adapter treats labels as opaque strings.
- Output: speaker activity intervals per Nemotron label, and the derived overlap intervals (any instant with two or more labels active). Nemotron has no confidence field, so the backbone carries none.
- **Label mapping to STT turns:** each turn is assigned the Nemotron label with the largest overlap. A turn where the top label holds less than 60% of the turn's time is `label_conflict`. A turn split across labels is `merged_turn` (§5.1).
- **Failure modes:** absent (1,601 of 3,490 have it), so the backbone falls back to STT speaker labels, with `no_diar_nemotron` in `degraded`. Arm (c) then needs a voiceprint keyed by STT label, which does not exist (**UNVERIFIED**), so without Nemotron only 3/3 can attribute. A malformed segment is dropped by `_shift` and counted.
- **Label namespaces.** L9 voiceprints are keyed `spkN` on the app-side Nemotron window (`0141_diarize_nemotron_identity.sql:50`). The bundle's `diar_nemotron` is the eta-lab clip lane with `speaker_N`. Whether these are the same run, and so whether `spkN` maps to `speaker_N`, is **UNVERIFIED** (OQ-3). Until it is settled, the phase-0 voter layer must emit its voiceprint result keyed by the bundle's own Nemotron labels.

### 5.4 L5 Sarvam diarization: `adapt_sarvam_diar`

- Used only to cross-check boundaries: a Nemotron speaker change with no Sarvam change within 1.5 s, or the reverse, inside a span that carries an order, adds `boundary_mismatch`. It is a conflict that lowers confidence; it does not block an order by itself.
- **Failure mode:** absent, so no cross-check and nothing is degraded.

### 5.5 L6 Jev C4: `adapt_jev_c4`

- Input: `encounter_catalog.jev.sets` with `state` current only. Output: the configured label tokens into `consult_context.jev`.
- Use: `u10_walk_in` and `u10_end_signal` tokens strengthen the existing boundary pre-check (`boundary.py`); the STT-quality label lowers all span confidences by a configured step when it says poor. Neither can create or block an order.
- **Failure modes:** absent (C4 has 562 consults, still filling), so the context is null. `band` `abstain` or `review` is treated as absent.
- **Access:** C4 is returned only to admin callers of `GET /api/encounter-catalog/search` or `scribe_catalog` (`lib/mcp/tools/catalog.ts:178-188`, `:468`). The box runner has no such client today, so phase 1 adds a read-only fetch with the admin bearer (secret name `ADMIN_TOKEN`; OQ-8), or the bundle grows a C4 slot.

### 5.6 Role voters 2 and 3, and arm (c): `adapt_role_votes` (phase-0 layer)

The brief does not compute these from raw audio. It reads one stored per-consult layer, `role_votes.v1`, produced by the phase-0 work in §12, with this interface:

```json
{"layer": "role_votes", "engine": "role-votes", "version": "v1", "status": "ok",
 "label_space": "diar_nemotron|stt",
 "labels": [{"label": "speaker_1",
             "jev": {"role": "doctor|patient|attender|staff|other|null", "doctor_rank": 1, "status": "ok|absent|failed"},
             "clef_omni": {"role": "...|null", "doctor_rank": 1, "status": "ok|absent|undecided|failed", "reason_code": "decided|doctor_margin|..."},
             "voiceprint": {"logged_in_doctor_cos": 0.0, "margin": 0.0, "status": "match|abstain|absent|no_enrolment"}}],
 "config": {"jev_set": "...", "clef_set": "timbre-role-v1", "cos_min": 0.65, "margin_min": 0.05}}
```

- `doctor_rank` 1 means that engine ranks this label as the most doctor-like in the consult. Clef-omni today keeps only `doctor_slot` (`role_clef.py:178`), which is rank 1 for that slot and null for the rest; that suffices for arm (c).
- `margin` is defined as in `decidePulseRoom` (best cosine minus runner-up, `identity.ts:193-196`). Whether the runner-up is the next centroid for the same label or the next label for the same centroid is OQ-4: `identity.ts` uses the first and `slots.py:40-42` uses the second.
- **Failure modes:** layer absent, so voters 2 and 3 are absent, nothing reaches 3/3 or arm (c), and every span is `none`. This is the whole-consult no-attribution case in §9.2. A voiceprint `no_enrolment` (the logged-in doctor has no print) disables arm (c) for the consult.

### 5.7 L7 Clef affect C4: `adapt_clef_affect`

Phase 1 copies medians and `scorable_pct` into `consult_context.clef_affect` for the record. Nothing reads them until phase 2 (§7.6).

### 5.8 L10 parts: `adapt_parts`

Optional section prior. A bin tagged `advice` or `followup` with `confidence: high` raises the prior that a doctor span in it is counselling, which Stage W may use. It never creates an item. The layer is provisional (`parts_lane.py:1`), and the fixture's parts segments carry `text`, which contradicts the writer's no-text rule (`parts_lane.py:6`). The adapter therefore drops any `text` key it finds.

### 5.9 Phase-2 slots: `adapt_features` (default off)

- Input: the `audio_features` layer (`catalog-consult.ts:527-552`): tracks `{engine, version, rows}`, with rows per speaker or role.
- Output: per brief speaker, `{feature, stat, value, reliability}` for the configured features (for example distress, worry, hesitation proxies).
- Interface defined now so the slot exists; config `features.enabled: false`. With the flag off the adapter returns `disabled` without reading anything. 0 consults have data today.

---

## 6. Fusion and conflict rules

The builder runs these steps in order. Each step is deterministic and unit-tested (§10). No model call happens in §6.

### 6.1 Clock and turns
All layers are on the tape clock via `_shift`. Turns are `Consult.turns` from `load_bundle`. Quarantined turns from `boundary.detect` (pre-Stage-A) are marked `boundary_quarantined` on their spans.

### 6.2 Backbone and brief speakers
1. If Nemotron is present, the brief speakers are the Nemotron labels with at least 2 s of speech. Labels with less are folded into `unknown`.
2. If Nemotron is absent, the brief speakers are the STT labels.
3. Each turn gets one brief speaker by the largest overlap (§5.3). There is no assumed speaker count: 1 to N labels are all valid.
4. A span is a maximal run of consecutive turns with the same brief speaker and no gap over 4 s. Merged turns are their own span with `merged_turn`.

### 6.3 Role per speaker
- **Votes:** voter 1 is the role layer's majority role by speech time for the STT labels mapped to this speaker. Voter 2 is Jev's role, and voter 3 is Clef-omni's role, both from `role_votes`.
- **Rule A, `voters_3of3`:** all three voters present and equal, so the speaker's role is that role. The confidence is the role layer's share times 1.0.
- **Rule B, `arm_c`** (doctor only): the label's voiceprint against the logged-in doctor's enrolled print is `match` (cos >= 0.65 and margin >= 0.05), and Clef `doctor_rank == 1`, and Jev `doctor_rank == 1`. The role is doctor, from source `arm_c`, with confidence 0.9 (a fixed constant, so that `arm_c` is never mistaken for a calibrated probability).
- **Precedence:** if A and B both apply and agree, the source is `voters_3of3`. If A says non-doctor while B says doctor, the result is a `role_disagreement` conflict and the speaker is `unknown` (both decisions are settled rules; neither may overrule the other; OQ-5 asks whether the lead wants a tie-break).
- **Otherwise:** the role is the role layer's role for display, with source `none`. Such a speaker can supply context (complaint, history) but no order.
- **At most one `arm_c` doctor per consult.** Two labels that both pass rule B (a diarizer split of one doctor) are both doctor, but only when Nemotron shows no overlap between them over 1 s in total. Otherwise both are `unknown` with `label_split`. This matches the 16 Oct root cause (two clinical voices overlapping, not a split doctor).
- **More than one 3/3 doctor:** allowed (for example a doctor plus a supervising doctor). Both are order-capable, and the second carries `second_doctor` in `degraded` for the metrics.

### 6.4 Span role
A span inherits its speaker's role and source, then:
- `overlap`: if another brief speaker is active for more than 30% of the span, the span keeps its role but loses `order_capable`, unless the overlapping speaker is also order-capable.
- `merged_turn`: the span is `unknown`, source `none`, never order-capable. The turn still reaches Stage A, labelled unattributed.
- `boundary_quarantined`: never order-capable; already excluded by Stage A rule 14 and the mapper.

### 6.5 Translators and attenders
- A **translator candidate** is a non-doctor speaker whose span starts within 3 s after a doctor span ends and whose content restates it. "Restates" is decided by Stage W (§7.3) or, without Stage W, by a deterministic overlap test: at least 50% of the doctor span's content tokens (drug names, numbers, test names) appear in the candidate span. The test token set is the guard's existing numerals and the mapper's catalogue lookups, so no new lexicon is needed.
- A translator span gets `role: translator`, `attribution_source: translator_support` and `translates_span` set. It is **never** `order_capable`.
- **Support only:** an item whose evidence has a doctor span plus a translator span gains `emphasis.translator_restated` and may take a number from the translator span only if the same number is in the doctor span. An item with only translator evidence is blocked (`translator_only`).
- An attender's words never create an order, whatever they say (as today, `NON_DOCTOR`).

### 6.6 Conflict table

| conflict | detected by | effect on span or item | blocks order |
|---|---|---|---|
| `role_disagreement` | 3/3 vs arm (c), or voters split with rule B false | speaker becomes unknown | yes |
| `label_split` | two arm (c) doctors that overlap | both unknown | yes |
| `merged_turn` | §5.1 | span unknown | yes |
| `overlap` | §6.4 | not order-capable unless both doctors | yes, unless both are order-capable |
| `boundary_mismatch` | §5.4 | confidence -0.1 | no |
| `translation_number_mismatch` | §5.1 | the number is dropped from the order; `translation_conflict` flag | for that number only (the existing medicine safety then applies) |
| `native_vs_english_drug` | drug name differs between native and English for the same turn | existing FRX-M9 path | as today |
| `reversal` | §7.4 | the earlier item is `superseded` | the superseded item only |
| `two_consults` | role-track extras, Jev u10 tokens, `boundary.py` | quarantine as today | yes, for quarantined turns |

### 6.7 Items without a model
Phase 1a (mode `brief`) builds **no** content items by itself: Stage A still extracts the content, now reading the attributed transcript plus the brief's span table. Phase 1b adds Stage W for doctor's words. So in mode `brief` the `items` array is filled after Stage A, by projecting each Stage A item onto its cited spans (§8.2). That keeps one extractor and makes the comparison between arms fair (the arm difference is the input, not a second extractor).

---

## 7. Doctor's-words layer (phase 1b)

### 7.1 Why a separate pass
Stage A rule 12 caps advice at 5 short items with no repeats (`prompts/stageA-v2.md`), and the mapper caps advice again at 5 items and 300 characters (`mapper.py:50-51`). Counselling and the "why" are lost at both caps. A separate, dedicated pass over doctor speech only, with its own budget, is the smallest change that addresses the 66% counselling recall without loosening Stage A's order rules.

### 7.2 Stage W
- **Input:** every span in time order, rendered `T<i> [B<n>|<role>|<source>] (mm:ss) text`, plus native where present. Spans that are not doctor-attributed are included for context but marked `CONTEXT-ONLY`. Translator spans are marked `RESTATES T<j>`.
- **Prompt:** `prompts/stageW-v1.md`, Bedrock Claude Sonnet, temperature 0, through the same `ModelClient` and `phi_guard`. Output is JSON matching §4.5 (without `priority`, which is computed).
- **Hard rules in the prompt:**
  1. Every unit cites at least one doctor span.
  2. A unit that cites only CONTEXT-ONLY spans is invalid.
  3. Capture ALL of explanations, instructions, counselling, warnings, lifestyle, how-to-take, contingencies and follow-up, with the stated reason in `because` when the doctor gave one.
  4. Do not summarise two different instructions into one.
  5. Never add a drug, a dose or a test that is not in the cited doctor span.
- **Deterministic post-checks** (`brief_dw.py`):
  - The citation check drops a unit with no doctor span.
  - The number check reuses `guard.numeric_support`: any number in `statement` or `because` must occur in a cited doctor span, or the unit is dropped.
  - The drug check: a unit that names a drug not in Stage A's prescription list, kept-out list or slots is kept as counselling text but marked so the mapper's C4 scrub (`README` C4) still removes kept-out names from the note.

### 7.3 Kinds, firmness and emphasis
- **Kinds** match the blind scoring taxonomy (counselling, advice, lifestyle, contingency, how-to-take, follow-up, warning), with `instruction` standing for advice and `explanation` for the "why", so recall can be measured per kind against the same labels.
- **Firmness** is `firm` ("take", "you must", "do not"), `hedged` ("you can try", "maybe", "if you like") or `conditional` ("if the pain increases, come"). Stage W assigns it, and a deterministic cue list overrides it in one direction only: a conditional cue ("if", "agar", and the Kannada, Telugu and Hindi conditional forms already used by `guard.CONTINUE_QUOTE` style lists) forces `conditional`.
- **Emphasis score:** `0.5*min(repeats,3)/3 + 0.3*explicit_emphasis + 0.2*translator_restated`.
  - `repeats` counts doctor spans that restate the unit. It is computed deterministically by token overlap (Jaccard >= 0.6) over doctor spans, not taken from the model.
  - `explicit_emphasis` comes from Stage W ("very important", "must", "do not forget", raised repetition).
  - The weights are proposed and **UNVERIFIED** (OQ-11).

### 7.4 Reversals: the final position wins
- Stage W links a unit to an earlier one it changes, with `supersedes` (for example "take it twice" then "no, once is enough"; "get an X-ray" then "no need for the X-ray").
- **Deterministic resolution:**
  - The later unit wins only if its doctor span starts after the earlier one's.
  - The earlier unit becomes `superseded` and never reaches the note.
  - A chain resolves to its last element.
- **Orders:** when a reversal touches an order item from Stage A (a drug, dose or test), the brief adds a `reversal` conflict. The mapper then keeps the final position, and the superseded value is kept out with flag `negation_cue_nearby`, which is the existing route for "stop" and "not given".
- **Unclear or bad reversals:** a reversal that Stage W asserts but whose spans are out of order is ignored and logged. A reversal by a non-doctor ("no, doctor said once") is never applied.

### 7.5 Priority and reordering before FreeScript
- **Score:** `priority score = emphasis.score + 0.3*must_carry + 0.1*firm`. Ties go to the earlier first mention.
- **Ranking:** units are ranked by score. `doctor_words` is reordered by rank, and each content item gets `priority` equal to the best rank of the doctor's-words units that are `about` it.
- **What reads the order:** the rank is what Stage B and the mapper's advice builder read (§8.4). It is computed before Stage B is called, as V's direction requires. Stage A is not reordered: it sees the transcript in time order, because time order is what its citation rules assume.

### 7.6 Patient affect (phase 2, interface only)
- **When it applies:** only in mode `brief_dw_affect` and only when at least 2 independent affect signals agree for the same patient-side speaker or window. The signals are the Clef affect lanes (L7), the emotion2vec and Odyssey features (P2, P1), and the Clef-omni `anxious` question (`mirrors/newcat/src/platform/clef/questions.ts:18-30`).
- **Output:** `affect = {signals_used[], agreement: n, flags: [worry|confusion|distress|hesitation], windows: [{t0_ms,t1_ms}]}`.
- **Allowed effects** are three, and nothing else:
  1. raise `priority` for doctor's-words units whose spans follow a flagged window;
  2. tell Stage B which counselling to state more clearly;
  3. add a follow-up emphasis flag.
- **Forbidden:** affect never creates, edits or removes an item, a number or a section, and never touches `gp_extraction` values.
- **Tests:** a property test asserts that `gp_extraction` is byte-identical between `brief_dw` and `brief_dw_affect` on every fixture.

---

## 8. How FreeScript consumes the brief (minimal runner change)

All changes are behind the flag (§9). With the flag off, every existing test must pass unchanged and the artifact must be byte-identical (§10.4).

### 8.1 New modules (new files only)
- `tools/eta2freescript/brief.py`: the adapters (§5), fusion (§6), the schema check, `build_brief(bundle, consult, extra) -> dict`, and `apply_to_consult(consult, brief)`.
- `tools/eta2freescript/brief_dw.py`: the Stage W call and its post-checks (§7).
- `tools/eta2freescript/brief_render.py`: renders the Stage A block and the Stage B priorities block.
- `tools/eta2freescript/prompts/stageA-v3.md`: stageA-v2 plus one block and three rules (§8.2). `prompts/stageW-v1.md`. `prompts/stageB-v10.md`: stageB-v9 plus a priorities block (§8.4).
- `tools/eta2freescript/schema/eta-encounter-brief.v1.schema.json` and its builder.

Note on `code_sha256`: `prompts.code_paths()` hashes every `*.py` in the package (`prompts.py:44-45`), so adding modules changes `code_sha256` for every run, which re-queues the `rejected` uids under `--skip-existing` (NIGHTLY.md). That is acceptable, but it must be announced before the runner moves (OQ-12).

### 8.2 Changes to existing files
1. **`ingest.py`.** `load_bundle` keeps the slot dicts it already reads and exposes `c.bundle_tracks` (a reference, with no copy of text). About 3 lines.
2. **`pipeline.py`** `run_consult`, about 25 lines:
   - after `pre = B.detect(c)`, if the mode is not `current`: `brief = build_brief(...)`; on any exception or a §9.2 condition, set `fallback` and continue down today's path unchanged;
   - `apply_to_consult(c, brief)` sets each `Turn.role` from its span role, using `translator -> other`. It sets `Turn.role_source` to `brief`, and `c.role_track = True`, so Stage A treats roles as given. It also keeps `brief.order_capable_turns`;
   - Stage A uses `stageA-v3`, with `{{ENCOUNTER_BRIEF}}` set by `brief_render.stage_a_block(brief)`;
   - after the guard, `brief.project_stage_a(enc)` fills `items` (§6.7) and records `order.eligible` per Stage A order;
   - in mode `brief_dw` and above, Stage W runs after Stage A and before the mapper;
   - `brief.json` is written to `od` (§9.4) and its `brief_id` goes into the log (`artifact.validation.json`) as `input_mode`, `brief_id` and `fallback`.
3. **`format_transcript`** (`ingest.py:425`): when `t.role_source == "brief"`, it renders `[S<spk>|<role>|<src>]`, where src is `3of3`, `armc` or `none`. That is a 2-line branch.
4. **`mapper.py`**, about 20 lines:
   - `by_non_doctor(turn)` and `_doctor_spoken(turns)` get a brief branch: in brief mode a decision turn must be in `order_capable_turns`; an `unknown` role no longer counts as doctor-spoken. This is the settled rule ("unattributed or non-doctor speech never yields an order").
   - A blocked order follows the existing kept-out route (`P(..., ptr=None)`, the decision speaker as recorded) and raises `completion_required`:
     - a medicine raises `pick_drug` when unnamed, and otherwise a new prompt kind `confirm_speaker`;
     - a test, referral or procedure raises `confirm_speaker`.
   - `confirm_speaker` needs a schema enum change (OQ-7). Until then, phase 1 reuses `inferred_confirm`, whose meaning ("offered for one tap") fits.
   - `evidence()` and `P()` set `speaker_source` to `diarisation` for brief-attributed turns. That is an existing enum value (`build_v03.py:101`), currently unused by the mapper, so no schema change is needed in phase 1.
5. **`guard.py`**: no code change. It reads `Turn.role`, which the brief has set, so doctor dose precedence uses brief-attributed doctor turns automatically.
6. **`validate.py`**: no rule removed. Add **FRX-B1**, active only when the log says `input_mode != current`: every pointed order provenance item's `decision.speaker` must be `doctor`, and the `unknown` with `speaker_uncertain` allowance of FRX-P2 does not apply. The check needs only the artifact, because the brief sets `decision.speaker` from the brief role.

### 8.3 What the Stage A block says (`stageA-v3`)
`{{ENCOUNTER_BRIEF}}` is rendered from the brief, with no new text beyond the transcript Stage A already sees:
- **Speaker table:** brief label, role, source, and speech seconds.
- **Spans that cannot order:** a list of turn indices that are not order-capable, each with its reason token.
- **Translator links:** `T<j> restates T<i>`.
- **Consult context:** attender present, two consults, STT-quality token, language.

Three added rules:
- **R21:** an order (`prescription`, `investigations`, `procedures`, `referrals`) needs a `decision_turn` that is not on the cannot-order list. Otherwise put it in `uncertainties`, citing the turn.
- **R22:** a `RESTATES` turn may be cited as support, never as `decision_turn`.
- **R23:** a turn marked `|none` may be cited for complaints, history and exam context.

The deterministic gate in the mapper (§8.2 item 4) enforces R21 whatever the model does, so the prompt rules are for recall, not for safety.

### 8.4 Doctor's words into the note (mode `brief_dw` and above)
- **Advice.** `mapper.Builder.advice` takes the doctor's-words units in priority order before Stage A's advice. `general_advice` is a string field (schema `GPLlmExtraction`), so no key is added.
  - Must-carry units (warnings, emergency contingencies) are always included.
  - The cap rises from 5 items and 300 characters to a brief-mode budget, proposed at 10 items and 700 characters (OQ-10). Units beyond the budget are kept out as review items, as today.
- **Plan.** Counselling and explanation units with a `because` render as "X, because Y" into `plan_of_management` text in priority order, with the same scrub of kept-out names (C4).
- **Stage B.** `stageB-v10` receives one more input, `{{DOCTOR_PRIORITIES}}`: a numbered list of `{rank, kind, statement}` drawn from units already present in `gp_extraction`, with the instruction to order the Advice and Plan headings by that rank and to keep every must-carry unit. Stage B still sees no transcript.

### 8.5 Medicines stay doctor-confirm prompts
No change to medicine posting rules. Medicines are posted only as `medication_safety.py` and FRX-M* allow today, and everything else goes to `pick_drug`, `dose_unstated` or `inferred_confirm`. In brief mode the set of postable medicines can only shrink (the order gate is stricter), never grow. The rendered note keeps today's wording; nothing labels the medicine list "the Rx".

---

## 9. Feature flag, fallback, storage

### 9.1 Flag
- **Env** `ETA2FS_INPUT`, one of `current` | `brief` | `brief_dw` | `brief_dw_affect`. It is unset or `current` by default. Any other value is a config error (exit 2), following the strict-flag style of `ETA_FREESCRIPT`.
- **CLI** `--input` overrides it per run. The eval harness passes it per arm.
- **Shadow.** `ETA2FS_INPUT_SHADOW=brief|brief_dw` builds the brief and writes `brief.json`, but runs `current` for the posted artifact. Only the cost of Stage W (in shadow `brief_dw`) is added.
- `brief_dw_affect` refuses to start unless `features.enabled` is true in the brief config. In phase 1 that is never the case.

### 9.2 Fallback to today's input
The run silently uses `current` and records `fallback.used: true` with a reason when:

| condition | reason token |
|---|---|
| `build_brief` raises | `brief_error:<ExceptionClass>` |
| no `role_votes` layer and no role track | `no_attribution_layers` |
| folder mode (no bundle) | `folder_mode` |
| brief fails its own schema | `brief_schema_invalid` |
| Stage W fails or returns invalid JSON (mode `brief_dw`) | the run continues as mode `brief`, with `stage_w_failed` |

**Not a fallback condition:** zero order-capable spans. That consult runs in brief mode, and every order becomes a doctor-confirm prompt. Falling back would reintroduce orders from unattributed speech, which the settled rule forbids. Under today's measurement this applies to about 15 of 60 consults (25%), so the medicine field shrinks there. Whether the lead accepts that is OQ-13; the spec's default is safety first.

### 9.3 Kill switch
`ETA2FS_INPUT=current` restores today's behaviour byte for byte (§10.4). No migration is involved.

### 9.4 Storage and retention
`brief.json` sits beside `encounter.json` in the run directory (umask 077). In bundle mode it is inside the `TemporaryDirectory` like every other output, and it is persisted to `out` only if the existing persistent-output rule copies it. Nothing in the brief is posted to Scribe. The ingest route refuses transcript-shaped fields anyway. Only `brief_id`, `input_mode`, `fallback` and the `quality` counts go into `artifact.validation.json`.

---

## 10. Tests (synthetic only)

All fixtures are synthetic, built by a script in the style of `tests/fixtures/build_fixtures.py`, with invented speech and no real uids, names or audio.

### 10.1 Unit tests: `tests/test_brief_*.py`
- **Adapters:**
  - each adapter gets `used`, `absent`, `invalid` (bad times, unknown role, non-object track) and `failed` cases;
  - the epoch and relative clocks are both shifted correctly;
  - a `text` key in parts is dropped;
  - Nemotron labels in both the `speaker_N` and digit formats;
  - the features adapter returns `disabled` when the flag is off and reads nothing.
- **Fusion, table-driven, one row per rule:**
  - 3/3 doctor; 3/3 patient;
  - 2/3 with arm (c) true, giving `arm_c`; 2/3 with arm (c) false, giving `none`;
  - arm (c) with cos 0.649, giving none; arm (c) with margin 0.049, giving none;
  - arm (c) with Clef rank 2, giving none; arm (c) with Jev absent, giving none;
  - 3/3 non-doctor against arm (c) doctor, giving a conflict and unknown;
  - two arm (c) labels with no overlap, giving both doctor; with 2 s of overlap, giving `label_split`;
  - a merged turn; a 35% overlap; a translator within 3 s; a translator at 4 s, which is not a translator;
  - a translator-only number; a boundary mismatch;
  - no Nemotron, so the STT-label backbone is used;
  - no `role_votes`, so the consult falls back.
- **Order gate:** for every fixture, a property test asserts that no `gp_extraction` order has a `decision.turn` outside `order_capable_turns`. The test also mutates a fixture's roles at random (seeded) and re-asserts.
- **Doctor's words:**
  - a citation-only-context unit is dropped; a number not in the cited span is dropped;
  - a reversal chain of 3 resolves to the last element;
  - an out-of-order reversal is ignored; a reversal said by a non-doctor is ignored;
  - a conditional cue overrides `firm`;
  - the repeat count is deterministic;
  - a must-carry warning survives the budget cap;
  - priority ties go to the earlier unit.
- **Affect:** `gp_extraction` is byte-identical with affect on and off. Affect with 1 signal changes nothing.
- **Schema:** the brief schema rejects an unknown key, an item without evidence, and an order with `eligible: true` and no order-capable span.

### 10.2 Golden fixtures: `tests/fixtures/brief/`
Each fixture has a bundle, `role_votes.json`, a recorded Stage A and Stage W (replay client), the expected `brief.json`, and the expected artifact. Proposed set of 12:

1. `synth-brief-clean`: a doctor and a patient, 3/3, a drug with a dose, and counselling with a "why".
2. `synth-brief-armc`: the role layer mislabels the doctor; arm (c) rescues the order.
3. `synth-brief-two-clinicians`: two overlapping clinical voices; no attribution; the order becomes a prompt.
4. `synth-brief-translator`: an attender translates the doctor's dose; it is supported, not created.
5. `synth-brief-translator-only`: the dose is heard only from the translator, so it is blocked.
6. `synth-brief-reversal-dose`: twice a day, then once a day; the final position wins.
7. `synth-brief-reversal-test`: an X-ray is ordered, then withdrawn, so it is not ordered.
8. `synth-brief-hedged`: "you can try" versus "you must"; firmness and priority.
9. `synth-brief-merged`: a long merged turn holding a drug, so it is blocked.
10. `synth-brief-redflag`: a hernia-style red flag said once among 8 advice lines; it must be carried.
11. `synth-brief-no-nemotron`: the STT backbone, degraded, still 3/3.
12. `synth-brief-patient-drug`: the patient names a brand and strength, so it is `drug_history` only.

### 10.3 Replay and CI
These run in the existing workflow (`.github/workflows/eta2freescript-tests.yml`) with the replay client, so CI makes 0 model calls.

### 10.4 Non-regression
- With `ETA2FS_INPUT` unset, the artifact from every existing fixture is compared byte for byte against a stored baseline, excluding only `generator.code_sha256` and `created_at`.
- All existing tests pass unchanged.

---

## 11. Metrics and the 4-arm proof

### 11.1 Brief health (every run, counts only, in `artifact.validation.json` and the nightly summary)
- **Attribution coverage:**
  - the share of consults with at least one order-capable span (16 Oct: 45 of 60 with arm (c));
  - doctor-attributed ms over the doctor's estimated speech ms;
  - the attribution source mix.
- **Rates:** degraded reasons; fallback rate by reason; Stage W failure rate.
- **Orders:** orders blocked, by `blocked_reason`; orders newly blocked versus `current` (in shadow mode).
- **Cost and time:** Stage W cost in USD and its added seconds.

### 11.2 The proof: 4 arms on the same consults

| arm | `--input` | harness label (proposed) |
|---|---|---|
| A0 current input | `current` | `B0` |
| A1 brief | `brief` | `Bb` |
| A2 brief plus doctor's words | `brief_dw` | `Bw` |
| A3 plus affect | `brief_dw_affect` | `Ba` (phase 2 only) |

- **Harness.** The PDQI-9 harness takes arm files keyed by uid (`eval/pdqi9/run.py:1-5`, `ARMS` at `:21`). It needs its arm list extended (OQ-14).
- **Consult set.** Only consults with all phase-1 layers, including `role_votes`. The set is stratified like the blind 30 (language, minute bin, doctor) and frozen before any arm is run.
- **Measures per arm:**
  - PDQI-9, from the separate spec;
  - the floors: 0 untaped drugs, 0 invented doses, 0 dose-precedence errors, 0 clip leakage, at most 0.2 hallucinations per consult, a 100% validator pass, and no placeholders;
  - against the posted Pulse Rx, through the audited matcher only, never the raw name rule (review pack §2): medicines posted or held as prompts, and investigations;
  - doctor's-instruction recall by kind (counselling, advice, lifestyle, contingency, how-to-take, follow-up, warning), scored like the blind item 8;
  - red flags carried;
  - cost and latency.
- **Decision rule (proposed, OQ-15):**
  - A1 is adopted over A0 if no floor regresses and PDQI-9 is not worse (paired Wilcoxon, the method on branch `freescript/pdqi9-wilcoxon-method`, **UNVERIFIED** as merged).
  - A2 is adopted over A1 if counselling weighted recall rises by at least 10 points and no floor regresses.
  - A3 waits for phase 2 data.
- **Expected trade-off (stated, not hidden):** A1 may lower medicine "posted" recall on the consults with no order-capable span, because those orders move to prompts. The prompt-inclusive measure ("posted or held", 68% today) should not fall.

---

## 12. Phased build plan

Sizes: S is up to 1 Builder day, M is 2 to 3 days, L is 4 to 6 days. Every phase ends with a Refuter pass and the repo gate (CLAUDE.md).

| phase | content | size | depends on | exit check |
|---|---|---|---|---|
| **0a** | Land the 16 Oct role-vote and arm (c) measurement code as a stored layer `role_votes.v1` (§5.6), on the box, keyed by bundle Nemotron labels; add a bundle slot or a side file | M | OQ-1, OQ-3, OQ-4 | reproduces the 37/60 and 15/60 numbers on the same 60 consults (counts only) |
| **0b** | Jev per-label doctor-cue question set, benched on labelled data before wiring (the Jev fit is in §13) | M | OQ-1 | calibration table on the labelled set |
| **1a** | `brief.py` adapters and fusion, the schema, Stage A v3, the mapper order gate, FRX-B1, the flag, fallback, shadow, unit tests and fixtures 1-5, 9, 11, 12 | L | 0a | gate green; byte-identical with the flag off; shadow on 1 day of consults with counts reported |
| **1b** | Stage W, `brief_dw.py`, the advice budget, Stage B v10, fixtures 6-8 and 10 | M | 1a, OQ-10 | gate green; replay CI |
| **1c** | The proof run, arms A0, A1 and A2, on the frozen set | M | 1b, the PDQI-9 spec, OQ-14 | the scoreboard row and the floor table |
| **2a** | Audio-feature adapters live, after the features layers produce data | M | P1-P6 coverage > 0 | adapter tests with real shapes (synthetic values) |
| **2b** | The affect layer, the 2+ agreement rule, arm A3 | M | 2a | the affect-off identity property test plus the A3 proof |

The critical path is 0a, then 1a, then 1b, then 1c: about 3 to 4 Builder weeks including Refuter passes (**UNVERIFIED** estimate). Phase 1a can be built against fixtures while 0a runs, but cannot ship before 0a.

---

## 13. Where Jev fits (per the standing rule)

- **Fits, after benching:**
  1. The per-label doctor-cue vote (0b) is a categorical decision over text that code acts on.
  2. Firmness (firm, hedged or conditional) of a doctor's-words unit.
  3. "Does span B restate span A?" for translator detection.
  4. "Does unit Y reverse unit X?"

  Each needs a labelled synthetic plus internal bench before code reads its probability. Thresholds stay in code. Jev is English-primary, so for native spans the English translation is what it sees.
- **Does not fit:** numbers, doses, times and the emphasis arithmetic. These stay deterministic.
- **Diff review:** the Refuter should also run `jev_review` on the 1a and 1b diffs.

---

## 14. Risks

| risk | mitigation |
|---|---|
| A stricter order gate lowers posted-medicine recall | Prompts carry the orders; measure "posted or held" (§11.2) |
| `role_votes` is built outside this repo and drifts | A stored, versioned layer with a `config` and sha256 in `inputs` |
| Stage W adds hallucinated counselling | Citation and number post-checks; the judge counts hallucinations per consult (floor <= 0.2) |
| Bigger advice text trips the FRX-N1 phrase rules (49 "addressed to doctor" rejects) | Fixture 10 plus a FRX-N1 replay over shadow output before 1b ships; OQ-16 |
| Label namespaces (spkN vs speaker_N) mismatch | Phase 0a emits votes in bundle label space only |
| Brand redaction erases drug names before the brief sees them | Out of scope; the brief records `[name]` token counts in `quality` so the effect is visible |
| Cost | Stage W is about one more Sonnet call per consult (**UNVERIFIED** price); shown in `cost_usd` |

---

## 15. Assumptions not verified in the repo (UNVERIFIED register)

- **U1.** The 16 Oct voter and arm (c) measurement code exists somewhere and can be landed as `role_votes.v1`; its exact Jev cue question is unknown.
- **U2.** `diar_sarvam` segment shape (writer not in the mirror).
- **U3.** Whether app-side Nemotron identity labels `spkN` correspond to the bundle `diar_nemotron` labels `speaker_N`.
- **U4.** The logged-in doctor of a consult is reachable on the box (the bundle `cutter_row.doctor_uid` exists in the fixture; its reliability is unknown) and has an enrolled print.
- **U5.** Coverage of Clef-omni role decisions, voiceprints, the `parts` lane and `acoustics` per consult.
- **U6.** `translate_gapfill` presence in box bundles.
- **U7.** These thresholds are design proposals, not fitted values: merged-turn 25 s and 20%, label share 60%, span gap 4 s, translator window 3 s, overlap 30%, the arm (c) confidence constant 0.9, the emphasis weights and the advice budget.
- **U8.** Stage W cost and latency.
- **U9.** That the PDQI-9 Wilcoxon method is merged and usable for the arm comparison.
- **U10.** That emotion2vec is the `timbre-e2v` slot (inferred from the name).
- **U11.** That a box runner may call the catalog search route with the admin bearer (C4 is admin-only).
