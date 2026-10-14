#!/usr/bin/env python3
"""6V: build / load the per-room-day consult document consults/<room>/<date>.json (private eta-lab-ratings bucket) that the viewer's
room timeline draws its consult bands from. Source: the CONSULT cutter's per-consult index (box ~/eta-data/consult/clips/index.jsonl),
LATEST row per consult_uid (the cutter re-writes a row each time it revisits a consult).

  consults_seed.py build --out <dir> [--index <path>] [--since YYYY-MM-DD] [--heldout <path>]
      writes <out>/consults/<room>/<date>.json. Blind room-days (R3/W51 heldout predicate, fail-closed) are NEVER written;
      a consult whose span touches a blind day is dropped too. Prints counts only.
  consults_seed.py load --dir <dir>
      puts each file to eta-lab-ratings consults/<room>/<date>.json, replacing the previous copy (derived data, rebuilt from the cutter
      index each time, so there is no archive). Each object is read back and compared before the next one.

The doc holds: id, doctor (display name), s/e (epoch ms, from span_start/span_end, which the cutter writes in IST wall time), minutes,
quality, close_reason, status, skip_kind (a short category, never the raw error text: those carry box paths), the clip prefix in eta-audio
(read only by the Worker, never sent to the browser) and the byte sizes of consult.flac / doctor.flac. No transcript text, no patient data."""
import argparse, datetime, hashlib, importlib.util, json, os, re, subprocess, sys
from pathlib import Path

BUCKET = "eta-lab-ratings"
INDEX = os.path.expanduser("~/eta-data/consult/clips/index.jsonl")
HELDOUT_PY = os.path.expanduser("~/eta-data/drtpqma/heldout.py")
IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
ROOM_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
ID_RE = re.compile(r"^[A-Za-z0-9_-]{6,64}$")
PREFIX_RE = re.compile(r"^consult-clips/\d{4}-\d{2}-\d{2}/[A-Za-z0-9_-]{1,64}/[A-Za-z0-9_-]{1,64}$")
CWD = Path(__file__).resolve().parents[1]


def load_heldout(path=HELDOUT_PY):
    """(is_held_out(day, room_id) -> bool). FAIL-CLOSED, same contract as reb_timeline_seed.load_heldout."""
    try:
        spec = importlib.util.spec_from_file_location("heldout", path)
        mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
        union, _sha = mod.load_union()
    except Exception as e:   # noqa: BLE001 - any failure to establish the guard is fatal
        sys.exit(f"R3/W51 guard unavailable ({type(e).__name__}); refusing to build consult docs unguarded")
    return lambda day, room_id: mod.is_held_out(union, day, room_id)


def ist_ms(s):
    """'2026-10-07 17:07:19.995' (IST wall time, no offset) -> epoch ms; None when it does not parse."""
    try:
        d = datetime.datetime.strptime(str(s)[:23].strip(), "%Y-%m-%d %H:%M:%S.%f" if "." in str(s) else "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return None
    return int(d.replace(tzinfo=IST).timestamp() * 1000)


def skip_kind(row):
    """Short category from the cutter's free-text reason. Raw error text (it names box paths) never goes into the doc."""
    st, why = row.get("status"), str(row.get("skip_reason") or "")
    if st == "deferred_long":
        return "too_long"
    if st == "error":
        return "cut_failed"
    if st == "skipped":
        if why.startswith("final after 24 h"):
            return "final_no_session"
        if why == "no_session":
            return "no_session"
        if why == "silent_audio":
            return "silent_audio"
        return "cut_failed"
    return None


def latest_rows(path):
    """consult_uid -> its newest row (by cut_at / computed_at, then file order)."""
    best = {}
    with open(path) as f:
        for n, line in enumerate(f):
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except ValueError:
                continue
            uid = r.get("consult_uid")
            if not isinstance(uid, str) or not ID_RE.match(uid):
                continue
            key = (str(r.get("cut_at") or r.get("computed_at") or ""), n)
            if uid not in best or key >= best[uid][0]:
                best[uid] = (key, r)
    return [r for _k, r in best.values()]


def consult_entry(r):
    s, e = ist_ms(r.get("span_start") or r.get("t_open")), ist_ms(r.get("span_end") or r.get("t_close"))
    if s is None or e is None or e <= s:
        return None
    r2 = r.get("r2") if isinstance(r.get("r2"), dict) else {}
    prefix = r2.get("prefix") if r2.get("status") in ("mirrored", "cut") and isinstance(r2.get("prefix"), str) and PREFIX_RE.match(r2["prefix"]) else None
    by = r.get("bytes") if isinstance(r.get("bytes"), dict) else {}
    return {"id": r["consult_uid"], "doctor": str(r.get("doctor_name") or "")[:80], "s": s, "e": e,
            "minutes": round(float(r["minutes"]), 1) if isinstance(r.get("minutes"), (int, float)) else round((e - s) / 60000, 1),
            "quality": str(r.get("quality") or "")[:24], "close_reason": str(r.get("close_reason") or "")[:24], "status": r.get("status"),
            "skip_kind": skip_kind(r), "prefix": prefix, "bytes": {"consult": int(by.get("consult.flac") or 0), "doctor": int(by.get("doctor.flac") or 0)}}


def build(args):
    is_held = load_heldout(args.heldout) if args.heldout else load_heldout()
    days = {}
    held = total = 0
    for r in latest_rows(args.index):
        room, date = r.get("room_id"), r.get("ist_date")
        if not (isinstance(room, str) and ROOM_RE.match(room) and isinstance(date, str) and DATE_RE.match(date)):
            continue
        if args.since and date < args.since:
            continue
        c = consult_entry(r)
        if c is None:
            continue
        total += 1
        end_day = datetime.datetime.fromtimestamp((c["e"] - 1000) / 1000, IST).strftime("%Y-%m-%d")
        if is_held(date, room) or is_held(end_day, room):
            held += 1
            continue
        days.setdefault((room, date), []).append(c)
    out = Path(args.out)
    for (room, date), cs in sorted(days.items()):
        cs.sort(key=lambda c: c["s"])
        d = out / "consults" / room; d.mkdir(parents=True, exist_ok=True); d.chmod(0o700)
        p = d / f"{date}.json"
        p.write_text(json.dumps({"schema": "eta-consults/1", "room_id": room, "ist_date": date, "consults": cs}, ensure_ascii=False)); p.chmod(0o600)
    print(f"built {len(days)} room-day consult files ({sum(len(v) for v in days.values())} consults) under {out / 'consults'}; {held} of {total} withheld as blind")


def put(key, path):
    r = subprocess.run(["npx", "wrangler", "r2", "object", "put", f"{BUCKET}/{key}", "--file", str(path), "--content-type", "application/json", "--remote"], capture_output=True, text=True, cwd=CWD)
    if r.returncode:
        sys.exit(f"FAILED put {key}")


def get(key):
    return subprocess.run(["npx", "wrangler", "r2", "object", "get", f"{BUCKET}/{key}", "--pipe", "--remote"], capture_output=True, cwd=CWD)


def load(args):
    files = sorted((Path(args.dir) / "consults").glob("*/*.json"))
    if not files:
        sys.exit(f"no consults/<room>/<date>.json files under {args.dir}")
    n = 0
    for f in files:
        room, date = f.parent.name, f.stem
        if not (ROOM_RE.match(room) and DATE_RE.match(date)):
            sys.exit(f"unexpected file {f}: refusing")
        key = f"consults/{room}/{date}.json"
        want = hashlib.sha256(f.read_bytes()).hexdigest()
        put(key, f)
        back = get(key)
        if back.returncode != 0 or hashlib.sha256(back.stdout).hexdigest() != want:
            sys.exit(f"{key} did not read back identical; stopping")
        n += 1
    print(f"put {n} consult files (replacing any earlier copy)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build"); b.add_argument("--out", required=True); b.add_argument("--index", default=INDEX); b.add_argument("--since"); b.add_argument("--heldout")
    l = sub.add_parser("load"); l.add_argument("--dir", required=True)
    a = ap.parse_args()
    (build if a.cmd == "build" else load)(a)
