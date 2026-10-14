# BF-CHECK-2 report (eta-refuter-2, 7 Oct 2026 ~17:45 IST; backfill-lead #9275). Read-only: no HF call, no bucket, no state/claims, no runner/lane edits.

## VERDICTS
(A) HF-1 lane-1 launcher: PASS-WITH-LIMITS. The blind, pin, claim, budget and collector guards hold; the 28 Sep pilot may go on a later order with V's balance figure, BUT only after F1 (track identity) is decided. F2-F4 should be fixed before going past the pilot.
(B) Six 0-segment windows since 15:47: NOT an engine fault. All six are router_status silent_skipped (the silence gate ran; no engine was called), unlike BF-CHECK-1, where s1 returned ok with 0 segments because of an engine FileNotFoundError. Four of them come from a DEAD recorder input at OPD 3 today (see B).

## (A) HF-1 lane-1 (files at sha16: job d0baa013, launch 9bfe8564, collect 301a33b2, budget e1264a7a, tests c3d3c405; order 2ceb6710, report 3a3c9458)
Verified:
- Blind, launcher: heldout.py sha16 f672c1ef asserted, union id f07171dc asserted, the job's embedded 14-entry list proven equal to the union. The per-window predicate covers start / end-1s IST days, ist_date and the day in the id; unparseable = blind. It runs before any claim, audio listing or job.
- Blind, job: refused per window BEFORE the audio is opened.
- Blind, collector: re-checks blind, the 3 lane hashes and status, then validate_track and write-once write_track.
- Pins: the job exits before reading audio or loading the model on a mismatch of own sha16, heldout constant, blind-list sha16, allow-listed model, 40-hex revision, or snapshot dir == revision.
- Config hashes a2131b2d / c7bd317b / 4b67551a: recomputed by me from the job's dicts AND from existing box REB tracks (machine=box); all equal, cap2 prompt included.
- Claims: O_EXCL, all-or-nothing per window; release = move to _released/.
- Budget: usage-v2 / job list / rates unreadable => BudgetUnavailable => refuse; --balance-usd required for --launch. Caps: lane $60, day $80, floor $15.
- Lane jobs are recognised by the name label. hf CLI 2.0.0 (installed) defaults it to "whisper3_hf_job-<hash>", so the prefix match works today.
- Tests: test_lane1.py rerun on my scratch copy: 31/31 OK.
- Mutants (one change each, in scratch): blind fail-open launcher KILLED; job blind off KILLED; no O_EXCL KILLED; collector overwrite KILLED; job ignores own sha KILLED; balance floor off KILLED. Launcher treating BudgetUnavailable as a pass SURVIVED (F6).
Fix list:
- F1 (DECIDE before the pilot; my ruling: NO): HF output must not carry the box hashes. Same config_hash would hide a different producer: transformers generate on fixed 30 s chunks, condition_on_prev off, no --suppress-nst, fp16 HF weights, LID on first-30 s logits, vs whisper.cpp ggml with its own seek. REB track files are write-once per (window, engine, v1, hash), so an HF track written first would also BLOCK the box track for that window and hash (TrackExistsError) and vice versa. Fix: add the runtime to the config, giving new hashes (or a distinct engine/version name); provenance.runtime alone is not enough.
- F2 (should): claims of windows that a COMPLETED job skipped (audio absent) or did not write (failed track) are never released, because --reconcile releases only ERROR/CANCELED/FAILED jobs. Those windows stay blocked for good. Fix: on a COMPLETED job, release (move) the claims whose <win>.json is absent from the out bucket.
- F3 (should): the balance floor uses V's point-in-time figure without subtracting spend billed since it was read. Fix: add --balance-asof and subtract usage-v2 billed since then.
- F4 (should): set the job label explicitly (--label name=whisper3_hf_job-...) and test it, so the lane cap does not depend on the CLI's default naming.
- F5 (limit): usage-v2 may lag. A job that has finished but is not yet billed is neither billed nor committed, so the day cap can under-count by the last jobs. The $15 floor and the 45 min commit absorb a pilot.
- F6 (test gap): add a test that main() refuses when snapshot() raises (the code itself is correct: ok=False).
- F7 (minor): on --launch, a failed bucket listing (None) silently drops the audio-gap check and the out-bucket skip. Refuse --launch when audio_ls is None. The in-job exists check limits damage.
- F8 (minor): the job receives the account HF_TOKEN as a secret but needs none (public model, mounted buckets). Least privilege: drop it, or use a read-only fine-grained token.
- F9 (note): the in-job "heldout assert" is a constant compare plus the embedded-list sha (heldout.py is not shipped). It is acceptable because the launcher proves list == union on every launch.

## (B) 0-segment done windows since 15:47 (state.jsonl, result files in runs/<run>/; audio = cached chunks ~/eta-data/hist-mining/audio, decoded with /usr/bin/ffmpeg in memory; levels only)
- All 6: router_status silent_skipped, error none, 900 s cut, cover 1.0, 4/4 chunks, no dropped chunks. Router rule (a876b3bd l.1616): silent_skipped iff no span passed the gate (rms >= 0.008 or peak >= 0.02).
- OPD 3 (room_87frpus9), 12:00 / 12:15 / 12:30 / 12:45, 4 windows: peak 0.00003, rms 0.0000, not zero-filled. ALL 16 cached OPD-3 chunks today (session bs_kv92xfe2, chunks 29-44, ~12:00-13:20 IST) have the same flat peak 0.00003. That is a dead or muted input, not a quiet room. [KIOSK/PROD, fable: check the OPD-3 recorder mic since ~12:00 today; nothing downstream can recover it.]
- OPD 5 (room_4ggnkg5x) 12:45 (:c3s0): peak 0.0189 < 0.02, rms 0.0002: genuinely below the gate. OPD 5 12:00 (:c3s1): one second has peak 0.024 within the 4 chunks (1200 s, a superset of the 900 s cut), so it is probably outside the cut or outside the VAD spans. Borderline-quiet, not a fault.
- Controls (same room, done since 15:47 with segments): OPD 5 12:15 (5 segs) and 12:30 (7 segs) peak 0.157, 14-20 of 80 15-s blocks pass the gate. The gate behaves as designed.
- Not a c3 fault: the four OPD-3 windows are silent at the source, whichever router ran them. No re-queue would help them.
