# W25 calibration sets (rulings 407a, 407b), built by eta-refuter-2, invented or repo data only

Ruling 407a: every role gets the CHEAPEST Zen model that passes its role calibration. Candidates are run cheapest-first. Each run is one fresh OpenCode session with no hints and no retries. Record the model, the Zen cost and the wall time. eta-refuter-2 scores.

| set | folder | pass rule | sealed key pin (sha256 of salt‖key, box ~/.claude/w25-calib/, mode 600) |
|---|---|---|---|
| Builder | `builder/` (SPEC.md, test_parity_metrics.py) | the visible tests AND the hidden acceptance suite (15 cases) pass; stdlib only; prints nothing | `1db2eb57c4845d8ee8acae2bd908162477f9bc96f8ba1a380a277e6997e8ca96` |
| Scout/Researcher | `scout/QUESTIONS.md` | 5 of 5 correct, with the file cited, at commit 18bc3c3 | `82cee3d3374126cf353fe668a963ce23ee5ecf3960d6f8149bc1b2af01c4740b` |
| Refuter (NOT USED) | `refuter-set/` | 8 of 10 seeded bugs | `c70a3301…` (see its README) |

The refuter set was built for 407a. Ruling 407b then kept every checker on Claude Code, so no model is calibrated with it. It is kept, not deleted.
The hidden Builder suite was checked against 5 plausible wrong implementations of the reference (edit rate divided by max length, a p95 rank off by one, ASCII-only normalisation, empty texts kept, >= 5% instead of > 5%). It fails all 5 and passes the reference.
Each salt is revealed with the first published score for its set. Once a set's results are published it is burnt: build v2 for the next round.
