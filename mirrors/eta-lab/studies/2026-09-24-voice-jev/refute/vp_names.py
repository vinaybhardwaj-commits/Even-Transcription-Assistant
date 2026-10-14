import json
from collections import Counter
B = "/srv/vj-truth/vpilot/split-speaker-pilot-v%d/"
for v in (2, 3, 4, 5):
    m = json.load(open(B % v + "manifest.json")); clips = m["clips"]
    print(f"v{v}: day", m.get("day"), "room_day", m.get("room_day_id"), "| doctors", m.get("doctors"), "| names", m.get("names"))
    for k in ("named", "unnamed", "present_as", "true_doctor", "kind"):
        if any(k in c for c in clips): print(f"   {k}:", dict(Counter(str(c.get(k)) for c in clips)))
    ans = [json.loads(l) for l in open(B % v + "answers.jsonl") if l.strip()]
    print("   answer kinds", dict(Counter((a.get("kind"), a.get("answer")) for a in ans)))
