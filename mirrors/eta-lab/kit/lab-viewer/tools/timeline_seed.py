#!/usr/bin/env python3
"""W49 Room Timeline: build / load the per-room-day timeline/<room>/<date>.json files (private eta-lab-ratings bucket).

  timeline_seed.py build --jevloop-dir <lx: dir of <room>/<date>.json, only `detected.jev_loop` used>
                          --acoustics-file <acoustics: their own missed_speech_spans.json shape>
                          --acoustics-room <box label>=<vault room_id> [--acoustics-room ...]   # e.g. OPD1=room_xxxxxxxx
                          --pqm-dir <linker/cap: dir of <room>/<date>.json, only pqm_truth used>
                          --cap-dir <cap: dir of <room>/<date>.json, only cap_links used>
                          --fleet-dir <fleet: dir of <room>/<date>.json, only fleet used>
                          --out <dir>
    Merges whichever inputs are given (any may be omitted) into <out>/timeline/<room>/<date>.json per TIMELINE-SHAPES.md.
    Each owner writes to THEIR OWN directory (never the same box path another owner also writes to - that would silently
    clobber); this script does the merging, so nobody's script needs to know about anybody else's.
  timeline_seed.py load --dir <dir with timeline/<room>/<date>.json files> [--resume]
    Puts each object; refuses to replace an existing one (add --resume to skip ones already there after a partial failure).

No patient/doctor/drug/diagnosis text ever passes through this script; it prints no row contents, only counts."""
import argparse, hashlib, json, os, re, subprocess, sys, time
from datetime import datetime, timezone
from pathlib import Path

BUCKET = "eta-lab-ratings"
ROOM_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
CWD = Path(__file__).resolve().parents[1]


def private_file(p):
    """PHI-adjacent on a box with a second account: every file 0600, every dir 0700, whatever the umask."""
    os.chmod(p, 0o600)


def iso_ms(s):
    """An ISO-8601 timestamp WITH an explicit offset -> epoch ms. Refuses a naive (offset-less) timestamp: ambiguous is worse than absent."""
    if not isinstance(s, str) or not re.search(r"(Z|[+-]\d{2}:?\d{2})$", s):
        return None
    try:
        return int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return None


def each_room_date_file(d):
    if not d:
        return
    for room_dir in sorted(Path(d).glob("*")):
        if not room_dir.is_dir() or not ROOM_RE.match(room_dir.name):
            continue
        for f in sorted(room_dir.glob("*.json")):
            if DATE_RE.match(f.stem):
                yield room_dir.name, f.stem, f


def load_json(p):
    try:
        return json.loads(Path(p).read_text())
    except (OSError, json.JSONDecodeError):
        return None


def merge_acoustics(acoustics_file, room_map):
    """acoustics' own per-chunk shape (`{"windows": [...]}`, one row per 5-min tape chunk) -> {(room_id, date): {missed_speech_pct, missed:[{start_ms,end_ms}]}}.
    A chunk's own `room_id` (already a vault id, e.g. room_yh3etjpf) is used directly when present and valid; otherwise a
    `room`/`room_label` name is looked up in --acoustics-room, and skipped (not guessed) if absent there. The date and the
    missed/reference totals come from the chunk's OWN fields (`started_at`, `missed_speech_s`, `reference_speech_s`) - never
    re-derived from reference_speech_spans, which is legitimately empty on a silent chunk (that chunk still has a date)."""
    out = {}
    if not acoustics_file:
        return out
    doc = load_json(acoustics_file)
    if not isinstance(doc, dict):
        sys.exit(f"acoustics file unreadable: {acoustics_file}")
    chunks = doc.get("windows") if isinstance(doc.get("windows"), list) else (doc.get("chunks") if isinstance(doc.get("chunks"), list) else (doc if isinstance(doc, list) else []))
    for c in chunks:
        rid = c.get("room_id")
        room_id = rid if isinstance(rid, str) and ROOM_RE.match(rid) else room_map.get(c.get("room") or c.get("room_label"))
        if not room_id:
            continue
        d0 = iso_ms(c.get("started_at"))
        date = datetime.fromtimestamp(d0 / 1000, tz=timezone.utc).astimezone(_IST).strftime("%Y-%m-%d") if d0 is not None else None
        if not date:
            continue
        spans = []
        for m in c.get("missed_speech_spans") or []:
            s0, s1 = iso_ms(m.get("start_at")), iso_ms(m.get("end_at"))
            if s0 is None or s1 is None or s1 <= s0:
                continue
            spans.append({"start_ms": s0, "end_ms": s1})
        miss_s = c["missed_speech_s"] if isinstance(c.get("missed_speech_s"), (int, float)) else sum((s["end_ms"] - s["start_ms"]) / 1000 for s in spans)
        ref_s = c["reference_speech_s"] if isinstance(c.get("reference_speech_s"), (int, float)) else sum(max(0, (iso_ms(s.get("end_at")) or 0) - (iso_ms(s.get("start_at")) or 0)) / 1000 for s in (c.get("reference_speech_spans") or []))
        k = (room_id, date)
        agg = out.setdefault(k, {"missed_s": 0, "ref_s": 0, "missed": []})
        agg["missed_s"] += miss_s
        agg["ref_s"] += ref_s
        agg["missed"].extend(spans)
    result = {}
    for k, agg in out.items():
        pct = round(100 * agg["missed_s"] / agg["ref_s"], 1) if agg["ref_s"] else None
        result[k] = {"missed_speech_pct": pct, "missed": agg["missed"][:500]}
    return result


from datetime import timedelta
_IST = timezone(timedelta(hours=5, minutes=30))


def build(args):
    os.umask(0o077)
    merged = {}   # (room, date) -> dict
    for room, date, f in each_room_date_file(args.jevloop_dir):
        d = load_json(f)
        if isinstance(d, dict) and isinstance(d.get("detected"), dict):
            merged.setdefault((room, date), {})["detected"] = d["detected"]
    room_map = dict(x.split("=", 1) for x in (args.acoustics_room or []))
    for (room, date), ac in merge_acoustics(args.acoustics_file, room_map).items():
        merged.setdefault((room, date), {})["acoustics"] = ac
    for label, key in (("pqm_dir", "pqm_truth"), ("cap_dir", "cap_links"), ("fleet_dir", "fleet")):
        for room, date, f in each_room_date_file(getattr(args, label)):
            d = load_json(f)
            if isinstance(d, dict) and key in d:
                merged.setdefault((room, date), {})[key] = d[key]
    if not merged:
        sys.exit("nothing to merge: give at least one of --jevloop-dir --acoustics-file --pqm-dir --cap-dir --fleet-dir")
    out = Path(args.out); out.mkdir(parents=True, exist_ok=True); out.chmod(0o700)
    n = 0
    for (room, date), doc in merged.items():
        if not ROOM_RE.match(room) or not DATE_RE.match(date):
            continue
        doc = {"schema": 1, "room_id": room, "date": date, "source_sha256": hashlib.sha256(json.dumps(doc, sort_keys=True).encode()).hexdigest(), **doc}
        d = out / "timeline" / room; d.mkdir(parents=True, exist_ok=True); d.chmod(0o700)
        p = d / f"{date}.json"; p.write_text(json.dumps(doc, ensure_ascii=False)); private_file(p)
        n += 1
    print(f"built {n} room-day timeline files under {out / 'timeline'}")


def put(key, path):
    r = subprocess.run(["npx", "wrangler", "r2", "object", "put", f"{BUCKET}/{key}", "--file", str(path), "--content-type", "application/json", "--remote"], capture_output=True, text=True, cwd=CWD)
    if r.returncode:
        sys.exit(f"FAILED put {key}")


def exists(key):
    """refuter-2 #4599 L5: a transient wrangler error is NOT the same as "not found" - treating it as absent risked put() overwriting
    a real object after a flaky check. Only wrangler's own "key does not exist" message counts as absent; anything else is a hard error."""
    r = subprocess.run(["npx", "wrangler", "r2", "object", "get", f"{BUCKET}/{key}", "--pipe", "--remote"], capture_output=True, text=True, cwd=CWD)
    if r.returncode == 0:
        return True
    if "does not exist" in (r.stderr or ""):
        return False
    sys.exit(f"cannot tell whether {key} exists (wrangler error, not a clean not-found - refusing to guess): {(r.stderr or '')[:300]}")


def load(args):
    root = Path(args.dir) / "timeline"
    files = [(room, date, f) for room, date, f in each_room_date_file(root)]
    if not files:
        sys.exit(f"no timeline/<room>/<date>.json files under {root}")
    n = skipped = replaced = 0
    for room, date, f in files:
        key = f"timeline/{room}/{date}.json"
        if exists(key):
            if args.resume:
                skipped += 1
                continue
            if args.replace:
                # a data correction, not a routine load: the old object is archived first (and the archive read back) or nothing is overwritten
                old = subprocess.run(["npx", "wrangler", "r2", "object", "get", f"{BUCKET}/{key}", "--pipe", "--remote"], capture_output=True, cwd=CWD)
                if old.returncode != 0 or not old.stdout:
                    sys.exit(f"cannot read the live {key} to archive it (rc {old.returncode}); refusing to overwrite without a copy")
                old_sha = hashlib.sha256(old.stdout).hexdigest()
                side = f.with_suffix(".livesha")
                if side.exists() and side.read_text().strip() != old_sha:
                    sys.exit(f"{key} changed in R2 since it was read for this merge (another writer): refusing to overwrite; redo the merge")
                import tempfile
                hk = f"timeline-history/{room}/{date}/{int(time.time())}.json"
                with tempfile.NamedTemporaryFile(suffix=".json") as t:
                    t.write(old.stdout); t.flush()
                    put(hk, Path(t.name))
                back = subprocess.run(["npx", "wrangler", "r2", "object", "get", f"{BUCKET}/{hk}", "--pipe", "--remote"], capture_output=True, cwd=CWD)
                if back.returncode != 0 or hashlib.sha256(back.stdout).hexdigest() != old_sha:
                    sys.exit(f"archive {hk} did not read back identical; live {key} untouched")
                put(key, f)
                replaced += 1
                continue
            sys.exit(f"{key} already exists: refusing to replace it (--resume to skip, or --replace to archive the old copy under timeline-history/ and overwrite - a real data correction, not a routine reload)")
        put(key, f)
        n += 1
    print(f"put {n} new, {replaced} replaced (old archived under timeline-history/), skipped {skipped} already present")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build")
    b.add_argument("--jevloop-dir"); b.add_argument("--acoustics-file"); b.add_argument("--acoustics-room", action="append")
    b.add_argument("--pqm-dir"); b.add_argument("--cap-dir"); b.add_argument("--fleet-dir"); b.add_argument("--out", required=True)
    l = sub.add_parser("load"); l.add_argument("--dir", required=True); l.add_argument("--resume", action="store_true"); l.add_argument("--replace", action="store_true")
    a = ap.parse_args()
    (build if a.cmd == "build" else load)(a)
