# Fable rulings 24 Sep 08:15 IST (hourly review)
Conductor: deliver each ruling to its owner(s), update the board, and relay pushback.

24. **Nemotron-3 direction** (diar-lab). Results on V's 5:
   - DER vs the pyannote.ai teacher: Nemotron 0.414, stock 3.1 0.530, our fine-tune 0.357.
   - Speaker-count error vs V's human counts: Nemotron **0.4**, the others 1.2.
   - Nemotron is 15–25x faster.

   Ruling:
   - (a) pyannote.ai stays primary for now.
   - (b) Nemotron replaces stock 3.1 as the LOCAL FALLBACK engine (pyannoteai_no_segments hit 3 windows this morning), and runs in SHADOW on every live window for 7 days, stored, never shown.
   - (c) diar-lab: stop fine-tuning pyannote 3.1. Retarget the training programme to fine-tuning Nemotron on the teacher labels, same durable/repeatable rules.
   - (d) Add pyannote.ai's own speaker-count error vs V's 5 to the table. Without it, "0.4 vs 1.2" can't be compared to the teacher.
   - (e) Build: a Nemotron diarize endpoint on the box twin (T4, if it ran) or gcp-l4, same /diarize contract. A cloud-built or split-speaker code change adds `nemotron` as a DIARIZE_ENGINE fallback + shadow, flag off. Refuter, then train.
   - Report the 3 biggest Nemotron vs pyannote.ai disagreements for V's ears, as file paths.
25. **Health flaps** (06:37, 07:50, 08:05; self-healing; whisper probe only). **eta-refuter (Mini, Opus) acts as Debugger, root cause only, no changes.**
   - Read the /api/health whisper probe code (timeout, and whether it caches a negative result: conductor saw failures in 1–2 ms).
   - Read Vercel runtime logs for those minutes and the Mini cloudflared logs for the same minutes.
   - Find what drives Mini load avg ~5 while whisper sits idle.
   - Check whether any REAL room_window/STT call failed in those minutes (prod impact yes/no).
   - Report ≤12 lines: cause, evidence, fix proposal.
26. **Twin env and backlog timing.** Bulk env (*_BULK_URLS, BULK_AGE_MINUTES) and the night-feeder token go in ONE redeploy at ~12:30, AFTER the whisper temperature decision (~12:00). The twins then run the fixed decode config, so the 20–22 Sep backlog is transcribed once, the right way, this afternoon.
   - Bulk lists:
     - whisper: box, gcp-l4 (NOT c3: CPU whisper at 4.8x real time times out on 900 s windows)
     - diarize/embed: box, c3
     - emotion: box, c3
   - lab-mover: post the exact twin URLs per service to studies/2026-09-24-redundancy/BULK-ENV.md, names only, no secrets.
27. **Shared breaker / migration 0119: NO for today.** The per-instance breaker is acceptable for bulk traffic. Revisit only if the bulk run shows breaker thrash.
28. **Diarize hostnames.** Prod stays as is (V's rule: internal, unauthenticated). Twins keep /enroll CLOSED (it shares the single Semaphore(1) with /diarize, so a stray /enroll call would stall diarization). No reopen.
29. **/speech_regions via the diarize-box hostname: yes** (twin only, same public rule), for the bench. Bench owner is **lab-mover**; split-speaker is on whisper determinism. The 48.7% cut on the sparse window confirms that DIARIZE_VAD_TRIM stays OFF. The bench measures what a safe setting would be.
30. **GH_TOKEN for the box** (herdr-kit): copy the Mini's `gh auth token` into the box's ~/.claude/secrets/gh_token (0600). The gate scripts read it for Actions-status calls only. Never print it.
31. **Join contention** (split-speaker #4): AUTO_DRAIN_BATCH_LIMIT stays 5. T2 (busy no longer burns an attempt) shipped in a30186c. Revisit only if the "exhausted" count keeps rising after 12:00.
32. **E-3 audio route and L5 go/no-go** (split-speaker): send conductor ONE line each: the question, the options, and your recommendation. Fable rules at 09:15.
33. **CLAUDE.md fix** (scribe): correct the repo CLAUDE.md line that says a push is only a PREVIEW. A push to vinay/s1-auto-drain deploys to PRODUCTION. Doc-only commit in the next train.
