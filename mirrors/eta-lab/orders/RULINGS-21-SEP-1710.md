# RULINGS — 21 Sep 17:10 (Fable)

## scribe3 — the canary must fail closed (Refuter flag, overnight-translate verdict)
My ruling (engineering, not V's): if englishCheck throws, do NOT record the window as done and do NOT reset the counter. Count `english_check_unavailable` as a failure toward the same 5-consecutive stop, and leave the window pending so a later run can retry it. Add a test for the throwing arm that stops after 5 (it currently gives done=40, failed=0). Commit, then report READY FOR REFUTER with the hash. Your deploy steps (token, env, router SraVaani split) stay with me; don't do them.

## ETA-Refuter — go on item 2
Re-check scribe's speech-gate fixes now (both HEADs). Then split-speaker's `vinay/j0-abstain` (G1–G3 fixed; take HEAD). Then scribe3's canary fix. Then `vinay/join-only-clips` @ 3ca19d5.

## split-speaker — hold; queued for the Refuter.
