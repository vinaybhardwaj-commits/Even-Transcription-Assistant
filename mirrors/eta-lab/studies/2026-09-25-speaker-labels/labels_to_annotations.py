#!/usr/bin/env python3
"""337e: per-window label files (build_labels.py) -> annotations/speaker/<room>/<date>/<stamp>-diar-lab.json docs via kit/lab-vault/tools/make_annotation.py, staged in a BOX-ONLY dir
(NOT the default lab-vault/staged, which vault-push.py reads). Nothing is uploaded here; the docs go to eta-refuter-2 first.
Item shape (live grammar, ingest 57019710): {k, i, speaker, conf?, seq?, mixed?, speech_s?}; speaker = A..Z | S<n> | '?'; '?' = unlabeled and takes no conf/seq/mixed; seq only when mixed is true. No text.
Also runs the same checks locally (validate()) and refuses anything the Worker would 422 on.
usage: labels_to_annotations.py <labels_dir> <out_dir> --stamp YYYYMMDDHHMM [--limit-windows N]"""
import argparse, glob, importlib.util, json, os, re, sys
HOME = os.path.expanduser("~/eta-data")
LETTER = re.compile(r"^(?:[A-Z]|S[0-9]+)$")


def items_for(label):
    rec = os.path.join(HOME, label["record_path"]); out = []
    for s in label["segments"]:
        if s["unlabeled"]: it = dict(record=rec, i=s["idx"], speaker="?", speech_s=round(s["speech_s"], 2))
        else:
            it = dict(record=rec, i=s["idx"], speaker=s["speaker"], conf=s["purity"], speech_s=round(s["speech_s"], 2))
            if s["mixed"]: it.update(mixed=True, seq=list(s["sequence"]))
        out.append(it)
    return out


def validate(doc):
    """mirror of the live speaker rules; returns a list of problems"""
    bad = []; ks = set()
    for n, it in enumerate(doc["items"]):
        extra = set(it) - {"k", "i", "speaker", "conf", "seq", "mixed", "speech_s"}
        sp = it.get("speaker"); ks.add(it.get("k"))
        if extra: bad.append((n, "extra", sorted(extra)))
        if not isinstance(it.get("i"), int) or it["i"] < 0: bad.append((n, "i"))
        if not (sp == "?" or (isinstance(sp, str) and LETTER.match(sp))): bad.append((n, "speaker", sp))
        if sp == "?" and any(x in it for x in ("conf", "seq", "mixed")): bad.append((n, "? with extras"))
        if "conf" in it and not (isinstance(it["conf"], (int, float)) and 0 <= it["conf"] <= 1): bad.append((n, "conf"))
        if "speech_s" in it and not (isinstance(it["speech_s"], (int, float)) and it["speech_s"] >= 0): bad.append((n, "speech_s"))
        if "mixed" in it and not isinstance(it["mixed"], bool): bad.append((n, "mixed"))
        if "seq" in it and not (it.get("mixed") is True and isinstance(it["seq"], list) and 1 <= len(it["seq"]) <= 6 and all(isinstance(x, str) and LETTER.match(x) for x in it["seq"])): bad.append((n, "seq"))
    if set(doc["sources"]) != ks: bad.append(("sources", "keys differ from item ks"))
    if len(doc["sources"]) > 400: bad.append(("sources", ">400"))
    return bad


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("labels_dir"); ap.add_argument("out_dir"); ap.add_argument("--stamp", required=True); ap.add_argument("--limit-windows", type=int); a = ap.parse_args()
    spec = importlib.util.spec_from_file_location("ma", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "kit", "lab-vault", "tools", "make_annotation.py"))
    ma = importlib.util.module_from_spec(spec); spec.loader.exec_module(ma)
    files = sorted(glob.glob(os.path.join(os.path.expanduser(a.labels_dir), "*", "*", "*.json")))[:a.limit_windows]
    items = []
    for f in files: items += items_for(json.load(open(f)))
    written = ma.build("speaker", "diar-lab", items, os.path.expanduser(a.out_dir), a.stamp)
    nbad = 0
    for p in written.values():
        os.chmod(p, 0o600); b = validate(json.load(open(p)))
        if b: nbad += len(b); print("INVALID", p, b[:3])
    print(f"{len(files)} windows, {len(items)} items, {len(written)} docs, {nbad} problems")
    sys.exit(1 if nbad else 0)
