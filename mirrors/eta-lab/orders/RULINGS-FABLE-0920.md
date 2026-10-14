# Fable rulings 24 Sep 09:20 IST (hourly review)
Conductor: deliver each ruling to its owner(s) and update the board.

34. **Stray branch + D1 push** (herdr-kit): YES to both.
    - (a) Push ONLY vinay/ci-docker-timeout (head 74f4b81, Refuter-confirmed, box gate green) to origin as a preview. Never push vinay/s1-auto-drain from the Mini.
    - (b) Delete the Mini's stray local vinay/s1-auto-drain: `git branch -D`, local only; the fix is kept as 15f6983.
    - After (b), `git fetch` and check out the origin-tracking branch fresh if one is needed.
    - scribe merges 74f4b81 into train-24sep-eve.
    - N2 (sh() timeout): deferred, not needed now.
35. **D1b: Jev reading real consult text for the surgery review is CLEARED by V in writing.** V, 24 Sep ~09:00, on the surgery page: "Use jevt to find out of conversations include discussion about surgery and which surgery is discussed, or at least is it named."
    - Scope: Workstream H only (U9/H-2 on the 18 v1 consults and the v2 pilot and set).
    - Record this quote next to D1b in CLAUDE.md or the ledger. fleet proceeds.
36. **Surgery scoring now** (fleet): V's 18 labels (~/eta-data/surgery-30/v-labels-2026-09-24.json) are the human truth for L8. Score U9 against them now.
    - Consensus rule for later multi-rater rounds: majority. A tie goes to V's label. R1/R2 are V's and final (both default).
    - The v1 multi-rater page is PAUSED; there are no RATINGS files until v2. v2 ratings arrive as studies/…/RATINGS-<hhmm>.json from Fable, schema {rater, rulings, c:{Sxx:{field:value}}}, raters by opaque id.
37. **Surgery v2 selection + audio** (fleet):
    - Pilot at 16:00 WITHOUT audio: 5 consults from 23 Sep (3 surgery-lead, 2 neither).
    - The full 20 waits for the 20–22 Sep backlog (transcribed on the twins this afternoon) to widen the pool.
    - Audio: extract clips after 20:30 through the normal path (audio v2.1). Don't route around the recording-time refusal or the classifier.
38. **Nemotron** (diar-lab, eta-refuter-2):
    - pyannote.ai's own count error on V's 5 is 0.0, vs Nemotron 0.4. pyannote.ai stays primary, clearly.
    - **eta-refuter-2 now reviews the Nemotron /diarize endpoint (box T4 :8002) and the trainer.** On PASS: Nemotron becomes the local fallback + shadow (ruling 24b), and the Nemotron fine-tune on teacher labels starts on gcp-l4.
    - V's 3 listen excerpts stay in ~/eta-data/nemotron/listen/. Fable offers them to V after the shadow week, not now.
39. **Shim loop-only re-decode** (minibot): push the design doc now. Build it on a branch ONLY if the 12:00 temperature decision turns the fallback off. It goes onto the Mini after 20:30 with a Refuter pass.
40. **Gate completeness** (#120): herdr-kit makes the box runners run the gate.yml baseline-diff for check:silent and print which gate lines ran. eta-refuter-2 refutes it.
    - Past verdicts need no re-check: every production release also passed the GitHub gate, which does run it.
41. **Still due from 08:15:** ruling 25 (health-flap root cause, eta-refuter) and ruling 32 (split-speaker's E-3/L5 one-liners). Conductor: chase both, due 10:15.
