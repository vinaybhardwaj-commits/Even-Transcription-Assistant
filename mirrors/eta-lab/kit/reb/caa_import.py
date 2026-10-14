"""caa_import.py: file CAA's September Sarvam results into the REB consult scope (ORDERS-PALIMPSEST-14A part 1). No Sarvam call, no audio, read-only on CAA's files.

Input: /home/eta/oc/palimpsest/in/caa/sarvam/<consult_uid>.json (copied hourly from the Mini mirror of CAA's sep-caa-sarvam): consult_uid, room (a LABEL: OPD 1 ... Dietary), t0_utc_ms / t1_utc_ms,
boundary_source, doctor_uid, status (ok | no_speech | no_consult_speech), segments [{t0_utc_ms, t1_utc_ms, speaker (doctor | patient | unknown: CAA's own roles), speaker_code, lang, text, en}], and the provenance
fields stt, translate ("sarvam mayura:v1"), speaker_source, masked ("names and phone/ID numbers masked (smask)"), room_basis, clip_t0_utc_ms, clip_s.
Output, under reb/<ist_date>/<room_id>/_consults/<consult_uid>/ (window_id "consult-<uid>", via writer.write_track, append-only):
  stt.sarvam-saaras-v3     version "caa"  segments {t0_ms, t1_ms, text, lang, speaker, extras{speaker_code, role_source: "caa"}}; status ok if there are segments, else empty (reason = CAA's status)
  translate.sarvam-mayura-v1 version "caa" the `en` of every segment that has one, lang en-IN, extras.source_language_code = the segment's lang; the translator is CAA's Mayura ("sarvam mayura:v1")
  role.caa-labels          version "caa"  one segment per stt turn {t0_ms, t1_ms, speaker, role}: CAA's own doctor / patient / attendant / unknown labels as given (never a voiceprint identity)
  manifest.json            source_kind "consult_clip_external", boundary_source, clock tape_utc, audio {r2_key "external:caa/<uid>", sha256 = the source file's, sample_rate 0, duration_ms = t1 - t0} (there is no audio
                           on the box), consult.attribution.doctor_identified (a boolean; the doctor id is NOT copied), provenance {caller "caa", file sha256, room_basis, speaker_source, masked}.
cfg8 = sha256 of {caller, source_sha256, version, layer}[:8], so a changed source file is a new track and a rerun is a no-op (skipped_existing).
Room label -> room_id through room-labels.json (equal, or the label followed by a space: "OPD 4" -> "OPD 4 Ortho"); an unmapped or ambiguous label is skipped and counted. The held-out guard
(from_hist.load_heldout, fail closed; empty after the lift) is applied to the consult span. Names and phone/ID numbers in CAA's text are already masked by CAA; this module neither unmasks nor reads them.
"""
import argparse
import collections
import datetime
import glob
import hashlib
import json
import os
import sys

from . import writer
from .from_hist import IST, load_heldout, window_held
from .schema import SCHEMA_VERSION
from .validate import validate_track

SRC_DIR = "/home/eta/oc/palimpsest/in/caa/sarvam"
ROOM_LABELS = "/home/eta/oc/palimpsest/in/room-labels.json"
ENGINE, VERSION, MACHINE = "sarvam-saaras-v3", "caa", "box-caa-import"
TR_ENGINE, TR_MODEL = "sarvam-mayura-v1", "mayura:v1"   # CAA's English is Mayura, not Saaras translate (architect #11439 ruling 4)
ROLE_ENGINE = "caa-labels"
ROLES = ("doctor", "patient", "attendant", "unknown")
REQUIRED = ("consult_uid", "room", "t0_utc_ms", "t1_utc_ms", "boundary_source", "status", "segments")
COUNTERS = ("roles", "role_labels_other", "files", "filed", "would_file", "skipped_existing", "unmapped_room", "bad_file", "blind_refused", "empty_tracks", "no_translate", "segments", "translate_segments")


def room_map(labels_path=ROOM_LABELS):
    rooms = json.load(open(labels_path))["rooms"]
    return [(r["label"], r["room_id"]) for r in rooms]


def map_room(label, rooms):
    """-> room_id, or None for an unmapped or ambiguous label."""
    label = (label or "").strip()
    hit = [rid for lab, rid in rooms if label and (lab == label or lab.startswith(label + " "))]
    return hit[0] if len(hit) == 1 else None


def load_result(path):
    """-> (result dict, sha256 of the file bytes). ValueError on anything malformed."""
    raw = open(path, "rb").read()
    d = json.loads(raw)
    if not isinstance(d, dict) or any(k not in d for k in REQUIRED):
        raise ValueError("missing required key")
    uid = str(d["consult_uid"])
    if not uid or "/" in uid or ".." in uid or uid != os.path.basename(path)[:-5]:
        raise ValueError("consult_uid does not match the file name")
    t0, t1 = int(d["t0_utc_ms"]), int(d["t1_utc_ms"])
    if t1 <= t0 or not isinstance(d["segments"], list):
        raise ValueError("bad span or segments")
    for s in d["segments"]:
        int(s["t0_utc_ms"]), int(s["t1_utc_ms"])
        if int(s["t1_utc_ms"]) < int(s["t0_utc_ms"]):
            raise ValueError("segment ends before it starts")
    return d, hashlib.sha256(raw).hexdigest()


def ist_date(ms):
    return datetime.datetime.fromtimestamp(ms / 1000, IST).strftime("%Y-%m-%d")


def config_for(layer, sha):
    return {"caller": "caa", "source_sha256": sha, "version": VERSION, "layer": layer}


def build_stt(res, sha, window_id):
    segs = [{"t0_ms": int(s["t0_utc_ms"]), "t1_ms": int(s["t1_utc_ms"]), "text": s.get("text") or "", "lang": s.get("lang"), "speaker": str(s.get("speaker")),
             "extras": {"speaker_code": s.get("speaker_code"), "role_source": "caa"}} for s in res["segments"]]
    cfg = config_for("stt", sha)
    ok = bool(segs)
    t = {"schema": SCHEMA_VERSION, "window_id": window_id, "layer": "stt", "engine": ENGINE, "model": "saaras:v3", "version": VERSION, "config": cfg, "config_hash": writer.config_hash(cfg),
         "machine": MACHINE, "status": "ok" if ok else "empty", "reason": None if ok else f"CAA status {res['status']}", "segments": segs,
         "extras": {"caller": "caa", "source_sha256": sha, "caa_status": res["status"], "stt": str(res.get("stt"))[:200], "speaker_source": str(res.get("speaker_source"))[:200],
                    "masked": str(res.get("masked"))[:200], "room_basis": res.get("room_basis"), "boundary_source": res["boundary_source"],
                    "clip_t0_utc_ms": res.get("clip_t0_utc_ms"), "clip_s": res.get("clip_s")}}
    validate_track(t)
    return t


def build_translate(res, sha, window_id):
    segs = [{"t0_ms": int(s["t0_utc_ms"]), "t1_ms": int(s["t1_utc_ms"]), "text": s["en"], "lang": "en-IN", "speaker": str(s.get("speaker")),
             "extras": {"source_language_code": s.get("lang")}} for s in res["segments"] if (s.get("en") or "").strip()]
    if not segs:
        return None
    cfg = config_for("translate", sha)
    t = {"schema": SCHEMA_VERSION, "window_id": window_id, "layer": "translate", "engine": TR_ENGINE, "model": TR_MODEL, "version": VERSION, "config": cfg, "config_hash": writer.config_hash(cfg),
         "machine": MACHINE, "status": "ok", "reason": None, "segments": segs,
         "extras": {"caller": "caa", "source_sha256": sha, "translator": str(res.get("translate"))[:200], "translated_to": "en-IN", "masked": str(res.get("masked"))[:200]}}
    validate_track(t)
    return t


def build_roles(res, sha, window_id):
    """role.caa-labels version caa (architect #11439 ruling 2): CAA's own speaker roles per stt turn, as given (doctor / patient / attendant / unknown; any other label becomes unknown and is counted in
    extras.labels_other). Provenance caller caa; these are labels CAA assigned, NEVER a voiceprint identity and never produced by the text judge."""
    segs, other = [], collections.Counter()
    for s in res["segments"]:
        lab = str(s.get("speaker"))
        if lab not in ROLES:
            other[lab] += 1
        segs.append({"t0_ms": int(s["t0_utc_ms"]), "t1_ms": int(s["t1_utc_ms"]), "speaker": lab, "role": lab if lab in ROLES else "unknown"})
    mp = {lab: {"role": lab if lab in ROLES else "unknown"} for lab in sorted({s["speaker"] for s in segs})}
    cfg = config_for("role", sha)
    t = {"schema": SCHEMA_VERSION, "window_id": window_id, "layer": "role", "engine": ROLE_ENGINE, "model": "caa-labels", "version": VERSION, "config": cfg, "config_hash": writer.config_hash(cfg),
         "machine": MACHINE, "status": "ok" if segs else "empty", "reason": None if segs else f"CAA status {res['status']}", "segments": segs,
         "extras": {"caller": "caa", "source_sha256": sha, "map": mp, "role_source": "caa_labels", "speaker_source": str(res.get("speaker_source"))[:200], "labels_other": dict(other),
                    "identity": "CAA's own role labels; not a voiceprint identity", "consult_uid": res["consult_uid"]}}
    validate_track(t)
    return t


def manifest_stub(res, sha, window_id, room_id, label):
    t0, t1 = int(res["t0_utc_ms"]), int(res["t1_utc_ms"])
    return {"window_id": window_id, "room_id": room_id, "room_slug": label, "ist_date": ist_date(t0), "t0_ms": t0, "t1_ms": t1, "clock": "tape_utc", "source_kind": "consult_clip_external",
            "boundary_source": res["boundary_source"],
            "audio": {"r2_key": f"external:caa/{res['consult_uid']}", "sha256": sha, "sample_rate": 0, "duration_ms": t1 - t0},
            "consult": {"attribution": {"doctor_identified": bool(res.get("doctor_uid"))}},
            "provenance": {"caller": "caa", "file_sha256": sha, "room_basis": res.get("room_basis"), "speaker_source": str(res.get("speaker_source"))[:200], "masked": str(res.get("masked"))[:200]}}


def file_all(src_dir=SRC_DIR, root=None, labels_path=ROOM_LABELS, write=False, is_held=None, limit=0):
    """-> counters. Dry run (default) maps and validates every file and counts what it would file; nothing is written."""
    from . import reb
    root = root or reb.DEFAULT_ROOT
    is_held = is_held or load_heldout()   # fail closed
    rooms = room_map(labels_path)
    cnt = collections.Counter({k: 0 for k in COUNTERS})
    for path in sorted(glob.glob(os.path.join(src_dir, "*.json"))):
        if limit and cnt["filed"] + cnt["would_file"] >= limit:
            break
        cnt["files"] += 1
        try:
            res, sha = load_result(path)
        except (ValueError, KeyError, TypeError, OSError):
            cnt["bad_file"] += 1
            continue
        room_id = map_room(res["room"], rooms)
        if room_id is None:
            cnt["unmapped_room"] += 1
            continue
        t0, t1 = int(res["t0_utc_ms"]), int(res["t1_utc_ms"])
        if window_held(is_held, room_id, t0, t1):
            cnt["blind_refused"] += 1
            continue
        wid = "consult-" + res["consult_uid"]
        date = ist_date(t0)
        tracks = [build_stt(res, sha, wid)]
        roles = build_roles(res, sha, wid)
        tracks.append(roles)
        cnt["role_labels_other"] += sum(roles["extras"]["labels_other"].values())
        tr = build_translate(res, sha, wid)
        if tr is None:
            cnt["no_translate"] += 1
        else:
            tracks.append(tr)
        if not write:
            cnt["would_file"] += 1
            continue
        stub = manifest_stub(res, sha, wid, room_id, res["room"])
        wrote = False
        for t in tracks:
            try:
                writer.write_track(root, date, room_id, wid, t, manifest_stub=stub, config_hash=t["config_hash"])
                wrote = True
                cnt["segments" if t["layer"] == "stt" else "translate_segments" if t["layer"] == "translate" else "roles"] += len(t["segments"]) if t["layer"] != "role" else 1
                cnt["empty_tracks"] += 1 if t["status"] == "empty" else 0
            except writer.TrackExistsError:
                pass
        cnt["filed" if wrote else "skipped_existing"] += 1
    return dict(cnt)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--src", default=SRC_DIR)
    ap.add_argument("--root")
    ap.add_argument("--write", action="store_true", help="file the tracks (default: a dry run that validates and counts)")
    ap.add_argument("--limit", type=int, default=0)
    a = ap.parse_args(argv)
    print(json.dumps({"write": a.write, "counts": file_all(a.src, root=a.root, write=a.write, limit=a.limit)}, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
