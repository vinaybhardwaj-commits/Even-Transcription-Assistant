# Fable rulings 24 Sep 07:15 IST (hourly review)
Conductor: deliver each ruling to its owner(s), update the board, and relay pushback. RULINGS-FABLE-0650.md is restored in this commit (its first commit was orphaned by an aborted rebase on the Mini).

12. **SHIP service-pools now** (scribe). Branch e42b7e6 has an ETA-Refuter PASS, eta-refuter-2 concurs, and GitHub gate 35942437126 passed.
    - Ship it through your train now, before clinic peak: fast-forward vinay/s1-auto-drain, verify the served dpl sha and /api/health.
    - No new env. Pools stay inert until Fable sets *_BULK_URLS.
    - R3 default accepted: bulk never falls back to live unless POOL_BULK_FALLBACK_LIVE=1, so the clinic stays protected.
    - Hung-endpoint behaviour (it fails over only after the breaker opens): accepted for now.
    - Report the dpl id.
13. **Twin exposure** (lab-mover): yes. Twin hostnames may be public and unauthenticated, exactly like prod's shim, diarize and emotion (V's standing rule for internal systems).
    - Write or stored-data routes (/enroll and anything that lists or stores data) stay CLOSED on every twin.
14. **Audio join is a Cloudflare Worker + Durable Object on R2, not the Mini.** It is not a Mini single point of failure, so there is no box or c3 join twin. c3 keeps embed, emotion and CPU whisper only.
    - Scout task for lab-mover: find the Worker source (repo/path) and report, locations only:
      - where the single-flight lock lives (one global DO, or one per room?)
      - what per-room sharding would change
    - Fable decides the design after that. T2 (busy does not burn attempts) stays the immediate fix.
15. **No lab load on Mini production services during clinic.** The 06:37–06:38 prod whisper-probe timeouts and the probe slowing from 1.6 s to 6 s coincide with lab and parity traffic.
    - From 08:00 to 20:30 IST: no lab or parity request to the Mini's whisper, diarize or emotion.
    - For the Mini side of any comparison, use the Mini outputs already stored in production (stt runs / scribe_job results).
    - Before 08:00: serial only, one request in flight.
16. **Whisper temperature fallback** (split-speaker; this is the biggest finding today). The Mini differs from itself by 33% WER on the same window, and the fallback is the cause. Build the decision on the 58-window labelled VAD-v3 set, on a box twin ONLY (no Mini, per 15), with two arms:
    - arm A: current config
    - arm B: temperature_inc=0

    Metrics: coverage of labelled speech, WER where transcripts exist, loop/repeat rate (canonical repeat-ratio definition), filler/hallucination count, and run-to-run stability (2 runs each).

    Report the table. Fable rules on changing prod after it. Priority: after the twin coverage table.
17. **Night-feeder token** (yoga-drain): no branch. Generate the token into the box's ~/.claude/secrets/night_feeder_token (0600) and write the SCRIBE_MCP_TOKENS entry FORMAT (no value) to studies/2026-09-24-tonight-backlog/TOKEN.md. Fable adds it to Vercel env and redeploys the same sha before 18:00. Fallback: operator-v1.
18. **D1: CI dockerAvailable 15 s timeout fix** (eta-refuter-2's ask): approved.
    - herdr-kit builds ONE branch, vinay/ci-docker-timeout, off vinay/s1-auto-drain. It carries the fix plus the missing tests/support/pg-harness.ts:22.
    - ETA-Refuter (Mini) refutes it. It ships in the next train.
19. **lab-run.sh** (eta-refuter-2): re-check herdr-kit's 52453f7 now. PASS or FAIL, with evidence.
20. **/speech_regions exists nowhere.** VAD-trim code is in prod with the flag off (it fails open). Low priority.
    - lab-mover adds /speech_regions to the box eta-diarize twin after R1 and tests it there.
    - The Mini gets it only after clinic, after a Refuter pass.
    - The backchannel bench (ruling 11) follows. Due 25 Sep.
21. **Bus routing** (herdr-kit): broadcast once to all panes that anything for Fable goes to the bus agent 'conductor' (it relays to Fable). 'fable' is not a bus agent.
22. **Tunnels made at 06:37** (conductor): ask herdr-kit, minibot and lab-mover in one line each who created them. Record it on the board. No other action; the tunnels are correct now.
23. **diar-lab go/no-go:** the fine-tune is a real gain but not a production candidate.
    - On V's 5, DER went from 0.53 to 0.36 and the tail blow-ups are gone. It is still far from the teacher.
    - Keep collecting teacher labels (cheap). HOLD the next fine-tune run until the Nemotron-3 bake-off result (14:00) sets the direction.
    - Clustering stays at default.
