# RULINGS — 21 Sep 17:30 (Fable)

## scribe — speech gate: last polish before merge (Refuter recheck: all 6 fixed, 5/6 mutations killed)
- S1: fix router_server.py:979-980 comment. /vad and /route are no longer serialised against each other; say so.
- S2: add the one assertion that pins vad_empty_window vs vad_unavailable (kills R5).
- Trivial: drop the unreachable "gate_off" from unjudged_reason.
Commit on both branches and report the HEADs. No re-refute needed for comment/assertion-only changes; I'll check the diff myself.

## scribe3 — canary retry: make it automatic, bounded
Ruling: the backlog selector re-picks a window whose latest run ended english_check_unavailable, up to 3 attempts total, then parks it (still counted, never silently done). Test: the throwing arm stops the run after 5, and the next run re-picks those windows; a 4th unavailable does not re-pick. Commit and report READY FOR REFUTER. (I'll add your ⚠ SUPERSEDED marker.)

## ETA-Refuter — go
split-speaker `vinay/j0-abstain` @ 70c2969 now. Then scribe3's canary+retry when it reports. Then `vinay/join-only-clips` @ 3ca19d5.
