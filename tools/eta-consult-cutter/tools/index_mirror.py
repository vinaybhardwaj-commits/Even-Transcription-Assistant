#!/usr/bin/env python3
"""index-mirror/01: mirror the cutter clip index to R2 for scribe_sarvam (spec = bus #10413, ORDERS-index-mirror-1).
Reads clips/index.jsonl, keeps the LATEST row per consult_uid (file order = append order = cut_at order), and of those only status=cut AND r2.status=mirrored (the audio key exists),
minus the held-out (ist_date, room_id) pairs of lib/rubrics/blind-room-days.ts (read from a box config file, never hard-coded). Each kept row is projected through an ALLOWLIST (spec item 4);
doctor_name, path and every other key are dropped; r2 keeps bucket, prefix, files, at only.
Output (bucket eta-lab-results): consult/index/latest.jsonl (one line per consult_uid, sorted, one PUT) then consult/index/manifest.json {generated_at, rows, sha256, code_commit} (one PUT, written second).
  python3 tools/index_mirror.py --dry-run DIR     writes both files under DIR/consult/index/, prints counts; reads no credential, makes no network call
  python3 tools/index_mirror.py --live            the two PUTs (NOT enabled by any unit or timer; an Opus refuter runs first)
Exit: 0 ok, 2 bad config / unreadable input / unknown code_commit, 5 room_slug matches a doctor_name token (counts only), 6 the leak guard fired (nothing written, nothing shown), 3 zero rows (refused: a full rewrite with no rows would blank the reader; --allow-empty overrides), 4 an upload failed (manifest is then not written)."""
import argparse, datetime as dt, hashlib, importlib.util, json, os, re, subprocess, sys, unicodedata
H = os.path.expanduser("~"); E = f"{H}/eta-data"
INDEX = f"{E}/consult/clips/index.jsonl"
BLIND_FILE = f"{E}/consult/index-mirror-blind.json"            # {source, union_sha16, pairs: [[ist_date, room_id], ...]}: copied from lib/rubrics/blind-room-days.ts
CRED_FILE = os.environ.get("CONSULT_MIRROR_CRED_FILE") or f"{H}/.config/consult-cutter/r2_lab_results_write"        # access, secret, endpoint (3 lines); only opened by --live
HELDOUT_PY = f"{E}/drtpqma/heldout.py"                        # the cutter's own held-out union (C.HELDOUT); the blind config is cross-checked against it
UNION_SHA16 = "f07171dcb708d080"                               # pinned: the union the blind config must come from (heldout.py load_union() returns the same)
DATE_RE, ROOM_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$"), re.compile(r"^room_[a-z0-9]+$")
TITLE_TOKENS = {"doctor", "prof", "professor", "mister", "madam"}   # name tokens too generic to match a room_slug on
BUCKET, KEY_LATEST, KEY_MANIFEST = "eta-lab-results", "consult/index/latest.jsonl", "consult/index/manifest.json"
ALLOW = ("consult_uid", "window_id", "ist_date", "room_id", "room_slug", "span_start", "span_end", "span_end_epoch", "t_open", "t_close", "minutes", "bytes", "quality", "flags", "coverage",
         "voice_isolated", "doctor_uid", "doctor_identified", "cut_at", "code_commit", "signature", "r2",
         "boundary_source", "room_source", "pqm_step_uid", "pqm_called", "pqm_completed", "consult_offset_s", "room_confidence")      # spec item 4 + m3-17 (PQM rows only; none contains name / path)
R2_ALLOW = ("bucket", "prefix", "files", "at")
NEVER = ("doctor_name", "path")
NEVER_KEY_PARTS = ("name", "path")                             # a key containing either (after folding: doctor_name, dr_name, name, clip_path ...) is blocked at any depth; no allowlisted key contains one
NAME_TITLES = {"dr", "doctor", "prof", "professor", "mr", "mrs", "ms", "miss", "mister", "madam", "shri", "smt", "sri"}   # leading titles stripped for the second comparison form
FULL_FLOOR, STRIPPED_FLOOR = 3, 5                              # minimum folded length of the full name / of the title-stripped name (shorter ones collide with random ids)                                  # spec item 5: must never reach the output

class ConfigError(Exception): pass
class LeakError(AssertionError): pass                          # the output guard fired: main() maps it to exit 6 and prints no content
class SlugNameError(ConfigError):
    def __init__(self, hits, counts): super().__init__(f"room_slug matches a doctor_name token in {hits} kept rows"); self.hits, self.counts = hits, counts

def load_blind(path=BLIND_FILE, heldout_py=HELDOUT_PY, pin=UNION_SHA16):
    """the held-out pairs as a set of (ist_date, room_id). heldout.py is loaded FIRST. If its union is EMPTY and its sha16 equals the pin (V lifted the blind rule, 10 Oct), returns set() whatever the blind config file holds
    (one stderr line says so). Every other case keeps the strict checks and fails closed (ConfigError): heldout.py cannot be loaded; an empty union with a sha that is not the pin; a missing / empty / malformed config file; a pair that is not
    [YYYY-MM-DD, room_xxx] (a reversed pair fails here); a duplicate pair; union_sha16 not equal to the pin; and any disagreement with the cutter's own heldout union (same sha16, and the pairs map onto exactly its entries)."""
    try:
        spec = importlib.util.spec_from_file_location("heldout", heldout_py); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); union, sha = m.load_union(); union = set(union)
    except Exception as e: raise ConfigError(f"blind-room-days config: the cutter heldout union cannot be loaded ({e.__class__.__name__})")
    if not union:
        if sha != pin: raise ConfigError("blind-room-days config: the cutter heldout union is empty but its sha16 does not match the pin")
        print("blind union empty: no room-days withheld", file=sys.stderr); return set()
    try:
        with open(path) as fh: d = json.load(fh)
    except (OSError, ValueError) as e: raise ConfigError(f"blind-room-days config {path}: {e.__class__.__name__}")
    p = d.get("pairs") if isinstance(d, dict) else None
    if not isinstance(p, list) or not p or not all(isinstance(x, list) and len(x) == 2 and all(isinstance(s, str) and s for s in x) for x in p): raise ConfigError(f"blind-room-days config {path}: pairs must be a non-empty list of [ist_date, room_id]")
    for a, b in p:
        try: ok = bool(DATE_RE.match(a)) and dt.date.fromisoformat(a) is not None
        except ValueError: ok = False
        if not ok or not ROOM_RE.match(b): raise ConfigError("blind-room-days config: a pair is not [YYYY-MM-DD, room_id] (reversed or malformed)")
    pairs = {(a, b) for a, b in p}
    if len(pairs) != len(p): raise ConfigError("blind-room-days config: duplicate pairs")
    if d.get("union_sha16") != pin: raise ConfigError("blind-room-days config: union_sha16 does not match the pinned union")
    try: want = {f"{a} {m.LABEL.get(b, b)}" for a, b in pairs}
    except Exception as e: raise ConfigError(f"blind-room-days config: the cutter heldout union cannot be loaded ({e.__class__.__name__})")
    if sha != pin or want != union: raise ConfigError("blind-room-days config: pairs do not match the cutter heldout union")
    return pairs

def read_index(path=INDEX):
    """-> (latest row per consult_uid in file order, lines, bad lines, every doctor_name seen on ANY line). A line that is not a JSON object (e.g. a half-written last line) is skipped and counted."""
    last, bad, n, names = {}, 0, 0, set()
    try: fh = open(path)
    except OSError as e: raise ConfigError(f"index {path}: {e.__class__.__name__}")
    with fh:
        for ln in fh:
            if not ln.strip(): continue
            n += 1
            try: r = json.loads(ln)
            except ValueError: bad += 1; continue
            if not isinstance(r, dict) or not isinstance(r.get("consult_uid"), str) or not r["consult_uid"]: bad += 1; continue
            last[r["consult_uid"]] = r
            if isinstance(r.get("doctor_name"), str): names.add(r["doctor_name"])
    return last, n, bad, names

def project(r):
    """the allowlisted copy of one row: only ALLOW keys that are present; r2 reduced to R2_ALLOW."""
    out = {k: r[k] for k in ALLOW if k in r and k != "r2"}
    out["r2"] = {k: r["r2"][k] for k in R2_ALLOW if k in r["r2"]}
    return out

def select(latest, blind):
    """-> (rows sorted by consult_uid, counts). Counts are numbers only."""
    c = dict(uids=len(latest), not_cut=0, not_mirrored=0, no_r2_key=0, blind=0, kept=0, voice_isolated=0)
    rows = []
    for uid in sorted(latest):
        r = latest[uid]
        if r.get("status") != "cut": c["not_cut"] += 1; continue
        r2 = r.get("r2")
        if not isinstance(r2, dict) or r2.get("status") != "mirrored": c["not_mirrored"] += 1; continue
        if not (isinstance(r2.get("bucket"), str) and r2["bucket"] and isinstance(r2.get("prefix"), str) and r2["prefix"]): c["no_r2_key"] += 1; continue
        if (r.get("ist_date"), r.get("room_id")) in blind: c["blind"] += 1; continue
        p = project(r); rows.append((r, p)); c["kept"] += 1; c["voice_isolated"] += 1 if r.get("voice_isolated") is True else 0
    return rows, c

def base(x): return "".join(ch for ch in unicodedata.normalize("NFKD", x) if not unicodedata.combining(ch)).casefold()     # NFKD, accents dropped, casefolded
def fold(x): return "".join(ch for ch in unicodedata.normalize("NFKD", x).casefold() if ch.isalnum())                      # + every non-alphanumeric removed: NFC/NFD, _ - . and spaces all compare equal
def walk(o):
    """every key and every string value at any depth, as decoded strings (not JSON-escaped text)."""
    if isinstance(o, dict):
        for k, v in o.items(): yield k; yield from walk(v)
    elif isinstance(o, (list, tuple)):
        for v in o: yield from walk(v)
    elif isinstance(o, str): yield o

def name_forms(names):
    """the folded forms every output string is compared with: each doctor_name in full (>= FULL_FLOOR chars) and with its leading title(s) removed (Dr, Dr., Doctor, Prof, Mr ...; >= STRIPPED_FLOOR chars)."""
    out = set()
    for n in names:
        if not isinstance(n, str): continue
        f = fold(n)
        if len(f) >= FULL_FLOOR: out.add(f)
        toks = [t for t in re.split(r"[^a-z0-9]+", base(n)) if t]
        while toks and toks[0] in NAME_TITLES: toks.pop(0)
        g = fold("".join(toks))
        if len(g) >= STRIPPED_FLOOR: out.add(g)
    return out

def leak_check(pairs, names=()):
    """defence in depth on top of the allowlist, fail closed (LeakError, an AssertionError): no non-allowlisted top-level or r2 key; no key containing "name" or "path" (after folding, so doctor_name,
    doctorName, dr_name, name, clip_path, PATH ...) at ANY depth; no decoded string anywhere that starts with "/" or holds "/home/"; and no string (key or value) that contains ANY doctor_name of the whole index once both
    sides are folded (NFKD + casefold + every non-alphanumeric removed: quotes, case, spacing, NFC vs NFD, and _ - . joiners cannot hide a name). A name is compared in full (3+ folded characters) and again with its leading title removed (5+)."""
    ns = name_forms(names)
    def keys(o):
        if isinstance(o, dict):
            for k, v in o.items(): yield k; yield from keys(v)
        elif isinstance(o, (list, tuple)):
            for v in o: yield from keys(v)
    for src, p in pairs:
        if set(p) - set(ALLOW) or set(p["r2"]) - set(R2_ALLOW): raise LeakError("non-allowlisted key in output")
        for k in keys(p):
            fk = fold(k) if isinstance(k, str) else ""
            if any(w in fk for w in NEVER_KEY_PARTS): raise LeakError("a doctor_name/path key in output")
        for t in walk(p):
            if t.startswith("/") or "/home/" in t or E in t: raise LeakError("absolute box path in output")
            ft = fold(t)
            for n in ns:
                if n in ft: raise LeakError("a doctor_name value in output")

def slug_name_hits(pairs, names):
    """kept rows whose room_slug shares a token (>= 4 letters, not a title) with ANY doctor_name of the index: a count of rows, never the names."""
    toks = {t for n in names if isinstance(n, str) for t in re.split(r"[^a-z0-9]+", base(n)) if len(t) >= 4 and t not in TITLE_TOKENS}
    return sum(1 for _, p in pairs if toks & set(re.split(r"[^a-z0-9]+", base(p.get("room_slug") or ""))))

def code_commit():
    try: return subprocess.run(["git", "-C", os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "rev-parse", "--short", "HEAD"], capture_output=True, text=True).stdout.strip() or None
    except Exception: return None

def build(index=INDEX, blind_file=BLIND_FILE, now=None, commit=None, heldout_py=HELDOUT_PY, accept_slug_names=0):
    """-> (latest_bytes, manifest_bytes, counts). latest.jsonl: sorted by consult_uid, compact JSON with sorted keys, one trailing newline per line.
    Fails closed (ConfigError) on: the blind config, an unknown code_commit, or room_slugs that match a doctor_name token (unless exactly that many rows were accepted with accept_slug_names)."""
    blind = load_blind(blind_file, heldout_py); latest, n, bad, names = read_index(index)
    commit = commit if commit is not None else code_commit()
    if not commit: raise ConfigError("code_commit unknown (git rev-parse failed)")
    pairs, c = select(latest, blind); leak_check(pairs, names)
    c.update(index_lines=n, bad_lines=bad, blind_pairs=len(blind), slug_name_rows=slug_name_hits(pairs, names))
    skip_slug = os.environ.get("INDEX_MIRROR_SKIP_SLUG_GUARD") == "1"   # 12 Oct 2026: durable override of the room_slug/doctor_name word-overlap refusal only; leak_check above still runs
    c["slug_guard_skipped"] = int(skip_slug)
    if not skip_slug and c["slug_name_rows"] != accept_slug_names: raise SlugNameError(c["slug_name_rows"], c)
    body = "".join(json.dumps(p, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n" for _, p in pairs).encode("utf-8")
    now = now or dt.datetime.now(dt.timezone.utc)
    man = dict(generated_at=now.strftime("%Y-%m-%dT%H:%M:%SZ"), rows=len(pairs), sha256=hashlib.sha256(body).hexdigest(), code_commit=commit)
    return body, (json.dumps(man, sort_keys=True, indent=1) + "\n").encode("utf-8"), c

def write_dry(outdir, latest, manifest):
    d = os.path.join(outdir, "consult", "index"); os.makedirs(d, mode=0o700, exist_ok=True)
    for name, data in (("latest.jsonl", latest), ("manifest.json", manifest)):
        fd = os.open(os.path.join(d, name), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as fh: fh.write(data)
    return d

def r2_client(cred_file=CRED_FILE):
    try: L = [x.strip() for x in open(cred_file).read().splitlines() if x.strip()]
    except OSError: raise ConfigError("credential file unreadable")
    if len(L) < 3 or (len(L) > 3 and L[3] != BUCKET): raise ConfigError("credential file shape")
    import boto3; from botocore.config import Config
    return boto3.client("s3", aws_access_key_id=L[0], aws_secret_access_key=L[1], endpoint_url=L[2], region_name="auto", config=Config(connect_timeout=10, read_timeout=60, retries={"total_max_attempts": 2}))

def put_both(client, latest, manifest):
    """latest first, then the manifest; if the first PUT raises the manifest is NOT written (the old pair stays consistent)."""
    client.put_object(Bucket=BUCKET, Key=KEY_LATEST, Body=latest, ContentType="application/x-ndjson")
    client.put_object(Bucket=BUCKET, Key=KEY_MANIFEST, Body=manifest, ContentType="application/json")

def main(argv=None, client=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0]); g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--dry-run", metavar="DIR"); g.add_argument("--live", action="store_true")
    ap.add_argument("--index", default=INDEX); ap.add_argument("--blind", default=BLIND_FILE); ap.add_argument("--cred", default=CRED_FILE); ap.add_argument("--allow-empty", action="store_true")
    ap.add_argument("--heldout", default=HELDOUT_PY); ap.add_argument("--accept-slug-names", type=int, default=0, metavar="N", help="lead's call: accept EXACTLY N kept rows whose room_slug matches a doctor_name token (any other count refuses)")
    a = ap.parse_args(argv)
    try: latest, manifest, c = build(a.index, a.blind, heldout_py=a.heldout, accept_slug_names=a.accept_slug_names)
    except AssertionError: print("LEAK: the output guard blocked the run; nothing written, no PUT (no content shown)", file=sys.stderr); return 6
    except SlugNameError as e: print("counts", json.dumps(e.counts, sort_keys=True)); print("REFUSED:", e, "(--accept-slug-names N after a lead decision)", file=sys.stderr); return 5
    except ConfigError as e: print("CONFIG ERROR:", e, file=sys.stderr); return 2
    print("counts", json.dumps(c, sort_keys=True))
    if c["kept"] == 0 and not a.allow_empty: print("REFUSED: zero rows", file=sys.stderr); return 3
    if a.dry_run:
        print("dry-run wrote", write_dry(a.dry_run, latest, manifest), "rows", c["kept"]); return 0
    try: put_both(client or r2_client(a.cred), latest, manifest)
    except ConfigError as e: print("CONFIG ERROR:", e, file=sys.stderr); return 2
    except Exception as e: print("UPLOAD FAILED:", e.__class__.__name__, file=sys.stderr); return 4
    print("live PUT ok", KEY_LATEST, KEY_MANIFEST, "rows", c["kept"]); return 0

if __name__ == "__main__": sys.exit(main())
