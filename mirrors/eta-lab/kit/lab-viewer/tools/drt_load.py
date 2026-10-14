#!/usr/bin/env python3
"""Sha-checked load of one day's DRT doc into eta-lab-ratings as drt/<date>.json (the only key the Worker reads).

  drt_load.py --date 2026-09-29 --dir ~/eta-data/drtpqma/2026-09-29 \
      --drt-sha 2c914346 --enc-sha 36031fb0 --tapes-sha 4bd5103e0113 [--expect-placed 82 --expect-gaps 157] [--apply [--replace]]

Default is a DRY RUN: every check runs, nothing is written, nothing needs a token. Output is keys, shas and counts only - never row content.
Refuses (exit 1) when: a file's sha256 does not start with the given prefix; the doc's built_from.tapes_index_sha or R3/W51 union sha
disagree; the doc fails the same shape checks worker/drt.js applies; an encounter sits on a blind room-day with audio or a non-held source;
an audio key is outside tapes/; counts disagree with encounters.json or --expect-*.
--apply also needs CLOUDFLARE_API_TOKEN (env, or ~/.claude/secrets/cloudflare_api_token); it will not replace an existing object unless
--replace, which archives the old copy under drt-history/<date>/<ts>.json first, and it reads the object back and compares sha256.
encounters.json is verified but NOT uploaded (no route reads it)."""
import argparse, hashlib, json, os, re, subprocess, sys, tempfile, time
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from reb_timeline_seed import load_heldout   # noqa: E402  fail-closed R3/W51 guard

BUCKET = "eta-lab-ratings"
CWD = Path(__file__).resolve().parents[1]
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_~-]{0,63}$")
KEY_RE = re.compile(r"^tapes/[A-Za-z0-9][A-Za-z0-9._/-]{0,300}$")
UNION16 = "f07171dcb708d080"
SOURCES = {"voice", "schedule", "schedule+voice", "held_out"}
IST = timezone(timedelta(hours=5, minutes=30))


def die(msg):
    print("REFUSE:", msg, file=sys.stderr)
    sys.exit(1)


def sha(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def check_sha(name, path, prefix):
    h = sha(path)
    if not re.fullmatch(r"[0-9a-f]{6,64}", prefix) or not h.startswith(prefix):
        die(f"{name} sha256 {h[:12]} does not start with {prefix}")
    print(f"ok  {name:15s} sha256 {h[:16]} (want {prefix})")
    return h


def ist_day(iso):
    try:
        return datetime.fromisoformat(iso).astimezone(IST).strftime("%Y-%m-%d")
    except (TypeError, ValueError):
        return None


def validate(d, enc, date, tapes_sha, expect_placed, expect_gaps):
    if not isinstance(d, dict) or d.get("date") != date or not isinstance(d.get("rooms"), list) or not isinstance(d.get("encounters"), list):
        die("drt.json shape (date/rooms/encounters) wrong")
    rooms = set()
    for r in d["rooms"]:
        if not isinstance(r, dict) or not isinstance(r.get("room_id"), str) or not ID_RE.match(r["room_id"]) or r["room_id"] in rooms:
            die("bad or duplicate room entry")
        rooms.add(r["room_id"])
    bf = d.get("built_from") or {}
    if bf.get("tapes_index_sha") != tapes_sha[:12]:
        die(f"built_from.tapes_index_sha {bf.get('tapes_index_sha')} != tapes {tapes_sha[:12]}")
    if bf.get("r3w51_union_sha16") != UNION16:
        die(f"built_from.r3w51_union_sha16 {bf.get('r3w51_union_sha16')} != {UNION16}")
    is_held = load_heldout()
    ids, n_audio, n_held = set(), 0, 0
    for e in d["encounters"]:
        if not isinstance(e, dict) or not isinstance(e.get("id"), str) or not ID_RE.match(e["id"]) or e["id"] in ids:
            die("bad or duplicate encounter id")
        ids.add(e["id"])
        if e.get("room_id") not in rooms:
            die("encounter room_id not in rooms")
        if ist_day(e.get("start")) != date or ist_day(e.get("end")) != date or not e["end"] > e["start"]:
            die("encounter start/end not on the IST day, or end<=start")
        held = e.get("room_source") == "held_out" or is_held(date, e["room_id"])
        if e.get("room_source") not in SOURCES:
            die("encounter room_source not in the Worker's set")
        if is_held(date, e["room_id"]) and (e.get("audio") or e.get("room_source") != "held_out"):
            die("blind room-day encounter carries audio or a non-held source")
        n_held += bool(held)
        for a in e.get("audio") or []:
            k = a.get("key") if isinstance(a, dict) else None
            if not isinstance(k, str) or not KEY_RE.match(k) or ".." in k or "//" in k:
                die("audio key outside tapes/ or malformed")
            if held:
                die("held-out encounter has audio")
            if not (isinstance(a.get("offset_s"), (int, float)) and isinstance(a.get("dur_s"), (int, float)) and a["offset_s"] >= 0 and a["dur_s"] > 0):
                die("audio offset/dur invalid")
            n_audio += 1
    gaps = d.get("gaps") or []
    for g in gaps:
        if not isinstance(g, dict) or not isinstance(g.get("id"), str) or not ID_RE.match(g["id"]):
            die("bad gap id")
    n_enc, n_gap = len(d["encounters"]), len(gaps)
    if isinstance(enc, dict):
        c = enc.get("counts") or {}
        total = len(enc.get("encounters") or [])
        if c.get("encounters") != total or total != n_enc + n_gap:
            die(f"encounters.json counts ({c.get('encounters')}/{total}) disagree with drt.json ({n_enc} placed, {n_gap} gaps)")
    if expect_placed is not None and n_enc != expect_placed:
        die(f"placed {n_enc} != expected {expect_placed}")
    if expect_gaps is not None and n_gap != expect_gaps:
        die(f"gaps {n_gap} != expected {expect_gaps}")
    by = {}
    for g in gaps:
        by[g.get("reason")] = by.get(g.get("reason"), 0) + 1
    print(f"ok  shape: {len(rooms)} rooms, {n_enc} placed ({n_audio} audio pieces, {n_held} held), {n_gap} gaps {dict(sorted(by.items(), key=str))}")


def token_env():
    t = os.environ.get("CLOUDFLARE_API_TOKEN")
    if not t:
        p = Path.home() / ".claude" / "secrets" / "cloudflare_api_token"
        if not p.exists():
            die("--apply needs CLOUDFLARE_API_TOKEN (env) or ~/.claude/secrets/cloudflare_api_token")
        t = p.read_text().strip()
    return {**os.environ, "CLOUDFLARE_API_TOKEN": t}


def wr(args, env, **kw):
    return subprocess.run(["npx", "wrangler", "r2", "object", *args, "--remote"], capture_output=True, text=True, cwd=CWD, env=env, **kw)


def get_bytes(key, env):
    r = subprocess.run(["npx", "wrangler", "r2", "object", "get", f"{BUCKET}/{key}", "--pipe", "--remote"], capture_output=True, cwd=CWD, env=env)
    if r.returncode == 0:
        return r.stdout
    if b"does not exist" in (r.stderr or b""):
        return None
    die(f"cannot tell whether {key} exists (wrangler error, not a clean not-found): {r.stderr[:200]!r}")


def put(key, path, env):
    r = wr(["put", f"{BUCKET}/{key}", "--file", str(path), "--content-type", "application/json"], env)
    if r.returncode:
        die(f"put {key} failed")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--date", required=True)
    ap.add_argument("--dir", required=True)
    ap.add_argument("--drt-sha", required=True)
    ap.add_argument("--enc-sha", required=True)
    ap.add_argument("--tapes-sha", required=True)
    ap.add_argument("--expect-placed", type=int)
    ap.add_argument("--expect-gaps", type=int)
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--replace", action="store_true")
    a = ap.parse_args()
    if not DATE_RE.match(a.date):
        die("bad --date")
    base = Path(a.dir)
    drt_p, enc_p, tap_p = base / "drt.json", base / "encounters.json", base / "tapes.json"
    drt_h = check_sha("drt.json", drt_p, a.drt_sha)
    check_sha("encounters.json", enc_p, a.enc_sha)
    tap_h = check_sha("tapes.json", tap_p, a.tapes_sha)
    raw = drt_p.read_bytes()
    try:
        d, enc = json.loads(raw), json.loads(enc_p.read_bytes())
    except ValueError:
        die("json parse failed")
    validate(d, enc, a.date, tap_h, a.expect_placed, a.expect_gaps)
    key = f"drt/{a.date}.json"
    print(f"{'APPLY' if a.apply else 'DRY-RUN'} would put {BUCKET}/{key}  sha256 {drt_h[:16]}  {len(raw)} bytes")
    if not a.apply:
        print("dry run: nothing written")
        return
    env = token_env()
    old = get_bytes(key, env)
    if old is not None:
        print(f"existing {key} sha256 {hashlib.sha256(old).hexdigest()[:16]}")
        if hashlib.sha256(old).digest() == hashlib.sha256(raw).digest():
            print("already identical: nothing to do")
            return
        if not a.replace:
            die(f"{key} exists with different content; --replace archives it under drt-history/{a.date}/ and overwrites")
        with tempfile.NamedTemporaryFile(suffix=".json") as t:
            t.write(old); t.flush()
            hk = f"drt-history/{a.date}/{int(time.time())}.json"
            put(hk, t.name, env)
            if hashlib.sha256(get_bytes(hk, env) or b"").digest() != hashlib.sha256(old).digest():
                die(f"archive {hk} read-back mismatch; live object untouched")
            print(f"archived old -> {hk}")
    put(key, drt_p, env)
    back = get_bytes(key, env)
    if back is None or hashlib.sha256(back).hexdigest() != drt_h:
        die(f"READ-BACK MISMATCH on {key}")
    print(f"put {key}  read-back sha256 {drt_h[:16]} OK")


if __name__ == "__main__":
    main()
