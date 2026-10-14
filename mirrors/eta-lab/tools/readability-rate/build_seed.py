#!/usr/bin/env python3
"""Build the seed for the Transcript Readability page (ruling 337f): N random consult excerpts from the lab vault.

  python3 build_seed.py --vault ~/eta-data/lab-vault/staged --out ~/eta-data/readability-rate/seed1 \
      [--n 20] [--seed 337] [--dates 2026-09-22..2026-09-24] [--min-words 40] [--max-lines 14] [--min-indic 0]

Eligible windows: newest index/view-*.jsonl rows with status "text" in the date range whose record file
runs/... resolves under --roots (tried in order; default hist-mining, hist, lab-vault/staged) (a window with no local record file is counted and skipped, never guessed).
A record keeps its segments at the top level (`segments`) or under `payload.segments`. Refused segments
(`refused` true) are dropped: the reader collapses or greys them, they are not judged here. Each pick is a
random run of consecutive segments of 40..~150 words, at most --max-lines lines. Clock times are absolute IST
(window start + segment start_s); a window with no start in the index (bench parity clips) shows time from the start of
the recording and is marked t_relative in the key. English (`text_en`) is copied when a segment has it.

Docs written to <out>/seed_docs.json = {"excerpts": [{id, lines:[{t, lang, text, en?}]}]} and nothing else:
no room, window, run, engine or language-share field. <out>/key.json (0600) maps each id to its window
(room, date, window id, run key, dominant language, whether English is present); it is the private key
and stays on the box, never in git. Everything under <out> is mode 0700/0600."""
import argparse, datetime as dt, glob, json, os, random, re, stat, sys

INDIC = {"kn", "hi", "ta", "ml", "bn", "gu", "te", "mr", "pa", "or", "as", "ur"}


DEFAULT_ROOTS = ["~/eta-data/hist-mining", "~/eta-data/hist", "~/eta-data/lab-vault/staged"]


def resolve(roots, key):
    """An index key ("runs/<run_id>/<room>/<date>/<window>.json") resolved against the roots in order, as the viewer does."""
    for r in roots:
        p = os.path.join(r, key)
        if os.path.exists(p):
            return p
    return None


def load_rows(vault, d0, d1):
    files = sorted(glob.glob(os.path.join(vault, "index", "view-*.jsonl")))
    if not files:
        sys.exit("no index/view-*.jsonl under " + vault)
    rows = [json.loads(l) for l in open(files[-1]) if l.strip()]
    return files[-1], [r for r in rows if r.get("status") == "text" and d0 <= r["ist_date"] <= d1]


def segs_of(rec):
    s = rec.get("segments")
    if s is None:
        s = (rec.get("payload") or {}).get("segments")
    return s or []


def clock(start_iso, off):
    """Absolute IST clock when the window has a start; otherwise time from the start of the recording (00:00:00)."""
    base = dt.datetime.fromisoformat(start_iso) if start_iso else dt.datetime(2000, 1, 1)
    return (base + dt.timedelta(seconds=float(off or 0))).strftime("%H:%M:%S")


def words(s):
    return len(re.findall(r"\S+", s or ""))


def dominant(lines):
    n = {}
    for l in lines:
        n[l["lang"]] = n.get(l["lang"], 0) + len(l["text"])
    return max(n, key=n.get) if n else "und"


def pick_run(rng, segs, min_w, max_lines):
    """A random run of consecutive segments with min_w..150 words and <= max_lines lines, or None."""
    n = len(segs)
    starts = list(range(n))
    rng.shuffle(starts)
    for i in starts:
        run, w = [], 0
        for s in segs[i:i + max_lines]:
            run.append(s)
            w += words(s["text"])
            if w >= 150:
                break
        if w >= min_w and w <= 220:
            return run
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--vault", required=True)
    ap.add_argument("--roots", nargs="+", default=DEFAULT_ROOTS, help="record roots, tried in order (default: hist-mining, hist, lab-vault/staged)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--n", type=int, default=20)
    ap.add_argument("--seed", type=int, default=337)
    ap.add_argument("--dates", default="2026-09-22..2026-09-24")
    ap.add_argument("--min-words", type=int, default=40)
    ap.add_argument("--max-lines", type=int, default=14)
    ap.add_argument("--min-indic", type=int, default=0, help="guarantee at least this many mostly-Indic excerpts (most of the text in an Indic language)")
    a = ap.parse_args()
    d0, d1 = a.dates.split("..")
    idx, rows = load_rows(a.vault, d0, d1)
    roots = [os.path.expanduser(x) for x in a.roots]
    rng = random.Random(a.seed)
    cand, missing = [], 0
    for r in rows:
        p = resolve(roots, r["key"])
        if not p:
            missing += 1
            continue
        rec = json.load(open(p))
        segs = [s for s in segs_of(rec) if not s.get("refused") and (s.get("text") or "").strip()]
        if segs:
            cand.append((r, rec, segs))
    print(f"index {os.path.basename(idx)}: {len(rows)} text windows in {a.dates}; record file present {len(cand)}, missing {missing}")
    if len(cand) < a.n:
        sys.exit(f"only {len(cand)} windows with a local record; need {a.n}. Check --roots.")
    rng.shuffle(cand)
    picks, used = [], set()
    def try_add(item, need_indic=False):
        r, rec, segs = item
        if r["key"] in used:
            return False
        run = pick_run(rng, segs, a.min_words, a.max_lines)
        if not run:
            return False
        if need_indic and dominant([{"lang": s.get("lang") or "und", "text": s["text"]} for s in run]) not in INDIC:
            return False
        picks.append((r, run))
        used.add(r["key"])
        return True
    if a.min_indic:
        for item in cand:
            if sum(dominant([{"lang": s.get("lang") or "und", "text": s["text"]} for s in run]) in INDIC for _, run in picks) >= a.min_indic:
                break
            try_add(item, True)
    for item in cand:
        if len(picks) >= a.n:
            break
        try_add(item)
    if len(picks) < a.n:
        sys.exit(f"could only build {len(picks)} excerpts")
    rng.shuffle(picks)
    docs, key = [], {}
    for i, (r, run) in enumerate(picks, 1):
        eid = f"R{i:02d}"
        lines = []
        for s in run:
            ln = {"t": clock(r["start"], s.get("start_s")), "lang": s.get("lang") or "und", "text": s["text"].strip()}
            if (s.get("text_en") or "").strip():
                ln["en"] = s["text_en"].strip()
            lines.append(ln)
        docs.append({"id": eid, "lines": lines})
        key[eid] = {"room": r.get("room_name"), "date": r["ist_date"], "window_id": r["window_id"], "run_key": r["key"],
                    "producer": r.get("producer"), "t_relative": not r.get("start"), "window_lang": r.get("lang"),
                    "langs": sorted({l["lang"] for l in lines}), "dominant": dominant(lines), "indic": dominant(lines) in INDIC, "any_indic": any(l["lang"] in INDIC for l in lines),
                    "has_en": any(l.get("en") for l in lines), "n_lines": len(lines), "n_words": sum(words(l["text"]) for l in lines)}
    os.makedirs(a.out, mode=0o700, exist_ok=True)
    os.chmod(a.out, 0o700)
    for name, obj in (("seed_docs.json", {"excerpts": docs}), ("key.json", key)):
        p = os.path.join(a.out, name)
        with open(p, "w") as f:
            json.dump(obj, f, ensure_ascii=False, indent=1)
        os.chmod(p, stat.S_IRUSR | stat.S_IWUSR)
    ind = sum(k["indic"] for k in key.values()); en = sum(k["has_en"] for k in key.values())
    print(f"wrote {len(docs)} excerpts to {a.out}: {ind} mostly Indic ({sum(k['any_indic'] for k in key.values())} with any Indic line), {en} with English text_en; lines {sum(k['n_lines'] for k in key.values())}")


if __name__ == "__main__":
    main()
