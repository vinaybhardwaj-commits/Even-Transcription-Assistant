"""Run AS vjscore inside /srv/vj-truth: derive the ruling-197(c) E-3 truth (clean doctor + clean not-doctor unique turns) from the installed original.
Excluded: two_voices, other_doctor, and any turn whose repeats carry conflicting labels. Prints counts only (no label values per turn)."""
import json, hashlib
src = "/srv/vj-truth/e3_recovery_labelled_turns.json"; rows = json.load(open(src))
MAP = {"dibyendu": True, "patient": False, "nurse": False}
by = {}
for r in rows: by.setdefault((r["window_id"], r["start_ms"], r["end_ms"]), set()).add(r["label_key"])
out, excl = [], {"two_voices_or_other_doctor": 0, "conflict": 0}
for (w, s, e), labs in sorted(by.items()):
    if len(labs) > 1: excl["conflict"] += 1; continue
    l = next(iter(labs))
    if l not in MAP: excl["two_voices_or_other_doctor"] += 1; continue
    out.append({"window_id": w, "start_ms": s, "end_ms": e, "is_doctor": MAP[l], "source": "e3_recovered", "rule": "ruling 197(c)"})
b = "\n".join(json.dumps(x, sort_keys=True) for x in out).encode() + b"\n"
open("/srv/vj-truth/e3_truth_r197.jsonl", "wb").write(b)
print("unique", len(by), "kept", len(out), "doctor", sum(x["is_doctor"] for x in out), "not", sum(not x["is_doctor"] for x in out), "excluded", excl, "sha12", hashlib.sha256(b).hexdigest()[:12])
