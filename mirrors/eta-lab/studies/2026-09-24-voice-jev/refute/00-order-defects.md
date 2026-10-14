# VJ refuter: order defects (VOICE-JEV-BUILD, ruling 144)

Order read from origin/main e30b4a7 (the local shared checkout is ahead 12 / behind 30, so `git pull --ff-only` refused; I did not merge or rebase it).

Freeze hash: b961291ae64c reproduces only when the text between the markers has its leading newline stripped (equivalently strip()+"\n"). Hashing the raw slice gives ed45439b3bec, and strip() alone gives 6078b935666c. Pin the convention, or builders will stamp result files with the wrong sha.

## Defects
1. BLINDING (count truth): only key.json is fenced. Fable writes truth/human-counts.json into the shared eta-lab tree, where vj-data and the arm runners can read it. The scorer and the arm runners are the same pane (vj-arms), so the fence is honour-only.
2. BLINDING (turn truth): at Checkpoint A, vj-data opens the doctor-turn truth (V5, the 58-window set) and then designs the descriptors and cards for those same turns. Nothing blinds the card builder to turn truth.
3. DOUBTFUL (undefined inputs): the margin's scale and embedding model are not named. There is no rule for a turn with no voice match or no enrolled doctor. "Window" is undefined for turns outside the labelled window sets. The Nemotron build is not pinned (a fine-tune is live today). If production never ran pyannote, computing it is a new model run inside "arm 1 = stored outputs".
4. PASS RULE (confident turns): the combine rule, "keep arm 1 if confident", is specified for arm 3 only. That makes "zero confident turns worse" automatic for arm 3 and undefined for arms 2 and 4. All arms need the same wrapper.
5. PASS RULE (no bar): "beats arm 1" has no minimum n or margin, so a 1-turn net win on a small doubtful set passes. Proposed fix: a minimum doubtful n, a net gain of at least k turns, and a paired test (McNemar).
6. PASS RULE (metric shape): Q1 has 5 options but L1 is binary, and doctor-or-not is not mapped. Arms 2 and 3 produce no speaker count (Q3 is yes/no), so count exact-match applies to arm 4 only. Arm 1's count source (Nemotron or pyannote) is unnamed.
7. REPRODUCTION: "re-running" is undefined for Jev and Gemini, which are nondeterministic. Is it a re-score of stored raw outputs, or k fresh calls with a tolerance? The same question applies to the 0.70 confidence gate.
