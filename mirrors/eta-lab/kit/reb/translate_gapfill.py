"""translate_gapfill.py: Sarvam TEXT translation for the stt turns that have no English of their own (ORDER 20A T2, S6 consult audit; research use).

For each given consult_uid (cutter consults only) this finds the stt turns the audit exporter would leave with text_en = null: a non-English turn with no translate-track segment at its
index/time, no gap-fill yet, and no acceptable strict overlap (export_consult_audit's own rule, via build_turns). It sends exactly those turns' native text, one gateway call per turn
(text longer than MAX_CHARS is split at sentence/space boundaries and the pieces are joined), to Sarvam /translate (model mayura:v1, source language = the turn's lang, target en-IN) through
the same ZDR gateway, service account and SigV4 path sarvam_lane uses (Gateway). Nothing else is sent: no audio, no ids, no other turn.
Output: ONE new track per consult, window_id consult-<uid>, translate.sarvam-mayura-v1 version gapfill-v1, written with writer.write_track (append-only), segments
{t0_ms, t1_ms, speaker, lang en-IN, text, extras {source_turn_index, source_language_code}} for the filled turns only. cfg8 = hash of config {model, version, target, stt_sha256,
turns [[t0, t1, lang]...]}: the same needs on the same stt give the same cfg8 (a rerun is a no-op), a different set is a new track. A consult is written all-or-nothing: if any turn
fails, nothing is written for it (the next run retries it). The exporter reads the track as text_en source "gapfill" (exact t0/t1 match).
Usage contract v1.2: one ledger line per call (sarvam.call.v1: task text_translate, mode sync, model mayura:v1, audio_s 0, chars = input length, scope consult_clip, use research,
caller palimpsest, ref = the consult_uid); never text in the ledger. Stops: any throttled response, or more than STOP_FAILED failed calls -> the run stops starting new calls (counted).
Default is DRY-RUN (counts only, nothing is sent or written); --write sends and writes. --limit N = at most N consults actually sent. The heldout guard (fail closed) is applied to each
consult span before anything is sent. Stdout is counts only.
"""
import argparse
import collections
import hashlib
import json
import os
import re
import sys
import time

from . import export_consult_audit as eca
from . import r2_mirror, reb, writer
from . import sarvam_lane as sl
from .from_hist import GuardUnavailable, load_heldout, window_held
from .schema import SCHEMA_VERSION
from .validate import validate_track

MODEL, ENGINE, VERSION, TARGET = "mayura:v1", eca.GAPFILL_ENGINE, eca.GAPFILL_VERSION, "en-IN"
PATH = "/translate"
MAX_CHARS = 900          # Sarvam text translate takes at most 1000 characters per request
STOP_FAILED = 5
USE, SCOPE, MACHINE = "research", "consult_clip", "box-translate-gapfill"
LANG_CODE = re.compile(r"^[a-z]{2,3}-[A-Z]{2}$")
COUNTERS = ("consults", "skipped_not_cutter", "no_scope", "ambiguous_scope", "no_stt", "blind_refused", "nothing_to_fill", "consults_with_gaps", "turns_needed", "chars_needed",
            "skipped_existing", "would_send_consults", "sent_consults", "calls", "call_failures", "failed_consults", "written", "limit_reached", "stopped_throttled", "stopped_failed",
            "unparseable_tracks")


class Stop(RuntimeError):
    pass


def chunks(text, limit=MAX_CHARS):
    """Split text into pieces of at most `limit` characters, at sentence ends (. ? ! danda) when possible, else at a space, else hard."""
    text = text.strip()
    out = []
    while len(text) > limit:
        cut = max((m.end() for m in re.finditer(r"[.?!।]\s", text[:limit])), default=0)
        if cut < limit // 3:
            cut = text.rfind(" ", 0, limit) + 1
        if cut < limit // 3:
            cut = limit
        out.append(text[:cut].strip())
        text = text[cut:].strip()
    if text:
        out.append(text)
    return out


def source_code(lang):
    return lang if isinstance(lang, str) and LANG_CODE.match(lang) else "auto"


def needs_of(win, bad=None):
    """-> (turns that need a gap-fill, stt body). Each: {index, speaker, t0, t1, lang, text_native}. Cutter rule: version caa is never read."""
    turns = eca.build_turns(win, False, None, bad, None, with_meta=True)
    if not turns:
        return [], None
    need = [t for t in turns if t["text_en"] is None and not (isinstance(t["lang"], str) and t["lang"].lower().startswith("en"))]
    return need, eca.latest_ok(win, "stt", (eca.STT_ENGINE,), lambda v: v != "caa", bad)


def config_of(need, stt):
    return {"model": MODEL, "version": VERSION, "target": TARGET, "stt_sha256": hashlib.sha256(json.dumps(stt, sort_keys=True, ensure_ascii=False).encode()).hexdigest(),
            "turns": [[t["t0"], t["t1"], t["lang"]] for t in need]}


def build_track(uid, need, texts, config, n_calls, chars_in):
    segs = [{"t0_ms": t["t0"], "t1_ms": t["t1"], "speaker": t["speaker"], "lang": TARGET, "text": txt,
             "extras": {"source_turn_index": t["index"], "source_language_code": t["lang"]}} for t, txt in zip(need, texts)]
    tr = {"schema": SCHEMA_VERSION, "window_id": "consult-" + uid, "layer": "translate", "engine": ENGINE, "model": MODEL, "version": VERSION, "config": config,
          "config_hash": writer.config_hash(config), "machine": MACHINE, "status": "ok", "reason": None, "segments": segs,
          "extras": {"caller": sl.CALLER, "use": USE, "gap_fill": True, "translated_to": TARGET, "n_turns": len(segs), "n_calls": n_calls, "chars_in": chars_in,
                     "derived_from": {"stt_sha256": config["stt_sha256"]}, "created_at": sl._utc_iso()}}
    validate_track(tr)
    return tr


class Translator:
    """One gateway call per piece; every call is ledgered (counts and ids only). Raises Stop on a throttled response, GatewayError-free: a failed call is returned as None."""

    def __init__(self, gw, sink, cnt):
        self.gw, self.sink, self.cnt = gw, sink, cnt

    def piece(self, text, lang, uid):
        started, throttled_before = time.time(), self.gw.throttled
        status, http, rid, out = "failed", None, None, None
        key = f"gapfill-{self.cnt['calls'] + 1}"
        if self.sink is not None:
            self.sink.safe(self.sink.begin, key, "text_translate", 0, SCOPE, model=MODEL, mode="sync")
        try:
            r = self.gw.call("POST", PATH, {"input": text, "source_language_code": source_code(lang), "target_language_code": TARGET, "model": MODEL})
            rid, http = (r or {}).get("request_id"), 200
            out = ((r or {}).get("translated_text") or "").strip() or None
            status = "ok" if out else "failed"
        except Exception as e:  # noqa: BLE001 - a timeout, connection error, bad JSON or token error may still have been billed: it is ledgered as failed, never lost
            http = getattr(e, "status", None)
            self.cnt["call_errors_" + type(e).__name__] += 1   # class name only, never the message
        finally:
            if self.sink is not None:
                self.sink.safe(self.sink.end, key)
        throttled = self.gw.throttled > throttled_before
        self.cnt["calls"] += 1
        if status != "ok":
            self.cnt["call_failures"] += 1
        if self.sink is not None:
            line = self.sink.call_line(rid if isinstance(rid, str) and rid else "none", rid if isinstance(rid, str) else None, "text_translate", 0, started, time.time(), status, http, throttled, SCOPE, uid, model=MODEL, use=USE)
            line["mode"], line["chars"] = "sync", len(text)
            self.sink.safe(self.sink.record, line)
        if self.gw.throttled > 0:
            self.cnt["stopped_throttled"] = 1
            raise Stop("throttled")
        if self.cnt["call_failures"] > STOP_FAILED:
            self.cnt["stopped_failed"] = 1
            raise Stop("failed")
        return out


def run(uids, root=None, write=False, limit=0, gw=None, sink=None, is_held=None, index_path=sl.CLIP_INDEX):
    root = root or sl.REB_ROOT
    cnt = collections.Counter({k: 0 for k in COUNTERS})
    index = sl.latest_rows(index_path) if os.path.exists(index_path) else {}
    scopes = eca.scan_scopes(root)
    tr = Translator(gw, sink, cnt) if write else None
    bad = collections.Counter()
    sent = 0
    for uid in uids:
        cnt["consults"] += 1
        row = index.get(uid)
        if row is None:
            cnt["skipped_not_cutter"] += 1
            continue
        sc = scopes.get(uid) or []
        sc = [s for s in sc if s[0] == row.get("ist_date") and s[1] == row.get("room_id")] or sc
        if not sc:
            cnt["no_scope"] += 1
            continue
        if len(sc) > 1:
            cnt["ambiguous_scope"] += 1
            continue
        date, room, d = sc[0]
        mp = os.path.join(d, "manifest.json")
        win = reb.Window(root, json.load(open(mp)), mp)
        if window_held(is_held, room, win.manifest.get("t0_ms"), win.manifest.get("t1_ms")):
            cnt["blind_refused"] += 1
            continue
        need, stt = needs_of(win, bad)
        if stt is None:
            cnt["no_stt"] += 1
            continue
        if not need:
            cnt["nothing_to_fill"] += 1
            continue
        cnt["consults_with_gaps"] += 1
        cnt["turns_needed"] += len(need)
        cnt["chars_needed"] += sum(len(t["text_native"]) for t in need)
        config = config_of(need, stt)
        if os.path.exists(os.path.join(d, "tracks", writer.track_filename("translate", ENGINE, VERSION, writer.config_hash(config)))):
            cnt["skipped_existing"] += 1
            continue
        if not write:
            cnt["would_send_consults"] += 1
            continue
        if limit and sent >= limit:
            cnt["limit_reached"] = 1
            break
        sent += 1
        cnt["sent_consults"] += 1
        texts, n_calls, chars_in = [], 0, 0
        try:
            for t in need:
                parts = [tr.piece(p, t["lang"], uid) for p in chunks(t["text_native"])]
                n_calls += len(parts)
                chars_in += len(t["text_native"])
                if any(p is None for p in parts):
                    texts = None
                    break
                texts.append(" ".join(parts))
        except Stop:
            cnt["failed_consults"] += 1   # the consult in flight is not written
            break
        if texts is None:
            cnt["failed_consults"] += 1
            continue
        track = build_track(uid, need, texts, config, n_calls, chars_in)
        try:
            writer.write_track(root, date, room, track["window_id"], track, config_hash=track["config_hash"])
            cnt["written"] += 1
        except writer.TrackExistsError:
            cnt["skipped_existing"] += 1
    cnt["unparseable_tracks"] = bad["unparseable_tracks"]
    if gw is not None:
        cnt["throttled_responses"] = gw.throttled
    return dict(cnt)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--uids", required=True, help="file with one consult_uid per line")
    ap.add_argument("--write", action="store_true", help="send to Sarvam and write tracks (default: dry-run, counts only)")
    ap.add_argument("--limit", type=int, default=0, help="at most N consults actually sent")
    ap.add_argument("--root", default=None, help="REB root to write under (default ~/eta-data/reb)")
    ap.add_argument("--index", default=sl.CLIP_INDEX)
    a = ap.parse_args(argv)
    if a.write and r2_mirror.enabled():
        sys.exit("REB_R2_MIRROR is on: translate_gapfill must not push to R2; unset it")
    try:
        is_held = load_heldout()   # fail closed
    except GuardUnavailable:
        print("refused: held-out guard unavailable", file=sys.stderr)
        return 2
    gw = sink = None
    if a.write:
        keyf = os.environ.get("SARVAM_R2_KEY_FILE")
        sink = sl.UsageSink(put=sl.R2Put(keyf) if keyf and os.path.isfile(keyf) else None)
        gw = sl.Gateway()
        if sink.put is None:
            print("WARNING: SARVAM_R2_KEY_FILE not set: usage ledger and lane file are written locally only", file=sys.stderr)
    try:
        res = run(eca.read_uids(a.uids), root=a.root, write=a.write, limit=a.limit, gw=gw, sink=sink, is_held=is_held, index_path=a.index)
    finally:
        if sink is not None:
            sink.close()   # always: the lane file is brought up to date even when the run raised
    print(json.dumps({"mode": "write" if a.write else "dry-run", **res}, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
