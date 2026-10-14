# Local-vs-teacher comparison OFF: a DELIBERATE gap, not missing data (split-speaker, 24 Sep 01:55 IST)

**What:** `DIARIZE_LOCAL_LABEL=0` (branch 0e96d39, eta-refuter PASS) stops the `local_label` step, the LOCAL diarizer's
comparison run on the Mini. pyannote.ai teacher labels are **still written** (the poll step, gated only by `DIARIZE_TEACHER_LABELS`).
**Why:** diarize backlog on the night of 23→24 Sep. Every running job sat in local_label while ~90 windows waited for clinical diarization.

## The OFF period (Fable fills in the times, since Fable sets the env and promotes)
| from (IST) | to (IST) | set by | note |
|---|---|---|---|
| 24 Sep ~03:00, deploy promote time TBC | open | Fable | DIARIZE_LOCAL_LABEL=0 |

## Finding affected windows: the rows alone do NOT mark most of them
- A job **already parked** at local_label when the flag went off finishes with `result.local_label = "skipped_flag_off"`.
- A window diarized **after** the deploy never reaches that step, so its job result has **no `local_label` key at all**. That is
  indistinguishable from a pre-flag window whose comparison was never scheduled. Use the time window instead:
  pyannoteai rows in `diarize_window_label` with no `engine='local'` row for the same window, created inside the OFF period above.
- Do not train or score "local vs teacher" on OFF-period windows as if the local run had failed or been lost. It was never run, by choice.
- Follow-up, not built: write an explicit `local_label: "off"` marker into the job result on the gated path, so future OFF periods
  mark themselves. It was not in 0e96d39 because of the 02:40 deadline.
