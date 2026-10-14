#!/usr/bin/env python3
"""Report rebuilt on the RECOVERED clip_id->turn mapping (out/recovered_mapping.json), not the
stale clips_manifest.json. Reads answers.json and answers_log.json READ-ONLY (never written here).
"""
import base64
import json
import math
import os
import struct
from collections import Counter

import build_and_sample as B

OUT = os.path.expanduser("~/dev/_fable/e3kit/out")


def to_vec(b64):
    raw = base64.b64decode(b64)
    return struct.unpack("<%df" % (len(raw) // 4), raw)


def cos(a, b):
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a)); nb = math.sqrt(sum(x * x for x in b))
    return dot / (na * nb) if na and nb else None


def mean_vec(vs):
    n = len(vs); d = len(vs[0])
    return [sum(v[i] for v in vs) / n for i in range(d)]


def dist(vals):
    if not vals:
        return None
    v = sorted(vals); n = len(v)
    q = lambda p: v[min(n - 1, int(p * n))]
    return {"n": n, "min": round(v[0], 4), "median": round(q(0.5), 4), "p90": round(q(0.9), 4), "max": round(v[-1], 4)}


def roc_and_eer(scored):
    thresholds = sorted(set(round(c, 4) for c, _ in scored))
    pos = sum(1 for _, d in scored if d) or 1
    neg = sum(1 for _, d in scored if not d) or 1
    best_j, best_t, eer_t, eer_gap, eer = -1, None, None, 1e9, None
    for t in thresholds:
        tp = sum(1 for c, d in scored if d and c >= t)
        fp = sum(1 for c, d in scored if not d and c >= t)
        tpr, fpr = tp / pos, fp / neg
        j = tpr - fpr
        if j > best_j:
            best_j, best_t = j, t
        gap = abs((1 - tpr) - fpr)
        if gap < eer_gap:
            eer_gap, eer_t, eer = gap, t, (1 - tpr + fpr) / 2
    return best_t, best_j, eer_t, eer


LABEL_IS_DOCTOR = {"dibyendu": True, "other_doctor": True, "patient": False, "family": False, "nurse": False, "two_voices": False}


def main():
    recovered = json.load(open(os.path.join(OUT, "recovered_mapping.json")))["unique"]  # clip_id -> turn dict (no embedding)
    answers = json.load(open(os.path.join(OUT, "answers.json")))          # READ ONLY
    log = json.load(open(os.path.join(OUT, "answers_log.json")))          # READ ONLY

    # Rebuild the embedding for every recovered turn (deterministic; needed for the cosine work).
    windows = B.load_windows()
    centroid = B.build_centroid(windows)
    all_turns = B.collect_turns(windows, centroid)
    emb_by_key = {(t["session_id"], t["start_ms"], t["end_ms"]): to_vec(t["embedding_base64"]) for t in all_turns}

    def vec_for(clip_id):
        t = recovered.get(clip_id)
        if not t:
            return None
        return emb_by_key.get((t["session_id"], t["start_ms"], t["end_ms"]))

    # --- label counts (answers.json, current answer per distinct clip, recovered clips only) ---
    answered_recovered = {cid: a for cid, a in answers.items() if cid in recovered}
    print("answers.json entries:", len(answers), "| of those with a recovered true clip:", len(answered_recovered))
    label_counts = Counter(a["label_key"] for a in answered_recovered.values())
    print("\n=== label counts ===")
    for k, v in label_counts.most_common():
        print(" ", k, v)

    # --- dominant cluster (recovered speaker_idx==0) vs label ---
    dom = Counter()
    for cid, a in answered_recovered.items():
        if recovered[cid]["speaker_idx"] == 0:
            dom[a["label_key"]] += 1
    n_dom = sum(dom.values())
    print("\n=== recovered speaker_idx==0 turns, n=%d ===" % n_dom)
    for k, v in dom.most_common():
        print(" ", k, v, "(%.0f%%)" % (100 * v / n_dom) if n_dom else "")

    # --- LOO doctor / non-doctor cosine + thresholds ---
    labelled = []
    for cid, a in answered_recovered.items():
        key = a["label_key"]
        if key not in LABEL_IS_DOCTOR:
            continue
        v = vec_for(cid)
        if v is None:
            continue
        labelled.append({"is_doctor": LABEL_IS_DOCTOR[key], "vec": v})
    doctor_rows = [r for r in labelled if r["is_doctor"]]
    other_rows = [r for r in labelled if not r["is_doctor"]]
    print("\n=== LOO doctor vs non-doctor (recovered) ===")
    if len(doctor_rows) >= 2:
        doctor_scores, other_scores, all_scored = [], [], []
        for i, r in enumerate(doctor_rows):
            loo = mean_vec([d["vec"] for j, d in enumerate(doctor_rows) if j != i])
            c = cos(r["vec"], loo)
            doctor_scores.append(c); all_scored.append((c, True))
        centroid_full = mean_vec([r["vec"] for r in doctor_rows])
        for r in other_rows:
            c = cos(r["vec"], centroid_full)
            other_scores.append(c); all_scored.append((c, False))
        print("doctor LOO:", dist(doctor_scores))
        print("non-doctor:", dist(other_scores))
        if other_rows:
            best_t, best_j, eer_t, eer = roc_and_eer(all_scored)
            print("threshold: youden=%.4f (J=%.4f)  eer_threshold=%.4f  EER=%.4f" % (best_t, best_j, eer_t, eer))

    # --- TRUE repeat pairs, recovered by duplicate-turn detection, agreement from the LOG ---
    by_turn = {}
    for cid, t in recovered.items():
        key = (t["session_id"], t["start_ms"], t["end_ms"])
        by_turn.setdefault(key, []).append(cid)
    true_pairs = [tuple(sorted(v)) for v in by_turn.values() if len(v) > 1]
    intentional = [p for p in true_pairs if any(x.startswith("r") for x in p)]
    accidental = [p for p in true_pairs if not any(x.startswith("r") for x in p)]
    print("\n=== TRUE duplicate-audio pairs (recovered) ===")
    print("intentional (c/r) repeat pairs:", len(intentional))
    print("accidental (c/c) duplicate pairs from the bug:", len(accidental), accidental)

    last_real = {}
    for e in log:
        if e["label_key"] != "__skip__":
            last_real[e["clip_id"]] = e["label_key"]
    agree, total = 0, 0
    rows = []
    for a, b_ in intentional:
        if a in last_real and b_ in last_real:
            total += 1
            ok = last_real[a] == last_real[b_]
            agree += ok
            rows.append((a, b_, last_real[a], last_real[b_], ok))
    print("intentional-pair agreement (from log): %d/%d = %.1f%%" % (agree, total, 100 * agree / total if total else 0))
    for r in rows:
        print(" ", r)

    agree2, total2, rows2 = 0, 0, []
    for a, b_ in accidental:
        if a in last_real and b_ in last_real:
            total2 += 1
            ok = last_real[a] == last_real[b_]
            agree2 += ok
            rows2.append((a, b_, last_real[a], last_real[b_], ok))
    print("accidental-pair agreement (bonus signal, from log): %d/%d = %.1f%%" % (agree2, total2, 100 * agree2 / total2 if total2 else 0))
    for r in rows2:
        print(" ", r)

    # --- cant_tell/two_voices by recovered clip length ---
    short = Counter(); long_ = Counter(); short_n = long_n = 0
    for cid, a in answered_recovered.items():
        dur = recovered[cid]["dur_s"]
        is_short = dur <= 3.0
        if is_short:
            short_n += 1
        else:
            long_n += 1
        if a["label_key"] in ("cant_tell", "two_voices"):
            (short if is_short else long_)[a["label_key"]] += 1
    print("\n=== cant_tell/two_voices by recovered length ===")
    print("short n=%d: cant_tell %d (%.0f%%) two_voices %d (%.0f%%)" % (short_n, short["cant_tell"], 100*short["cant_tell"]/short_n if short_n else 0, short["two_voices"], 100*short["two_voices"]/short_n if short_n else 0))
    print("long  n=%d: cant_tell %d (%.0f%%) two_voices %d (%.0f%%)" % (long_n, long_["cant_tell"], 100*long_["cant_tell"]/long_n if long_n else 0, long_["two_voices"], 100*long_["two_voices"]/long_n if long_n else 0))


if __name__ == "__main__":
    main()
