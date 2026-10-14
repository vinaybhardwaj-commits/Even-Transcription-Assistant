import json, sys
prod = json.loads(sys.stdin.read()); t = [json.loads(l) for l in open("/srv/vj-truth/e3_truth_r197.jsonl")]
m = [x for x in t if any(w == x["window_id"] and min(e, x["end_ms"]) - max(s, x["start_ms"]) >= 0.5 * (x["end_ms"] - x["start_ms"]) for w, s, e in prod)]
print("clean E-3 truth turns", len(t), "scorable (map to a production turn)", len(m), "of which doctor", sum(x["is_doctor"] for x in m), "not-doctor", sum(not x["is_doctor"] for x in m))
