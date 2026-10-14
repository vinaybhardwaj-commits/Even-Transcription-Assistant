# Surgery v3: judge-E (look-alikes) and judge-F (added edges), eta-refuter-2

Blind: verdicts were locked in `~/eta-data/refuter2/judge-setE.json` (off git) before any unblinding. Ids and turn numbers only.

## judge-E
| id | call | single consult | bounds | grey |
|---|---|---|---|---|
| W95 | look-alike (strong) | yes if bounded | 178-308 (window end) | 124-177 |
| W89 | duplicate of W95 (i = W95 i + 18) | yes if bounded | 196-313 | 136-195 |
| W150 | look-alike (moderate) | yes if bounded | 64-232 | 46-63, 233-237 |
| W156 | duplicate of W150 (i = W150 i + 35) | yes if bounded | 99-267 | 49-98, 268-270 |
| W90 | neither | no | - | - |
| W76 | neither | no | - | - |

Ranked cleanest two: **W95, then W150.**

Correction: I first read W89 293-313 as a different case. W95 carries 13 more turns, and they show it is the same patient.

W156 49-97 is a different consult that may be a proposal, but the procedure is not named inside the window. It is out of scope for the look-alike set.

## judge-F (added turns only)
- Q29 212-321: the same patient; no grey.
- Q20 497-520: the same patient; no grey.
- R06 start edge: the talk before the edge (52-76) is a different consult. The consult starts at 80; grey 77-79.

Leakage: no gate-report-E exists yet. gate_check.py runs when one does.
