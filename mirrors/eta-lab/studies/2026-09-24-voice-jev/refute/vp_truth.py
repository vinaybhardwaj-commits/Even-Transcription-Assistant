"""Run AS vjscore in /srv/vj-truth. stdin = data/vpilot-times-only.json (times only). Writes:
 vp_truth_me.jsonl      : 'me' answers -> is_doctor=true (a doctor is speaking), deduped by repeat_of; repeats used for self-consistency only.
 vp_pending_notme.jsonl : 'not_me'/'no' answers, held (not truth) until Fable rules on 'not Dr X' semantics.
Prints counts only."""
import json, sys, hashlib
from collections import Counter
times = {(r["page"], r["clip_id"]): r for r in json.load(sys.stdin)["rows"]}
B = "/srv/vj-truth/vpilot/split-speaker-pilot-%s/"
me, pend, stats, rep = [], [], Counter(), Counter()
for p in ("v2", "v3", "v4", "v5"):
    ans = {}
    for l in open(B % p + "answers.jsonl"):
        if l.strip():
            a = json.loads(l)
            if "id" in a and "answer" in a: ans[a["id"]] = a["answer"]
            else: stats["answer_lines_without_id"] += 1
    for (pg, cid), r in times.items():
        if pg != p: continue
        a = ans.get(cid)
        if a is None: stats["unanswered"] += 1; continue
        if r["repeat_of"]:
            o = ans.get(r["repeat_of"]); rep["pairs"] += 1; rep["agree"] += (o == a); continue
        row = {"page": p, "window_id": r["window_id"], "start_ms": r["start_ms"], "end_ms": r["end_ms"], "segs": r.get("segs"), "turn_full_ms": r.get("turn_full_ms")}
        if a == "me": me.append({**row, "is_doctor": True, "source": "vpilot_me"})
        elif a in ("not_me", "no"): pend.append({**row, "answer_class": "not_named_doctor", "source": "vpilot_notme_PENDING"})
        else: stats["cant_tell_or_not_sure"] += 1
def w(path, rows):
    b = ("\n".join(json.dumps(x, sort_keys=True) for x in rows) + "\n").encode(); open(path, "wb").write(b); return hashlib.sha256(b).hexdigest()[:12]
print("me(doctor) unique", len(me), "sha", w("/srv/vj-truth/vp_truth_me.jsonl", me), "| not_me pending", len(pend), "sha", w("/srv/vj-truth/vp_pending_notme.jsonl", pend),
      "| excluded", dict(stats), "| repeats", dict(rep), "| me by page", dict(Counter(x["page"] for x in me)))
