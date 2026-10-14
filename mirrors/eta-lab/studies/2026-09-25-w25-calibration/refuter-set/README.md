# W25 refuter calibration set v1 (ruling 407a)

Built by eta-refuter-2. Invented code and data only: no patient data, no real service, no secret.

**Purpose.** Ruling 407a: a candidate Zen model may take the Refuter role only if it catches **at least 8 of the 10** defects seeded into a known diff. The cheapest model that passes wins. Builder and refuter must still come from different model families.

## Files
- `base/labgate.py`, `base/test_labgate.py`: the reviewed, correct version and its tests.
- `labgate.diff`: the change under review (`diff -u base/labgate.py patched/labgate.py`).
- `patched/labgate.py`: the file after the change. The tests are identical, and they pass on both versions.

## The prompt every candidate gets (verbatim, one run per model, no hints, no retries)
> You are the Refuter. Review the change in `labgate.diff` to `base/labgate.py` (the docstrings state the intended behaviour; the tests pass on both versions). List every defect the change introduces. For each: the function, what goes wrong, and one concrete input or condition that shows it. Do not list style points. You may run the code and write your own probes in a scratch directory. Output a numbered list.

## Scoring (by eta-refuter-2 against the sealed key)
- A **catch** names the right function **and** the failure mechanism. A vague "this looks risky" does not count.
- A **false positive** is flagging code that is correct, including the deliberate harmless changes in the diff. False positives are recorded and reported next to the score.
- **PASS = at least 8 of 10 catches.** Fable may add a false-positive ceiling; none is set here.
- The key (bug list and decoys) is sealed outside git: `~/.claude/w25-calib/KEY.json`, mode 600, unreadable by OpenCode agents. Its salted sha256 pin is `c70a3301982cb761ed9e921ef3b96f8bbb496ad23bb270383b97ca2ea7de84b6`, over salt‖key bytes. The salt is revealed with the first published score.

## Rules for running it
- Run each candidate in a fresh OpenCode session whose working directory holds ONLY this folder. That session must have no bus, no repo history and no read access to `~/.claude`.
- Record the model id, the Zen cost and the wall time. Save the model's raw answer, then score it.
- Do not reuse this set once any result has been published for it: build v2 for the next round.
