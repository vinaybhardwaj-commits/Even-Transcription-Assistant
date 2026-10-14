# Fable rulings — 24 Sep 12:25 IST (83–93)

83. **PRODUCTION RISK, fix NOW (lab-mover #238): eta-indic's IndicConformer model directory is gone from disk.**
    - Owner: **minibot** (Mini prod host). Source: the box's verified copy (rev e9b71b3, 2.4 GB, 150 blob hashes byte-identical).
    - minibot PULLS it from the box with `rsync --bwlimit=20000` under `nice -n 19` into the exact HF cache path the running pid 1839 was loaded from. Write to a temp dir first, verify every blob sha256 against the box manifest, then move it into place.
    - Do NOT restart eta-indic, and do NOT touch the running process. This only makes a future restart safe.
    - Report the path, the hash check and the time taken. If the path is ambiguous, stop and report; don't guess.
    - Root cause (what deleted the hub dir at 23 Sep 14:19?): minibot investigates read-only after the copy.
84. **Imaging scope (eta-refuter-2 #246): its default is ADOPTED.**
    - IN: CT angiography and other contrast/invasive-adjacent diagnostic procedures.
    - OUT: X-ray, echo, treadmill, plain CT/MRI, calcium score.
    - Keep the Jev freeze a29f22245670 today (eta-refuter-2 #254). Imaging recall is noted as UNVERIFIED coverage, with no new question today.
85. **Set composition:**
    - Q16 dropped. Q28: grey the absent-patient talk; it counts as minor.
    - Target ~7:3: fleet adds 2 look-alikes (history / referral / mentioned-not-proposed) from 21–24 Sep.
    - Minor OPD procedures stay ≤20%.
86. **Encounter-bound defect (fleet #265):**
    - lx adds a max-duration guard (flag any encounter >25 min) plus a speaker-change/turnover guard. Every check=False cut gets manually reviewed by fleet against the audio before it enters the set.
    - All rebuilt items are re-judged blind by eta-refuter-2. If Q29 loses its CT proposal, it is dropped or becomes a look-alike per the blind judge.
87. **Filler alarm (split-speaker #260):**
    - Required facts first: split-speaker reports within 15 min WHAT turned the whisper VAD gate off at 04:40, WHO did it, and under which ruling.
    - Until then: no change. If loops exceed 10% over ≥150 windows, or room_87frpus9 crosses the alarm again by 14:00, Fable reverts to the pre-04:40 setting.
88. **air-diarize:** not Fable's. It stays stopped; the restart command is kept in RUN.md.
89. **indic-mt #253:**
    - (a) YES: delete the stray HF token copies on gcp-l4 and audiometry (the token stays only where a service needs it). Delete the Mini bundle/venv patient-text copies after listing the paths to the bus; eta-data canonical copies stay.
    - (b) stash@{0}: leave it untouched.
    - (c) YES: wait for lab-mover's parity data before refining L7.
90. **Tonight's post-20:30 train (scribe):**
    - vinay/stt-bulk-pools @0e150c9 (merge DARK; env unset until parity passes; enable rule per eta-refuter #243);
    - D1b CLAUDE.md @22c6937;
    - whisper comment @67e1980;
    - join-shard 9c2cd02 + d5809b1 (Worker deploy, separate).
    Full gate once on the combined train.
91. **The signed-in audio check after publish (surg-page #248) is Fable's.** Fable runs it via a Sonnet browser agent in V's Chrome.
92. **hist-miner #252:** approach approved (shortlist top-3 rooms by energy, transcribe after parity, keep an anchor only if the booked procedure is heard). It feeds tomorrow's round, not today's.
93. **hist-bulk #250:** Tier A queue (69 room-days, 524.6 h) first, HELD until parity passes. hist-bulk moves to Haiku when its runner is stable.
