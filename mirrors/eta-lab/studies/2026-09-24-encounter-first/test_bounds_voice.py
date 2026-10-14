"""Offline self-test for encounter_bounds' voice logic (synthetic diarizer labels, no data, no network).
Run: python3 test_bounds_voice.py   (exits non-zero on the first failure)"""
import json, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import encounter_bounds as EB

W0 = 1_000_000_000_000; MIN = 60_000
def window(w0, segs, wid="w1", engine="pyannoteai"):
    """segs: [(speaker_idx, start_min, end_min)] relative to the window start; a 15-min window."""
    return {"window_id": wid, "engine": engine, "start_ms": w0, "end_ms": w0 + 15 * MIN,
            "segments_json": json.dumps([{"speaker_idx": i, "start_ms": int(a * MIN), "end_ms": int(b * MIN)} for i, a, b in segs])}
DOC = [(0, 0, 15)]          # speaker 0 (the doctor) talks all window: the dominant voice

def check(name, got, want):
    ok = got == want; print(("PASS " if ok else "FAIL ") + name + ("" if ok else f" (got {got!r}, want {want!r})"))
    if not ok: sys.exit(1)

edge = W0 + 7 * MIN
# back-to-back: patient 2 before the edge, patient 4 after; the doctor throughout
b2b = [window(W0, DOC + [(2, 0, 7), (4, 7, 14)])]
check("different patient across the edge, doctor constant -> voice_change True", EB.voice_change(b2b, edge), True)
# one patient throughout: the same non-doctor voice on both sides
one = [window(W0, DOC + [(2, 0, 14)])]
check("same patient throughout -> voice_change False", EB.voice_change(one, edge), False)
# doctor confound: only the doctor speaks either side -> no non-doctor voice to compare -> unknown, never "same"
check("doctor only -> voice_change None (unknown)", EB.voice_change([window(W0, DOC)], edge), None)
# window boundary between the two sides: ids restart per window, so abstain
edge2 = W0 + 15 * MIN
two = [window(W0, DOC + [(2, 0, 15)], "w1"), window(W0 + 15 * MIN, DOC + [(2, 0, 15)], "w2")]
check("edge on a window boundary -> None (abstain)", EB.voice_change(two, edge2), None)
# the doctor is left out of the sets
others, _ = EB._others(b2b, W0, W0 + 7 * MIN)
check("_others excludes the doctor (speaker 0)", others, {2})
# doctor-alone tail: patient 2 speaks until minute 8, then only the doctor for 5 min
tail_lab = [window(W0, DOC + [(2, 0, 8)])]
t = EB.doctor_alone_tail(tail_lab, W0 + 1 * MIN, W0 + 14 * MIN)
check("doctor-alone tail found (>= 2 min)", (t[0], t[1]) if t else None, (W0 + 8 * MIN, 6))
check("no tail while the patient still speaks", EB.doctor_alone_tail([window(W0, DOC + [(2, 0, 14)])], W0 + 1 * MIN, W0 + 14 * MIN), None)
check("no labels -> no tail (never assume silence)", EB.doctor_alone_tail([], W0 + 1 * MIN, W0 + 14 * MIN), None)
print("ALL PASS")
