# Speaker-attributed tone — design (L7, 23 Sep, e2e box, not implemented)

**Question:** how do emotion scores (`room_span_emotion`) become "this is the doctor's tone" /
"this is the patient's tone" rather than an unlabelled speaker index?

**Owner:** Builder (lab-mover) **Date:** 2026-09-23 **Status:** design only, no code, no migration.

## The join already exists, just isn't used for this

`room_span_emotion` carries `window_id`, `diarize_run_id`, `speaker_idx`. `room_turn_speaker`
carries `window_id`, `speaker_idx`, `run_id`, `clinician_id`, `role`, `match_confidence`,
`no_role_reason`. Both are keyed off the same diarize run's local speaker index for a window —
join on `(window_id, speaker_idx)` **and** `room_turn_speaker.run_id = room_span_emotion.diarize_run_id`,
not `window_id + speaker_idx` alone. Reason: `speaker_idx` is local to one diarize attempt: if a
window is re-diarized, a new run can assign index 0 to a different physical speaker than the
previous run did. Migration 0089's own comment already says this ("identity comes only from
room_turn_speaker") — the schema anticipated this join, nobody built the query yet.

```sql
SELECT e.window_id, e.speaker_idx, e.top_label, e.top_score, e.anger, e.disgust, e.enthusiasm,
       e.fear, e.happiness, e.neutral, e.sadness,
       t.role, t.clinician_id, t.match_confidence, t.no_role_reason
FROM room_span_emotion e
LEFT JOIN room_turn_speaker t
  ON t.window_id = e.window_id AND t.speaker_idx = e.speaker_idx AND t.run_id = e.diarize_run_id
WHERE e.state = 'scored';
```

(Verbatim, inferred against the migration files, not run against live data for this design —
the shape has been exercised implicitly by every "voiceprint attribution" study this session,
e.g. e3kit and e7-pqm-truth, but never joined against `room_span_emotion` specifically until now.)

## Three roles a segment can land in, and none of them is a guess

1. **Attributed** (`t.role IS NOT NULL`, e.g. `doctor`): the segment's tone is that clinician's,
   at whatever `match_confidence` the voiceprint match carries. **Surface the confidence
   alongside the label** — a low-confidence `doctor` attribution presented with the same
   certainty as a high-confidence one would overstate what the data supports.
2. **Attributed-but-refused** (`t.no_role_reason IS NOT NULL`): the join found a row, but
   `room_turn_speaker` itself declined to name a role (below match threshold, ambiguous, etc.).
   Surface as **"unattributed — <reason>"**, never silently drop it or silently fold it into
   "patient" by elimination. A two-speaker room isn't proof the other voice is the patient.
3. **No join row at all** (`t` is `NULL`): the diarize run this emotion segment came from has no
   speaker-role data for that index at all (yet, or ever). Surface as **"unattributed — no speaker
   data"**, distinct from case 2. Mark, never delete, never infer.

## What NOT to build

- **No new table.** The join above is a view-shaped query, not a schema change — consistent with
  this lane's "no shadow schema" rule (`AUDIT.md`'s backlog section) and with `room_span_emotion`'s
  own migration comment that it "does not record... any reading of what \[the model\] output means."
  A materialized view is a reasonable optimization *later* if the live join is measured to be slow;
  not proposed here without that measurement.
- **No aggregate "doctor's average mood today" without `EMOTION_SURFACE_ENABLED`.** The two-flag
  design (`gate.ts`) already separates "compute and store" from "a clinician can see this" — a
  tone aggregate is exactly the kind of surface `canSurfaceEmotion()` exists to gate, and nothing
  should call it before that flag is deliberately flipped (still false today, per `AUDIT.md`).
- **No per-segment label as ground truth.** Every table comment on this feature says the model is
  "trained elsewhere and not validated on this audio." A tone design that treats `top_label` as a
  fact rather than a candidate signal would misuse the data more than the join logic could ever
  get wrong.

## Open question for whoever builds this next

`match_confidence` bucketing (what counts as "confident enough to attribute") isn't defined
anywhere in this design — it's a product/clinical call, not an engineering one, and belongs in an
order, not invented here.
