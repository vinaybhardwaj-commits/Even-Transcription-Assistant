#!/usr/bin/env python3
"""E-3 kit step 3 (weekA-2310). Given V's labels (window_id, time -> doctor|patient|other, per
clinician), build per-clinician room_primary centroids from the labelled doctor turns (leave-one-out
for scoring each doctor turn against its own centroid), report the cosine distribution for doctor vs
everyone-else, and the best separating threshold (max-Youden's-J point on the ROC, plus the EER).
This REPLACES the unreproducible 0.735/0.842 fixed targets from the earlier best-available run with
real, labelled numbers. No DB write, no voiceprint-store write; embeddings only, never transcript
text (score.py never reads a transcript field — turns.json and embeds.json carry none).

labels.csv columns: window_id,time_ms,label,clinician_id
  window_id  — must match a window_id in turns.json
  time_ms    — a clock instant (absolute epoch ms, or window-relative ms for a seeded dry run);
               matched to the turn in that window whose [start_ms,end_ms) covers it
  label      — doctor | patient | other
  clinician_id — free text/id; only used to group centroids when more than one clinician is labelled
"""
import base64
import csv
import json
import math
import os
import struct
import sys


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


def load_labels(path):
    rows = []
    with open(path) as f:
        for r in csv.DictReader(f):
            rows.append({"window_id": r["window_id"], "time_ms": int(r["time_ms"]), "label": r["label"].strip(), "clinician_id": r.get("clinician_id") or "unknown"})
    return rows


def match_turn(turns_by_window, window_id, time_ms):
    for t in turns_by_window.get(window_id, []):
        if t["start_ms"] is not None and t["end_ms"] is not None and t["start_ms"] <= time_ms < t["end_ms"]:
            return t
    return None


def roc_and_eer(scored):
    """scored: list of (cosine, is_doctor). Returns (best_threshold_by_youden, eer_threshold, eer)."""
    thresholds = sorted(set(round(c, 4) for c, _ in scored))
    pos = sum(1 for _, d in scored if d) or 1
    neg = sum(1 for _, d in scored if not d) or 1
    best_j, best_t = -1, None
    eer_t, eer_gap = None, 1e9
    for t in thresholds:
        tp = sum(1 for c, d in scored if d and c >= t)
        fp = sum(1 for c, d in scored if not d and c >= t)
        tpr = tp / pos; fpr = fp / neg
        j = tpr - fpr
        if j > best_j:
            best_j, best_t = j, t
        gap = abs((1 - tpr) - fpr)
        if gap < eer_gap:
            eer_gap, eer_t, eer = gap, t, (1 - tpr + fpr) / 2
    return best_t, best_j, eer_t, eer


def dist(vals):
    if not vals:
        return None
    v = sorted(vals)
    q = lambda p: v[min(len(v) - 1, int(p * len(v)))]
    return {"n": len(v), "min": round(v[0], 4), "median": round(q(0.5), 4), "p90": round(q(0.9), 4), "max": round(v[-1], 4)}


def run(turns_path, embeds_path, labels_path):
    turns_doc = json.load(open(turns_path))
    embeds_doc = json.load(open(embeds_path))
    turn_by_id = {t["turn_id"]: t for t in turns_doc["turns"]}
    turns_by_window = {}
    for t in turns_doc["turns"]:
        turns_by_window.setdefault(t["window_id"], []).append(t)
    vec_by_turn = {r["turn_id"]: to_vec(r["embedding_base64"]) for r in embeds_doc["results"] if r.get("embedding_base64")}

    labels = load_labels(labels_path)
    labelled = []  # (turn_id, clinician_id, label, vec)
    unmatched = 0
    for lr in labels:
        t = match_turn(turns_by_window, lr["window_id"], lr["time_ms"])
        if t is None or t["turn_id"] not in vec_by_turn:
            unmatched += 1
            continue
        labelled.append({"turn_id": t["turn_id"], "clinician_id": lr["clinician_id"], "label": lr["label"], "vec": vec_by_turn[t["turn_id"]]})

    by_clinician = {}
    for row in labelled:
        by_clinician.setdefault(row["clinician_id"], []).append(row)

    report = {"n_labels": len(labels), "n_matched": len(labelled), "n_unmatched": unmatched, "clinicians": {}}
    all_scored = []

    for cid, rows in by_clinician.items():
        doctor_rows = [r for r in rows if r["label"] == "doctor"]
        other_rows = [r for r in rows if r["label"] != "doctor"]
        if len(doctor_rows) < 2:
            report["clinicians"][cid] = {"error": "need >=2 'doctor' labels to build a leave-one-out centroid; got %d" % len(doctor_rows)}
            continue
        centroid_full = mean_vec([r["vec"] for r in doctor_rows])
        doctor_scores, other_scores = [], []
        for i, r in enumerate(doctor_rows):
            loo = mean_vec([d["vec"] for j, d in enumerate(doctor_rows) if j != i]) if len(doctor_rows) > 1 else centroid_full
            c = cos(r["vec"], loo)
            doctor_scores.append(c)
            all_scored.append((c, True))
        for r in other_rows:
            c = cos(r["vec"], centroid_full)
            other_scores.append(c)
            all_scored.append((c, False))
        report["clinicians"][cid] = {
            "n_doctor": len(doctor_rows), "n_other": len(other_rows),
            "doctor_cosine_loo": dist(doctor_scores), "other_cosine": dist(other_scores),
        }

    if len(set(d for _, d in all_scored)) > 1:
        best_t, best_j, eer_t, eer = roc_and_eer(all_scored)
        report["threshold"] = {"best_youden_threshold": best_t, "youden_j": round(best_j, 4), "eer_threshold": eer_t, "eer": round(eer, 4)}
    else:
        report["threshold"] = {"note": "need both doctor and non-doctor labels across at least one clinician to fit a threshold"}

    out_path = os.path.join(os.path.dirname(turns_path), "score_%s" % os.path.basename(labels_path).replace(".csv", ".json"))
    json.dump(report, open(out_path, "w"), indent=1)
    print(json.dumps(report, indent=1))
    print("wrote", out_path)
    return report


if __name__ == "__main__":
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument("turns_json")
    p.add_argument("embeds_json")
    p.add_argument("--labels", required=True)
    a = p.parse_args()
    run(a.turns_json, a.embeds_json, a.labels)
