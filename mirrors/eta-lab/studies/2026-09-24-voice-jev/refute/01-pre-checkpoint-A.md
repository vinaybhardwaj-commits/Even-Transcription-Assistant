# Pre-Checkpoint A notes (16:50 IST; draft inventory.json, not yet declared as Checkpoint A)
- arms/freeze.txt: sha256 = b961291ae64c (raw file). Matches the order. OK.
- No inventoried set has human doctor-turn labels (V5 0, SC30 0, W58 none). The pass rule's primary metric (doctor attribution on DOUBTFUL turns) has no truth yet. A turn-label page is required before any arm can PASS.
- Clause (a), margin < 0.10: 0 turns have a computable margin in the stored outputs, so the doubtful set is (b) or (c) only. V5 is 1059/1059 diarization_only, so it has 0 confident turns and "zero confident worse" is vacuous there.
- Blinding: inventory.json carries V's V5 human speaker counts (which count as truth) in a vj-data file. The order only fences key.json, so this is not a rule breach, but it is the leak I raised in defect 1/2.
- SC30: vj-data says Nemotron counts for SC30 live only in key.json's hidden fields. That makes selector clause (c) for SC30 depend on a blinded file, which is a conflict for Fable to rule on.
- inventory.py states it never reads key.json (line 4). To verify at the checkpoint: grep the code and shell history.
