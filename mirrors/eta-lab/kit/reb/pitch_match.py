"""pitch_match.py: match surgery-pitch clips to Sarvam consult transcripts for the Sentiment Analyzer (ORDERS-PALIMPSEST-9A).

No Sarvam call; read-only on the store. Input: a CSV with at least clip_id, scribe_room_id, window_from_ist, window_to_ist (other columns ignored).
Per clip: the Sarvam consult tracks (_consults/<uid>/ stt, translate where present) of that room whose consult span overlaps the IST window.
Output (0600, in a 0700 folder): one JSON per clip_id (the matched consult_uids, overlap_s, and the overlapping stt segments only: IST ISO times, speaker id, lang,
text, English from the translate track beside it where present) and index.csv (clip_id, consult_uids, overlap_s, status).
Status: matched = the consult spans cover >= 50% of the window; partial = some overlap; none = no overlap, or the room-day is blind (heldout first; then the JSON
carries no reason). Speaker ids only: no role (voiceprints are out, the text-judge role is not live), no cutter-row or doctor fields.
"""
import argparse
import csv
import datetime
import json
import os
import sys

from . import reb
from .from_hist import IST, load_heldout, window_held

OUT_DIR = "/home/eta/oc/palimpsest/out/sentiment-pitch-match"
MATCH_FRACTION = 0.5
SARVAM = "sarvam-saaras-v3"


def parse_ist(s):
    """'2026-10-08 10:15:00', '2026-10-08T10:15:00.5' or an ISO string with an offset -> epoch ms. A naive time is IST."""
    d = datetime.datetime.fromisoformat(str(s).strip().replace("Z", "+00:00"))
    if d.tzinfo is None:
        d = d.replace(tzinfo=IST)
    return int(round(d.timestamp() * 1000))


def ist_iso(ms):
    return datetime.datetime.fromtimestamp(ms / 1000, IST).isoformat(timespec="milliseconds")


def overlap_ms(a0, a1, b0, b1):
    return max(0, min(a1, b1) - max(a0, b0))


def ist_days(t0_ms, t1_ms):
    d0 = datetime.datetime.fromtimestamp(t0_ms / 1000, IST).date()
    d1 = datetime.datetime.fromtimestamp(max(t0_ms, t1_ms - 1) / 1000, IST).date()
    return [(d0 + datetime.timedelta(days=i)).isoformat() for i in range((d1 - d0).days + 1)]


def read_clips(path):
    rows = list(csv.DictReader(open(path, newline="")))
    need = ("clip_id", "scribe_room_id", "window_from_ist", "window_to_ist")
    if not rows or any(k not in rows[0] for k in need):
        raise ValueError("clip CSV needs columns: " + ",".join(need))
    return rows


def live_ok(window, layer):
    """The latest-finished ok sarvam <layer> Track of a consult Window (quarantined tracks are excluded by Window.tracks), or None."""
    ts = [t for t in window.tracks(layer=layer, engine=SARVAM) if t.status == "ok"]
    return max(ts, key=lambda t: t.entry.get("finished_at") or "") if ts else None


def english_for(seg, tr_segs):
    best, bo = None, 0
    for t in tr_segs:
        o = overlap_ms(seg["t0_ms"], seg["t1_ms"], t["t0_ms"], t["t1_ms"])
        if o > bo:
            best, bo = t, o
    return best.get("text") if best else None


def match_clip(clip, root, is_held):
    """-> the per-clip result dict (what goes to <clip_id>.json)."""
    w0, w1 = parse_ist(clip["window_from_ist"]), parse_ist(clip["window_to_ist"])
    room = clip["scribe_room_id"]
    res = {"clip_id": clip["clip_id"], "scribe_room_id": room, "window_from_ist": ist_iso(w0), "window_to_ist": ist_iso(w1), "window_s": round((w1 - w0) / 1000, 3),
           "status": "none", "overlap_s": 0.0, "consults": [], "segments": []}
    if w1 <= w0:
        res["reason"] = "empty_window"
        return res
    if any(is_held(d, room) for d in ist_days(w0, w1)) or window_held(is_held, room, w0, w1):   # heldout first; a blind room-day gives none with no reason
        return res
    spans = []
    for day in ist_days(w0, w1):
        for cw in reb.consults(day, room_id=room, root=root):
            c0, c1 = int(cw.t0_ms), int(cw.t1_ms)
            ov = overlap_ms(c0, c1, w0, w1)
            if not ov:
                continue
            stt = live_ok(cw, "stt")
            if stt is None:
                continue
            tr = live_ok(cw, "translate")
            trs = tr.segments if tr else []
            uid = cw.window_id[len("consult-"):] if cw.window_id.startswith("consult-") else cw.window_id
            segs = []
            for sg in sorted(stt.segments, key=lambda x: (x["t0_ms"], x["t1_ms"])):
                if overlap_ms(sg["t0_ms"], sg["t1_ms"], w0, w1):
                    s = {"consult_uid": uid, "t0_ist": ist_iso(sg["t0_ms"]), "t1_ist": ist_iso(sg["t1_ms"]), "speaker": str(sg.get("speaker")), "lang": sg.get("lang"),
                         "text": sg.get("text")}
                    if tr:
                        s["english"] = english_for(sg, trs)
                    segs.append(s)
            spans.append((max(c0, w0), min(c1, w1)))
            res["consults"].append({"consult_uid": uid, "overlap_s": round(ov / 1000, 3), "has_translate": bool(tr), "n_segments": len(segs)})
            res["segments"] += segs
    res["segments"].sort(key=lambda s: (s["t0_ist"], s["consult_uid"]))
    covered, covered_end = 0, None
    for a, b in sorted(spans):   # union of the consult spans inside the window
        if covered_end is None or a > covered_end:
            covered += b - a
            covered_end = b
        elif b > covered_end:
            covered += b - covered_end
            covered_end = b
    res["overlap_s"] = round(covered / 1000, 3)
    res["status"] = "none" if not covered else "matched" if covered >= MATCH_FRACTION * (w1 - w0) else "partial"
    return res


def run(csv_path, out_dir, root=None, is_held=None):
    root = root or reb.DEFAULT_ROOT
    is_held = is_held or load_heldout()   # fail closed
    clips = read_clips(csv_path)
    os.makedirs(out_dir, mode=0o700, exist_ok=True)
    os.chmod(out_dir, 0o700)
    index, counts = [], {"matched": 0, "partial": 0, "none": 0}
    for c in clips:
        r = match_clip(c, root, is_held)
        counts[r["status"]] += 1
        write_private(os.path.join(out_dir, os.path.basename(c["clip_id"]) + ".json"), json.dumps(r, indent=1, ensure_ascii=False, sort_keys=True))
        index.append([c["clip_id"], ";".join(x["consult_uid"] for x in r["consults"]), r["overlap_s"], r["status"]])
    body = "clip_id,consult_uids,overlap_s,status\n" + "\n".join(",".join(str(x) for x in row) for row in index) + "\n"
    write_private(os.path.join(out_dir, "index.csv"), body)
    return counts


def write_private(path, body):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(body)
    os.chmod(path, 0o600)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--clips", default="/home/eta/oc/palimpsest/in/sentiment-pitch-27.csv")
    ap.add_argument("--out", default=OUT_DIR)
    ap.add_argument("--root")
    a = ap.parse_args(argv)
    print(json.dumps(run(a.clips, a.out, root=a.root), sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
