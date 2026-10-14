# 337c re-transcription of garbled segments (indic-mt)

Ruling 337c/349: re-run flagged segments on eta-lab-l4 with the language FORCED, keep both versions, score by blind sample.
Old text is never touched; outputs are new files. Everything below touches patient audio/text: data lives under
`~/eta-data/readable-rerun/` (0700) on the box and `~/eta-lab-night/indic-mt/` (0700) on eta-lab-l4, never in git.

| file | where it runs | what it does |
|---|---|---|
| `cut_segments.py` | box | rebuilds each hist window with fleet's `full_audio.assemble` (the pipeline's own placement) and slices segments to 16 kHz wavs + manifest (no text). `sample` = stratified test sample; `list FILE` = the flagged list `{"record": relpath, "idx": n}` |
| `rerun_whisper.py` | eta-lab-l4 | faster-whisper large-v3, forced language (arm A) |
| `rerun_indicconformer.py` | eta-lab-l4 | IndicConformer-600M pinned e9b71b3, RNNT, copied from the Mini (arm B) |

Findings so far (counts only): the first cutter (per-segment ffmpeg -ss) disagreed with the stored text on English controls and was
replaced by the assembly slice; large-v3 auto-detect labels Indian-accented English as hi/kn/ta/ml with p=1, so the language is always forced
(force_lang: the segment's Indic tag, else the window's dominant Indic language, else its commonest Indic tag, else skip).
