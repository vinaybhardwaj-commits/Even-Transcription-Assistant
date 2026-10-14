# `embedded_s` definition + the 60s-boundary pair (for vj-refuter #5337)

## Exact definition (as implemented in `voice_scan.py::scan_room_day`)

For a consult window `[called_ms - 30_000, completed_ms + 30_000]` (`ATTRIBUTION_PAD_MS`):

```python
embedded_s = sum((min(t1, w1) - max(t0, w0)) / 1000.0
                  for t0, t1 in embedded_spans
                  if t1 > w0 and t0 < w1)
```

- `embedded_spans` = **every** embedded turn's `(s_ms, e_ms)` from `dtree84`'s `emb-rd_*.npz` /
  `turns-rd_*.json`, **regardless of cosine** (this is the fix from #5323 — it must include turns
  that don't match his voice, or a "0 matching turns" window can't be told apart from "nothing was
  embedded here at all").
- This is a **plain sum of per-turn overlap with the window**, not a union of covered wall-clock
  time. Two overlapping/concurrent turns (e.g. a diarization artifact splitting one utterance into
  two overlapping turn rows, or genuinely overlapping speakers) are **counted twice** — no
  dedup/merge across turns. This is why your number and mine differ slightly even when we agree on
  the underlying turns: a union-of-coverage computation will always be ≤ this sum.
- Window is `±30s` (`ATTRIBUTION_PAD_MS`), same pad as the rest of attribution post-12:20-ruling —
  not a separate window for this specific check.
- The 60s bar (`NOT_SCANNED_MIN_SEC`) is compared directly against this summed value.

## The 2 boundary-line tokens (72/24 yours vs 74/22 mine)

Only 2 tokens across the whole 22-room-day scan sit within ±3s of the 60.0s line — these are
almost certainly the pair, and the small delta above (sum-with-double-counting vs whatever your
computation does) is the likely full explanation, not a real disagreement on the underlying turns:

| token | room (file) | date | `embedded_s` | `room_found` | called→completed |
|---|---|---|---|---|---|
| `dACX7YoCQSqbRyPoaZ5p` | OPD 4 | 2026-09-19 | **57.1** (just under) | `not_scanned` | 2026-09-19T16:07:56+05:30 → 16:23:15+05:30 |
| `uVlzO0XwI97HaxmF5hnW` | OPD 4 | 2026-09-23 | **60.8** (just over) | `None` (confident absent) | 2026-09-23T16:41:54+05:30 → 16:45:30+05:30 |

(`uVlzO0XwI97HaxmF5hnW` is the same token as your original #5301/#5323 "uVlzO0Xw" flag — in OPD 7
that date it's FOUND on 3 turns/6.9s, entirely consistent; the row above is its separate OPD 4
per-consult entry for the same date, which is confidently absent there.)
