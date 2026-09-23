# Medication-note labelled set — placeholder

Order NOTE-SAFETY-SHADOW.md §4: "the J-CORE-3 harness runs U4 on a labelled set; add a place for
a MEDICATION-note set (the corpus has none)". This directory is that place. It is empty on
purpose — no labelled medication-note set exists yet, and none should be invented here.

## What belongs here

One JSON file per labelled batch, an array of `lib/jev/bench.ts`'s `BenchItem` shape:

```json
[
  {
    "subjectId": "enc_xxx:current_medications[0]",
    "expected": "supported",
    "predicted": "supported",
    "confidence": 0.97,
    "latencyMs": 420,
    "inputTokens": 310
  }
]
```

- `subjectId`: the same `encounterId:path` shape `lib/jev/note-safety-shadow.ts` uses for
  `jev_decision.subject_id` — no note or transcript text, only a structural path.
- `expected`/`predicted`: a human-reviewed label and Jev's own answer, as comparable strings
  (`"supported"` / `"unsupported"` for a U4 noul question, thresholded at 0.5 — `scoreJevBench`
  is answer-shape-agnostic and does not care which labels are used, as long as `expected` and
  `predicted` use the SAME vocabulary).
- `confidence`/`latencyMs`/`inputTokens`: read straight off the corresponding `jev_decision` row
  once U4 has run over the encounters in the batch (`scribe_note_safety_replay`, or the automatic
  pipeline hook, with `JEV_NOTE_FAITHFULNESS` on).

No file here may contain transcript text, note text, or a patient/clinician identifier — the same
rule as every fixture in this repo (`tests/fixtures/jev/day-clean.json` already follows it).

## How to score a batch, once one exists

```ts
import { scoreJevBench, formatJevBenchReport, type BenchItem } from "@/lib/jev/bench";
const items: BenchItem[] = JSON.parse(fs.readFileSync("tests/fixtures/jev/medication-notes/<file>.json", "utf8"));
const metrics = scoreJevBench(items);
console.log(formatJevBenchReport({ use: "U4 medication instructions", questionId: "note_sentence_supported", promptVersion: "jev-note-safety-v1", metrics }));
```

`lib/jev/bench.ts`'s harness needs no medication-specific code — it is the same `scoreJevBench`
every use runs through (J-CORE-3, PLAN-v3 §2). Only the labelled data was missing.

## Sizing, measured 23 Sep 2026 (read-only, count only, no text — see the build report)

See the build report for the exact count of recent production notes containing medication
instructions, as a sizing reference for how large a first labelled batch could realistically be.
