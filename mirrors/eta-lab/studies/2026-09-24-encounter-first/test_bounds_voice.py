"""Offline self-test for encounter_bounds' voice logic (synthetic diarizer labels, no data, no network).
Run: ~/.venv-r2/bin/python test_bounds_voice.py   (numpy is needed for the voice_sequence checks; exits non-zero on the first failure)"""
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

# label_coverage: the speaker guard must know when it is blind (V3-01: labels existed for the room-day, not for the span)
check("label_coverage: fully covered span", EB.label_coverage([window(W0, DOC)], W0 + 1 * MIN, W0 + 14 * MIN), 1.0)
check("label_coverage: span outside every labelled window", EB.label_coverage([window(W0, DOC)], W0 + 60 * MIN, W0 + 100 * MIN), 0.0)
check("label_coverage: half covered", round(EB.label_coverage([window(W0, DOC)], W0 + 10 * MIN, W0 + 20 * MIN), 2), 0.5)
print("ALL PASS (incl. coverage)")

# voice_sequence: dominant non-doctor voice per bin on synthetic embeddings (A for 2 bins, then B for 2 bins)
import numpy as np, voice_sequence as VS
rng = np.random.default_rng(1)
va, vb, vd = (rng.normal(size=192) for _ in range(3))
def emb(v, n): return v + 0.05 * rng.normal(size=(n, 192))
t = np.arange(0, 20 * 60000, 1500, dtype=np.int64)               # 20 min of 1.5-s windows
E = np.zeros((len(t), 192), np.float32)
for i, tt in enumerate(t):
    v = vd if i % 2 == 0 else (va if tt < 10 * 60000 else vb)      # half of the windows are the doctor: clearly the largest cluster
    E[i] = emb(v, 1)[0]
rows, changes = VS.sequence(t, E, 0, 20 * 60000, 0.55)
check("voice_sequence: two consecutive patients -> exactly 1 dominant-voice change", changes, 1)
E1 = np.array([emb(vd if i % 2 == 0 else va, 1)[0] for i in range(len(t))], dtype=np.float32)   # patient A all 20 min
rows1, ch1 = VS.sequence(t, E1, 0, 20 * 60000, 0.55)
check("voice_sequence: one patient throughout -> 0 changes", ch1, 0)
print("ALL PASS (incl. voice_sequence)")


# bounds() wiring offline (no database, no Metabase): the speaker guard must say when the labels do not cover the encounter
from datetime import datetime, timezone, timedelta
IST = timezone(timedelta(hours=5, minutes=30))
T10 = int(datetime(2026, 9, 23, 10, 0, tzinfo=IST).timestamp() * 1000)

def run_bounds(label_windows):
    levels = [{"t": T10 - 600000 + i * 2000, "peak": 0.1 if 0 <= i * 2000 - 600000 < 40 * 60000 else 0.01} for i in range(0, 3300)]
    def fake_neon(q):
        if "FROM room_day" in q: return [{"room_id": "room_x"}]
        if "bench_level_sample" in q: return levels
        if "diarize_window_label" in q:
            return [{"window_id": f"w{i}", "engine": "pyannoteai", "start_ms": w0, "end_ms": w0 + 15 * MIN, "segments_json": json.dumps([{"speaker_idx": 0, "start_ms": 0, "end_ms": 15 * MIN}])} for i, w0 in enumerate(label_windows)]
        return []
    EB.neon = fake_neon
    item = {"item_id": "T", "room_day_id": "rd_test", "ist_date": "2026-09-23",
            "called_at": "2026-09-23T10:00:00+05:30", "completed_at": "2026-09-23T10:40:00+05:30"}
    return EB.bounds([item])[0]

quiet = lambda f: (sys.stdout.write, None)
r_blind = run_bounds([T10])                                    # labels cover 15 of the 40 min (0.375)
check("bounds(): labels cover < 50% of a 40-min encounter -> no_speaker_data", "no_speaker_data" in r_blind["check_reasons"], True)
r_ok = run_bounds([T10, T10 + 15 * MIN, T10 + 30 * MIN])       # labels cover all of it
check("bounds(): labels cover the encounter -> no no_speaker_data", "no_speaker_data" in r_ok["check_reasons"], False)
print("ALL PASS (incl. bounds wiring)")
