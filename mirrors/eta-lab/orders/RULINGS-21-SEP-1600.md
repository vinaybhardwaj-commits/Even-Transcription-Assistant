# RULINGS — 21 Sep 16:00 (Fable)

## scribe — speech gate: fix the Refuter's findings (verdict: PASS-WITH-FIXES, docs/handoff/ETA-SPEECH-GATE-REFUTER-VERDICT-21-SEP-2026.md)
On `vinay/speech-gate` (app) and `~/eta-router vinay/vad-endpoint` (router). Fix all of these:
- F1 (blocker): wire it. `fetchWindowSpeech` must feed `diarizeWindow`'s `speech` argument on the real drain path. Today DIARIZE_SPEECH_GATE=1 stamps every segment `unjudged`. Add a test proving that flag ON with a working /vad gives judged segments.
- F2: kill surviving mutations M5/M6. Assert the wiring's OUTPUT, not just that it runs.
- F3: fix the stale comment at lib/stt/speech-gate.ts:178-182.
- Flag OFF must be byte-identical to production: no extra per-segment fields when the flag is off (today it's 44 → 174 bytes/segment).
- Router: add a request size/duration cap to /vad (reject before reading the whole body into memory where possible), and stop /vad calls queuing behind /route on `_ROUTE_SEM` past the client's 120 s abort: give it its own limit, or drop queued work whose client is gone.
Keep the flag default OFF. Test only on a spare port, never :8083. Then commit and report READY FOR REFUTER with both hashes. The Refuter re-checks only these findings.

## ETA-Refuter — next in queue, in this order
1. `vinay/j0-abstain` (worktree /Users/vinaybhardwaj/dev/ETA-j0-abstain, take its HEAD; builder split-speaker). Claims: an absent language signal abstains; ≥2 present signals, all English; empty `{}` mix = absent; a present non-English signal vetoes; vote tally in the job result, not persisted. Dry run: native_en 13/39, noise 10/10, speech 3/29.
2. `vinay/overnight-translate` (builder scribe3; find its HEAD with `git branch`). Closest look at the `switch_override`: my ruling is that it must require WRITE scope, not invoke. If it currently accepts an invoke token, that's a FAIL finding. Also check: the 07:10 IST stop and the clock gate; the canary (stops after 5 windows with no English); the deploy-order guard; and transcript-off rooms passed per job without the room setting ever being written.
3. `vinay/join-only-clips` @ 3ca19d5.
4. Re-check scribe's speech-gate fixes when scribe reports ready.
Your production-read refusal (room_turn_speaker): leave it NOT RUN in the verdict. V is handling production-read permissions.

## scribe3 — overnight translate
Ruling on flag 1: `switch_override` requires WRITE scope. Make that change now, before the Refuter reaches you (the Refuter is on j0-abstain first). The driver will get its own write-scoped token at deploy. Everything else stands. Keep holding.

## yoga-drain — Yoga Indic engines: reachability from the Mini (unblocks option B)
The overnight plan needs the router's Indic engines (IndicConformer :8082, SraVaani :8085) served from the Yoga. Before anyone repoints the router, measure from the MINI (a shell on the Mini, not the Yoga):
- /healthz on the Yoga's two engines over Tailscale (use the addresses and ports from ETA-YOGA-SPLIT-20-SEP-2026.md / the yoga pane's report);
- 5 multipart POSTs to each /inference with known clips (the same 30 s clips the yoga pane used), reporting HTTP status, wall time and real-time factor;
- character edit distance of the Yoga's output vs the Mini's own :8082/:8085 on the same clips: NUMBERS ONLY, no text.
Don't change router env, restart the router, or touch the recorder session on the Yoga. Output ≤15 lines plus one [infra] ledger line. If the engines aren't up on the Yoga, stop and say which one.
