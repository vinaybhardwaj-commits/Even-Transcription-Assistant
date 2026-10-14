#!/usr/bin/env python3
"""Rating pages (ruling 349): load a seed into the private eta-lab-ratings bucket, and export the raters' answers back to the box.

  rate_seed.py load   --set label200 --file ~/eta-data/readability/r1/label-page-seed/seed_docs.json     # once; refuses to replace an existing seed
  rate_seed.py load   --set ba106    --file ~/eta-data/pair-label/ba106/seed_docs.json     # identical A/B rows are allowed (10 controls)
  rate_seed.py load   --set rate20   --file ~/eta-data/readability-rate/seed1/seed_docs.json
  rate_seed.py export --set label200 --out ~/eta-data/readability/r1/labels --rater vinay=staff-redacted@even.in --rater sandhya=staff-redacted@even.in

Needs CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID in the environment (never printed) and `npx wrangler`. The seed goes to rate-seed/<set>.json in
eta-lab-ratings (a separate bucket from the vault; the viewer serves it only to the two raters, whitelisted fields only). Export writes, per rater,
<out>/<name>.json = {"<id>": <answer>} (label200/ba106: the label string; rate20: the answers object) plus the current history count, and never prints text."""
import argparse, hashlib, json, os, subprocess, sys, tempfile
from pathlib import Path

BUCKET = "eta-lab-ratings"
SETS = {"label200": ("rows", {"id", "n", "lang", "dur_s", "text"}, 200), "rate20": ("excerpts", {"id", "lines"}, 60),
        "ba106": ("rows", {"id", "n", "lang", "text_A", "text_B"}, 106),
        "pitch25": ("rows", {"id", "day", "reason", "link_status", "turns", "jev"}, 60)}


def check(set_, path):
    key, fields, cap = SETS[set_]
    d = json.load(open(path))
    rows = d[key] if isinstance(d, dict) else d
    if not isinstance(rows, list) or not 1 <= len(rows) <= cap:
        sys.exit(f"{path}: expected 1..{cap} rows under '{key}'")
    for r in rows:
        if not isinstance(r, dict) or set(r) != fields:
            sys.exit(f"row {r.get('id') if isinstance(r, dict) else r!r}: fields must be exactly {sorted(fields)} (the page never gets anything else)")
    if len({r["id"] for r in rows}) != len(rows):
        sys.exit("ids are not unique")
    return {key: rows}


def wrangler(*a, **kw):
    return subprocess.run(["npx", "wrangler", "r2", "object", *a, "--remote"], capture_output=True, text=True, cwd=Path(__file__).resolve().parents[1], **kw)


def label200_export(t):
    """421a/split-speaker #3218: the scorer reads the FLAT dict of the five keys ONLY.
    - a == one of the five -> flat[id] = a
    - a == "cant_judge"    -> ABSENT from flat (never a 6th value; the unknown_labels bucket is reserved for typos), sidecar skipped=true
    - old rows without mode (V's 11, 413d) -> sidecar mode="text"
    Returns (flat, sidecar); sidecar keys only ever the five + skipped + mode + gloss_open + tags."""
    KEYS = {"readable", "romanised_readable", "garbled", "wrong_language", "unsure"}
    TAGS = {"diff_lang_speakers", "code_mixed", "crosstalk", "non_clinical", "partly_readable", "med_terms_wrong", "audio_poor", "words_missing"}
    flat, side = {}, {}
    for i, v in t.items():
        a = v.get("a") if isinstance(v, dict) else v
        if a in KEYS:
            flat[i] = a
        elif a != "cant_judge":   # eta-refuter #3247: never drop a stray value silently - the scorer's unknown_labels bucket must stay reserved for real typos
            raise SystemExit(f"export refuses: {i} has a={a!r}, outside the five keys and cant_judge (fix the doc or the worker before exporting)")
        if isinstance(v, dict):
            side[i] = {"mode": v.get("mode") or "text", "gloss_open": v.get("g") is True,
                       "skipped": a == "cant_judge", "tags": [x for x in (v.get("tags") or []) if x in TAGS]}
    skipped = {i for i, r in side.items() if r["skipped"]}
    if (set(flat) & skipped) or (set(flat) | skipped) != set(t):   # split-speaker #3248(2): exact partition - no invisible loss, no contradiction
        raise SystemExit(f"export partition broken: overlap={sorted(set(flat) & skipped)[:3]} missing={sorted(set(t) - set(flat) - skipped)[:3]}")
    return flat, side


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["load", "export"]); ap.add_argument("--set", required=True, choices=list(SETS))
    ap.add_argument("--file"); ap.add_argument("--out"); ap.add_argument("--rater", action="append", default=[])
    ap.add_argument("--require-doc", action="store_true", help="export: a rater with no_doc (explicit not-found) exits 1 - use for the DONE run (eta-refuter #3257)")
    a = ap.parse_args()
    if a.cmd == "load":
        doc = check(a.set, os.path.expanduser(a.file))
        tgt = f"{BUCKET}/rate-seed/{a.set}.json"
        if wrangler("get", tgt, "--pipe").returncode == 0:
            sys.exit(f"{tgt} already exists: not replaced (labels are keyed to these ids; a new seed needs a new set name and a ruling)")
        with tempfile.NamedTemporaryFile("w", suffix=".json") as f:
            json.dump(doc, f); f.flush()
            r = wrangler("put", tgt, "--file", f.name, "--content-type", "application/json")
        print(json.dumps({"loaded": a.set, "rows": len(doc[SETS[a.set][0]]), "ok": r.returncode == 0}))
        sys.exit(r.returncode)
    run_export(a.set, a.rater, Path(os.path.expanduser(a.out)), require_doc=a.require_doc)


def atomic(p, text):
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(text); tmp.chmod(0o600); os.replace(tmp, p)


def run_export(set_name, rater_specs, out, require_doc=False):
    """Read->compute->write pipeline, injectable via the module-level wrangler() (eta-refuter-2 #3259: the read path MUST be tested)."""
    out.mkdir(parents=True, exist_ok=True, mode=0o700)
    prepared = []
    for spec in rater_specs:   # eta-refuter #3253(1): a failed READ is READ FAILED (exit 1) unless the object is explicitly not-found - never a silent "no answers"
        name, email = spec.split("=", 1)
        h = hashlib.sha256(email.strip().lower().encode()).hexdigest()[:16]
        r = wrangler("get", f"{BUCKET}/rate/{set_name}/{h}.json", "--pipe")
        if r.returncode != 0:
            if "does not exist" in (r.stdout + r.stderr):
                prepared.append((name, None, None, None)); continue
            sys.exit(f"READ FAILED for rater {name} ({set_name}/{h}): refusing to export (unmeasured is not absent)")
        d = json.loads(r.stdout)
        if set_name == "label200":   # 421a: flat dict of the five + sidecar - split-speaker #3218/#3248; computed for ALL raters BEFORE any write
            flat, side = label200_export(d["t"])
            prepared.append((name, d, flat, side))
            continue
        t = {i: (v["a"] if set_name == "ba106" else v) for i, v in d["t"].items()}
        prepared.append((name, d, t, None))
    for name, d, main_obj, side in prepared:      # split-speaker #3248(1): every rater computed BEFORE any write - a refusal leaves no partial pair
        if d is None:
            if require_doc:   # eta-refuter #3257 / split-speaker #3254: at DONE, a rater with no doc IS a failure
                sys.exit(f"EXPORT FAILED: rater {name} has no_doc but --require-doc was passed (a DONE rater must have a doc)")
            print(json.dumps({"rater": name, "state": "no_doc (explicit not-found)"})); continue
        fp = out / f"{name}.json"
        if side is not None:
            q = out / f"{name}.sidecar.json"
            atomic(fp, json.dumps(main_obj, sort_keys=True)); atomic(q, json.dumps(side, sort_keys=True))
            nskip = sum(1 for s_ in side.values() if s_["skipped"])
            print(json.dumps({"rater": name, "n_doc": len(side), "n_flat": len(main_obj), "n_skipped": nskip,
                              "mode_audio": sum(1 for s_ in side.values() if s_["mode"] == "audio"),
                              "mode_text_default": sum(1 for s_ in side.values() if s_["mode"] == "text"),
                              "updated": d.get("updated"), "file": str(fp), "sidecar": str(q),
                              "flat_sha": hashlib.sha256(fp.read_bytes()).hexdigest(),
                              "sidecar_sha": hashlib.sha256(q.read_bytes()).hexdigest()}))
        else:
            atomic(fp, json.dumps(main_obj, sort_keys=True))
            print(json.dumps({"rater": name, "answers": len(main_obj), "updated": d.get("updated"), "file": str(fp)}))


if __name__ == "__main__":
    main()
