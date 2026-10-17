#!/usr/bin/env python3
"""R13 vocabulary tests. (1) Coverage: every word of coverage_words.json is vocabulary. (2) False fails: the V18
vocabulary rule run on every gp_extraction string of the 7 examples and on every field of the 20 invented clean notes
must flag nothing. Prints the counts; exit 1 on any miss."""
import glob, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, ROOT)
import validate_artifact as V  # noqa: E402


def flagged(text):
    return sorted({x for x in V.alpha_toks(text) if len(x) >= 3 and not V.in_vocab(x)})


cov = json.load(open(os.path.join(HERE, "coverage_words.json")))["words"]
missing = [w for w in cov if not V.in_vocab(w)]
ex_fail, ex_words = 0, set()
for f in sorted(glob.glob(os.path.join(ROOT, "examples", "*.json"))):
    a = json.load(open(f, encoding="utf-8"))
    prompt_toks = {x for pr in a["confirm_prompts"] for n in ((V.drug_names(pr["drug"]) if pr.get("drug") else []) + [pr.get("name") or ""]) for x in V.alpha_toks(n)}
    w = {x for _, s in V.walk_strings(a["gp_extraction"]) for x in flagged(s)} - prompt_toks
    ex_fail += bool(w)
    ex_words |= w
cn_fail, cn_words = 0, set()
for n in json.load(open(os.path.join(HERE, "clean_notes.json")))["notes"]:
    w = {x for s in n.values() for x in flagged(s)}
    cn_fail += bool(w)
    cn_words |= w
print("coverage: %d/%d clinical words present%s" % (len(cov) - len(missing), len(cov), (" missing %s" % missing) if missing else ""))
print("false fails: examples %d/7%s; clean notes %d/20%s" % (ex_fail, (" %s" % sorted(ex_words)) if ex_words else "", cn_fail, (" %s" % sorted(cn_words)) if cn_words else ""))
held = json.load(open(os.path.join(HERE, "heldout_notes.json")))
for b in ("batch1", "batch2"):
    fails = sum(bool({x for s in n.values() for x in flagged(s)}) for n in held[b])
    print("held-out %s (reported, not gated): %d/%d false fails" % (b, fails, len(held[b])))
sys.exit(1 if missing or ex_fail or cn_fail else 0)
