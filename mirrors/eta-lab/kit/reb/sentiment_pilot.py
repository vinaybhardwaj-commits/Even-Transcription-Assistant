"""sentiment_pilot.py: READ-ONLY collection of what the store already has for a list of consult_uids (ORDERS-PALIMPSEST-9B step 1).

No Sarvam call, no transcription, nothing written to the REB store. For each consult_uid (found under reb/<ist_date>/<room>/_consults/<uid>/) one JSON:
  stt        the latest-finished live ok stt.sarvam-saaras-v3 track: segments with t0_ms/t1_ms (absolute tape-UTC ms), t0_ist/t1_ist (ISO, +05:30), speaker, lang, text;
             and per segment `en` (the English beside it) and `role`
  translate  the latest-finished live ok translate.sarvam-saaras-v3 track, if any. Each translate segment is assigned to the stt segment it overlaps most (by tape
             time; ties to the earlier), so no English text is repeated; an stt segment's `en` is its assigned translate texts joined in order
  role       role.text-judge (its map, abstain_reason, judge) and role.sarvam-doctor-map (its map); `role` per stt segment is the text-judge role of the segment with
             the greatest time overlap, else the doctor-map's
The raw Sarvam payload (extras.raw) is NEVER copied. Index: index.csv with consult_uid, date, room, has_stt, has_translate, language, has_role, doctor_assigned,
status, reason. Directory 0700, files 0600. Transcript text is in the per-consult JSON only (V O6/O7: it may go to tailnet machines); the bus gets counts and ids.

language = the most common segment `lang` of the stt track. A consult needs a translate track when that language is not English (en-IN / en).
status: done = stt + role (+ translate when needed); failed = a stt / role / translate track exists for the consult but none of its tracks is ok (status failed);
pending = otherwise, with reason in {no_consult, no_stt, stt_empty, no_role, no_translate}. doctor_assigned = the cutter's attribution.doctor_identified (a boolean; no doctor id is written).
"""
import argparse
import collections
import csv
import datetime
import glob
import json
import os
import sys

from . import reb
from .from_hist import IST

OUT = "/home/eta/oc/palimpsest/out/sentiment-forward-pilot"
STT, TR, ROLE, DMAP = ("stt", "sarvam-saaras-v3"), ("translate", "sarvam-saaras-v3"), ("role", "text-judge"), ("role", "sarvam-doctor-map")
ENGLISH = ("en-IN", "en")


def iso_ist(ms):
    return datetime.datetime.fromtimestamp(ms / 1000.0, IST).isoformat(timespec="milliseconds")


def overlap(a0, a1, b0, b1):
    return max(0, min(a1, b1) - max(a0, b0))


def find_consult(root, uid):
    """-> (manifest_path, date, room) or None. A uid under several dates: the one holding an ok stt track wins, else the latest date."""
    hits = sorted(glob.glob(os.path.join(root, "20*", "*", "_consults", uid, "manifest.json")))
    if not hits:
        return None
    for h in reversed(hits):
        if glob.glob(os.path.join(os.path.dirname(h), "tracks", "stt.sarvam-saaras-v3__*.json")):
            return (h,) + tuple(os.path.relpath(h, root).split(os.sep)[:2])
    h = hits[-1]
    return (h,) + tuple(os.path.relpath(h, root).split(os.sep)[:2])


def load_tracks(consult_dir):
    """{(layer, engine): [(finished_at, status, track_json)]} over the live tracks (quarantine dirs are skipped by the glob)."""
    out = collections.defaultdict(list)
    for p in glob.glob(os.path.join(consult_dir, "tracks", "*.json")):
        try:
            j = json.load(open(p))
        except ValueError:
            continue
        out[(j.get("layer"), j.get("engine"))].append((j.get("finished_at") or (j.get("extras") or {}).get("created_at") or "", j.get("status"), j))
    return out


def latest(tracks, key, status="ok"):
    c = sorted([t for t in tracks.get(key, []) if t[1] == status], key=lambda t: t[0])
    return c[-1][2] if c else None


def modal_language(segs):
    c = collections.Counter(s.get("lang") for s in segs if s.get("lang"))
    return c.most_common(1)[0][0] if c else None


def align_english(stt_segs, tr_segs):
    """Index of the stt segment each translate segment belongs to (greatest overlap; ties to the earlier), -> list of lists of English texts per stt segment."""
    out = [[] for _ in stt_segs]
    for t in sorted(tr_segs, key=lambda s: (s["t0_ms"], s["t1_ms"])):
        best, bi = 0, None
        for i, s in enumerate(stt_segs):
            o = overlap(s["t0_ms"], s["t1_ms"], t["t0_ms"], t["t1_ms"])
            if o > best:
                best, bi = o, i
        if bi is not None and t.get("text"):
            out[bi].append(t["text"])
    return out


def overlap_idx(stt_segs, tr_segs):
    """For each stt segment, the indices (into the time-sorted translate list) of every translate segment that overlaps it at all."""
    return [[j for j, t in enumerate(tr_segs) if overlap(s["t0_ms"], s["t1_ms"], t["t0_ms"], t["t1_ms"]) > 0] for s in stt_segs]


def role_of(seg, judge_segs, map_segs):
    for pool in (judge_segs, map_segs):
        best, role = 0, None
        for r in pool or []:
            o = overlap(seg["t0_ms"], seg["t1_ms"], r["t0_ms"], r["t1_ms"])
            if o > best:
                best, role = o, r.get("role")
        if role is not None:
            return role
    return None


def public_extras(j, keep):
    e = j.get("extras") or {}
    return {k: e[k] for k in keep if k in e}


def collect(root, uid):
    """-> (doc or None, row dict for index.csv)."""
    row = {"consult_uid": uid, "date": "", "room": "", "has_stt": False, "has_translate": False, "language": "", "has_role": False, "doctor_assigned": "", "status": "pending",
           "reason": "no_consult", "n_translate_unlinked": "", "n_stt_en_empty": ""}
    f = find_consult(root, uid)
    if not f:
        return None, row
    mp, date, room = f
    row["date"], row["room"] = date, room
    cdir = os.path.dirname(mp)
    man = json.load(open(mp))
    row["doctor_assigned"] = bool(((man.get("consult") or {}).get("attribution") or {}).get("doctor_identified"))
    tracks = load_tracks(cdir)
    stt, tr, role, dmap = latest(tracks, STT), latest(tracks, TR), latest(tracks, ROLE), latest(tracks, DMAP)
    row["has_stt"], row["has_translate"], row["has_role"] = stt is not None, tr is not None, role is not None
    segs = [dict(s) for s in (stt or {}).get("segments", [])]
    lang = modal_language(segs)
    row["language"] = lang or ""
    needs_tr = bool(lang) and lang not in ENGLISH
    any_failed = any(st == "failed" for k in (STT, TR, ROLE) for _, st, _ in tracks.get(k, []))
    if stt is None:
        empty = any(st == "empty" for _, st, _ in tracks.get(STT, []))
        row["status"], row["reason"] = ("failed", "stt_failed") if (any_failed and not empty) else ("pending", "stt_empty" if empty else "no_stt")
    elif role is None:
        row["status"], row["reason"] = ("failed", "role_failed") if any_failed else ("pending", "no_role")
    elif needs_tr and tr is None:
        row["status"], row["reason"] = "pending", "no_translate"
    else:
        row["status"], row["reason"] = "done", ""
    if stt is None:
        return None, row
    trs = sorted(tr.get("segments", []), key=lambda x: (x["t0_ms"], x["t1_ms"])) if tr else []
    en = align_english(segs, trs) if tr else None
    en_idx = overlap_idx(segs, trs) if tr else None
    for i, s in enumerate(segs):
        s["t0_ist"], s["t1_ist"] = iso_ist(s["t0_ms"]), iso_ist(s["t1_ms"])
        s.pop("extras", None)
        if en is not None:
            s["en"] = " ".join(en[i])
            s["en_idx"] = en_idx[i]       # every translate segment overlapping this one, also those whose text sits on a neighbour (see `translate.segments`)
        s["role"] = role_of(s, (role or {}).get("segments"), (dmap or {}).get("segments"))
    sig = (stt.get("extras") or {}).get("clip_signature") or {}
    en_stats = None
    if tr:
        linked = {j for ix in en_idx for j in ix}
        en_stats = {"n_translate_segments": len(trs), "n_translate_unlinked": len(trs) - len(linked),      # English present in translate.segments but overlapping no stt segment
                    "n_stt_segments": len(segs), "n_stt_en_empty": sum(1 for x in segs if not x["en"]),
                    "n_stt_en_empty_text_on_neighbour": sum(1 for x in segs if not x["en"] and x["en_idx"])}
    row.update({"n_translate_unlinked": "" if en_stats is None else en_stats["n_translate_unlinked"], "n_stt_en_empty": "" if en_stats is None else en_stats["n_stt_en_empty"]})
    doc = {"consult_uid": uid, "date": date, "room": room, "window_id": stt.get("window_id"),
           "clip": {"audio_s": (stt.get("extras") or {}).get("audio_s"), "start_utc_s": sig.get("start"), "end_utc_s": sig.get("end"), "room_slug": sig.get("room")},
           "language": lang, "needs_translate": needs_tr, "en_stats": en_stats, "doctor_assigned": row["doctor_assigned"],
           "stt": {**public_extras(stt, ("job_id", "model", "n_speakers", "language_probability", "mode")), "engine": stt.get("engine"), "segments": segs},
           "translate": None if tr is None else {**public_extras(tr, ("job_id", "model", "n_speakers", "language_probability", "mode", "source_language_code", "translated_to")),
                                                 "n_segments": len(trs),
                                                 "segments": [{"i": j, "t0_ms": t["t0_ms"], "t1_ms": t["t1_ms"], "t0_ist": iso_ist(t["t0_ms"]), "t1_ist": iso_ist(t["t1_ms"]),
                                                               "speaker": t.get("speaker"), "text": t.get("text") or ""} for j, t in enumerate(trs)]},
           "role": None if (role is None and dmap is None) else {
               "text_judge": None if role is None else public_extras(role, ("abstain_reason", "judge", "map", "rule")),
               "sarvam_doctor_map": None if dmap is None else public_extras(dmap, ("map", "n_doctor_turns", "rule"))}}
    return doc, row


def write_private(path, body):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(body)
    os.chmod(path, 0o600)


def run(root, uids, out):
    os.makedirs(out, mode=0o700, exist_ok=True)
    os.chmod(out, 0o700)
    rows, counts, reasons, no_tr = [], collections.Counter(), collections.Counter(), []
    for uid in list(dict.fromkeys(uids)):
        doc, row = collect(root, uid)
        if doc is not None:
            write_private(os.path.join(out, f"{uid}.json"), json.dumps(doc, ensure_ascii=False, indent=1))
        rows.append(row)
        counts[row["status"]] += 1
        if row["reason"]:
            reasons[row["reason"]] += 1
        if row["reason"] == "no_translate":
            no_tr.append(uid)
    cols = ["consult_uid", "date", "room", "has_stt", "has_translate", "language", "has_role", "doctor_assigned", "status", "reason", "n_translate_unlinked", "n_stt_en_empty"]
    import io
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=cols)
    w.writeheader()
    w.writerows(rows)
    write_private(os.path.join(out, "index.csv"), buf.getvalue())
    return {"consults": len(rows), "status": dict(counts), "reasons": dict(reasons), "non_english_without_translate": no_tr,
            "languages": dict(collections.Counter(r["language"] or "none" for r in rows))}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--uids", required=True, help="file with one consult_uid per line")
    ap.add_argument("--root", default=reb.DEFAULT_ROOT)
    ap.add_argument("--out", default=OUT)
    a = ap.parse_args(argv)
    uids = [l.strip() for l in open(a.uids) if l.strip() and not l.startswith("#")]
    print(json.dumps(run(a.root, uids, a.out)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
