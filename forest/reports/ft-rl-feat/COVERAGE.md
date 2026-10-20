# ft-rl-feat COVERAGE (counts only). Rows = D episodes with >= 1 transcribed call: 369
Manifest calls (D): 933; STT ok: 933; STT failed/missing: 0 ({})
Roles source (calls): {'talk_fallback': 678, 'lexicon': 254, 'single_speaker': 1}  (talk_fallback = lexicon tie, speaker with more words = counsellor; talk-share features on those calls are weaker)
Odyssey windows scored ok: 9823, errors: 0; calls with >=1 patient window: 845
Haiku-tagged calls: 922 (STT-ok calls untagged after retry, excluded from aggregates: 11); outcome_revealed (verified) calls: 140; post-event calls: 0

| window | episodes with >=1 call | with patient valence | with tags | h14 pos among covered | h90 pos among covered |
|---|---|---|---|---|---|
| T=3 (day_from_rx < 3) | 255 | 242 | 255 | 38/220 | 33/112 |
| T=7 (day_from_rx < 7) | 306 | 291 | 306 | 41/269 | 36/133 |
| T=14 (day_from_rx < 14) | 344 | 329 | 344 | 42/303 | 38/156 |

Notes: D split only (non-D episode ids in the manifest are dropped before any STT/audio is read; output asserts split == D). Calls with a verified outcome_revealed tag and calls on/after the event date are excluded from every aggregate.
h14/h90 columns are copied from labels.parquet for convenience; h90 is NaN/pending for young Rx. Small n = DIRECTIONAL.
