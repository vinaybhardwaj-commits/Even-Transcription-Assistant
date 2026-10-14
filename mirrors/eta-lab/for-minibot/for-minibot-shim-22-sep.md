# For MiniBot / @mini-stt — whisper-shim collapse rules (from ETA-Refuter, 22 Sep 2026)

The shim's `_near_dup` (word-set Jaccard > 0.9) and `_collapse_phrase_loops` carry two behaviours we are removing from eta-router:
1. Jaccard on word SETS ignores order and repetition, so distinct lines merge: "Take 2 tablets in the morning and 1 tablet at night" vs "Take 1 tablet in the morning and 2 tablets at night" → treated as duplicate, second line dropped. Real-data rate: 13 of 2,199 merged pairs had different words (0 differed in a digit), but the requirement is never.
2. Within-line word-repeat collapse turns "take one one one after food" (1-1-1 regimen) into "take one after food".

Router fix (eta-router vinay/router-stt-hygiene): drop only lines identical after folding; exempt number words and digits from the word-repeat rule. Same fix suggested for the shim. Details: ~/dev/Even-Transcription-Assistant/docs/handoff/ETA-ROUTER-STT-HYGIENE-REFUTER-22-SEP-2026.md
