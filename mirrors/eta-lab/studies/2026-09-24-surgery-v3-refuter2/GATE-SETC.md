# Surgery v3 gate, SET C (rebuilt on neighbour-trimmed bounds: Q29 Q24 Q28 R06) — eta-refuter-2, 24 Sep 2026
Judged fresh from judge-C/ only (earlier verdicts NOT reused); locked before gate-report-C.json. **Blindness caveat:** fleet's
hand-offs #265/#268 disclosed Jev calls for R06 and Q28 before I read them. Scope: ruling 84 (CT angiography IN; plain imaging OUT).
## Leakage: PASS
0 token / patient overlap with V's 18; the single time flag is the same token cleared at doctor level in set A (a different doctor).
## Verdicts
| id | code | note |
|---|---|---|
| Q29 | Y-now | the CT-angiography proposal and its prep are INSIDE the trimmed window, so it holds. **Check:** the part trimmed as a "different patient" reads like this patient's own earlier history; fleet should verify the PQM mapping |
| Q24 | Y-patient | patient-raised; doctor describes and discourages ("not absolutely indicated… your desire"). **Grey turns 218–233** (the next patient) |
| Q28 | Y-minor | bedside manoeuvre, minor per ruling 85. **Grey turns 115–233** (clinicians' case talk about an absent patient's operation, plus chat); the patient consult starts at turn 234 |
| R06 | Y-now | an operation proposed and described (mechanism, recovery, written up); one coherent consult; room placement not judgeable from text |
## Set as of 12:40 (A kept 8 + C)
Proposals 8: Q20 Q24 Q27 Q29 Q32 Q36(minor) Q28(minor) R06 · look-alikes 2: Q06 Q34 → 80/20. With ruling 85's +2 look-alikes:
12 items at 67/33. Minor OPD 2/12 = 17% (≤20%). Q07 and R05 dropped (their proposal talk was a neighbour's), Q16 and Q17 dropped.

## Q29 re-cut (judge-D/Q29.json, 24.1 min, turns 322–630), judged fresh, ids/paths-only hand-off: **Y-now, no grey needed**
One coherent consult: history and exam, then "calcium >1000, very high → you require a CT coronary angiogram", then prep.
The earlier trim HAD cut this patient's own talk inside its own PQM interval; fleet's re-cut fixes it.

## Q20 boundary read (judge-D/Q20.json; the same text as the judged version, 0.994 sequence similarity, ids shifted +2): ONE encounter, no grey
Same patient throughout: history, family history, report look-ups with staff while the patient is present, an in-consult echo
screening (why the PQM is ~40 min), treadmill read, CT-angiography proposal and prep, closing. lx's long_encounter flag is explained
by the in-consult echo, not by a neighbour. Q32 and Q34 clamp re-cuts sit inside the judged windows; no re-read needed.
