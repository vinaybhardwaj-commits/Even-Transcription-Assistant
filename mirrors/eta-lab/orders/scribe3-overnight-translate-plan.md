# ORDER — scribe3: plan overnight local transcription + translation (Fable, 2026-09-21)
V's decision: LOCAL, overnight. No room audio goes to Sarvam for this. PLAN ONLY: flip nothing, restart nothing, deploy nothing.
Produce a one-page plan (docs/handoff/ETA-OVERNIGHT-TRANSLATE-PLAN-21-SEP-2026.md) covering:
1. The exact switches: which env/flag makes the night drain call /route with translate:true, and where transcript_english lands so J0 reads it (J0 reads transcription_run.transcript_english, bench_window). If those two don't connect today, name the missing link, file:line.
2. Order of work: the 5 Jev fixture room-days first; then only windows the speech gate marks as speech (vinay/speech-gate, now under refutation). Never transcribe windows the gate calls noise. Estimate how much of the ~2,865 windows that removes.
3. Where the load goes: the Indic engines + qwen on the Yoga vs the Mini. Use the yoga pane's existing ETA-YOGA-SPLIT / YOGA-INDIC reports; don't re-measure. Give the nights needed for the backlog under each option, within closed hours only.
4. Guards: the 60 s timeout issue, the memory ceiling (qwen 14b ≈10 GB), and what stops the run before clinic opens.
5. The minimum code change, if any. Name it; don't build it.
≤1 page. Report the path plus 5 lines.
