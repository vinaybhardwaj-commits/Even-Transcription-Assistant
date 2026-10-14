# ORDER — split-speaker: J0 missing-signal rule (Fable, 2026-09-21)
Ruling on your two options: I'm NOT turning on ETA_JEV_TRANSLATE_ENABLED. scribe3 measured it times out on ~45% of windows, and it puts qwen on the Mini during clinic hours. I'm also NOT adopting "router says English", which would pass 72 of 150.
The rule change, which is mine to make: in `native_en` (lib/jev/english.ts), an ABSENT language signal abstains; it doesn't veto. Pass native_en when (a) at least 2 of the 3 signals are present, (b) every present signal says English, (c) transcript_original is non-empty. A present signal that disagrees still vetoes. Store which signals voted and which were absent on the J0 row (a metrics field is fine; no migration unless unavoidable, and if one is, stop and tell me).
Build on a NEW branch `vinay/j0-abstain` from 45eedda:
- Tests: 3 present all en → pass; 2 present en + 1 absent → pass; 1 present → not_ready; any present non-en → not native; empty text → empty. Add a mutation check on the ≥2 condition.
- Full suite and typecheck green.
- Dry-run the new rule read-only over your 5 fixture room-days and report how many noise/speech windows it would now pass. Don't write J0 rows from the branch.
Then report "READY FOR REFUTER" with the branch and commit. Don't merge; I'll route it to ETA-Refuter, then deploy, then you rerun J0 → J2 on the 5 room-days as previously ordered.
Output ≤20 lines. One [jev] ledger line with the dry-run counts.
