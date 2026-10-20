#!/usr/bin/env python3
"""Spine S1 box poster: turn pqm windows, cutter index rows or CAA scope bundles into spine_signal rows and POST them to /api/spine/signals (bearer token, D10: the box holds no DB credential).

  post_signals.py --kind pqm|cutter|caa|nemotron_window --file FILE [--url URL --token-file FILE --post]

DEFAULT IS --dry-run: it prints counts only (no ids, no names; `refused_by_reason` counts per reason code: source_key, room_id, text_key, attrs_key, attrs_ids.<allowlisted key>[.digit_run|.proxy], attrs_ids.unknown_key, close_reason, quality, too_deep, and never a value), opens no socket and reads no token. --post needs --url and --token-file, a regular file with mode 0600 holding the token.
The poster sends no source_rev: the server applies the rev rule (a new rev only when t_open, t_close, room_id or the close reason changed), so a re-run is idempotent.
A key matching the PHI word list at any depth (normalised), an attrs key outside ids / quality / close_reason, or a value outside the closed rules (ids allowlist, enums, tokens) is refused HERE: that row is skipped and counted as `refused`, the rest still go. rc 0 with refused/skipped > 0 is reported in the counts.
Exit codes: 0 done (refused / skipped rows are in the counts); 1 the server answered non-200; 3 the server reported `conflict` > 0 (a changed signal lost its race and was NOT stored: re-run the same file, the rev rule makes that idempotent). The `conflict` count is always in the post summary.
No timer is installed by this file.

Input shapes:
  pqm     JSONL of the windows tools/pqm_windows.py writes (consult_uid, room_id, t_open / t_close epoch seconds, close_reason, quality).
  cutter  index.jsonl (append-only: the latest row per consult_uid wins): consult_uid, room_id, span_start / span_end naive IST "YYYY-MM-DD HH:MM:SS[.fff]", status, window_id.
  nemotron_window  JSONL of the diarize_nemotron_window rows the box holds (db/migrations/0140): window_id, status ok|empty|failed, audio_ms, optional start_ms. One signal per window_id (the latest row wins); a failed row or one with no audio is skipped. t_open = start_ms, else the 13-digit start in the bw_ id (lib/bench-window.ts:357); t_close = t_open + audio_ms. Only attrs.ids.window_id; no room_id (the row names none); no turns are read.
  caa     JSONL of scope bundles: {consult_uid, scope_path "<scope>/<room dir>/...", manifest: {t0_ms, t1_ms}}. UNVERIFIED shape: taken from tools/eta2freescript/ingest.py bundle_window.
"""
import argparse, datetime as dt, json, os, re, stat, sys, unicodedata, urllib.error, urllib.request

IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
WORDS = re.compile(r"text|name|phone|patient|transcript|email|uhid|mrn|mobile|dob|aadhaar|addr|address")
MAX_DEPTH = 12
BATCH = 500
KINDS = ("pqm", "cutter", "caa", "nemotron_window")
ATTR_KEYS = {"ids", "quality", "close_reason"}
# The value rules are shared with lib/spine/phi-screen.ts: ONE json both read (enums, id keys, per-key formats, source_key format per proxy).
with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "phi-rules.json"), encoding="utf-8") as _fh:
    _RULES = json.load(_fh)
ID_KEYS = set(_RULES["id_keys"])
FORMATS = {k: re.compile(v) for k, v in _RULES["formats"].items()}
SOURCE_KEY_FORMAT = _RULES["source_key_format"]
ID_KEY_PROXIES = _RULES["id_key_proxies"]
DIGIT_GUARD = "(?!.*[0-9]{7})"
_UNGUARDED = {k: re.compile(v.replace(DIGIT_GUARD, "")) for k, v in _RULES["formats"].items()}
ENUMS = {p: {"close_reason": set(e["close_reason"]), "quality": set(e["quality"])} for p, e in _RULES["enums"].items()}
_LOOKALIKE = {
    "ı": "i", "а": "a", "е": "e", "к": "k", "м": "m", "н": "h", "о": "o", "р": "p", "с": "c", "т": "t", "у": "y", "х": "x",
    "і": "i", "ј": "j", "ѕ": "s", "ԁ": "d", "ԛ": "q", "ԝ": "w", "һ": "h", "ӏ": "l",
    "α": "a", "ε": "e", "ι": "i", "κ": "k", "ν": "v", "ο": "o", "ρ": "p", "τ": "t", "υ": "u", "χ": "x",
}


class Refused(ValueError):
    """args[0] is the code the server would answer; .reason is the finer code the dry-run counts (never a value, never an unlisted key)."""

    def __init__(self, code, reason=None):
        super().__init__(code)
        self.reason = reason or code


def norm_key(k):
    """NFKC, drop combining marks and Unicode Cf, lower-case, fold Cyrillic / Greek lookalikes. Mirrors normKey in lib/spine/phi-screen.ts."""
    s = unicodedata.normalize("NFD", unicodedata.normalize("NFKC", str(k)))
    s = "".join(c for c in s if unicodedata.category(c) not in ("Mn", "Cf")).lower()
    return "".join(_LOOKALIKE.get(c, c) for c in s)


def refuse_keys(v, depth=0):
    """Raise Refused('text_key' | 'too_deep') when any key at any depth looks like identity or text. Mirrors refuseKeys in lib/spine/signal-validate.ts (depth counts containers only)."""
    if not isinstance(v, (list, dict)):
        return
    if depth > MAX_DEPTH:
        raise Refused("too_deep")
    if isinstance(v, list):
        for x in v:
            refuse_keys(x, depth + 1)
    else:
        for k, x in v.items():
            if WORDS.search(norm_key(k)):
                raise Refused("text_key")
            refuse_keys(x, depth + 1)


def _fmt(key, v):
    f = FORMATS.get(key) if key is not None else None
    return f is not None and isinstance(v, str) and f.fullmatch(v) is not None


def _guard_only(key, v):
    """True when v fails key's format but passes it without the 7-digit guard."""
    f = _UNGUARDED.get(key) if key is not None else None
    return f is not None and isinstance(v, str) and f.fullmatch(v) is not None


def _id_key_reason(k, x, proxy):
    if k not in ID_KEYS:
        return "attrs_ids.unknown_key"
    if proxy not in ID_KEY_PROXIES.get(k, [proxy]):
        return f"attrs_ids.{k}.proxy"
    if _fmt(k, x):
        return None
    return f"attrs_ids.{k}.digit_run" if _guard_only(k, x) else f"attrs_ids.{k}"


def refuse_values(s):
    """Mirrors refuseValueReason in lib/spine/phi-screen.ts; the server would answer 422 for any of these."""
    proxy = s.get("proxy")
    skf = SOURCE_KEY_FORMAT.get(proxy)
    if not _fmt(skf, s.get("source_key")):
        raise Refused("source_key", "source_key.digit_run" if _guard_only(skf, s.get("source_key")) else "source_key")
    if s.get("room_id") is not None and not _fmt("room_id", s["room_id"]):
        raise Refused("room_id")
    a = s.get("attrs") or {}
    if "ids" in a:                                  # present-but-null is refused, as the server does
        ids = a["ids"]
        if not isinstance(ids, dict):
            raise Refused("attrs_ids", "attrs_ids.not_object")
        for k, x in ids.items():
            r = _id_key_reason(k, x, proxy)
            if r:
                raise Refused("attrs_ids", r)
    en = ENUMS.get(proxy, {"close_reason": set(), "quality": set()})
    if "close_reason" in a and not (isinstance(a["close_reason"], str) and a["close_reason"] in en["close_reason"]):
        raise Refused("attrs_close_reason", "close_reason")
    if "quality" in a and not (isinstance(a["quality"], str) and a["quality"] in en["quality"]):
        raise Refused("attrs_quality", "quality")


def check_signal(s):
    refuse_keys(s)
    extra = set(s.get("attrs", {})) - ATTR_KEYS
    if extra:
        raise Refused("attrs_key")
    refuse_values(s)
    return s


def iso_epoch_s(t):
    return dt.datetime.fromtimestamp(float(t), dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def iso_epoch_ms(t):
    return iso_epoch_s(int(t) / 1000.0)


def iso_ist(s):
    """naive IST wall-clock 'YYYY-MM-DD HH:MM:SS[.fff]' -> UTC ISO, or None."""
    if not s:
        return None
    try:
        d = dt.datetime.fromisoformat(str(s).replace(" ", "T")).replace(tzinfo=IST)
    except ValueError:
        return None
    return d.astimezone(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _attrs(ids, quality=None, close_reason=None):
    a = {"ids": {k: str(v) for k, v in ids.items() if v}}
    if quality:
        a["quality"] = str(quality)
    if close_reason:
        a["close_reason"] = str(close_reason)
    return a


def from_pqm(r, observed):
    uid = r.get("consult_uid")
    if not uid or r.get("t_open") is None:
        return None
    return {"proxy": "pqm", "source_key": uid, "room_id": r.get("room_id"), "t_open": iso_epoch_s(r["t_open"]),
            "t_close": iso_epoch_s(r["t_close"]) if r.get("t_close") is not None else None, "observed_at": observed,
            "attrs": _attrs({"consult_uid": uid, "pqm_step_uid": r.get("pqm_step_uid")}, r.get("quality"), r.get("close_reason"))}


def from_cutter(r, observed):
    uid = r.get("consult_uid")
    t_open = iso_ist(r.get("span_start"))
    if not uid or not t_open:
        return None
    return {"proxy": "cutter", "source_key": uid, "room_id": r.get("room_id"), "t_open": t_open, "t_close": iso_ist(r.get("span_end")), "observed_at": observed,
            "attrs": _attrs({"consult_uid": uid, "window_id": str(r["window_id"]) if r.get("window_id") is not None else None}, r.get("status"), r.get("close_reason"))}


def from_caa(r, observed):
    uid = r.get("consult_uid")
    m = r.get("manifest") if isinstance(r.get("manifest"), dict) else {}
    try:
        t0, t1 = int(m["t0_ms"]), int(m["t1_ms"])
    except (KeyError, TypeError, ValueError):
        return None
    parts = str(r.get("scope_path") or "").split("/")
    room = parts[1] if len(parts) >= 2 and parts[1] else None
    if not uid or not t1 > t0:
        return None
    return {"proxy": "caa", "source_key": uid, "room_id": room, "t_open": iso_epoch_ms(t0), "t_close": iso_epoch_ms(t1), "observed_at": observed,
            "attrs": _attrs({"consult_uid": uid})}


BW_ID = re.compile(r"^bw_[a-z0-9]{8}_([0-9]{13})_(?:primary|backup)$")


def from_nemotron_window(r, observed):
    wid = r.get("window_id")
    if not isinstance(wid, str) or r.get("status") not in ("ok", "empty"):
        return None
    try:
        audio = int(r["audio_ms"])
        if r.get("start_ms") is not None:
            t0 = int(r["start_ms"])
        else:
            m = BW_ID.match(wid)
            t0 = int(m.group(1)) if m else None
    except (KeyError, TypeError, ValueError):
        return None
    if t0 is None or t0 < 0 or audio <= 0:
        return None
    return {"proxy": "nemotron_window", "source_key": wid, "room_id": None, "t_open": iso_epoch_ms(t0), "t_close": iso_epoch_ms(t0 + audio), "observed_at": observed,
            "attrs": _attrs({"window_id": wid})}


MAPPERS = {"pqm": from_pqm, "cutter": from_cutter, "caa": from_caa, "nemotron_window": from_nemotron_window}
LATEST_BY = {"cutter": "consult_uid", "nemotron_window": "window_id"}


def read_rows(path, kind):
    rows, bad = [], 0
    with open(path) as fh:
        for line in fh:
            if not line.strip():
                continue
            try:
                r = json.loads(line)
            except ValueError:
                bad += 1
                continue
            if isinstance(r, dict):
                rows.append(r)
            else:
                bad += 1
    if kind in LATEST_BY:                     # append-only: the latest row per key
        latest, keyless = {}, []
        for r in rows:
            if isinstance(r.get(LATEST_BY[kind]), (str, int)) and r.get(LATEST_BY[kind]):
                latest[r[LATEST_BY[kind]]] = r
            else:
                keyless.append(r)             # kept so the mapper counts it as skipped, not silently dropped
        rows = list(latest.values()) + keyless
    return rows, bad


def build(path, kind, observed):
    """-> (signals, counts). Refused rows are dropped and counted; nothing about them is printed."""
    rows, bad = read_rows(path, kind)
    signals, skipped, refused, by_reason = [], 0, 0, {}
    for r in rows:
        s = MAPPERS[kind](r, observed)
        if s is None:
            skipped += 1
            continue
        try:
            signals.append(check_signal(s))
        except Refused as e:
            refused += 1
            by_reason[e.reason] = by_reason.get(e.reason, 0) + 1
    return signals, {"read": len(rows) + bad, "bad_lines": bad, "skipped": skipped, "refused": refused, "refused_by_reason": dict(sorted(by_reason.items())), "signals": len(signals)}


def read_token(path):
    st = os.stat(path)
    if not stat.S_ISREG(st.st_mode) or st.st_mode & 0o077:
        raise SystemExit("token file must be a regular file with mode 0600")
    tok = open(path).read().strip()
    if not tok:
        raise SystemExit("token file is empty")
    return tok


def post_batch(url, token, batch):
    req = urllib.request.Request(url, data=json.dumps(batch).encode(), method="POST",
                                 headers={"content-type": "application/json", "authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, {}


def main(argv=None, now=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--kind", required=True, choices=KINDS)
    ap.add_argument("--file", required=True)
    ap.add_argument("--dry-run", action="store_true", help="the default; prints counts only")
    ap.add_argument("--post", action="store_true")
    ap.add_argument("--url")
    ap.add_argument("--token-file")
    a = ap.parse_args(argv)
    if a.post and a.dry_run:
        ap.error("--post and --dry-run are exclusive")
    if a.post and not (a.url and a.token_file):
        ap.error("--post needs --url and --token-file")
    observed = (now or dt.datetime.now(dt.timezone.utc)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    signals, counts = build(a.file, a.kind, observed)
    if not a.post:
        print(json.dumps({"mode": "dry-run", "kind": a.kind, **counts}))
        return 0
    token = read_token(a.token_file)
    sent = dup = conflict = 0
    for i in range(0, len(signals), BATCH):
        code, body = post_batch(a.url, token, signals[i:i + BATCH])
        if code != 200:
            print(json.dumps({"mode": "post", "kind": a.kind, **counts, "sent": sent, "failed_status": code}))
            return 1
        if body.get("skipped"):
            print(json.dumps({"mode": "post", "kind": a.kind, **counts, "inserted": sent, "duplicate": dup, "conflict": conflict, "server_skipped": body["skipped"]}))
            return 3 if conflict > 0 else 0
        sent += body.get("inserted", 0)
        dup += body.get("duplicate", 0)
        conflict += body.get("conflict", 0)
    print(json.dumps({"mode": "post", "kind": a.kind, **counts, "inserted": sent, "duplicate": dup, "conflict": conflict}))
    return 3 if conflict > 0 else 0


if __name__ == "__main__":
    sys.exit(main())
