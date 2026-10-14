"""role_map.py: role layer for Sarvam consult tracks (ORDERS-PALIMPSEST-6S8). Maps each Sarvam diar speaker id to doctor | other | unknown.

NO Sarvam call. Reads the live ok diar.sarvam-saaras-v3 track of a consult clip and the CONSULT cutter's timeline.json (voiceprint turns labelled
"doctor" or S1..Sn), read-only. Writes one derived track per clip: layer "role", engine "sarvam-doctor-map", version "v1", window_id consult-<uid>,
through writer.write_track into the clip's own _consults/<uid>/ dir. Segments carry no text.

Rule v1 (RULE below is hashed into the cfg8, so a rule change is a new track)
- doctor_identified false (cutter row) -> status skipped, reason doctor_not_identified, no segments.
- For each Sarvam speaker id: talk_s = seconds covered by its diar turns (union of its intervals), doctor_overlap_s = seconds of that union that lie
  inside the union of the cutter's "doctor" turns (tape time: span start + start_s), share = doctor_overlap_s / talk_s.
- Within one group (an unsplit clip is one group; a split consult has one group per part, ids are namespaced p<k>:<id> as in diar), the speaker
  with the highest share is "doctor" if share >= 0.5 and talk_s >= 10. A tie on share is broken by doctor_overlap_s; a tie on both leaves the
  group without a doctor (every tied candidate is "unknown"). A second candidate over the thresholds is "unknown" (at most one doctor per group).
- Every other speaker with talk_s >= 10 and share < 0.2 is "other". Everything else is "unknown".
"""
import argparse
import collections
import hashlib
import json
import os
import sys

from . import sarvam_lane as sl
from . import writer
from .from_hist import GuardUnavailable, load_heldout, window_held
from .schema import SCHEMA_VERSION
from .validate import validate_track

REB = os.path.expanduser("~/eta-data/reb")
ENGINE, VERSION, LAYER = "sarvam-doctor-map", "v1", "role"
SRC_ENGINE = sl.ENGINE
RULE = {"rule": "v1", "doctor_min_share": 0.5, "doctor_min_talk_s": 10.0, "other_max_share": 0.2, "other_min_talk_s": 10.0}
COUNTERS = ("clips", "written", "would_write", "skipped_existing", "not_identified", "signature_mismatch", "no_diar", "blind_refused",
            "errors", "clips_one_doctor", "clips_zero_doctor", "clips_two_or_more_doctor", "roles_doctor", "roles_other", "roles_unknown")


# ---------------------------------------------------------------- pure rule
def merge(iv):
    out = []
    for a, b in sorted((a, b) for a, b in iv if b > a):
        if out and a <= out[-1][1]:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return out


def covered(iv):
    return sum(b - a for a, b in iv)


def inter(a, b):
    """Seconds shared by two already-merged interval lists."""
    i = j = 0
    tot = 0.0
    while i < len(a) and j < len(b):
        lo, hi = max(a[i][0], b[j][0]), min(a[i][1], b[j][1])
        if hi > lo:
            tot += hi - lo
        if a[i][1] < b[j][1]:
            i += 1
        else:
            j += 1
    return tot


def group_of(speaker):
    """'p2:3' -> 'p2'; an unsplit clip's bare id -> ''."""
    return speaker.split(":", 1)[0] if ":" in speaker else ""


def map_roles(turns, doctor_turns):
    """turns: [(t0_s, t1_s, speaker)] of the diar track; doctor_turns: [(t0_s, t1_s)] on the same clock. -> {speaker: dict(role, share, talk_s, doctor_overlap_s)}."""
    doc = merge(doctor_turns)
    per = collections.defaultdict(list)
    for a, b, sp in turns:
        per[sp].append((a, b))
    stats = {}
    for sp, iv in per.items():
        m = merge(iv)
        talk = covered(m)
        ov = inter(m, doc)
        stats[sp] = {"talk_s": talk, "doctor_overlap_s": ov, "share": (ov / talk) if talk > 0 else 0.0}
    out = {}
    groups = collections.defaultdict(list)
    for sp in stats:
        groups[group_of(sp)].append(sp)
    for g, sps in groups.items():
        cand = [s for s in sps if stats[s]["share"] >= RULE["doctor_min_share"] and stats[s]["talk_s"] >= RULE["doctor_min_talk_s"]]
        doctor = None
        if cand:
            best = max((stats[s]["share"], stats[s]["doctor_overlap_s"]) for s in cand)
            top = [s for s in cand if (stats[s]["share"], stats[s]["doctor_overlap_s"]) == best]
            doctor = top[0] if len(top) == 1 else None
        for s in sps:
            st = stats[s]
            if s == doctor:
                role = "doctor"
            elif s not in cand and st["talk_s"] >= RULE["other_min_talk_s"] and st["share"] < RULE["other_max_share"]:
                role = "other"
            else:
                role = "unknown"
            out[s] = {"role": role, "share": round(st["share"], 4), "talk_s": round(st["talk_s"], 3), "doctor_overlap_s": round(st["doctor_overlap_s"], 3)}
    return out


# ---------------------------------------------------------------- inputs
def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for blk in iter(lambda: f.read(1 << 20), b""):
            h.update(blk)
    return h.hexdigest()


def live_diar(root, row):
    """(relative path, absolute path, track) of the latest-finished live ok diar.sarvam-saaras-v3 track of the clip, or None."""
    wd = writer._window_dir(root, row["ist_date"], row["room_id"], "consult-" + row["consult_uid"])
    try:
        m = json.load(open(os.path.join(wd, "manifest.json")))
    except (OSError, ValueError):
        return None
    best = None
    for e in m.get("tracks", []):
        if e.get("layer") != "diar" or e.get("engine") != SRC_ENGINE or e.get("status") != "ok":
            continue
        p = os.path.join(root, e["path"])
        if os.path.exists(p) and (best is None or (e.get("finished_at") or "") >= (best[0] or "")):
            best = (e.get("finished_at"), e["path"], p)
    if not best:
        return None
    return best[1], best[2], json.load(open(best[2]))


def build_track(row, clip, diar_rel, diar_sha, tl_sha, diar):
    """Pure. -> the role track for this clip."""
    uid = row["consult_uid"]
    config = {"diar_sha256": diar_sha, "timeline_sha256": tl_sha, "rule": RULE}
    cfg = writer.config_hash(config)
    base = {"schema": SCHEMA_VERSION, "window_id": "consult-" + uid, "layer": LAYER, "engine": ENGINE, "model": "rule-v1", "version": VERSION,
            "config": config, "config_hash": cfg, "machine": "box-role-map"}
    derived = {"diar_path": diar_rel, "diar_sha256": diar_sha, "timeline_sha256": tl_sha}
    if not row.get("doctor_identified"):
        t = {**base, "status": "skipped", "reason": "doctor_not_identified", "segments": [],
             "extras": {"rule": RULE["rule"], "rule_params": RULE, "derived_from": derived, "consult_uid": uid, "clip_signature": row["signature"], "map": {}}}
        validate_track(t)
        return t
    s0 = clip["span_start_ms"]
    dturns = [(float(t["start_s"]), float(t["end_s"])) for t in clip["tl"].get("turns", []) if t.get("speaker") == "doctor"]
    segs_in = diar.get("segments", [])
    turns = [((sg["t0_ms"] - s0) / 1000.0, (sg["t1_ms"] - s0) / 1000.0, sg["speaker"]) for sg in segs_in]
    mp = map_roles(turns, dturns)
    segs = [{"t0_ms": sg["t0_ms"], "t1_ms": sg["t1_ms"], "speaker": sg["speaker"], "role": mp[sg["speaker"]]["role"]} for sg in segs_in]
    t = {**base, "status": "ok" if segs else "empty", "reason": None if segs else "diar track has no turns", "segments": segs,
         "extras": {"rule": RULE["rule"], "rule_params": RULE, "map": mp, "derived_from": derived, "consult_uid": uid,
                    "clip_signature": row["signature"], "n_doctor_turns": len(dturns)}}
    validate_track(t)
    return t


def role_path(root, row, track):
    wd = writer._window_dir(root, row["ist_date"], row["room_id"], "consult-" + row["consult_uid"])
    return os.path.join(wd, "tracks", writer.track_filename(LAYER, ENGINE, VERSION, track["config_hash"]))


# ---------------------------------------------------------------- run
def process(row, root, is_held, write, cnt, clips_root=sl.CLIPS):
    cnt["clips"] += 1
    try:
        if is_held(row["ist_date"], row["room_id"]):
            cnt["blind_refused"] += 1
            return
        found = live_diar(root, row)
        if not found:
            cnt["no_diar"] += 1
            return
        diar_rel, diar_abs, diar = found
        try:
            clip = sl.open_clip(row, clips_root)
        except sl.ClipRefused:
            cnt["signature_mismatch"] += 1
            return
        if window_held(is_held, row["room_id"], clip["span_start_ms"], clip["span_end_ms"]):
            cnt["blind_refused"] += 1
            return
        sig_ok = (diar.get("config") or {}).get("clip_signature") == row["signature"] and \
            bool(clip["tl"].get("doctor_identified")) == bool(row.get("doctor_identified"))
        if not sig_ok:
            cnt["signature_mismatch"] += 1
            return
        tl_path = os.path.join(os.path.dirname(clip["path"]), "timeline.json")
        track = build_track(row, clip, diar_rel, sha256_file(diar_abs), sha256_file(tl_path), diar)
        if track["status"] == "skipped":
            cnt["not_identified"] += 1
        else:
            nd = sum(1 for v in track["extras"]["map"].values() if v["role"] == "doctor")
            cnt["clips_one_doctor" if nd == 1 else "clips_zero_doctor" if nd == 0 else "clips_two_or_more_doctor"] += 1
            for v in track["extras"]["map"].values():
                cnt["roles_" + v["role"]] += 1
        if os.path.exists(role_path(root, row, track)):
            cnt["skipped_existing"] += 1
        elif write:
            try:
                writer.write_track(root, row["ist_date"], row["room_id"], track["window_id"], track, config_hash=track["config_hash"])
                cnt["written"] += 1
            except writer.TrackExistsError:
                cnt["skipped_existing"] += 1
        else:
            cnt["would_write"] += 1
    except GuardUnavailable:
        raise
    except Exception:   # noqa: BLE001 - one bad clip must not stop the run; counted
        cnt["errors"] += 1


def run(args, root=None, is_held=None, index_path=sl.CLIP_INDEX, clips_root=sl.CLIPS):
    root = root or REB
    is_held = is_held or load_heldout()   # fail closed before any write
    rows = sl.select(args, index_path)
    cnt = collections.Counter({k: 0 for k in COUNTERS})
    for r in rows:
        process(r, root, is_held, args.write, cnt, clips_root)
    return dict(cnt)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--consult")
    g.add_argument("--date")
    g.add_argument("--since")
    ap.add_argument("--write", action="store_true", help="write role tracks (default: dry-run)")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--root", help="REB root (default ~/eta-data/reb)")
    a = ap.parse_args(argv)
    if a.write and a.dry_run:
        ap.error("--write and --dry-run are exclusive")
    a.min_minutes, a.identified = 0, False
    print(json.dumps(run(a, root=a.root), sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
