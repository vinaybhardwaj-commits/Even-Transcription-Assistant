"""Arm 1: production's stored labels, no model run. Validates the export from vj-data and stamps the DOUBTFUL flag.
Ruling 165 D: production's speaker role "clinician" = DOCTOR; an empty role or any other role = NOT DOCTOR (that is what production's live output shows).
Ruling 186: CONFIDENT needs margin >= 0.10 AND best >= 0.50 (verified centroids only).
Input jsonl: {turn_id, window_id, role (may be null/"" but the key must exist), margin, best (best match to the room-day doctor's verified centroid; null allowed, key must exist), speaker_basis, nemotron_n, pyannote_n, doctor_name?, doubtful?}
If the record carries its own `doubtful` (vj-data's selector), it must equal the frozen rule here (cross-check), else refuse.
Output: {turn_id, window_id, arm:1, is_doctor, role, role_empty, doubtful, margin, speaker_basis, nemotron_n, pyannote_n}
Usage: arm1.py --in production.jsonl --out out/arm1.jsonl
"""
import argparse, sys
import common as C

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--in", dest="inp", required=True); ap.add_argument("--out", required=True)
    a = ap.parse_args(); C.freeze_text()
    rows = C.read_jsonl(a.inp); C.blind_check(a.inp, rows)
    out, bad = [], []
    for r in rows:
        d = C.is_doubtful(r)
        if "doubtful" in r and bool(r["doubtful"]) != d: bad.append(r["turn_id"])
        if r.get("production_row") is False: raise SystemExit(f"turn {r['turn_id']}: production_row is false. Non-production pseudo-turns (E3X, ruling 290) must NOT enter arm1_in (they would be scored with a fabricated arm-1 answer); hand them off in a separate file and pass their ids with --extra-ids")
        for k in ("role", "best", "margin"):
            if k not in r: raise SystemExit(f"turn {r['turn_id']}: no `{k}` key (a null value is fine, a missing key is a schema error)")
        out.append({"turn_id": r["turn_id"], "window_id": r.get("window_id"), "arm": 1, "role": r["role"], "role_empty": not r["role"], "is_doctor": r["role"] == "clinician",
                    "doubtful": d, **{k: r.get(k) for k in ("margin", "best", "speaker_basis", "nemotron_n", "pyannote_n")}, **C.stamp()})
    if bad: raise SystemExit(f"selector mismatch vs frozen rule on {len(bad)} turns, first: {bad[:5]}")
    C.write_jsonl(a.out, out)
    nd = [o for o in out if not o["is_doctor"]]
    print(f"arm1: {len(out)} turns, {sum(o['doubtful'] for o in out)} doubtful, {len(nd)} not-doctor of which {sum(o['role_empty'] for o in nd)} had an empty role")

if __name__ == "__main__":
    sys.exit(main())
