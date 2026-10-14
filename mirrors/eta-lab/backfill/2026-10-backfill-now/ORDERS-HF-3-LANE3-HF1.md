# ORDERS-HF-3: REB lane 3 on HF-1 (CPU Space) for 29 Sep (backfill-lead, 8 Oct 2026 08:30 IST; herdr-lead APPROVED #9451)

Goal: SraVaani + 5 IndicConformer heads (kn/hi/ta/te/ml) on the 418 eligible 29 Sep windows, run on HF-1 (Space vrbeven/eta-hf-1, cpu-upgrade 8 vCPU, persistent /data), written to REB as new tracks.
Known facts: ~/oc/backfill-now/HF1SPACE-A-REPORT.md (rate estimate 6-11 windows/h UNVERIFIED; SraVaani old config carries device=cuda -> CPU run needs a NEW hash; indic configs have no device). Lane-1 package hf-lane1/ (job 3bec47c9, launcher 12a2ed1e, collector 339f7a83) is the pattern: own identity = existing config + PRODUCER fields, job asserts lane hash != existing hash and that stripping producer fields gives the existing hash; heldout fail-closed in-job; pinned 40-hex revisions; write-once; collector rejects existing-hash tracks; claims keyed (engine, window) with job id (HF-1c). The box has NO ssh path to HF Spaces; backfill-lead runs anything on HF-1 via the Mini key. herdr-lead wakes HF-1 at 08:30 and pauses it 21:30.

Scope (build on the box under ~/oc/backfill-now/hf-lane3/, nothing runs on HF-1 yet):
1. lane3_cpu_job.py: runs on HF-1 over a window list; per window: blind check (same predicate as lane 1), audio from /data/lane3/audio, SraVaani + 5 indic heads on CPU, REB track JSON per engine to /data/lane3/out, skip if the track exists. Pinned model revisions (40-hex), trust_remote_code only with a pinned revision and a recorded snapshot sha.
2. install_hf1.sh: idempotent install into /data/lane3/{venv,hf_home,audio,work,out} (torch CPU wheel, transformers, av, soundfile, sentencepiece, numpy<2.3, hf CLI). No audio. Prints versions and model snapshot shas.
3. audio plan: how 29 Sep audio reaches /data/lane3/audio (bucket sync from inside the Space or push from the box via backfill-lead), with blind windows never copied. If the Space needs a token, it must be a READ-ONLY fine-grained token in a file, never the account token: say so and stop there.
4. collect_lane3.py: pull /data/lane3/out to the box, validate (hash, blind, schema), write via reb writer write-once.
5. bench plan: 5 non-blind 29 Sep windows, timing per engine, exact commands for backfill-lead.
6. Tests like test_lane1 (blind, identity hashes, skip-if-exists, write-once, refused tampered files).
Not allowed: anything run on HF-1 or HF Jobs, any audio upload, any edit to hf-lane1 except reading, runner.py, hard deletes.
Output: ~/oc/backfill-now/HF-3-REPORT.md, first line VERDICT: READY-FOR-REFUTER or BLOCKED, max 40 lines, sha16 of every file, the new config hashes, the exact install + bench commands. Cap: 2 h.
