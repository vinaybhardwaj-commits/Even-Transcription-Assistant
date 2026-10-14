#!/usr/bin/env python3
"""Ruling 146.2: tag English-dominant windows in HIST output (the known systematic parity miss is an English window, ~0.5 similarity to production).
english_dominant = router dominant_language in {en, english}  OR  Indic-script share of the native transcript < 10% while the transcript is non-empty.
Adds two fields to each record, never removes anything: english_dominant (bool), indic_script_share (0..1). Works on JSONL (one record per line) or a JSON list.
Usage: tag_english.py in.jsonl out.jsonl [--lang-key dominant_language] [--text-key transcript_native]. Nothing is printed except counts."""
import json, re, sys, argparse
INDIC = re.compile(r"[ऀ-෿]")
def tag(rec, lang_key="dominant_language", text_key="transcript_native"):
    lang = (rec.get(lang_key) or "").lower()
    txt = rec.get(text_key) or ""
    share = round(len(INDIC.findall(txt)) / max(1, len(txt)), 3)
    rec["indic_script_share"] = share
    rec["english_dominant"] = bool(lang in ("en", "english") or (txt.strip() and share < 0.10))
    return rec
if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("inp"); ap.add_argument("out"); ap.add_argument("--lang-key", default="dominant_language"); ap.add_argument("--text-key", default="transcript_native")
    a = ap.parse_args(); n = e = 0
    raw = open(a.inp).read()
    recs = json.loads(raw) if raw.lstrip().startswith("[") else [json.loads(l) for l in raw.splitlines() if l.strip()]
    out = [tag(r, a.lang_key, a.text_key) for r in recs]
    n = len(out); e = sum(1 for r in out if r["english_dominant"])
    with open(a.out, "w") as f:
        if raw.lstrip().startswith("["): json.dump(out, f)
        else: f.write("\n".join(json.dumps(r) for r in out) + "\n")
    print(f"{n} records, {e} english_dominant")
