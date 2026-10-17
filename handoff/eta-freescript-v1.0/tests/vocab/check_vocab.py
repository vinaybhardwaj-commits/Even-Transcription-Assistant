#!/usr/bin/env python3
"""Vocabulary tests (R13, R15, R16, R18).
(1) R15: no brand-map key or brand word, LASA name, curated brand, denylisted drug or medicine name is vocabulary, in
    the dictionary file or in any loaded layer; the abbreviation and order-object lists hold none either; the
    order-object list has at most 60 words.
(2) Coverage: every word of coverage_words.json is vocabulary.
(3) False fails, gated: the 7 examples and the 20 invented clean notes pass at artifact level.
(4) Held-out notes, reported and not gated: each note is checked the way a generator's output would be. A hit in
    Plan, Advice, Follow up or symptoms fails the artifact; a vocabulary hit in diagnosis or examination withholds
    that field (R18, r13_vocab) and is counted.
Exit 1 on any failure of (1)-(3)."""
import glob, json, os, sys

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, ROOT)
import validate_artifact as V  # noqa: E402

PATHS = {"symptoms": "/presenting_complaints/symptoms", "examination": "/examination", "diagnosis": "/presenting_complaints/diagnoses/0/diagnosis_or_impression",
         "plan": "/plan_of_management/management_plan", "advice": "/general_advice", "follow_up": "/follow_up/follow_up_instructions"}
ORDER_FIELDS = {"plan", "advice", "follow_up"}


def note_result(n):
    """(artifact_fails, withheld_fields, reasons) for one note dict, as V18 and R18 treat a generator's output."""
    fails, withheld, why = False, [], []
    for k, s in n.items():
        path = PATHS[k]
        hist = bool(V.HISTORY_PATHS.match(path))
        hard = V.dose_hits(s, history=hist) + V.form_mentions(s)
        if k in ORDER_FIELDS:
            hard += ["%s %s" % x for x in V.unresolved_after_verbs(s) + V.order_object_misses(s, set())]
        unknown = V.r13_unknown(s, path, set())
        if unknown and V.CLINICAL_FIELD.match(path):
            withheld.append(k)
        elif unknown:
            hard += unknown
        if hard:
            fails = True
            why += ["%s: %s" % (k, h) for h in hard]
    return fails, withheld, why


bad = 0
forb = V.FORBIDDEN | {w for w in V.BRAND_WORDS}
scowl = set(V._data("scowl_words.json")["words"])
for name, words in (("scowl_words.json", scowl), ("loaded vocabulary", {w for w in V.VOCAB if V.in_vocab(w)}),
                    ("clinical_abbreviations.json", V.CLIN_ABBR), ("order_objects.json", V.R16_OBJECTS)):
    inter = sorted(words & forb)
    print("R15 %s ∩ drug/brand names: %d%s" % (name, len(inter), (" %s" % inter[:10]) if inter else ""))
    bad += bool(inter)
for probe in ("benadryl", "sumo", "dolo", "crocin", "augmentin", "pcm", "ors"):
    if V.in_vocab(probe):
        print("R15 FAIL: '%s' is vocabulary" % probe)
        bad += 1
if len(V.R16_OBJECTS) > 60:
    print("R16 FAIL: order-object list has %d words (> 60)" % len(V.R16_OBJECTS))
    bad += 1
cov = json.load(open(os.path.join(HERE, "coverage_words.json")))["words"]
missing = [w for w in cov if not V.in_vocab(w)]
print("coverage: %d/%d clinical words present%s" % (len(cov) - len(missing), len(cov), (" missing %s" % missing) if missing else ""))
bad += bool(missing)
ex_fail = 0
for f in sorted(glob.glob(os.path.join(ROOT, "examples", "*.json"))):
    ex_fail += bool(V.check(json.load(open(f, encoding="utf-8"))))
cn = [note_result(n) for n in json.load(open(os.path.join(HERE, "clean_notes.json")))["notes"]]
cn_fail = sum(r[0] for r in cn)
print("false fails (gated): examples %d/7; clean notes %d/20 (fields withheld %d)%s" % (
    ex_fail, cn_fail, sum(len(r[1]) for r in cn), "".join("\n  %s" % w for r in cn if r[0] for w in r[2])))
bad += ex_fail + cn_fail
held = json.load(open(os.path.join(HERE, "heldout_notes.json")))
for b in [k for k in held if k.startswith("batch")]:
    res = [note_result(n) for n in held[b]]
    print("held-out %s (reported, not gated): %d/%d artifact-level false fails; %d field(s) withheld (r13_vocab) in %d note(s)%s" % (
        b, sum(r[0] for r in res), len(res), sum(len(r[1]) for r in res), sum(bool(r[1]) for r in res),
        "".join("\n  %s" % w for r in res if r[0] for w in r[2])))
sys.exit(1 if bad else 0)
