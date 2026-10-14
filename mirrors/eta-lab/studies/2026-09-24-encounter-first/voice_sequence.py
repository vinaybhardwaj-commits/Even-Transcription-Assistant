"""voice_sequence.py — is a long encounter really ONE encounter? Dominant non-doctor voice per 5 min (lx, 24 Sep).

Speaker embeddings (the box diarize twin's ECAPA, 1.5-s windows) clustered WITHIN the span, so it works on days with
no diarizer labels and across diarizer-window boundaries (where speaker ids restart). The doctor is the largest
cluster and is left out. Two thresholds are printed (cosine 0.55 and 0.45).

VALIDATION (lx, 24 Sep): DO NOT READ A "CHANGE" AS EVIDENCE OF A SECOND PATIENT. On V3-01 (ONE patient across 43.8 min,
established by eta-refuter-2 from the text) this tool reported two dominant-voice changes at both thresholds.
A recurrence control (best-cosine match of one bin's 1.5-s windows in another bin, doctor-like cluster excluded, bins
placed on the encounter's true clock 10:23:05-11:06:55) gives: same patient start->proposal 0.422, proposal->end 0.445,
start->end 0.438; DIFFERENT patient (the next one) 0.397 / 0.384 / 0.402. The margin is real but small (0.02-0.06) next to
the ~0.45 split-half ceiling, so the method LEANS toward the same voices across a consult and cannot segment it. An
earlier version of this note used bins 3 min early (eta-refuter-2's clock) and read the method as useless; the
corrected bins show a weak positive signal. Use it, at most, to choose WHERE to listen, never to cut or drop.

Steps (each in its own venv; nothing is written to git):
  1. ~/.venv-r2/bin/python r2audio.py fetch <room_day_id> <start_ms> <end_ms>
  2. cd ~/services/eta-diarize && HF_HUB_OFFLINE=1 nice -n 10 venv/bin/python <here>/embed_span.py <room_day_id> <start_ms> <end_ms> <out.npz>
  3. ~/.venv-r2/bin/python voice_sequence.py <out.npz> <start_ms> <end_ms>
Prints times, counts and cluster ids only.
"""
import collections, sys
from datetime import datetime, timezone, timedelta
import numpy as np

IST = timezone(timedelta(hours=5, minutes=30)); hm = lambda t: datetime.fromtimestamp(t / 1000, IST).strftime("%H:%M")
MIN_CLUSTER = 12


def cluster(E, cos):
    X = E / np.maximum(np.linalg.norm(E, axis=1, keepdims=True), 1e-9)
    cents, counts, lab = [], [], np.empty(len(X), dtype=np.int64)
    for i, x in enumerate(X):
        if cents:
            s = np.array(cents) @ x; j = int(np.argmax(s))
            if s[j] >= cos:
                counts[j] += 1; c = cents[j] + (x - cents[j]) / counts[j]; cents[j] = c / np.linalg.norm(c); lab[i] = j; continue
        cents.append(x.copy()); counts.append(1); lab[i] = len(cents) - 1
    big = [j for j, n in enumerate(counts) if n >= MIN_CLUSTER]
    return lab, big, (max(big, key=lambda j: counts[j]) if big else None)


def sequence(t, E, a, b, cos, bin_ms=300000):
    """[(bin_start_ms, active_windows, dominant_non_doctor_cluster_or_None)] and the number of dominant-voice changes."""
    lab, big, doc = cluster(E, cos); out = []; cur = a
    while cur < b:
        e = min(cur + bin_ms, b); w = [l for tt, l in zip(t, lab) if cur <= tt < e]
        c = collections.Counter(l for l in w if l in big and l != doc)
        out.append((cur, len(w), c.most_common(1)[0][0] if c else None)); cur = e
    seen = [d for _, _, d in out if d is not None]
    return out, sum(1 for x, y in zip(seen, seen[1:]) if x != y)


if __name__ == "__main__":
    print("NOTE: exploratory. A 'change' below is NOT evidence of another patient (see VALIDATION in the header).")
    z = np.load(sys.argv[1]); a, b = int(sys.argv[2]), int(sys.argv[3])
    for cos in (0.55, 0.45):
        rows, changes = sequence(z["t_ms"], z["emb"], a, b, cos)
        print(f"cosine {cos}: dominant non-doctor voice per 5 min, {changes} change(s):",
              " | ".join(f"{hm(s)}:{d if d is not None else '-'}" for s, _, d in rows))
