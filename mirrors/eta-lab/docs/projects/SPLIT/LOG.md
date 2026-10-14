# LOG — SPLIT (diarization: who spoke when)

Build and event log, newest first. Owner panes: diar-lab, eta-refuter-2 (checker).

## 26 Sep ~19:3x-20:1x IST — 337e T4 run done; split takes over
Session: diar-lab, split.
T4 run finished 15/15, 1,342 windows (#3853); labels move to the new split pane (W27.6; #3881).
Refs: #3853, #3881.

## 25 Sep 23:00 IST — 337e speaker labeling complete
Session: diar-lab (runner on box T4 + HF).
Segment-level speaker labels across all 4,167 vault windows, published under kind `speaker` (RESULTS-337E.md). Temporary HF audio bucket deleted.
Refs: #3100, r418.

## 24 Sep 21:05 IST — Nemotron fine-tune halted
Session: diar-lab + eta-refuter-2.
Nemotron fine-tuned on teacher labels collapsed on minor speakers; untuned base beat all tuned variants on count accuracy. Count fine-tuning stopped; pyannote.ai retained as primary for counting; untuned Nemotron kept for local shadow.
Refs: #966, r94, r210.

## 24 Sep 14:21 IST — 30-window benchmark page
Session: surg-page (UI) + diar-lab (selection).
"Who is speaking / how many people" 30-window page published (SiDazgRkh29bUrVEi1NUwg); V rated 8/30. Scoring auto-triggers at ≥20.
Refs: #292, r94.

## Goal
Own diarization model within 3 DER points of pyannote.ai on 2 weekly evals — not yet started (needs the ≥20-window benchmark first).
