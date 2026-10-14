import json
from collections import Counter
B = "/srv/vj-truth/vpilot/split-speaker-pilot-v%d/"
for v in (2, 3, 4, 5):
    man = json.load(open(B % v + "manifest.json")); ans = [json.loads(l) for l in open(B % v + "answers.jsonl") if l.strip()]
    clips = man.get("clips") if isinstance(man, dict) else man
    if clips is None: clips = next(x for x in man.values() if isinstance(x, list))
    print(f"v{v}: manifest top keys", list(man.keys()) if isinstance(man, dict) else "list", "| clip keys", sorted(Counter(k for c in clips for k in c)))
    print(f"   answers n={len(ans)} keys", sorted(Counter(k for a in ans for k in a)))
    for k in ("answer", "a", "choice", "value"):
        if any(k in a for a in ans): print("   answer values", Counter(str(a.get(k)) for a in ans)); break
    for k in ("true_doctor", "present_as", "named"):
        if any(k in c for c in clips): print(f"   {k}: n_distinct", len({str(c.get(k)) for c in clips}), "| equal named==true_doctor", sum(1 for c in clips if c.get('named') is not None and c.get('named') == c.get('true_doctor')), "of", len(clips))
