#!/usr/bin/env python3
"""REB fuser v0 (Fable 13:35 order): M6 (SraVaani-script language pick) + ETR (Whisper numeral
recovery), reimplemented as pure functions over REB tracks instead of live engine calls inside
process_segment. Uses reb's real reader/writer library, PINNED and ENFORCED to eta-lab main @
a447dc36 (kit/reb merged, reb #4657; PASSed by eta-refuter-2 as 18c52b9f, #4632). REB_LIB_PATH_PIN
below is asserted against REB_LIB_PATH's actual git HEAD at import time (eta-refuter-2 #4661 P1): a
stale checkout refuses to import rather than silently changing v0's behavior.

Core logic (pick_indic_lang_by_sravaani, find_value_anchor, recover_english_numerals, the Devanagari
normalisation tables) is imported UNCHANGED from router_server.py -- the fuser only reshapes REB track
segments into the (sra_text, indic_results, w_text) shape those functions already take, and writes a
fused.* track back out via reb's writer. No engine calls happen here: REB has already run every engine
independently; the only "call" this file makes into router_server.py's M6 function is a stand-in for
the hi/mr ctc tiebreak, answered from an already-fetched track (see _ctc_infer below), not a live call.

ETR on/off (eta-refuter-2 #4656/#4661 P2, lid-debug's ADDENDUM-1 V0-noETR): set ETA_FUSER_ETR=0 to
disable ETR entirely for a V0-noETR build. The flag's value is part of `config`, so it changes
config_hash (a different, addressable track file), never a silent variant of the same one.
"""
import hashlib
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import router_server as rs  # noqa: E402

REB_LIB_PATH = os.environ.get("REB_LIB_PATH", "/tmp/wt-reb-a447dc36")
REB_LIB_PATH_PIN = os.environ.get("REB_LIB_PATH_PIN", "a447dc367d6ba825c9fe63b78fee7a9652bb3988")
sys.path.insert(0, REB_LIB_PATH + "/kit")
import reb as reb_pkg  # noqa: E402  -- kit/reb's __init__.py re-exports load_window/write_track/etc.


def _checked_reb_sha() -> str:
    """P1 (+ eta-refuter-2 #4671 note i): refuse to import a stale or dirty REB_LIB_PATH silently.
    Raises if HEAD != REB_LIB_PATH_PIN, or if the checkout has uncommitted changes (a clean HEAD match
    on a dirty tree would still be running unreviewed code). Logs when REB_LIB_PATH_PIN itself was
    overridden from the built-in default, since that's a deliberate escape hatch, not silent drift."""
    default_pin = "a447dc367d6ba825c9fe63b78fee7a9652bb3988"
    if REB_LIB_PATH_PIN != default_pin:
        sys.stderr.write(f"[fuser_v0] REB_LIB_PATH_PIN overridden from the built-in {default_pin} to "
                         f"{REB_LIB_PATH_PIN} -- say so in the freeze record.\n")
    try:
        head = subprocess.run(["git", "-C", REB_LIB_PATH, "rev-parse", "HEAD"],
                              check=True, capture_output=True, text=True).stdout.strip()
        dirty = subprocess.run(["git", "-C", REB_LIB_PATH, "status", "--porcelain"],
                               check=True, capture_output=True, text=True).stdout.strip()
    except Exception as e:
        raise RuntimeError(f"REB_LIB_PATH={REB_LIB_PATH!r} is not a git checkout I can verify: {e!r}") from e
    if head != REB_LIB_PATH_PIN:
        raise RuntimeError(
            f"REB_LIB_PATH={REB_LIB_PATH!r} is at {head}, not the pinned {REB_LIB_PATH_PIN} -- "
            "refusing to run fuser_v0 against an unverified reb library. Check out the pinned sha, "
            "or set REB_LIB_PATH_PIN to the sha you intend (and say so in the freeze record).")
    if dirty:
        raise RuntimeError(
            f"REB_LIB_PATH={REB_LIB_PATH!r} is at the pinned {head} but has uncommitted changes -- "
            "refusing to run fuser_v0 against unreviewed local edits on top of a pinned sha:\n" + dirty)
    return head


REB_SHA = _checked_reb_sha()


ALLOW_DIRTY_CODE = os.environ.get("ETA_FUSER_ALLOW_DIRTY_CODE", "0") in ("1", "true", "True")


def _fuser_code_sha() -> tuple[str | None, bool]:
    """(sha, dirty) for the router-fix repo's own HEAD, so a fused track names the code that produced
    it (eta-refuter-2 #4671 note ii). (None, False) if this isn't a git checkout (e.g. installed some
    other way). REFUSES if the checkout is dirty, same posture as the reb pin (lid-debug #4687: a
    best-effort sha suffix understates the risk -- an unclean fuser checkout means unreviewed code
    produced this track, not just an unrecorded one), unless ETA_FUSER_ALLOW_DIRTY_CODE overrides it
    (logged, an explicit escape hatch, not silent)."""
    repo = os.path.dirname(os.path.abspath(__file__))
    try:
        sha = subprocess.run(["git", "-C", repo, "rev-parse", "HEAD"],
                             check=True, capture_output=True, text=True).stdout.strip()
        dirty = bool(subprocess.run(["git", "-C", repo, "status", "--porcelain"],
                                    check=True, capture_output=True, text=True).stdout.strip())
    except Exception:
        return None, False
    if dirty:
        if ALLOW_DIRTY_CODE:
            sys.stderr.write("[fuser_v0] ETA_FUSER_ALLOW_DIRTY_CODE overrides a dirty router-fix "
                             f"checkout at {repo} -- fuser_code_sha={sha} is NOT what's actually running.\n")
        else:
            raise RuntimeError(
                f"router-fix checkout at {repo} has uncommitted changes -- refusing to run fuser_v0 "
                "from unreviewed local edits. Commit or stash, or set ETA_FUSER_ALLOW_DIRTY_CODE=1 to "
                "override (logged, for local dev only, never for a real run).")
    return sha, dirty


FUSER_CODE_SHA, FUSER_CODE_DIRTY = _fuser_code_sha()

FUSER_ENGINE, FUSER_VERSION = "fuser-v0-m6-etr", "1"  # reb #4537's naming convention
ETR_ENABLED = os.environ.get("ETA_FUSER_ETR", "1") not in ("0", "false", "False")


def _track_spans(track) -> list[dict]:
    """[{t0_ms, t1_ms, text}] from a reb.Track, empty if missing/failed. `track` is None when tracks()
    found nothing for that (layer, engine) -- a normal case (e.g. no indic-ctc-mr track this window)."""
    if track is None or track.status != "ok":
        return []
    return [{"t0_ms": s["t0_ms"], "t1_ms": s["t1_ms"], "text": (s.get("text") or "").strip()}
            for s in track.segments if s.get("text")]


def _one(w, layer: str, engine: str):
    ts = w.tracks(layer=layer, engine=engine)
    return ts[0] if ts else None


def fuse_window(window_id: str, ist_date: str | None = None, room_id: str | None = None,
                etr_enabled: bool | None = None, root: str | None = None) -> dict:
    """Fuse one REB window's stt tracks into a fused track: M6 language pick (SraVaani script) + ETR
    numeral recovery (insert-after-anchor, unless etr_enabled is False -- the V0-noETR arm), per
    SraVaani span. Returns a reb.track.v1-shaped dict ready for reb_pkg.write_track (not written here
    -- see write_fused_window). etr_enabled defaults to the ETR_ENABLED module flag (ETA_FUSER_ETR).
    root overrides reb_pkg's DEFAULT_ROOT (REB_ROOT env) for testing against a throwaway REB tree."""
    etr_on = ETR_ENABLED if etr_enabled is None else etr_enabled
    w = reb_pkg.load_window(window_id, ist_date=ist_date, room_id=room_id, root=root)
    sra_spans = _track_spans(_one(w, "stt", "sravaani"))
    whisper_spans = _track_spans(_one(w, "stt", "whisper-forced-en") or _one(w, "stt", "whisper-auto"))
    conformer_by_lang = {
        eng.split("-", 2)[2]: _track_spans(_one(w, "stt", eng))
        for eng in ("indic-ctc-kn", "indic-ctc-hi", "indic-ctc-ta", "indic-ctc-te", "indic-ctc-ml")
    }

    fused_segments = []
    # One fused segment per SraVaani span (SraVaani's own segmentation is the fusion unit in v0; a
    # later version may re-segment across tracks -- not attempted here).
    for sp in sra_spans:
        t0, t1 = sp["t0_ms"], sp["t1_ms"]
        sra_text = sp["text"]
        indic_results = {lang: " ".join(s["text"] for s in spans if s["t0_ms"] < t1 and s["t1_ms"] > t0)
                         for lang, spans in conformer_by_lang.items()}
        indic_results = {k: v for k, v in indic_results.items() if v}
        w_text = " ".join(s["text"] for s in whisper_spans if s["t0_ms"] < t1 and s["t1_ms"] > t0)

        # M6's hi/mr tiebreak wants a live ctc call in the router; REB's indic-ctc-* tracks already ran
        # ctc decoding for every candidate language up front, so answer from what's already fetched.
        def _ctc_infer(wav_path, language, decoding="rnnt", timeout=None):
            return {"text": indic_results.get(language, "")}

        lang = rs.pick_indic_lang_by_sravaani(sra_text, indic_results, _ctc_infer, window_id)
        if lang is None:
            cands = {**indic_results, "sravaani": sra_text}
            lang = max(cands, key=lambda k: rs.score_asr_text_grapheme(cands[k])) if cands else None
            text = cands.get(lang, sra_text) if lang else sra_text
            engine = "sravaani" if lang in (None, "sravaani") else "indicconformer"
        else:
            text = indic_results.get(lang, sra_text)
            engine = "indicconformer" if lang in indic_results else "sravaani"

        if etr_on and w_text:
            etr = rs.recover_english_numerals(text, w_text)
        else:
            etr = {"text": text, "recovered": [], "unanchored": []}
        fused_segments.append({
            "t0_ms": t0, "t1_ms": t1, "text": etr["text"], "lang": lang, "engine": engine,
            "extras": {"etr_recovered": etr["recovered"], "etr_unanchored": etr["unanchored"]},
        })

    config = {"m6": "sravaani_script_v4", "etr_enabled": etr_on, "reb_sha": REB_SHA,
              "fuser_code_sha": FUSER_CODE_SHA, "fuser_code_dirty": FUSER_CODE_DIRTY}
    return {
        "schema": "reb.track.v1", "window_id": window_id, "layer": "fused",
        "engine": FUSER_ENGINE, "model": "router-fix/router_server.py@" + FUSER_VERSION,
        "version": FUSER_VERSION,
        "config": config, "config_hash": reb_pkg.config_hash(config),
        "machine": os.uname().nodename, "status": "ok", "reason": None,
        "segments": fused_segments,
    }


def write_fused_window(window_id: str, ist_date: str, room_id: str, root: str | None = None,
                       etr_enabled: bool | None = None) -> str:
    """Fuse and write the track via reb's own writer (append-only; raises TrackExistsError if this
    exact (engine, version, config_hash) was already written for this window -- V0 and V0-noETR land
    as two distinct track files, since etr_enabled is part of config/config_hash)."""
    track = fuse_window(window_id, ist_date=ist_date, room_id=room_id, etr_enabled=etr_enabled)
    return reb_pkg.write_track(root or reb_pkg.reb.DEFAULT_ROOT, ist_date, room_id, window_id, track)


if __name__ == "__main__":
    result = fuse_window(sys.argv[1], ist_date=sys.argv[2] if len(sys.argv) > 2 else None,
                         room_id=sys.argv[3] if len(sys.argv) > 3 else None)
    print(json.dumps(result, ensure_ascii=False, indent=1))
