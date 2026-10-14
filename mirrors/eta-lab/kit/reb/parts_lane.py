"""parts_lane.py: consult parts tagging with CLEF + Jev (ORDERS-PALIMPSEST-17A, provisional). Layer "parts", engine "clef-jev", version "v0-provisional".

Per cut consult clip with a live ok stt.sarvam-saaras-v3 track (the English translate turns are preferred where present): tag the clip's 30 s bins with the conversation parts
history | exam | order | medicine | followup | advice, using consult-lead's tagger (vendored as kit/reb/parts_tag.py, byte for byte, pinned by sha256: its logic is NOT changed here;
the lane only injects the CLEF and Jev callables the tagger already accepts).
Segments = {t0_ms, t1_ms, part, score, source, confidence} on the tape clock (clip span start + clip offset). NO text anywhere in the track.
  source     = the tagger's: clef | jev | clef+jev (which signal crossed its threshold); a clip that went Jev-only has source jev.
  confidence = "high" | "low" per part, read from the thresholds config (never hardcoded here).
Thresholds config: consult-lead's parts_config.json, read IN PLACE at run time (consult-lead owns the retunes); its sha256 goes in the track config, so a new config = a new cfg8
= a new track (the store stays append-only). The lane fails closed when the config is missing, unreadable, lacks a part, or changes while it is read.
cfg8 = config_hash({stt_sha256, translate_sha256, parts_tag_sha256, parts_config_sha256, parts_config_version, jev model name, bin/call caps}): known before any call, so a clip already
done is skipped before CLEF or Jev is touched.
Keys: CLEF only through /opt/clef (the helper reads its own credential; this lane never reads, prints or passes it); Jev through the same client and key path as the role judge. Metadata logging only.
Spend: the lane stops at a daily CLEF cap (default US$5 per IST day, persisted across runs in ~/eta-data/parts-spend, until consult-lead names one). The per-call CLEF price is a PROVISIONAL
constant (CLEF_USD_PER_CALL) that consult-lead / the architect must confirm; Jev spend is not in cost_usd.
CLEF mode (follow-up to 17A): before the first clip a preflight checks that /opt/clef imports and that its env file is readable by this process (os.access only; the file is never opened).
If not, the whole run is "jev-only": no audio goes to the tagger, no CLEF call is made, and the cfg8 carries clef_mode "jev-only", so a later run with CLEF working writes NEW "clef+jev"
tracks beside these (append-only). A clip whose CLEF dies mid-clip is likewise written as "jev-only". Only CLEF calls that answered are charged to cost_usd and the day's cap.
Default is a dry run: no CLEF call, no Jev call, nothing written; --write runs for real.
"""
import argparse
import collections
import datetime
import hashlib
import json
import os
import sys
import tempfile
import time

from . import jev_client
from . import parts_tag as pt
from . import role_text_judge as rj
from . import sarvam_lane as sl
from . import writer
from .from_hist import GuardUnavailable, load_heldout, window_held
from .schema import SCHEMA_VERSION
from .validate import validate_track

REB = os.path.expanduser("~/eta-data/reb")
LAYER, ENGINE, VERSION = "parts", "clef-jev", "v0-provisional"
PARTS_TAG_SHA256 = "af1a3bcd0d4dd615b388b5adc6da4bcae0f7b1a89f4fa9be6353cfd47d6934e0"   # the vendored kit/reb/parts_tag.py (consult-lead, 12 Oct 06:01 IST)
CONFIG_PATH = os.path.expanduser("~/oc/consult/studies/boundary-12oct/parts_config.json")
SPEND_DIR = os.path.expanduser("~/eta-data/parts-spend")
DAILY_CAP_USD = 5.0                 # until consult-lead sets one (their estimate: US$2-3 a day)
CLEF_USD_PER_CALL = 0.0012          # PROVISIONAL: one CLEF call per 30 s window; set so a ~60-consult day lands near consult-lead's estimate. To be confirmed.
MAX_CLEF_CALLS = 60                 # the tagger's own per-clip caps (its defaults), recorded in the cfg8
MAX_JEV_CALLS = 60
CONFIDENCE_VALUES = ("high", "low")
IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
COUNTERS = ("clips", "written", "would_write", "skipped_existing", "no_stt", "no_text", "signature_mismatch", "blind_refused", "errors", "degraded", "budget_stopped",
            "limit_reached", "clef_calls", "clef_errors", "jev_calls", "jev_errors", "est_clef_calls", "clef_preflight_ok", "clef_preflight_failed")
CLEF_DIR = "/opt/clef"
MODES = ("clef+jev", "jev-only")


class ConfigError(RuntimeError):
    pass


class BudgetStop(RuntimeError):
    pass


def sha256_bytes(b):
    return hashlib.sha256(b).hexdigest()


# ---------------------------------------------------------------- pins and config
def verify_vendored():
    """Refuse to run if the vendored tagger is not exactly the pinned file."""
    path = pt.__file__
    got = sha256_bytes(open(path, "rb").read())
    if got != PARTS_TAG_SHA256:
        raise ConfigError("parts_tag.py sha256 differs from the pin")
    return got


def load_config(path=CONFIG_PATH):
    """-> (cfg, sha256, version). cfg = the tagger's own per-part structure ({part: {rule, tj_only, confidence}}), built the way parts_tag._load_config builds it, and installed as
    parts_tag.CONFIG: the tagger silently falls back to its built-in rules when CONFIG is empty, and this lane must never run on that fallback."""
    try:
        raw = open(path, "rb").read()
        doc = json.loads(raw)
        parts = doc["parts"]
        cfg = {p: {"rule": v["rule"], "tj_only": float(v["tj_only"]), "confidence": v.get("confidence")} for p, v in parts.items() if p in pt.RULES}
    except (OSError, ValueError, KeyError, TypeError) as e:
        raise ConfigError("parts config unreadable: " + type(e).__name__)
    if set(cfg) != set(pt.RULES):
        raise ConfigError("parts config lacks parts: " + ",".join(sorted(set(pt.RULES) - set(cfg))))
    bad = [p for p, v in cfg.items() if v["confidence"] not in CONFIDENCE_VALUES]
    if bad:
        raise ConfigError("parts config has no high|low confidence for: " + ",".join(sorted(bad)))
    sha = sha256_bytes(raw)
    if sha256_bytes(open(path, "rb").read()) != sha:
        raise ConfigError("parts config changed while it was read")
    pt.CONFIG = cfg
    return cfg, sha, str(doc.get("version"))


# ---------------------------------------------------------------- CLEF preflight
def clef_preflight(clef_dir=CLEF_DIR):
    """True when CLEF can be used by THIS process: /opt/clef imports and its env file is readable (os.access only: the file is never opened, read or printed). False otherwise
    (typically the process predates the `clef` group, so `sg clef -c '<command>'` is the way to run the lane). Importing the helper reads nothing secret."""
    try:
        if clef_dir not in sys.path:
            sys.path.insert(0, clef_dir)
        import clef
        return bool(os.access(getattr(clef, "ENV_FILE", os.path.join(clef_dir, "clef.env")), os.R_OK))
    except Exception:   # noqa: BLE001 - any import / attribute failure is "CLEF not usable"
        return False


# ---------------------------------------------------------------- daily spend
class Spend:
    """The CLEF spend of one IST day, persisted in SPEND_DIR/<date>.json so the cap holds across the hourly runs."""

    def __init__(self, directory=SPEND_DIR, cap=DAILY_CAP_USD, now=time.time):
        self.dir, self.cap, self._now = directory, cap, now

    def _path(self):
        d = datetime.datetime.fromtimestamp(self._now(), IST).strftime("%Y-%m-%d")
        return os.path.join(self.dir, d + ".json")

    def spent(self):
        try:
            return float(json.load(open(self._path()))["clef_usd"])
        except (OSError, ValueError, KeyError, TypeError):
            return 0.0

    def add(self, usd):
        os.makedirs(self.dir, exist_ok=True)
        p = self._path()
        fd, tmp = tempfile.mkstemp(dir=self.dir)
        with os.fdopen(fd, "w") as f:
            json.dump({"clef_usd": round(self.spent() + usd, 6), "cap_usd": self.cap}, f)
        os.chmod(tmp, 0o600)
        os.replace(tmp, p)

    def room_for(self, usd):
        return self.spent() + usd <= self.cap


# ---------------------------------------------------------------- the clip
def track_config(stt_sha, tr_sha, cfg_sha, cfg_version, jev_name, clef_mode="clef+jev"):
    """clef_mode is part of the cfg8: a clip tagged Jev-only gets its own track beside (never instead of) a later CLEF+Jev one."""
    assert clef_mode in MODES
    return {"clef_mode": clef_mode, "stt_sha256": stt_sha, "translate_sha256": tr_sha, "parts_tag_sha256": PARTS_TAG_SHA256, "parts_config_sha256": cfg_sha, "parts_config_version": cfg_version,
            "jev": jev_name, "bin_s": pt.BIN, "max_clef_calls": MAX_CLEF_CALLS, "max_jev_calls": MAX_JEV_CALLS}


def parts_path(root, row, cfg_hash):
    wd = writer._window_dir(root, row["ist_date"], row["room_id"], "consult-" + row["consult_uid"])
    return os.path.join(wd, "tracks", writer.track_filename(LAYER, ENGINE, VERSION, cfg_hash))


def tag_input(turns, span_start_ms):
    """The tagger's segments: clip-relative seconds, English where a translate turn exists. Text goes only to the tagger (and from it to CLEF-less Jev), never into the track."""
    return [{"t0": (t0 - span_start_ms) / 1000.0, "text": (en or text or ""), "speaker": sp} for sp, text, en, t0, t1 in turns]


def build_track(row, clip, tags, stats, cfg, cfg_sha, cfg_version, config, stt_rel, stt_sha, tr_sha, text_source, cost_usd, jev_model, jev_reported):
    base = clip["span_start_ms"]
    segs = [{"t0_ms": base + int(round(g["t0"] * 1000)), "t1_ms": base + int(round(g["t1"] * 1000)), "part": g["part"], "score": g["score"], "source": g["source"],
             "confidence": cfg[g["part"]]["confidence"]} for g in tags]
    t = {"schema": SCHEMA_VERSION, "window_id": "consult-" + row["consult_uid"], "layer": LAYER, "engine": ENGINE, "model": "clef-omni+" + (jev_model or "jev"), "version": VERSION,
         "config": config, "config_hash": writer.config_hash(config), "machine": "box-parts-lane", "status": "ok" if segs else "empty", "reason": None if segs else "no part crossed its threshold",
         "segments": segs,
         "extras": {"calls": {"clef": stats["clef_calls"], "jev": stats["jev_calls"]}, "errors": {"clef": stats["clef_errors"], "jev": stats["jev_errors"]},
                    "cost_usd": round(cost_usd, 6), "cost_basis": "answered clef calls x CLEF_USD_PER_CALL (provisional; failed calls are not charged); Jev not included",
                    "parts_tag_sha256": PARTS_TAG_SHA256, "parts_config_sha256": cfg_sha, "degraded": bool(stats["degraded"]),
                    "judge": {"jev": jev_model, "reported": jev_reported},
                    "derived_from": {"stt_path": stt_rel, "stt_sha256": stt_sha, "translate_sha256": tr_sha, "text_source": text_source},
                    "consult_uid": row["consult_uid"], "clip_signature": row["signature"]}}
    validate_track(t)
    return t


class Ctx:
    """Everything a clip needs that is not the clip: pins, config, the (injectable) CLEF / Jev callables, the spend ledger."""

    def __init__(self, cfg, cfg_sha, cfg_version, spend, clef_fn=None, jev_fn=None, jev_model=None, jev_reported=lambda: None, usd_per_call=CLEF_USD_PER_CALL, tag=None, preflight=None):
        self.cfg, self.cfg_sha, self.cfg_version, self.spend = cfg, cfg_sha, cfg_version, spend
        self.clef_fn, self.jev_fn, self.jev_model, self.jev_reported, self.usd_per_call = clef_fn, jev_fn, jev_model, jev_reported, usd_per_call
        self.tag = tag or pt.tag_clip
        self.preflight = preflight or clef_preflight
        self.clef_mode = "clef+jev"   # set by run() before the first clip, from the preflight


def process(row, root, is_held, write, cnt, ctx, clips_root=sl.CLIPS, limit=None):
    cnt["clips"] += 1
    try:
        if is_held(row["ist_date"], row["room_id"]):   # heldout first, before any text is read
            cnt["blind_refused"] += 1
            return
        try:
            clip = sl.open_clip(row, clips_root)
        except sl.ClipRefused:
            cnt["signature_mismatch"] += 1
            return
        if window_held(is_held, row["room_id"], clip["span_start_ms"], clip["span_end_ms"]):
            cnt["blind_refused"] += 1
            return
        stt_found = rj.live_track(root, row, "stt")   # the transcript is opened only now
        if not stt_found:
            cnt["no_stt"] += 1
            return
        stt_rel, stt_abs, stt = stt_found
        if (stt.get("config") or {}).get("clip_signature") != row["signature"]:
            cnt["signature_mismatch"] += 1
            return
        tr_found = rj.live_track(root, row, "translate")
        tr = tr_found[2] if tr_found and (tr_found[2].get("config") or {}).get("clip_signature") == row["signature"] else None
        tr_sha = rj.sha256_file(tr_found[1]) if tr else None
        stt_sha = rj.sha256_file(stt_abs)
        config = track_config(stt_sha, tr_sha, ctx.cfg_sha, ctx.cfg_version, ctx.jev_model, ctx.clef_mode)   # the mode THIS run will use (decided by the preflight)
        cfg_hash = writer.config_hash(config)
        if os.path.exists(parts_path(root, row, cfg_hash)):
            cnt["skipped_existing"] += 1   # known before any call: no CLEF, no Jev for a clip already done in this mode
            return
        turns = rj.speaker_turns(stt, tr)
        segs_in = tag_input(turns, clip["span_start_ms"])
        if not any((s["text"] or "").strip() for s in segs_in):
            cnt["no_text"] += 1
            return
        dur_s = (clip["span_end_ms"] - clip["span_start_ms"]) / 1000.0
        est = min(pt.estimate_calls(dur_s)["clef"], MAX_CLEF_CALLS) if ctx.clef_mode == "clef+jev" else 0   # a Jev-only run makes no CLEF call
        cnt["est_clef_calls"] += est
        if not write:   # dry run: counts only, nothing is called
            cnt["would_write"] += 1
            return
        if limit is not None and limit.exhausted():
            cnt["limit_reached"] += 1
            return
        if not ctx.spend.room_for(est * ctx.usd_per_call):
            cnt["budget_stopped"] += 1
            raise BudgetStop()
        if limit is not None:
            limit.take()
        stats = {}
        try:
            # jev-only mode (preflight failed): no audio is handed to the tagger, so it makes no CLEF call at all and tags from the Jev signal alone
            tags = ctx.tag(clip["path"] if ctx.clef_mode == "clef+jev" else None, segs_in, max_clef_calls=MAX_CLEF_CALLS, max_jev_calls=MAX_JEV_CALLS,
                           clef_fn=ctx.clef_fn, jev_fn=ctx.jev_fn, duration_s=dur_s, stats=stats)
        finally:
            cost = max(stats.get("clef_calls", 0) - stats.get("clef_errors", 0), 0) * ctx.usd_per_call   # only the CLEF calls that answered are charged
            if stats:
                ctx.spend.add(cost)
                for k in ("clef_calls", "clef_errors", "jev_calls", "jev_errors"):
                    cnt[k] += stats.get(k, 0)
        if stats["degraded"]:
            cnt["degraded"] += 1
        if stats["jev_calls"] > 0 and stats["jev_errors"] == stats["jev_calls"]:
            cnt["errors"] += 1   # every Jev call failed: there is no signal behind an empty result, so nothing is written
            return
        if ctx.clef_mode == "clef+jev" and stats["degraded"]:   # CLEF died mid-clip: what was actually done is Jev-only, and it must not block a later CLEF+Jev track
            config = track_config(stt_sha, tr_sha, ctx.cfg_sha, ctx.cfg_version, ctx.jev_model, "jev-only")
        track = build_track(row, clip, tags, stats, ctx.cfg, ctx.cfg_sha, ctx.cfg_version, config, stt_rel, stt_sha, tr_sha,
                            "caa" if (stt or {}).get("version") == "caa" else "palimpsest", cost, ctx.jev_model, ctx.jev_reported())
        try:
            writer.write_track(root, row["ist_date"], row["room_id"], track["window_id"], track, config_hash=track["config_hash"])
            cnt["written"] += 1
        except writer.TrackExistsError:
            cnt["skipped_existing"] += 1
    except (GuardUnavailable, BudgetStop):
        raise
    except Exception:   # noqa: BLE001 - one bad clip must not stop the run; counted, class only (a message could carry text)
        cnt["errors"] += 1


class Limit:
    def __init__(self, n):
        self.n, self.taken = n, 0

    def exhausted(self):
        return bool(self.n) and self.taken >= self.n

    def take(self):
        self.taken += 1


def run(args, root=None, is_held=None, ctx=None, index_path=sl.CLIP_INDEX, clips_root=sl.CLIPS):
    """-> counters. Fails closed on the pin, the config and the heldout guard BEFORE any clip is read."""
    root = root or REB
    verify_vendored()
    is_held = is_held or load_heldout()
    if ctx is None:
        cfg, cfg_sha, cfg_version = load_config(getattr(args, "config", None) or CONFIG_PATH)
        ctx = Ctx(cfg, cfg_sha, cfg_version, Spend(cap=getattr(args, "daily_cap_usd", DAILY_CAP_USD)))
    cnt = collections.Counter({k: 0 for k in COUNTERS})
    ok = bool(ctx.preflight())    # decided once, before any tagging
    ctx.clef_mode = "clef+jev" if ok else "jev-only"
    cnt["clef_preflight_ok" if ok else "clef_preflight_failed"] += 1
    rows = sl.select(args, index_path)
    if getattr(args, "until", None):
        rows = [r for r in rows if r["ist_date"] <= args.until]
    limit = Limit(getattr(args, "limit", 0)) if args.write else None
    try:
        for r in rows:
            process(r, root, is_held, args.write, cnt, ctx, clips_root, limit)
    except BudgetStop:
        pass   # counted budget_stopped; the clips after it are left for the next run (the day's cap)
    out = dict(cnt)
    out["clef_mode"] = ctx.clef_mode
    out["cost_usd"] = round(ctx.spend.spent(), 6) if args.write else 0.0
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--consult")
    g.add_argument("--date")
    g.add_argument("--since")
    ap.add_argument("--until", default=None, help="last ist_date included (inclusive)")
    ap.add_argument("--write", action="store_true", help="call CLEF and Jev and write the tracks (default: dry run, nothing is called)")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=0, help="at most N clips are sent to CLEF / Jev")
    ap.add_argument("--daily-cap-usd", type=float, default=DAILY_CAP_USD, help="CLEF spend cap per IST day (default 5.0, until consult-lead sets one)")
    ap.add_argument("--clef-usd-per-call", type=float, default=CLEF_USD_PER_CALL, help="PROVISIONAL price of one CLEF call")
    ap.add_argument("--config", default=CONFIG_PATH)
    ap.add_argument("--root")
    a = ap.parse_args(argv)
    if a.dry_run:
        a.write = False
    a.min_minutes, a.identified = 0, False
    out = {}
    client = logf = None
    ctx = None
    cfg, cfg_sha, cfg_version = load_config(a.config)
    if a.write:
        import threading
        lock = threading.Lock()
        path = os.path.join(sl.OUT_DIR, "jev-calls-parts-" + time.strftime("%Y%m%dT%H%M%S") + ".jsonl")
        os.makedirs(sl.OUT_DIR, exist_ok=True)
        logf = os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600), "a")

        def log(meta):   # one 0600 JSONL line per call: status, latency, attempt, tokens. Never the state, the questions or the key.
            with lock:
                logf.write(json.dumps({"ts": time.strftime("%H:%M:%S"), "use": "17A", **meta}, sort_keys=True) + "\n")
                logf.flush()
        client = jev_client.JevClient(log=log)
        ctx = Ctx(cfg, cfg_sha, cfg_version, Spend(cap=a.daily_cap_usd), clef_fn=None, jev_fn=make_jev_fn(client), jev_model=client.model,
                  jev_reported=lambda: client.model_id, usd_per_call=a.clef_usd_per_call)
    else:
        ctx = Ctx(cfg, cfg_sha, cfg_version, Spend(cap=a.daily_cap_usd), jev_model=jev_client.MODEL, usd_per_call=a.clef_usd_per_call)
    try:
        out["counts"] = run(a, root=a.root, ctx=ctx)
    finally:
        if logf:
            logf.close()
    if client:
        st = client.stats
        out["jev_call_log"] = path
        out["jev"] = {"model": client.model_id, "calls": st["calls"], "ok": st["ok"], "retries": st["retries"], "errors": st["errors"],
                      "input_tokens": st["input_tokens"], "output_tokens": st["output_tokens"]}
    out["spend"] = {"clef_usd_today": round(ctx.spend.spent(), 6), "cap_usd": ctx.spend.cap}
    print(json.dumps(out, sort_keys=True))
    return 0


def make_jev_fn(client):
    """The tagger's own Jev question (parts_tag._default_jev), sent through the role judge's JevClient (same key file, same retries, metadata logging) instead of the tagger's
    private import path. The state and the questions are built exactly as the tagger builds them."""
    def jev_fn(prev, cur):
        state = "Excerpt from a doctor-patient consultation in an outpatient clinic.\n" + ("[Earlier] " + " / ".join(prev) + "\n" if prev else "") + "[Now] " + " / ".join(cur)
        qs = {ty: {"type": "noul", "instructions": "In the [Now] part: " + d + "?", "criteria": {"true": "Yes", "false": "No"}} for ty, d in pt.TYPES.items()}
        r = client._post({"state": state, "model": client.model, "questions": qs})
        return {ty: ((r.get("answers") or {}).get(ty, {}).get("noul") or 0.0) for ty in pt.TYPES}
    return jev_fn


if __name__ == "__main__":
    sys.exit(main())
