# Fable rulings — 24 Sep 12:55 IST (95–105)

95. **12:30 deploy (dpl_Aa8yKpWBaFKvd5TkZZ5agCGcuF7X, 5970852): ACCEPTED COMPLETE.** Smoke 4/4, bulk served_by = whisper-box. The e31b R58 flake gets fixed in the next train (scribe).
96. **join-shard: push d5809b1 to origin NOW** so the night train carries it. The Worker deploy stays separate, after 20:30, on Fable's go.
97. **Health flap 12:35 (whisper probe negative-cache, :05 room_window slot):** no action. The conductor re-probes. If it repeats outside the :05 slot, eta-refuter reopens ruling 25.
98. **Whisper VAD off:** it is V's ruling (PLAN-v3, SoP s7). Keep it OFF. The revert trigger in ruling 87 stands (loops >10% over ≥150 windows, or 87frpus9 alarm again by 14:00).
    - minibot records WHO executed it (plist mtime + launchctl print, read-only) in the ledger.
99. **indic-mt #273: DELETE ALL three stray patient-text copies** (gcp-l4 and audiometry `~/eta-lab-night/indic-mt`, T4 `/home/eta/indic/mini-bundle`), after confirming no running process has them open. Canonical copies stay in eta-data. Report the paths deleted.
100. **hist-miner:** create the pinned production worktree at 5970852 now. Transcription waits for Fable's word after the parity PASS.
101. **Q29:** use eta-refuter-2's re-judged cut (one consult, no grey). lx adds a `clamped_mid_speech` flag.
     - fleet: every check=False edge in the final set gets a 20-second listening check at each boundary before seeding, done by a Sonnet agent with the audio (not just the automated check). Q24's weak audio: drop it if the word check still fails after listening.
102. **eta-indic model durability (minibot):**
     - Stage a second copy NOW at `~/models/indicconformer-e9b71b3/` (hardlinks per lab-mover #280, never symlinks).
     - The plist change to point HF_HOME/model path there + restart + smoke → tonight after 20:30 only.
     - RCA: cause unknown. Standing rule from now: no session may use the minidisk `delete_path` tool (or rm) on `~/.cache`, `~/models`, or any service model/venv path. Board it.
103. **Nemotron (diar-lab diagnosis):** ceiling 8 is not the cause, and the teacher equals V on V5. So the teacher is sound and the problem is the data.
     - **Key fix:** VAL is biased low (mean 2.7 speakers vs bench 5.0), so val-stopping rewards under-counting. Re-stratify VAL to match the test count distribution (while staying disjoint) BEFORE variant A. eta-refuter-2 checks the new split.
     - Arm D (no-training) is approved; it is cheap.
     - Order: D and the val re-stratify now; then A → B → C, each diff refuted before launch. eta-refuter-2's pre-launch checklist (#288) is adopted.
104. **Night train @73868e4 (gated green 4594/0):** Fable orders the push after 20:30. scribe holds.
105. **Surgery v3:** 10 built (8 proposals + 2 look-alikes); fleet adds ≥2 look-alikes by 14:00. Seed at 16:00 stands. The UNVERIFIED list (fleet #286) goes into the study notes, not onto the rater page.
