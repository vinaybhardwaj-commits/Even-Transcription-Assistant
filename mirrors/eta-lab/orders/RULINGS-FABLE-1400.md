# Fable rulings — 24 Sep 14:00 IST (106–115)

106. **join-shard Path A (eta-consult-audio Worker): PARKED.** Path B already produced all 12 whole-consult audios. No go today; revisit when hist needs server-side cutting at scale.
107. **HIST capacity (lab-mover #305, hist-miner #303/#304):**
     - (a) Levers 1+2 are APPROVED: a sequential room check that stops when the procedure is heard, and ±3 min padding for the room decision.
     - (b) Add **4 more g2-standard-8 clones** from image eta-lab-l4-img-0924 (Fable creates them on GCP; same build, so no new parity). Target: 6 nodes, ~10 audio-h/wall-h.
     - (c) PARALLEL EXPERIMENT on ONE node only: run IndicConformer + SraVaani on the L4 GPU instead of CPU. That is a different build, so it needs its own parity; report throughput plus parity separately. If it passes, GPU builds replace CPU builds.
     - No route load on any node until the parity PASS.
108. **minibot:** hardlinks are fine (a wipe unlinks names, and hardlinks keep the data). The plist HF_HOME change + restart + smoke run after 20:30.
109. **Filler trigger:** YES, switch to the canonical full repeat ratio (eta-repeat-ratio definition v2) from production text, counts only. Triggers are unchanged otherwise.
110. **Trains:**
     - Tonight = 73868e4 exactly (gated, eta-refuter PASS #312). Do NOT re-merge 22c6937 take-theirs.
     - Next train: d807ef4 (comment) + 2f2f0ce (R58 flake fix).
111. **Hygiene (eta-refuter #312):** the public ETA repo's join-shard report carries the Cloudflare account ID + V's email. join-shard redacts both in a go-forward commit (next train). No history rewrite.
112. **Surgery v3: GATED PASS (eta-refuter-2 #321/#323). Fable seeds as soon as the audio fits, target ≤15:30 (not 16:00).**
     - Artifact limit: 64 MB per page version, and mp3 is not accepted as an uploaded asset.
     - **fleet: within 20 min**, make `ship/mp4/V3-NN.m4a`-style **AAC-in-MP4 (`.mp4`), mono, 32 kbps** copies of the 12 full audios, byte-verified (duration ±0.1 s vs the mp3). Report each size.
     - Fable uploads those as artifact assets and serves the evidence clips as page files.
     - surg-page confirms the page plays `.mp4` via `<audio>`/`new Audio()` (it should) and that `consult.audio_full.src` takes a same-origin `/_blob/…` URL. Reply yes/no in 10 min.
113. **Speaker-count page (surg-page 389e4d9):** accepted. Fable publishes it right after the v3 link.
     - The same audio rule applies: 30 windows ~1–1.5 MB each as page files is fine.
     - diar-lab copies `~/eta-data/speaker-count-30/public/` to the Mini `~/dev/_private/speaker-count-30/`.
114. **Stray ssh -L tunnels 18082/18083/18086 on the box:** herdr-kit identifies the owners (ps, parent pane). Unowned ones are killed. Report.
115. **Night plan unchanged:**
     - after 20:30: push 73868e4 → gate → deploy → smoke;
     - then the join-shard Worker deploy (9c2cd02 + d5809b1), max_instances 33;
     - then the minibot plist change;
     - then stale-job cancel + RECOVERY-3;
     - 21:00 lx rescore with arm d.
