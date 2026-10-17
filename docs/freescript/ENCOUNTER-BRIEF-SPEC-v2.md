# ENCOUNTER-BRIEF-SPEC-v2: the Encounter Brief, FreeScript's new input layer

Status: v2, 17 Oct 2026. This is a fix round on v1 after an Opus refute (PASS-WITH-FIXES) and the lead's rulings on OQ-1 to OQ-20. Documents only; no production code changes with this spec.
v1 is kept unchanged at `docs/freescript/ENCOUNTER-BRIEF-SPEC-v1.md`. Every change in this file is tagged **[v2]**. The closure table (M1-M6, S1-S5, the rulings) is at the top of `docs/freescript/ENCOUNTER-BRIEF-V2-NOTES.md`.
Repo base: `origin/main`. The frozen runner `59739ddb` is an ancestor of it, so every code fact below holds for the runner too unless marked otherwise. **[v2]** FreeScript R1/R2 (`tools/eta2freescript/r1_floors.py`) is cited from branch `cloudpane/cloud-frx-r2-build/r2` at `fd65cdc6`, which is not on `origin/main`; the brief depends on it landing (§8.5).
Companion: `docs/freescript/ENCOUNTER-BRIEF-OPEN-QUESTIONS.md` (v1 questions, now all ruled; the rulings are in V2-NOTES).
PDQI-9 scoring is a separate spec and is only referenced here.

Legend. A code fact carries `path:line`. **UNVERIFIED** marks anything I could not confirm in the repo: live coverage numbers, the behaviour of code outside this repo, or an inference from field names. Numbers quoted from the 16 Oct review pack and V's direction are taken as given and are not re-derived.

No patient data, consult uids or doctor names appear in this spec, its fixtures or its tests.

**[v2] Ship gate, stated once.** No consult runs in live brief mode before (a) the phase 1c proof verdict and (b) fable's ship gate. Until then the brief runs in shadow only (§9.1). Every live-mode rule in this spec describes behaviour after that gate.

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
              "attribution_sources": {"voters_3of3": 0, "arm_c": 0, "none": 0}, "doctor_conflict": 0, "second_doctor": 0, "placeholder_units_dropped": 0,
              "order_eligible_items": 0, "order_blocked_items": 0},
  "degraded": ["token", "..."],
  "fallback": {"used": false, "reason": null}, "no_order": false
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

**[v2]** `flags` may also carry `second_doctor` and `doctor_conflict`; `label_split` is removed. `B<n>` labels are brief-local and carry no identity. `translator` is a new brief-only role (the REB vocabulary has none, `ingest.py:31`); in the artifact it maps to `other` (§8.3). Clinician ids and patient names never enter the brief: `is_logged_in_doctor` is a boolean.

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
- `order_capable` is true only when `role == doctor`, `attribution_source` is `voters_3of3` or `arm_c`, the speaker is an order-capable label under the §6.3 table **[v2]**, the consult is not `no_order` **[v2]**, and no blocking conflict is attached (§6.6). It is the one bit the order gate reads.
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
- `section` is the FreeScript heading the item belongs to; `kind` is finer. `medications` items render as doctor-confirm prompts, never as "the Rx"; **[v2]** in brief mode every medicine is a prompt (§8.5).

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
 "kind": "doctor_conflict|mapping_failed|number_speaker|boundary_mismatch|overlap|translation_number_mismatch|native_vs_english_drug|reversal|merged_turn|two_consults",
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

### 5.6 Role voters 2 and 3, and arm (c): `adapt_role_votes` (phase-0 layer) [v2]

**[v2] Source (OQ-1 ruling).** Phase 0a ports the off-repo role-vote and arm (c) code from the pdqi9 work into this repo as the stored layer `role_votes.v1`. The brief reads only that layer; it computes nothing from audio.

```json
{"layer": "role_votes", "engine": "role-votes", "version": "v1", "status": "ok",
 "label_space": "diar_nemotron",
 "mapping": {"status": "clean|ambiguous|failed", "app_labels": {"speaker_1": "spk0"}, "reason": "token|null"},
 "labels": [{"label": "speaker_1",
             "jev": {"role": "doctor|patient|attender|staff|other|null", "doctor_rank": 1, "status": "ok|absent|failed"},
             "clef_omni": {"role": "doctor|null", "doctor_rank": "1|null", "status": "ok|absent|undecided|failed", "reason_code": "decided|doctor_margin|..."},
             "voiceprint": {"logged_in_doctor_cos": 0.0,
                            "margin_next_label": 0.0, "margin_runner_up_centroid": 0.0,
                            "status": "match|abstain|absent|no_enrolment|no_doctor_uid"}}],
 "metadata": {"jev_question_set": "...", "jev_question_id": "...", "jev_model": "...",
              "clef_set": "timbre-role-v1", "cos_min": 0.65, "margin_min": 0.05,
              "port_source_sha256": "...", "code_sha256": "..."}}
```

- **[v2] Jev question id (OQ-1).** The Jev question set, question id and model that produced the doctor-cue vote are layer metadata. A brief whose `role_votes.metadata.jev_question_id` differs from the benched one in the brief config treats the Jev vote as absent (§12, 0b).
- **[v2] Clef's vote (M3).** Clef-omni keeps only `doctor_slot` and `patient_slot` per clip (`tools/timbre/role_clef.py:178`). `role_votes` therefore defines Clef's vote as: `role: doctor, doctor_rank: 1` for the label that is the doctor_slot; `role: null, doctor_rank: null` for **every other label**, including the patient_slot. Clef never votes "patient", "attender" or "staff". Consequence: rule A (3/3) can only ever decide **doctor**; every non-doctor role is display-only from voter 1, source `none`. That is the intended conservative result: 3/3 exists to authorise orders, and only doctors order.
- **[v2] Both margins (OQ-4 ruling).** Arm (c) needs `logged_in_doctor_cos >= 0.65` AND `margin_next_label >= 0.05` (the best label's cosine to the logged-in doctor's print minus the next label's cosine to the same print, the `tools/timbre/slots.py:40-42` sense) AND `margin_runner_up_centroid >= 0.05` (this label's cosine to the logged-in doctor minus its cosine to the runner-up enrolled centroid, the `lib/diarize-nemotron/identity.ts:193-196` sense). A label with no runner-up centroid (one-centroid set) abstains, as `decidePulseRoom` does.
- **[v2] Only one label can pass arm (c) (S2).** `margin_next_label >= 0.05` holds for at most one label, so arm (c) names zero or one label per consult. v1's "two arm (c) doctors" case is impossible and removed (§6.3).
- **[v2] Mapping (OQ-3 ruling, M5).** The bundle `diar_nemotron` is the backbone. App-side voiceprints are keyed `spkN` (`db/migrations/0141_diarize_nemotron_identity.sql:50`); phase 0a proves the mapping from bundle `speaker_N` to app `spkN` per consult (time-overlap based, both ways one-to-one). `mapping.status` is `clean` only when every bundle label with at least 2 s of speech maps to exactly one app label and back. **With `ambiguous` or `failed`, voters 2 and 3 are absent for that consult**: 3/3 cannot fire and arm (c) is off. That consult then has no order-capable span (§9.2).
- **[v2] Enrolment (OQ-19 ruling).** Arm (c) is off when the logged-in doctor has no enrolled print (`no_enrolment`) or the consult has no `doctor_uid` (`no_doctor_uid`).
- **Failure modes:** layer absent, so voters 2 and 3 are absent and nothing can order (§9.2).

### 5.7 L7 Clef affect C4: `adapt_clef_affect`

Phase 1 copies medians and `scorable_pct` into `consult_context.clef_affect` for the record. Nothing reads them until phase 2 (§7.6).

### 5.8 L10 parts: `adapt_parts`

**[v2] Off (OQ-20 ruling).** The adapter ships disabled and is not read by fusion or Stage W; the text below is kept as the design for a later decision.

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

### 6.3 Role per speaker [v2]

- **Votes:** voter 1 is the role layer's majority role by speech time for the STT labels mapped to this speaker. Voter 2 is Jev's role, and voter 3 is Clef-omni's vote as defined in §5.6 (doctor for the doctor_slot, null elsewhere).
- **Rule A, `voters_3of3`:** all three voters present and equal. **[v2]** Because Clef only ever votes doctor (§5.6), rule A only ever yields **doctor**. Confidence is the role layer's share times 1.0.
- **Rule B, `arm_c`** (doctor only): voiceprint `match` under both margins (§5.6), and Clef `doctor_rank == 1`, and Jev `doctor_rank == 1`. Role doctor, source `arm_c`, confidence 0.9 (a fixed constant, never a calibrated probability). **[v2]** At most one label per consult (S2).
- **[v2] Disagreement (OQ-5 ruling).** Rule A says non-doctor cannot occur (Rule A cannot say non-doctor). The remaining disagreement is voter 1 or voter 2 calling a label non-doctor while rule B names it: the label is `unknown`, no order, and the brief logs a `doctor_conflict` conflict (counted in `quality`).
- **Otherwise:** role is the role layer's role for display, source `none`; context only, never an order.
- **[v2] Which labels may order (M3, M4; amends OQ-18).** Let D3 be the set of labels decided by rule A and C the label named by rule B (zero or one).

  | D3 | C | order-capable labels |
  |---|---|---|
  | {} | none | none |
  | {} | x | x |
  | {a} | none | a |
  | {a} | a | a |
  | {a} | x (x != a) | **none** (M4: a third label named by arm (c) blocks every span) |
  | {a, b} | none | **none**: both are doctor for display; every order is a confirm prompt (M3) |
  | {a, b} | a | a only (M4) |
  | {a, b} | x (x not in D3) | **none** (M4) |

  "Order-capable label" is a precondition; the span rules (§6.4) and the live-mode medicine rule (§8.5) still apply. Every row with "none" while D3 or C is non-empty logs `doctor_conflict` or `second_doctor` for the metrics.
- **[v2] Translator check on doctor-voted labels (M3).** §6.5 translator detection runs on every label, including labels decided doctor by rule A. A rule-A label whose every span qualifies as a relay of another doctor-voted label's span is re-marked `translator` and loses order capability. A relay never creates an order (OQ-17 ruling).

### 6.4 Span role [v2]

A span inherits its speaker's role and source, then:
- `overlap`: if another brief speaker is active for more than 30% of the span, the span keeps its role but loses `order_capable`, unless the overlapping speaker is also order-capable.
- **[v2] Overlap under 30% (S4).** When any non-order-capable speaker overlaps an order's decision span at all, the builder checks who spoke the order's numbers (strength, frequency, duration, test count). Each number token is assigned to the speaker active at its STT word time if word times exist, else to the speaker with the larger overlap of the STT segment that holds it (**UNVERIFIED** whether saaras word times reach the bundle). A number assigned to a non-order-capable speaker is dropped from the order and raised as `dose_unstated`; the drug or test itself still follows the normal gate.
- `merged_turn`: the span is `unknown`, source `none`, never order-capable. The turn still reaches Stage A, labelled unattributed.
- `boundary_quarantined`: never order-capable; already excluded by Stage A rule 14 and the mapper.

### 6.5 Translators, relays and attenders [v2]

- A **relay candidate** is any speaker other than the speaker of a doctor span, **[v2] including a label voted doctor** (M3), whose span starts within 3 s after that doctor span ends and restates it. "Restates" is decided by the deterministic overlap test (at least 50% of the doctor span's content tokens: drug names, numbers, test names) and, from 0b on, by the benched Jev restate question. Brief-side detection only (OQ-17 ruling).
- A relay span gets `role: translator`, `attribution_source: translator_support` and `translates_span`. It is **never** `order_capable`.
- **Support only:** an item with doctor evidence plus relay evidence gains `emphasis.translator_restated` and may take a number from the relay only if the same number is in the doctor span. An item with relay-only evidence is blocked (`translator_only`). A relay supports an order and never creates one.
- An attender's or staff member's words never create an order, whatever they say (as today, `NON_DOCTOR`), **[v2]** and a staff or translator label that the voters decided as doctor is caught by the relay check above or by the M3/M4 table in §6.3.

### 6.6 Conflict table [v2]

| conflict | detected by | effect on span or item | blocks order |
|---|---|---|---|
| `doctor_conflict` **[v2]** | arm (c) vs voter 1 or 2; arm (c) naming a third label; two rule-A doctors | label unknown, or no label orders (§6.3 table) | yes |
| `mapping_failed` **[v2]** | `role_votes.mapping.status != clean` | voters 2 and 3 absent | yes (whole consult) |
| `merged_turn` | §5.1 | span unknown | yes |
| `overlap` | §6.4 | not order-capable unless both doctors | yes, unless both are order-capable |
| `number_speaker` **[v2]** | §6.4 S4 check | the number is dropped, `dose_unstated` | for that number |
| `boundary_mismatch` | §5.4 | confidence -0.1 | no |
| `translation_number_mismatch` | §5.1 | number dropped; `translation_conflict` | for that number |
| `native_vs_english_drug` | drug differs native vs English | existing FRX-M9 path | as today |
| `reversal` | §7.4 | earlier item `superseded` | the superseded item only |
| `two_consults` | role extras, Jev u10, `boundary.py` | quarantine as today | yes, for quarantined turns |

v1's `label_split` is removed (S2): two arm (c) labels cannot occur.

### 6.7 Items without a model
Phase 1a (mode `brief`) builds **no** content items by itself: Stage A still extracts the content, now reading the attributed transcript plus the brief's span table. Phase 1b adds Stage W for doctor's words. So in mode `brief` the `items` array is filled after Stage A, by projecting each Stage A item onto its cited spans (§8.2). That keeps one extractor and makes the comparison between arms fair (the arm difference is the input, not a second extractor).

---

## 7. Doctor's-words layer (phase 1b)

### 7.1 Why a separate pass
Stage A rule 12 caps advice at 5 short items with no repeats (`prompts/stageA-v2.md`), and the mapper caps advice again at 5 items and 300 characters (`mapper.py:50-51`). Counselling and the "why" are lost at both caps. A separate, dedicated pass over doctor speech only, with its own budget, is the smallest change that addresses the 66% counselling recall without loosening Stage A's order rules.

### 7.2 Stage W [v2]
- **Input:** every span in time order, rendered `T<i> [B<n>|<role>|<source>] (mm:ss) text`, plus native where present. Spans that are not doctor-attributed are marked `CONTEXT-ONLY`; relay spans are marked `RESTATES T<j>`. **[v2]** Quarantined turns (`boundary_quarantined`) are **not rendered at all**, not even as context, so no other patient's speech reaches the prompt or the stored brief (S5, clip leakage).
- **Prompt:** `prompts/stageW-v1.md`, Bedrock Claude Sonnet, temperature 0, through the same `ModelClient` and `phi_guard`. Output is JSON matching §4.5 (without `priority`).
- **Hard rules in the prompt:**
  1. Every unit cites at least one doctor span.
  2. A unit that cites only CONTEXT-ONLY spans is invalid.
  3. Capture ALL of explanations, instructions, counselling, warnings, lifestyle, how-to-take, contingencies and follow-up, with the stated reason in `because` when the doctor gave one.
  4. Do not merge two different instructions into one.
  5. Never add a drug, a dose or a test that is not in the cited doctor span.
- **Deterministic post-checks** (`brief_dw.py`), in this order:
  - citation check: drop a unit with no doctor span;
  - number check (`guard.numeric_support`): drop a unit whose `statement` or `because` holds a number not in a cited doctor span;
  - **[v2] unlisted-drug drop (M2):** drop a unit that names any drug not in Stage A's prescription list, kept-out list or slots (name, brand and alias matching through `medication_safety` alias data and `r1_floors.guard_names`). v1 kept such units as text; v2 drops them;
  - **[v2] how-to-take dose drop (M2):** drop every `how_to_take` unit that carries a dose, strength, frequency or duration token (the guard's numerals plus frequency words such as "twice a day", "BD"). How-to-take without a dose ("take it after food") is kept;
  - **[v2] placeholder drop (S5):** drop a unit whose `statement` or `because` holds a redaction token (`[name]` or any `[...]` placeholder); the count goes to `quality.placeholder_units_dropped`.
- **[v2]** Units that pass are still subject to R2 moved-drug withholding after they reach `gp_extraction` (§8.4, §8.5): a unit naming a medicine that was moved to a prompt is withheld whole.

### 7.3 Kinds, firmness and emphasis
- **Kinds** match the blind scoring taxonomy (counselling, advice, lifestyle, contingency, how-to-take, follow-up, warning), with `instruction` standing for advice and `explanation` for the "why", so recall can be measured per kind against the same labels.
- **Firmness** is `firm` ("take", "you must", "do not"), `hedged` ("you can try", "maybe", "if you like") or `conditional` ("if the pain increases, come"). Stage W assigns it, and a deterministic cue list overrides it in one direction only: a conditional cue ("if", "agar", and the Kannada, Telugu and Hindi conditional forms already used by `guard.CONTINUE_QUOTE` style lists) forces `conditional`.
- **Emphasis score:** `0.5*min(repeats,3)/3 + 0.3*explicit_emphasis + 0.2*translator_restated`.
  - `repeats` counts doctor spans that restate the unit. It is computed deterministically by token overlap (Jaccard >= 0.6) over doctor spans, not taken from the model.
  - `explicit_emphasis` comes from Stage W ("very important", "must", "do not forget", raised repetition).
  - The weights are proposed and **UNVERIFIED**; **[v2]** they run in shadow only (OQ-11 ruling, §8.4).

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

Note on `code_sha256`: `prompts.code_paths()` hashes every `*.py` in the package (`prompts.py:44-45`), so adding modules changes `code_sha256` for every run, which would re-queue `rejected` uids under `--skip-existing`. **[v2] (OQ-12 ruling)** The move is announced to fable before it happens and applies to new consults only (`--brief-from`, §9.1).

### 8.2 Changes to existing files [v2]
1. **`ingest.py`.** `load_bundle` keeps the slot dicts it already reads and exposes `c.bundle_tracks` (a reference, no copy of text). About 3 lines.
2. **`pipeline.py`** `run_consult`, about 30 lines:
   - after `pre = B.detect(c)`, if the mode is not `current`: `brief = build_brief(...)`. **[v2]** On any exception or §9.2 condition in **live** brief mode the run continues in brief mode with `brief.no_order = true` (M1), never in `current`; in **shadow** mode it records the failure and the posted run is `current` as today;
   - `apply_to_consult(c, brief)` sets each `Turn.role` from its span role (`translator -> other`), `Turn.role_source = "brief"`, `c.role_track = True`, and keeps `brief.order_capable_turns` (empty when `no_order`);
   - Stage A uses `stageA-v3` with `{{ENCOUNTER_BRIEF}}` from `brief_render.stage_a_block(brief)`;
   - after the guard, `brief.project_stage_a(enc)` fills `items` and records `order.eligible`;
   - in mode `brief_dw` and above, Stage W runs after Stage A and before the mapper;
   - **[v2] order of steps after Stage A (M2):** mapper `build()` (which writes the doctor's-words advice and plan text, §8.4) → brief medicine demotion (§8.5) → `r1_floors.apply_r1_ex` (R1 floors and R2 moved-drug withholding over every posted string, advice and plan included) → Stage B. R2 therefore always runs after the doctor's-words text exists;
   - `brief.json` is written to `od` (§9.4); `brief_id`, `input_mode`, `fallback` and `no_order` go into `artifact.validation.json`.
3. **`format_transcript`** (`ingest.py:425`): when `t.role_source == "brief"`, render `[S<spk>|<role>|<src>]` with src `3of3`, `armc` or `none`. A 2-line branch.
4. **`mapper.py`**, about 20 lines:
   - `by_non_doctor(turn)` and `_doctor_spoken(turns)` get a brief branch: a decision turn must be in `order_capable_turns`; `unknown` no longer counts as doctor-spoken;
   - a blocked order follows the existing kept-out route and raises `completion_required`: an unnamed medicine `pick_drug`, everything else `inferred_confirm` (no schema change, OQ-7 default accepted);
   - `evidence()` and `P()` set `speaker_source` to `diarisation` for brief-attributed turns (existing enum value).
5. **`guard.py`**: no change; it reads `Turn.role`.
6. **`validate.py`**: no rule removed. **[v2] FRX-B1 (S3)**, two parts:
   - the artifact must carry its input mode in `generator.version`, as the build-metadata suffix `+input.<mode>` (for example `2.4.0+input.brief_dw`); `generator.version` is a free string in the v0.3 schema, so no schema change is needed. A brief-mode run whose artifact lacks the suffix, or whose suffix disagrees with the run's mode, fails validation and is not written;
   - when the suffix names a brief mode: every pointed order provenance item's `decision.speaker` must be `doctor` (FRX-P2's `unknown` with `speaker_uncertain` allowance does not apply), and **no** `gp_extraction.medicines` row may be present (§8.5).

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

### 8.4 Doctor's words into the note (mode `brief_dw` and above) [v2]
- **Advice.** `mapper.Builder.advice` takes the doctor's-words units in priority order before Stage A's advice. `general_advice` is a string field, so no key is added. Must-carry units (warnings, emergency contingencies) are always included. **[v2] Budget (OQ-10 ruling):** live stays at today's 5 items and 300 characters; the 10 items and 700 characters budget runs in **shadow only** until the PDQI-9 arm run decides it. Units beyond the live budget are kept out as review items, as today; must-carry units displace the lowest-ranked non-must-carry units first. **[v2]** FreeScript R1-5 red-flag carry (`r1_floors.r1_red_flags`) then finds doctor emergency clauses already covered and adds nothing twice.
- **Plan.** Counselling and explanation units with a `because` render as "X, because Y" into `plan_of_management` text in priority order.
- **[v2] Withholding runs last (M2).** After the mapper writes advice and plan text, the §8.5 demotion moves every medicine to a prompt, and R2 (`r1_floors.r1_moved_mentions`, `r1_floors.py:464-486` on the R2 branch) withholds, whole, every posted string that names a moved drug under its name, raw name, aliases, provenance names or any brand or generic of the same molecule (`guard_names`, `r1_floors.py:437`). A doctor's-words line that names a drug therefore never reaches the posted advice or plan. Consequence, stated: how-to-take and counselling lines that name a drug are lost from the posted text in live brief mode; they remain visible to the doctor through the prompt's `detail`.
- **Stage B.** `stageB-v10` receives `{{DOCTOR_PRIORITIES}}`: a numbered list of `{rank, kind, statement}` drawn only from units still present in `gp_extraction` **after** R2 withholding, with the instruction to order Advice and Plan by rank and keep every must-carry unit. Stage B still sees no transcript.
- **[v2] Weights (OQ-11 ruling).** The emphasis and priority weights of §7.3 and §7.5 run in shadow only; live brief mode (after the ship gate) orders by first mention plus must-carry until the shadow rank changes are reviewed.

### 8.5 Medicines: every medicine is a doctor-confirm prompt in brief mode [v2]
- **[v2] Rule (M2).** In any brief mode, after the mapper, **every** row of `gp_extraction.medicines` is moved to a doctor-confirm prompt through the existing R1 route `r1_floors._to_pick_drug` (`r1_floors.py:242-262` on the R2 branch): the row leaves `gp_extraction`, its owner is kept out, its guard names join the moved set, and a `pick_drug` completion item is raised with the heard label in `detail`. A medicine is never posted as "the Rx" in brief mode, whether its speaker was attributed or not. The stricter speaker gate (§8.2) still decides which prompts carry a doctor-attributed decision quote, which is what the doctor sees as support.
- **[v2] Prompt wording.** The prompt is R1's existing `PICK_PROMPT` ("Name this drug", `r1_floors.py:32`), with the drug in `detail`. A "Confirm this drug" wording would need a vendor-side change and is not proposed here.
- FRX-B1 (§8.2) rejects any brief-mode artifact that still has a medicine row.
- **[v2] Dependency.** R1/R2 is on `cloudpane/cloud-frx-r2-build/r2`, not on `origin/main`. Phase 1a cannot ship before R2 lands on main; with R2 absent the brief code must refuse live mode (config error, exit 2).

## 9. Feature flag, fallback, storage

### 9.1 Flag [v2]
- **Env** `ETA2FS_INPUT`: `current` | `brief` | `brief_dw` | `brief_dw_affect`; unset means `current`. Any other value is a config error (exit 2).
- **CLI** `--input` overrides it per run. The eval harness passes it per arm.
- **Shadow.** `ETA2FS_INPUT_SHADOW=brief|brief_dw` builds the brief and writes `brief.json` but posts the `current` artifact. Shadow behaviour is unchanged from v1, including its fallback to `current` (M1 applies to live mode only).
- **[v2] Live mode is locked** until the 1c verdict and fable's ship gate: setting `ETA2FS_INPUT` to a brief mode also requires `ETA2FS_BRIEF_LIVE_OK=<gate id>` matching the gate id in the brief config; without it the run is a config error (exit 2). Eval runs over stored bundles (`--input` with `--out` outside the nightly) are not posting runs and do not need it.
- **[v2] Announcement (OQ-12 ruling).** Any runner move that changes `code_sha256` is announced to fable first and applies to new consults only: the nightly gains `--brief-from <IST date>` and does not re-run earlier `rejected` uids because of the brief code change.
- `brief_dw_affect` refuses to start unless `features.enabled` is true; in phase 1 it never is.

### 9.2 Failure handling: no fail-open [v2]

**[v2] Live brief mode never falls back to `current` (M1).** Any of these makes the consult run with `no_order = true`, so every order (medicine, test, referral, procedure) becomes a doctor-confirm prompt, and the note sections run as usual from Stage A:

| condition | reason token |
|---|---|
| `build_brief` raises | `brief_error:<ExceptionClass>` |
| no `role_votes` layer and no role track | `no_attribution_layers` |
| `role_votes.mapping.status != clean` | `mapping_failed` (M5) |
| folder mode (no bundle) | `folder_mode` |
| brief fails its own schema | `brief_schema_invalid` |
| zero order-capable spans after fusion | `no_order_capable_span` (OQ-13 confirmed) |

Where the brief itself could not be built (`brief_error`, `brief_schema_invalid`), Stage A has no brief block; the consult then runs with today's role join for display, **no** order capability, and the same all-prompts outcome. If even that fails, the consult is skipped (state `rejected` with reason `brief_unbuildable`), never run as `current`.

Stage W failure (mode `brief_dw`) continues as mode `brief` with `stage_w_failed`; it changes advice text only, never order capability.

**Shadow mode** is unchanged: the posted artifact is `current`, and the shadow brief records its failure reason.

**[v2] S1.** Phase 0a reports the share of consults that would run all-prompts (any row above), so the cost of M1 is known before 1a.

### 9.3 Kill switch
`ETA2FS_INPUT=current` (or unset) restores today's behaviour byte for byte (§10.4). No migration is involved.

### 9.4 Storage and retention
`brief.json` sits beside `encounter.json` in the run directory (umask 077). In bundle mode it is inside the `TemporaryDirectory` like every other output, and it is persisted to `out` only if the existing persistent-output rule copies it. Nothing in the brief is posted to Scribe. The ingest route refuses transcript-shaped fields anyway. Only `brief_id`, `input_mode`, `fallback` and the `quality` counts go into `artifact.validation.json`.

---

## 10. Tests (synthetic only)

All fixtures are synthetic, built by a script in the style of `tests/fixtures/build_fixtures.py`, with invented speech and no real uids, names or audio.

### 10.1 Unit tests: `tests/test_brief_*.py`
- **Adapters:** each adapter gets `used`, `absent`, `invalid` and `failed` cases; epoch and relative clocks; a `text` key in parts dropped; Nemotron labels in `speaker_N` and digit formats; features adapter `disabled` with the flag off.
- **Fusion, table-driven, one row per rule:**
  - 3/3 doctor; 3/3 attempted for a patient label gives `none` because Clef votes null (§5.6) **[v2]**;
  - 2/3 with arm (c) true gives `arm_c`; 2/3 with arm (c) false gives `none`;
  - arm (c) with cos 0.649 gives none; next-label margin 0.049 gives none; **[v2] runner-up-centroid margin 0.049 gives none**; one-centroid set gives none **[v2]**;
  - arm (c) with Clef rank null or Jev absent gives none;
  - voter 1 non-doctor vs arm (c) doctor gives unknown plus `doctor_conflict` **[v2]**;
  - **[v2]** every row of the §6.3 M3/M4 table, including two 3/3 doctors plus arm (c) on a third label (no order-capable label) and two 3/3 doctors with arm (c) on one of them (only that label);
  - **[v2]** a translator or staff label voted 3/3 doctor whose spans relay another doctor label: re-marked translator, no order;
  - merged turn; 35% overlap; translator within 3 s and at 4 s; translator-only number; boundary mismatch;
  - **[v2]** attender overlap of 10% speaking the strength: strength dropped, `dose_unstated` (S4);
  - no Nemotron gives the STT backbone;
  - **[v2]** OQ-3 mapping error (`ambiguous` and `failed`): voters 2 and 3 absent, no order-capable span (M5).
- **[v2] Fallback gives 0 orders (M1, S5):** for each §9.2 condition in live mode, the artifact has 0 pointed orders and 0 medicine rows, and is never byte-equal to the `current` artifact for a fixture with orders. In shadow mode the posted artifact equals `current`.
- **Order gate property:** no `gp_extraction` order has a `decision.turn` outside `order_capable_turns`, over every fixture and seeded random role mutations.
- **[v2] No medicine leaves as Rx (S5):** property test over every fixture and every brief mode: `gp_extraction.medicines` is empty, every heard drug is a `pick_drug` completion item, and FRX-B1 rejects an artifact with a medicine row.
- **[v2] R2 alias withholding over doctor's-words text (S5):** a counselling unit names the brand of a drug Stage A heard by its generic (and the reverse, and a listed alias); after §8.5 and R2 the posted advice and plan contain no name from that drug's `guard_names`.
- **Doctor's words:** context-only citation dropped; unsupported number dropped; reversal chain of 3 resolves to the last; out-of-order reversal ignored; non-doctor reversal ignored; conditional cue overrides `firm`; deterministic repeat count; must-carry survives the live 5/300 cap; ties go to the earlier unit; **[v2]** a unit naming an unlisted drug is dropped; a how-to-take unit with "500 mg twice a day" is dropped and one with "after food" is kept.
- **[v2] Clip leakage (S5):** a fixture with quarantined turns from a neighbouring synthetic consult: no quarantined turn's text, turn index or token appears in `brief.json`, the Stage A brief block or the Stage W input.
- **[v2] Placeholder (S5):** a fixture whose transcript carries `[name]` tokens: no `[name]` (or any `[...]` placeholder) appears in the rendered Stage A block's statements, in `doctor_words`, or in posted advice and plan; the count is in `quality`.
- **Affect:** `gp_extraction` byte-identical with affect on and off; affect with 1 signal changes nothing.
- **Schema:** the brief schema rejects an unknown key, an item without evidence, and an order with `eligible: true` and no order-capable span.
- **[v2] FRX-B1:** a brief-mode artifact without the `+input.` suffix, or with a mismatched one, is not written.

### 10.2 Golden fixtures: `tests/fixtures/brief/`
Each fixture has a bundle, `role_votes.json`, a recorded Stage A and Stage W (replay client), the expected `brief.json`, and the expected artifact. The set (all synthetic; these also form P-SYN for the merged-turn bench, OQ-6):

1. `synth-brief-clean`: doctor and patient, 3/3, a drug with a dose, counselling with a "why". **[v2]** The drug ends as a prompt.
2. `synth-brief-armc`: the role layer mislabels the doctor; arm (c) gives order capability.
3. `synth-brief-two-clinicians`: two overlapping clinical voices; no attribution; orders become prompts.
4. `synth-brief-translator`: an attender relays the doctor's dose; supported, not created.
5. `synth-brief-translator-only`: dose heard only from the relay; blocked.
6. `synth-brief-reversal-dose`: twice a day, then once a day; final position wins.
7. `synth-brief-reversal-test`: X-ray ordered then withdrawn; not ordered.
8. `synth-brief-hedged`: "you can try" vs "you must"; firmness and priority.
9. `synth-brief-merged`: long merged turn holding a drug; blocked.
10. `synth-brief-redflag`: a red flag said once among 8 advice lines; carried within 5/300.
11. `synth-brief-no-nemotron`: STT backbone, degraded.
12. `synth-brief-patient-drug`: the patient names a brand and strength; `drug_history` only.
13. **[v2]** `synth-brief-third-label`: two 3/3 doctors plus arm (c) on a third label; no order-capable span.
14. **[v2]** `synth-brief-staff-voted`: a staff member relaying the doctor is voted 3/3; re-marked translator.
15. **[v2]** `synth-brief-mapping-fail`: bundle and app labels do not map one-to-one; all prompts.
16. **[v2]** `synth-brief-fallback`: `role_votes` missing and role track missing in live mode; 0 orders.
17. **[v2]** `synth-brief-leak`: quarantined neighbour turns plus `[name]` tokens; nothing leaks.
18. **[v2]** `synth-brief-alias`: doctor's words name a brand, Stage A heard the generic; R2 withholds the line.

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

### 11.2 The proof: 4 arms on the same consults [v2]

| arm | `--input` | harness label |
|---|---|---|
| A0 current input | `current` | `B0` |
| A1 brief | `brief` | `Bb` |
| A2 brief plus doctor's words | `brief_dw` | `Bw` |
| A3 plus affect | `brief_dw_affect` | `Ba` (phase 2 only) |

- **Harness.** Extend the PDQI-9 arm list (`eval/pdqi9/run.py:21`) to `B0`, `Bb`, `Bw`, `Ba` (OQ-14 default accepted).
- **Consult set.** n=60, only consults with all phase-1 layers including a `clean` `role_votes` mapping, stratified like the blind 30, frozen before any arm runs (OQ-15 default accepted).
- **[v2] Budget arms.** A2 is run twice, at the live 5/300 advice budget and at the shadow 10/700 budget, so the OQ-10 decision has its own evidence.
- **Measures per arm:**
  - PDQI-9 (separate spec);
  - the floors: 0 untaped drugs, 0 invented doses, 0 dose-precedence errors, 0 clip leakage, at most 0.2 hallucinations per consult, 100% validator pass, no placeholders;
  - **[v2] medicines, rescoped (M2):** in brief arms no medicine is posted by design, so the measure is **prompts**: the share of the doctor's posted Pulse Rx medicines that appear as a doctor-confirm prompt (name in the prompt `detail`, through the audited matcher only, never the raw name rule), plus prompts per consult and the share of prompts carrying a doctor-attributed decision quote. Arm A0 is scored on "posted or held as a prompt" so the comparison is like for like;
  - investigations against the posted Pulse Rx (prompts in brief arms, posted or held in A0);
  - doctor's-instruction recall by kind, scored like the blind item 8, **[v2]** reported both on the posted note and on note plus prompt details (because R2 withholds drug-naming lines);
  - red flags carried; cost and latency.
- **Decision rule (OQ-15 default accepted):** A1 over A0 if no floor regresses and PDQI-9 is not worse (paired Wilcoxon, **UNVERIFIED** as merged); A2 over A1 if counselling weighted recall rises by at least 10 points and no floor regresses. A3 waits for phase 2.
- **[v2]** The verdict feeds fable's ship gate; it does not itself turn live mode on (§9.1).

## 12. Phased build plan [v2]

Sizes: S up to 1 Builder day, M 2 to 3 days, L 4 to 6 days. Every phase ends with a Refuter pass and the repo gate.

| phase | content | size | depends on | exit check |
|---|---|---|---|---|
| **0a** | **[v2]** Port the off-repo role-vote and arm (c) code from the pdqi9 work into the repo as `role_votes.v1` (§5.6), with the Jev question id in metadata, both margins, Clef null-vote rule, and the bundle-to-app label mapping proof | M | OQ-1, OQ-3 rulings | **[v2] (M6, S1)** reports on the same 60 consults, counts only: (1) 37/60 and 15/60 under the old one-margin definition, reproduced; (2) the same two numbers under the both-margins definition; (3) a labelled false-doctor-attribution rate (labels wrongly made order-capable) on P-SYN plus the 20 hand-checked real consults; (4) mapping status counts (clean, ambiguous, failed); (5) the all-prompt consult share under every §9.2 row |
| **0b** | Jev per-label doctor-cue question set, benched on labelled data before wiring | M | 0a | calibration table on the labelled set; the benched question id goes into the brief config |
| **1a** | `brief.py`, schema, Stage A v3, mapper order gate, §8.5 medicine demotion, FRX-B1, flag, live lock, no-fail-open handling, shadow, unit tests and fixtures 1-5, 9, 11-17 | L | **[v2] 0a and 0b**, R2 on main | gate green; byte-identical with the flag off; shadow on new consults only, counts reported |
| **1b** | Stage W, `brief_dw.py` (v2 drops), shadow 10/700 budget, Stage B v10, fixtures 6-8, 10, 18 | M | 1a | gate green; replay CI |
| **1c** | The proof run: A0, A1, A2 (two budgets) on the frozen set | M | 1b, PDQI-9 spec | scoreboard row and floor table |
| **ship** **[v2]** | Live brief mode | S | 1c verdict **and** fable's ship gate | `ETA2FS_BRIEF_LIVE_OK` set to the gate id |
| **2a** | Audio-feature adapters live | M | P1-P6 coverage > 0 | adapter tests with real shapes (synthetic values) |
| **2b** | Affect layer, 2+ agreement rule, arm A3 | M | 2a | affect-off identity property plus A3 proof |

Critical path: 0a, 0b, 1a, 1b, 1c, ship gate. About 4 to 5 Builder weeks including Refuter passes (**UNVERIFIED** estimate). 1a can be built against fixtures while 0a and 0b run but cannot merge before both pass.

**[v2] Rulings carried as plan items:** merged-turn thresholds ship as defaults in shadow and are tuned on P-SYN plus 20 hand-checked real consults (OQ-6); FRX-N1 stays at today's rule, and its policy belongs to fable (OQ-16); `parts` is off (OQ-20).

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
| **[v2]** No medicine is posted in brief mode, and M1 makes some consults all-prompts | By design (M2, M1); measured as prompt recall (§11.2); 0a reports the all-prompt share (S1) |
| `role_votes` is built outside this repo and drifts | A stored, versioned layer with a `config` and sha256 in `inputs` |
| Stage W adds hallucinated counselling | Citation and number post-checks; the judge counts hallucinations per consult (floor <= 0.2) |
| Bigger advice text trips the FRX-N1 phrase rules (49 "addressed to doctor" rejects) | **[v2]** Today's FRX-N1 rule applies; its policy belongs to fable (OQ-16). Shadow measures the reject delta |
| Label namespaces (spkN vs speaker_N) mismatch | Phase 0a emits votes in bundle label space only |
| **[v2]** R2 withholding removes drug-naming counselling lines from posted text | Recall reported on note plus prompt details (§11.2) |
| Brand redaction erases drug names before the brief sees them | Out of scope; the brief records `[name]` token counts in `quality` so the effect is visible |
| Cost | Stage W is about one more Sonnet call per consult (**UNVERIFIED** price); shown in `cost_usd` |

---

## 15. Assumptions not verified in the repo (UNVERIFIED register)

- **U1.** **[v2]** The pdqi9 role-vote and arm (c) code exists off-repo and can be ported as `role_votes.v1` (OQ-1 ruling names the source; the code itself is not in this repo).
- **U2.** `diar_sarvam` segment shape (writer not in the mirror).
- **U3.** **[v2]** That a one-to-one bundle `speaker_N` to app `spkN` mapping exists for most consults; 0a measures it, and M5 makes failure safe.
- **U4.** The logged-in doctor of a consult is reachable on the box (`cutter_row.doctor_uid`) and has an enrolled print; without either, arm (c) is off (OQ-19 ruling).
- **U5.** Coverage of Clef-omni role decisions, voiceprints and `acoustics` per consult.
- **U6.** `translate_gapfill` presence in box bundles.
- **U7.** Thresholds are design proposals: merged-turn 25 s and 20%, label share 60%, span gap 4 s, relay window 3 s, overlap 30%, arm (c) confidence 0.9, emphasis weights.
- **U8.** Stage W cost and latency.
- **U9.** The PDQI-9 Wilcoxon method is merged and usable.
- **U10.** `timbre-e2v` is emotion2vec.
- **U11.** A box runner may read C4 (resolved by the OQ-8 default: a bundle slot).
- **U12.** **[v2]** Saaras word-level times reach the bundle (S4 number-speaker check falls back to segment overlap without them).
- **U13.** **[v2]** R1/R2 (`r1_floors.py`) lands on main with `_to_pick_drug`, `guard_names` and `r1_moved_mentions` as cited from `cloudpane/cloud-frx-r2-build/r2` at `fd65cdc6`.
- **U14.** **[v2]** No consumer of the artifact parses `generator.version` as strict semver without build metadata (FRX-B1 suffix).
