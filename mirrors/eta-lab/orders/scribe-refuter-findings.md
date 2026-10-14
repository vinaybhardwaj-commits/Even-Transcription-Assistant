# ORDER — scribe — the Refuter passed your branch and found two things that matter

Verdict was PASS and the branch is good. But under V's durable-centroids ruling the Refuter's two
findings stop being cosmetic, so fix them before this lands:

1. **`lib/voice-samples.ts:185 → :209`** — the prior-samples SELECT sits **outside** the atomic
   batch. Two concurrent enrolments lose an update on `sample_count` / `samples_json`. That corrupts
   the very provenance the centroid is supposed to carry, which is exactly what "durable" is for.
2. **`lib/voice-samples.ts:166`** — R2 uploads precede the batch with no compensation, so a failed
   batch orphans the audio. Now that retained audio **is** the durable asset, leaked audio matters
   more than it did yesterday.

## Also: make versioning live — this is the bigger win
The Refuter established that migration **0108 `voice_print_generation` is applied in production with
7 rows** and holds exactly what the ruling asks for: per clinician a `generation`, an `origin`
CHECKed to `('enrolment_clip','room_audio')`, the raw 768-byte centroid, `sample_count`,
`samples_json`, `provenance_json`, unique on `(clinician_id, generation)`, insert-only.

**Nothing reads it. The matcher still reads `voice_print`.**

So requirement 4 of the ruling needs a **reader, not a migration**, and `origin` already encodes the
room-domain distinction the whole programme now turns on. Write that reader: the matcher should load
the newest generation per clinician from `voice_print_generation`, falling back to `voice_print`
where no generation row exists. Behind a flag, default OFF, using the `lib/flags.ts` convention
(`FLAG_TRUTHY`/`FLAG_FALSY`, throw on anything else).

## Constraints
Neon HTTP driver — no `sql.unsafe`, no interactive transactions, timestamps return as ISO strings.
Branch from `vinay/enrolment-retention` at `de23934`. **Do not recompute, migrate or delete any
existing centroid, sample or voiceprint.** Tests first; prove each fix by reverting it and showing
the test fails.

## Output
Per-file changes, the flag name, mutation results, test counts. Do not push. CAP 180 words.
