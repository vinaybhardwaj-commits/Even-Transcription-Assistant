#!/usr/bin/env python3
"""R15 build step for data/scowl_words.json: subtract every brand-map key and brand word, every LASA name, the curated
brand list, the drug denylist (names and stems), the bundle's medicine names and the salt-drug phrases' non-qualifier
words. Idempotent and deterministic: run it after any change to those lists. check_vocab.py proves the result."""
import json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(os.path.dirname(os.path.dirname(HERE)), "data")


def load(n):
    return json.load(open(os.path.join(DATA, n), encoding="utf-8"))


def forbidden():
    """Every word that may never be vocabulary: drug and brand names in any of the bundle's lists."""
    q = set(load("qualifier_words.json")["words"])
    words = set()
    for e in load("brand_generic_min.json")["entries"]:
        words.add(e["key"])  # the brand's own key ("pand"); a brand's ordinary-word parts ("pan") stay vocabulary (R20)
    for pair in load("lasa_pairs.json")["pairs"]:
        words |= set(pair)
    words |= set(load("brand_names_curated.json")["names"])
    words |= set(load("drug_denylist.json")["names"])
    words |= {w for g in load("medicine_names_min.json")["generics"] for w in g.split()} - q
    words |= {w for s in load("salt_drugs.json")["drugs"] for w in s.split()} - q
    return {w for w in words if len(w) >= 3}


def main(argv):
    """`build_vocab.py OUT` writes the rebuilt dictionary to OUT and never touches data/. `build_vocab.py --write` rebuilds
    data/scowl_words.json in place (a deliberate data change; run_checks.sh never does this)."""
    if len(argv) != 2 or (argv[1] != "--write" and argv[1].startswith("--")):
        sys.exit("usage: build_vocab.py OUT | --write")
    p = os.path.join(DATA, "scowl_words.json") if argv[1] == "--write" else argv[1]
    d = load("scowl_words.json")
    stems = re.compile(load("drug_denylist.json")["stems_regex"])
    bad = forbidden()
    before = len(d["words"])
    d["words"] = [w for w in d["words"] if w not in bad and not stems.search(w)]
    d["count"] = len(d["words"])
    d["brand_subtraction"] = "tests/vocab/build_vocab.py subtracts brand keys, LASA names, curated brands, the drug denylist and medicine names (R15)."
    with open(p, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False)
        f.write("\n")
    print("scowl_words: %d -> %d" % (before, d["count"]))


if __name__ == "__main__":
    sys.dont_write_bytecode = True
    main(sys.argv)
