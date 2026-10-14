#!/usr/bin/env python3
"""LISTEN-E3-CARDIOLOGY step 8. Run only after V finishes. Reads out/clips_manifest.json (has each
clip's embedding, server-side only) and out/answers.json (V's real answers), builds a leave-one-out
doctor centroid the same way score.py does, reports the doctor/non-doctor cosine distributions, the
Youden and EER thresholds, and V's agreement rate on the 10 hidden repeats."""
import base64
import json
import math
import os
import struct


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
    out = os.path.expanduser("~/dev/_fable/e3kit/out")
    manifest = json.load(open(os.path.join(out, "clips_manifest.json")))
    answers = json.load(open(os.path.join(out, "answers.json")))
    clips = {c["clip_id"]: c for c in manifest["clips"]}

    labelled = []
    for clip_id, ans in answers.items():
        key = ans.get("label_key")
        if key not in LABEL_IS_DOCTOR or clip_id not in clips:
            continue
        labelled.append({"clip_id": clip_id, "is_doctor": LABEL_IS_DOCTOR[key], "vec": to_vec(clips[clip_id]["embedding_base64"])})

    doctor_rows = [r for r in labelled if r["is_doctor"]]
    other_rows = [r for r in labelled if not r["is_doctor"]]
    report = {"n_answered": len(answers), "n_doctor": len(doctor_rows), "n_other": len(other_rows)}

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
        report["doctor_cosine_loo"] = dist(doctor_scores)
        report["other_cosine"] = dist(other_scores)
        if other_rows:
            best_t, best_j, eer_t, eer = roc_and_eer(all_scored)
            report["threshold"] = {"best_youden_threshold": best_t, "youden_j": round(best_j, 4), "eer_threshold": eer_t, "eer": round(eer, 4)}
    else:
        report["note"] = "fewer than 2 doctor-labelled clips answered"

    repeats = [c for c in manifest["clips"] if c.get("is_repeat_of")]
    agree, total = 0, 0
    for r in repeats:
        a1 = answers.get(r["clip_id"]); a2 = answers.get(r["is_repeat_of"])
        if a1 and a2 and a1.get("label_key") != "__skip__" and a2.get("label_key") != "__skip__":
            total += 1
            if a1.get("label_key") == a2.get("label_key"):
                agree += 1
    report["repeat_agreement"] = {"agree": agree, "of": total, "rate": round(agree / total, 3) if total else None}

    print(json.dumps(report, indent=1))
    json.dump(report, open(os.path.join(out, "report_cardiology.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
