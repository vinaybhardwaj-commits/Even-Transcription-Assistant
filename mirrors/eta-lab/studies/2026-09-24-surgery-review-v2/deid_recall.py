#!/usr/bin/env python3
"""deid_recall.py — measure de-id RECALL ON REAL TEXT, counts only (the number deid_eval.py cannot give: its 42 plants are invented).

Real clinic ASR text carries few identifiers, so a random sample finds almost none (fleet's 30 random real turns held 0). This draws a seeded,
stable-order sample ENRICHED for identifier cues, plus a no-cue baseline, for a human to label; then scores the labels.

  sample: deid_recall.py sample --raw RAW.json --deid DEID.json --seed 27 --n-cue 40 --n-caps 20 --n-base 20 --out-dir DIR
     RAW/DEID: a list of records {item, room, i, en} (linker's mt/translated.json + deid.json layout) or a consult {id, turns:[{i, en|text}]}.
     writes, all 0600 and refused inside a git work tree:  sample.json (turn keys + strata, NO text), sheet.txt (raw vs de-identified side by side,
     REAL TEXT, box only), labels_template.json (empty). stdout: counts only.
  score:  deid_recall.py score --sample DIR/sample.json --labels LABELS.json [--gate-max-missed 0]
     LABELS: {turn_key: {"present": {type: n}, "missed": {type: n}, "doctors_kept_ok": n, "doctors_removed_wrongly": n}}, filled by hand from sheet.txt.
     prints recall per type / stratum with a Wilson 95% interval, and the doctor counts. Exit 1 if total missed > --gate-max-missed; exit 2 if the labels
     do not cover exactly the sampled turns (nothing is silently skipped).

The cue detector (CUES, CAP_WORD, DIGIT_WORDS/SPOKEN_RUN) shares no code or word list with deid.py, so the sample is not circular; only the git-tree guard is
borrowed. LIMIT: a lowercase name ("tell ramesh") matches no cue and can only enter through the baseline stratum. No transcript text is ever printed.
"""
import argparse, json, math, os, random, re, sys

import deid

TYPES = ("name", "phone", "id", "address", "dob", "age", "email")
CUES = re.compile(r"(?i)\b(?:name|naam|hesaru|number|phone|mobile|contact|address|aadhaar|aadhar|uhid|mrn|email|mail id|dob|born|date of birth|"
                  r"years old|residing|lives? in|staying at|whatsapp)\b|\d{6,}|\d{4}\s?\d{4}\s?\d{4}")
# Spoken-number detector, written independently of deid.py (its own list, no import of its tokenizer) and deliberately LOOSER: any run of >= 5 digit words or
# digits (English, Hindi and Kannada Latin spellings, plus script digits) joined by spaces/commas/dashes counts as a cue. Over-sampling is harmless here.
DIGIT_WORDS = {"zero", "oh", "shunya", "sonne", "sunna", "sifar", "one", "ek", "ondu", "two", "do", "eradu", "three", "teen", "mooru", "moru", "four", "char", "chaar",
               "naalku", "nalku", "five", "paanch", "panch", "aidu", "six", "chhe", "chhah", "cheh", "chah", "aaru", "aru", "seven", "saat", "elu", "yelu", "eight", "aath",
               "aat", "entu", "nine", "nau", "ombattu", "ombhattu", "double", "triple"}
SPOKEN_RUN = re.compile(r"(?i)(?:(?:\b(?:" + "|".join(sorted(DIGIT_WORDS)) + r")\b|\d|[\u0966-\u096f\u0ce6-\u0cef])[\s,.\-]*){5,}")
NOT_PROPER = {"i", "dr", "ct", "mri", "ecg", "ot", "icu", "opd", "iv", "bp", "hiv", "ok", "okay", "yes", "no", "sir", "madam", "mr", "mrs", "ms", "the", "and"}
CAP_WORD = re.compile(r"[A-Z][a-z]{2,}")


def turn_key(item, room, i):
    return f"{item}#{room}#{i}"


def load_turns(path):
    """key -> text, from a record list or a consult dict. Keys are (item#room#i); duplicates are an error, not a silent overwrite."""
    with open(path) as fh:
        doc = json.load(fh)
    recs = doc["turns"] if isinstance(doc, dict) else doc
    item0 = doc.get("id", "") if isinstance(doc, dict) else ""
    out = {}
    for r in recs:
        text = r.get("en_deid") if "en_deid" in r else r.get("en", r.get("text", ""))
        k = turn_key(r.get("item", item0), r.get("room", ""), r["i"])
        if k in out:
            raise ValueError("duplicate turn key in input")
        out[k] = text or ""
    return out


def cue_kind(text):
    """'cue' if an identifier cue fires; 'caps' if only a mid-sentence capitalised word is present; else 'none'."""
    if CUES.search(text) or SPOKEN_RUN.search(text):
        return "cue"
    for m in CAP_WORD.finditer(text):
        before = text[:m.start()].rstrip()
        if before and before[-1] not in ".!?" and m.group().lower() not in NOT_PROPER:
            return "caps"
    return "none"


def wilson(k, n, z=1.96):
    """95% Wilson interval for a proportion k/n; (None, None) if n == 0."""
    if n == 0:
        return None, None
    p = k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return round((c - h) / d, 3), round((c + h) / d, 3)


def draw(raw, seed, n_cue, n_caps, n_base):
    """Stable order first (sorted keys), then a seeded draw per stratum: the same inputs and seed always give the same sample."""
    keys = sorted(raw)
    strata = {"cue": [], "caps": [], "baseline": []}
    for k in keys:
        strata[{"cue": "cue", "caps": "caps", "none": "baseline"}[cue_kind(raw[k])]].append(k)
    rng = random.Random(seed)
    picked = []
    for name, n in (("cue", n_cue), ("caps", n_caps), ("baseline", n_base)):
        pool = strata[name]
        picked += [(k, name) for k in rng.sample(pool, min(n, len(pool)))]
    return picked, {s: len(v) for s, v in strata.items()}


def _write_private(path, text):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write(text)


def cmd_sample(a):
    probe = os.path.abspath(a.out_dir)
    while not os.path.isdir(probe):  # git errors on a directory that does not exist yet, which would read as "not in git"
        probe = os.path.dirname(probe)
    if not a.allow_git and deid._inside_git(os.path.join(probe, "x")):
        sys.exit("refusing to write inside a git work tree: the review sheet holds real text")
    raw, dei = load_turns(a.raw), load_turns(a.deid)
    if set(raw) != set(dei):
        sys.exit(f"raw and de-identified inputs do not cover the same turns ({len(set(raw) ^ set(dei))} differ)")
    picked, pool = draw(raw, a.seed, a.n_cue, a.n_caps, a.n_base)
    os.makedirs(a.out_dir, mode=0o700, exist_ok=True)
    _write_private(os.path.join(a.out_dir, "sample.json"), json.dumps(
        {"seed": a.seed, "params": {"n_cue": a.n_cue, "n_caps": a.n_caps, "n_base": a.n_base}, "pool": pool,
         "turns": [{"key": k, "stratum": s} for k, s in picked]}, indent=1))
    _write_private(os.path.join(a.out_dir, "sheet.txt"), "\n\n".join(
        f"[{k}] stratum={s}\n  RAW : {raw[k]}\n  DEID: {dei[k]}" for k, s in picked) + "\n")
    _write_private(os.path.join(a.out_dir, "labels_template.json"), json.dumps(
        {k: {"present": {}, "missed": {}, "doctors_kept_ok": 0, "doctors_removed_wrongly": 0} for k, _ in picked}, indent=1))
    print(json.dumps({"pool": pool, "sampled": {s: sum(1 for _, x in picked if x == s) for s in pool}, "seed": a.seed}))


def cmd_score(a):
    with open(a.sample) as f1, open(a.labels) as f2:
        sample, labels = json.load(f1), json.load(f2)
    stratum = {t["key"]: t["stratum"] for t in sample["turns"]}
    if set(labels) != set(stratum):
        print(json.dumps({"error": "labels do not cover exactly the sampled turns", "missing": len(set(stratum) - set(labels)),
                          "unknown": len(set(labels) - set(stratum))}))
        sys.exit(2)
    per = {}  # (stratum, type) -> [present, missed]
    docs = {"kept_ok": 0, "removed_wrongly": 0}
    for k, lab in labels.items():
        for t, n in lab.get("present", {}).items():
            if t not in TYPES:
                print(json.dumps({"error": f"unknown identifier type {t!r}"})); sys.exit(2)
            miss = lab.get("missed", {}).get(t, 0)
            if miss > n or miss < 0 or n < 0:
                print(json.dumps({"error": "missed must be between 0 and present", "turn_type": [t]})); sys.exit(2)
            for s in (stratum[k], "ALL"):
                cell = per.setdefault((s, t), [0, 0]); cell[0] += n; cell[1] += miss
        for t in lab.get("missed", {}):
            if t not in lab.get("present", {}):
                print(json.dumps({"error": "a type is in missed but not in present"})); sys.exit(2)
        docs["kept_ok"] += lab.get("doctors_kept_ok", 0); docs["removed_wrongly"] += lab.get("doctors_removed_wrongly", 0)
    rows = {}
    for (s, t), (n, m) in sorted(per.items()):
        lo, hi = wilson(n - m, n)
        rows.setdefault(s, {})[t] = {"present": n, "missed": m, "recall": round((n - m) / n, 3), "ci95": [lo, hi]}
    tot_n = sum(c[0] for (s, _), c in per.items() if s == "ALL"); tot_m = sum(c[1] for (s, _), c in per.items() if s == "ALL")
    lo, hi = wilson(tot_n - tot_m, tot_n)
    out = {"turns_labelled": len(labels), "identifiers_present": tot_n, "missed": tot_m,
           "recall": round((tot_n - tot_m) / tot_n, 3) if tot_n else None, "ci95": [lo, hi], "doctors": docs, "by_stratum_type": rows,
           "caveats": ["lowercase names match no cue and are sampled only through the baseline stratum", "recall is over the labelled identifiers only; see ci95"]}
    print(json.dumps(out))
    if a.gate_max_missed is not None and tot_m > a.gate_max_missed:
        sys.exit(1)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("sample"); s.add_argument("--raw", required=True); s.add_argument("--deid", required=True)
    s.add_argument("--seed", type=int, required=True); s.add_argument("--n-cue", type=int, default=40); s.add_argument("--n-caps", type=int, default=20)
    s.add_argument("--n-base", type=int, default=20); s.add_argument("--out-dir", required=True); s.add_argument("--allow-git", action="store_true")
    c = sub.add_parser("score"); c.add_argument("--sample", required=True); c.add_argument("--labels", required=True)
    c.add_argument("--gate-max-missed", type=int, default=None)
    a = ap.parse_args(argv)
    {"sample": cmd_sample, "score": cmd_score}[a.cmd](a)


if __name__ == "__main__":
    main()
