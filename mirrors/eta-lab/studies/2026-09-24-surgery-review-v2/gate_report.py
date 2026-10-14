#!/usr/bin/env python3
"""gate_report.py — the JSON eta-refuter-2 asked for (bus #192): ~/eta-data/surgery-review-v3/gate-report.json (0600, ids and times only, NO text).
Usage: gate_report.py <Q##,Q##,...> <real_n> <judge>   (real_n = the blind judge's count of real surgical conversations among the listed ids)"""
import json, os, sys
import mb, v3
V3 = os.path.expanduser("~/eta-data/surgery-review-v3")


def main(ids, real, judge):
    S = json.load(open(f"{V3}/{os.environ.get('V3_SEL', 'selected.json')}"))
    toks = ",".join(f"'{S[q]['token_uid']}'" for q in ids)
    _, rows, tr = mb.query(f"SELECT uid, metadata->>'INDIVIDUAL_UID' FROM queue_tokens WHERE uid IN ({toks})")
    assert not tr and len(rows) == len(ids), "every token must resolve"
    ind = dict(rows)
    rep = {"items": [{"id": q, "token_uid": S[q]["token_uid"], "individual_uid": ind[S[q]["token_uid"]], "called_at": S[q]["called"], "completed_at": S[q]["done"]} for q in ids],
           "wording_sha": "64ba6c7 (frozen a29f22245670f8c7d78367492272d67bee0634c74a5bc7aea3ea8b0314f09f65; v3.py check_frozen enforces it)", "judge": judge, "gate_share": ({"real": real, "of": len(ids)} if real >= 0 else None)}
    p = f"{V3}/{os.environ.get('V3_REPORT', 'gate-report.json')}"; json.dump(rep, open(p, "w"), indent=1); os.chmod(p, 0o600)
    print("written", p, "| items", len(ids), "| share", real, "of", len(ids))


if __name__ == "__main__":
    main(sys.argv[1].split(","), int(sys.argv[2]), sys.argv[3])
