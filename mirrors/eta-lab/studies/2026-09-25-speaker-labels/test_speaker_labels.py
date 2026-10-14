#!/usr/bin/env python3
"""Tests for speaker_labels.py on invented numbers (no data). python test_speaker_labels.py -> PASS n/n"""
import sys
import speaker_labels as S
res = []
def check(name, ok): res.append(bool(ok)); print(("PASS " if ok else "FAIL ") + name)
# chunks: A 0-100, gap 100-130, B 130-200 (wall seconds; window 0-200)
ax = S.chunk_axis([(0, 100), (130, 200)], 0, 200)
check("chunk axis: second chunk starts at closed 100", ax == [(0, 100, 0.0), (130, 200, 100.0)])
w = S.closed_to_wall([(90, 110, "x")], ax, 0)          # closed 90..110 straddles the join (closed 100)
check("turn straddling the join is split, gap excluded", w == [(90.0, 100.0, "x"), (130.0, 140.0, "x")])
check("turn after the gap shifts by the gap length (30 s)", S.closed_to_wall([(150, 160, "y")], ax, 0) == [(180.0, 190.0, "y")])
check("turn before the gap unchanged", S.closed_to_wall([(10, 20, "y")], ax, 0) == [(10.0, 20.0, "y")])
ax2 = S.chunk_axis([(1000, 1100), (1130, 1200)], 1000, 1200)
check("window origin is subtracted (wall relative to window start)", S.closed_to_wall([(150, 160, "y")], ax2, 1000) == [(180.0, 190.0, "y")])
check("chunks outside the window are trimmed away", S.chunk_axis([(-50, 20), (180, 300)], 0, 200) == [(0, 20, 0.0), (180, 200, 20.0)])
# assign
turns = [(0, 10, "p"), (10, 20, "q"), (20, 30, "p")]
r = S.assign([(1, 9), (11, 19), (8, 12), (40, 50), (5, 25)], turns)
check("dominant speaker: p, q; letters by first appearance (p=A, q=B)", r[0]["speaker"] == "A" and r[1]["speaker"] == "B")
check("segment across a speaker change: 2 s each is >= 30% and >= 2 s => mixed, sequence A > B", r[2]["mixed"] and r[2]["sequence"] == ["A", "B"] and abs(r[2]["purity"] - 0.5) < 1e-6)
check("segment outside all turns is unlabeled, empty sequence", r[3]["unlabeled"] and r[3]["speaker"] is None and r[3]["speech_s"] == 0.0 and r[3]["sequence"] == [])
check("long segment 5-25: A 10 s (5-10 and 20-25), B 10 s: tie broken by first-listed; mixed; sequence A > B > A", r[4]["mixed"] and r[4]["sequence"] == ["A", "B", "A"] and r[4]["speech_s"] == 20.0)
r2 = S.assign([(0, 10)], [(0, 0.8, "z")])
check("0.8 s of speech (< 1.0 s) -> unlabeled", r2[0]["unlabeled"])
r2b = S.assign([(0, 30)], [(0, 3, "z")])
check("a 30 s block with 3 s of one speaker IS labelled (fraction-of-duration would have rejected it)", (not r2b[0]["unlabeled"]) and r2b[0]["speaker"] == "A" and r2b[0]["coverage"] == 0.1 and r2b[0]["purity"] == 1.0)
r3 = S.assign([(0, 10)], [(0, 6, "a"), (4, 10, "b")])
check("overlapping turns: speech seconds count the union once (10, not 12)", r3[0]["speech_s"] == 10.0)
r4 = S.assign([(0, 10)], [(0, 9, "a"), (9, 10, "b")])
check("second speaker below 2 s / 30% is not 'mixed'", (not r4[0]["mixed"]) and r4[0]["speaker"] == "A" and r4[0]["sequence"] == ["A", "B"])
# agreement
a = ["A", "A", "B", "B", "C", None]; b = ["X", "X", "Y", "Y", "Y", "X"]
ag, n, m = S.agreement(a, b)
check("agreement after best relabelling: 4/5 (C vs Y is the miss)", abs(ag - 0.8) < 1e-9 and n == 5 and m["X"] == "A" and m["Y"] == "B")
ag2, n2, _ = S.agreement(["A", "B"], ["Q", "Q"])
check("two-cluster vs one-cluster: best mapping gives 1/2", abs(ag2 - 0.5) < 1e-9 and n2 == 2)
check("no jointly labelled segments -> None", S.agreement([None], ["A"])[0] is None)
agw, _, _ = S.agreement(["A", "B"], ["X", "Y"], weights=[1, 3]); check("permutation-invariant: swapped names still 1.0", abs(agw - 1.0) < 1e-9 and abs(S.agreement(["A", "B"], ["Y", "X"])[0] - 1.0) < 1e-9)
print(f"{'PASS' if all(res) else 'FAIL'} {sum(res)}/{len(res)}"); sys.exit(0 if all(res) else 1)
