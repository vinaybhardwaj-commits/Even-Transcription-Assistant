#!/usr/bin/env python3
"""scan_anchors.py — SURGERY-REVIEW-V3: run the two-stage Jev scan over the ANCHORED consults that can be placed in a room, and report the anchored positives Jev MISSES.

  stage : for every anchor placed in a room (voiceprint-confirmed room of the same doctor if there is one, else the content-located room; ambiguous / no_match / no_transcript are
          skipped and counted), pull the consult's transcript (PQM window, read-only), write ~/eta-data/surgery-review-v3/staging/A<nn>.json (0600, RAW, never shared).
          Consults already labelled by V (the 5 v2 pilot consults, the 18 v1 consults) are EXCLUDED: this measurement is on consults V has NOT labelled.
  scan  : reads ~/eta-data/surgery-review-v3/deid/A<nn>.json (surg-deid's CLI output: de-identified text), refuses anything with an identifier shape or Indic script (finalize.residual_identifiers),
          runs v3.scan (stage a recall, stage b status) and writes scan.json (ids, booked procedure name, probabilities; NO text). Jev only ever sees de-identified text.
Prints aggregates and the misses (booked procedure names are not identifiers).
"""
import json, os, sys
from collections import Counter
import fetch_turns, finalize, build_consult as bc, v3, anchor as an

V3 = os.path.expanduser("~/eta-data/surgery-review-v3")
V2 = os.path.expanduser("~/eta-data/surgery-review-v2")


def labelled_tokens():
    out = set()
    for f, key in ((f"{V2}/pilot-key.json", None), (os.path.expanduser("~/eta-data/surgery-30/key.json"), "key")):
        if os.path.exists(f):
            d = json.load(open(f))
            out |= {v["token_uid"] for v in (d[key] if key else d).values()}
    return out


def placed():
    L = json.load(open(f"{V3}/located.json")); A = {a["token_uid"]: a for a in json.load(open(f"{V3}/anchors.json"))}
    conf = json.load(open(f"{V3}/confirmed_room_days.json")); lab = labelled_tokens()
    out, skipped = [], Counter()
    for r in L:
        a = A[r["token_uid"]]
        if r["token_uid"] in lab:
            skipped["already labelled by V"] += 1; continue
        vp = next((o for o in conf if o["date"] == r["day"] and ((o["doctor_uid"] and o["doctor_uid"] == a["doctor_uid"]) or (o["doctor_name"] and an.same_doctor_name(o["doctor_name"], a["doctor_name"])))), None)
        if vp:
            room, how = vp["room_day_id"], "voiceprint"
        elif r["decision"] == "located":
            room, how = r["room_day_id"], "content"
        else:
            skipped[r["decision"]] += 1; continue
        out.append({**r, "room_day_id": room, "placed_by": how})
    return out, skipped


def stage():
    P, skipped = placed()
    os.makedirs(f"{V3}/staging", exist_ok=True); os.chmod(f"{V3}/staging", 0o700)
    idx = {}
    for n, r in enumerate(P, 1):
        aid = f"A{n:02d}"
        turns = fetch_turns.fetch({"room_day_id": r["room_day_id"], "called": r["called"], "done": r["done"]})
        doc = {"id": aid, "turns": [{"i": i, "speaker": t["speaker"], "lang": "en", "orig": t["text"], "en": t["text"]} for i, t in enumerate(turns)]}
        p = f"{V3}/staging/{aid}.json"; json.dump(doc, open(p, "w"), ensure_ascii=False); os.chmod(p, 0o600)
        idx[aid] = {"token_uid": r["token_uid"], "booked_procedure": r["booked_procedure"], "day": r["day"], "placed_by": r["placed_by"], "room_day_id": r["room_day_id"], "turns": len(turns),
                    "chars": sum(len(t["text"]) for t in turns), "terms": r["terms"]}
    json.dump(idx, open(f"{V3}/staging-index.json", "w"), indent=1); os.chmod(f"{V3}/staging-index.json", 0o600)
    print("placed & unlabelled:", len(P), "| by placement:", dict(Counter(r["placed_by"] for r in P)), "| skipped:", dict(skipped))
    print("turns per consult min/median/max:", sorted(v["turns"] for v in idx.values())[0], sorted(v["turns"] for v in idx.values())[len(idx) // 2], sorted(v["turns"] for v in idx.values())[-1])


def scan():
    idx = json.load(open(f"{V3}/staging-index.json")); res = {}
    for aid, m in idx.items():
        dp = f"{V3}/deid/{aid}.json"
        if not os.path.exists(dp):
            res[aid] = {**{k: m[k] for k in ("booked_procedure", "day", "placed_by", "turns")}, "status": "no_deid_file"}; continue
        doc = json.load(open(dp))
        bad = finalize.residual_identifiers(doc["turns"])
        if bad:
            res[aid] = {**{k: m[k] for k in ("booked_procedure", "day", "placed_by", "turns")}, "status": f"refused_{len(bad)}_identifier_or_script_hits"}; continue
        state = bc.state_text(finalize.to_bc_turns(doc))
        sc = v3.scan(state)
        res[aid] = {**{k: m[k] for k in ("booked_procedure", "day", "placed_by", "turns")}, "recall_p": round(sc["recall_p"], 3), "passed": sc["passed"],
                    "status": (sc["b"]["status"] if sc["b"] else None), "raised_by": (sc["b"]["raised_by"] if sc["b"] else None), "category": (sc["b"]["category"] if sc["b"] else None)}
    p = f"{V3}/scan.json"; json.dump(res, open(p, "w"), indent=1); os.chmod(p, 0o600)
    ok = {k: v for k, v in res.items() if "recall_p" in v}
    print("scanned:", len(ok), "of", len(res), "| refused/no file:", dict(Counter(v["status"] for v in res.values() if "recall_p" not in v)))
    print("stage (a) recall_p >= 0.5:", sum(v["recall_p"] >= 0.5 for v in ok.values()), "| passes the low cut (>=0.25):", sum(v["passed"] for v in ok.values()), "| below the cut (MISSED):", sum(not v["passed"] for v in ok.values()))
    print("stage (b) status among those passing:", dict(Counter(v["status"][0] for v in ok.values() if v["status"])))
    print("category among those passing:", dict(Counter(v["category"][0] for v in ok.values() if v["category"])))
    print("ANCHORED POSITIVES JEV MISSES (below the recall cut):")
    for aid, v in sorted(ok.items()):
        if not v["passed"]:
            print(f"  {aid} {v['day']} booked='{v['booked_procedure'][:50]}' recall_p={v['recall_p']} turns={v['turns']} placed_by={v['placed_by']}")


if __name__ == "__main__":
    {"stage": stage, "scan": scan}[sys.argv[1]]()
