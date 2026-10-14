"""sarvam_stats.py: READ-ONLY numbers for the Sarvam consult-clip summary (ORDERS-PALIMPSEST-6S6).

Reads the REB store (consult-scope tracks), the CONSULT cutter index and timelines, the Sarvam usage ledger and the lane's job logs.
Makes no Sarvam call, writes nothing to the store, quarantines nothing. Output: one JSON (mode 0600) + a counts-only markdown table.
Window mode (--windows-file, ORDERS-PALIMPSEST-7B part 3): the same numbers for whole 15-minute windows that carry a research Sarvam stt+diar track,
compared with the other engines' tracks of the same window (see window_report).
No transcript text, names or identifiers beyond consult_uid / room_id are written: text is only compared in memory.

Formulas
- text similarity: both texts NFKC-lowercased, every non-alphanumeric character removed (spaces too), then the Dice coefficient on character
  bigrams as multisets: 2*|A&B| / (|A|+|B|). Order-insensitive, script-sensitive (a Devanagari text against a Roman-script text scores ~0).
  Only pairs where both sides have >= MIN_CHARS characters are scored.
- diarisation agreement: overlap seconds between every (Sarvam speaker, reference speaker) pair on the same span; each Sarvam speaker is
  mapped to the reference speaker it overlaps most (many-to-one allowed); agreement = overlap seconds on the mapped pairs / overlap seconds on
  all pairs (time both sides label as speech). Dominant-speaker mapping, not an optimal one-to-one assignment.
"""
import argparse
import collections
import datetime
import glob
import json
import os
import statistics
import sys
import unicodedata

REB = os.path.expanduser("~/eta-data/reb")
CLIPS = os.path.expanduser("~/eta-data/consult/clips")
LEDGER = os.path.expanduser("~/eta-data/sarvam-ledger/palimpsest")
OUT = "/home/eta/oc/palimpsest/out"
FIRST_DATE = "2026-10-02"
MIN_CHARS = 100
RETIRED = ("whisper-auto", "whisper-forced-en", "whisper-cap2", "indic-conformer", "sravaani")
RETIRED_PREFIX = ("indic-ctc-",)


# ---------------------------------------------------------------- small pure helpers
def pct(vals, p):
    if not vals:
        return None
    v = sorted(vals)
    k = (len(v) - 1) * p
    lo, hi = int(k), min(int(k) + 1, len(v) - 1)
    return round(v[lo] + (v[hi] - v[lo]) * (k - lo), 4)


def summ(vals):
    vals = [x for x in vals if x is not None]
    return {"n": len(vals), "median": pct(vals, 0.5), "p10": pct(vals, 0.1), "p90": pct(vals, 0.9),
            "max": round(max(vals), 4) if vals else None}


def norm(text):
    return "".join(c for c in unicodedata.normalize("NFKC", text or "").lower() if c.isalnum())


def dice(a, b):
    """Dice coefficient on character bigram multisets of two already-normalised strings."""
    if len(a) < 2 or len(b) < 2:
        return None
    ca = collections.Counter(a[i:i + 2] for i in range(len(a) - 1))
    cb = collections.Counter(b[i:i + 2] for i in range(len(b) - 1))
    inter = sum((ca & cb).values())
    return 2.0 * inter / (sum(ca.values()) + sum(cb.values()))


def indic_share(text):
    letters = [c for c in (text or "") if c.isalpha()]
    if not letters:
        return None
    return sum(1 for c in letters if "ऀ" <= c <= "෿") / len(letters)


def bucket(x):
    if x is None:
        return "no_letters"
    return "0" if x == 0 else "<=0.25" if x <= 0.25 else "<=0.5" if x <= 0.5 else "<=0.75" if x <= 0.75 else "<=1.0"


def overlap_s(a0, a1, b0, b1):
    return max(0.0, min(a1, b1) - max(a0, b0))


def agreement(sarvam, ref):
    """sarvam, ref: [(t0_s, t1_s, speaker)]. -> (agreement or None, overlap_total_s)."""
    mat = collections.defaultdict(float)
    for s0, s1, sp in sarvam:
        for r0, r1, rp in ref:
            o = overlap_s(s0, s1, r0, r1)
            if o > 0:
                mat[(sp, rp)] += o
    total = sum(mat.values())
    if total <= 0:
        return None, 0.0
    best = {}
    for (sp, rp), o in mat.items():
        if sp not in best or o > best[sp][1]:
            best[sp] = (rp, o)
    return sum(o for _, o in best.values()) / total, total


# ---------------------------------------------------------------- readers
def live_tracks(manifest_path):
    """{layer: (track dict)} the latest-finished live (non-quarantined) sarvam track per layer of a consult manifest."""
    root = REB
    m = json.load(open(manifest_path))
    best = {}
    for e in m.get("tracks", []):
        if e.get("engine") != "sarvam-saaras-v3":
            continue
        p = os.path.join(root, e["path"])
        if not os.path.exists(p):
            continue
        k = e["layer"]
        if k not in best or (e.get("finished_at") or "") >= (best[k][0] or ""):
            best[k] = (e.get("finished_at"), p, e)
    return m, {k: json.load(open(v[1])) for k, v in best.items()}


def read_ledger(ledger_dir=LEDGER):
    rows = []
    for f in sorted(glob.glob(os.path.join(ledger_dir, "*.jsonl"))):
        rows += [json.loads(l) for l in open(f) if l.strip()]
    return rows


def read_joblogs(out=OUT):
    """consult_uid -> {mode: [wall_s, ...]} from the lane's own job logs (ok jobs only; submit-to-done seconds)."""
    d = collections.defaultdict(lambda: collections.defaultdict(list))
    for f in sorted(glob.glob(os.path.join(out, "sarvam-jobs-*.jsonl"))):
        for l in open(f):
            try:
                r = json.loads(l)
            except ValueError:
                continue
            if r.get("ok") is True and r.get("consult_uid") and r.get("submit_to_done_s") is not None:
                d[r["consult_uid"]][r.get("mode")].append((r.get("ts"), float(r["submit_to_done_s"]), r.get("part")))
    return d


def window_tracks_overlapping(root, date, room, t0, t1, cache):
    """[(engine, layer, track)] ok tracks of REB windows of room/date overlapping [t0, t1) ms (windows only, not consult scope)."""
    key = (date, room)
    if key not in cache:
        wins = []
        rd = os.path.join(root, date, room)
        if os.path.isdir(rd):
            for w in os.listdir(rd):
                mp = os.path.join(rd, w, "manifest.json")
                if w.startswith("_") or not os.path.exists(mp):
                    continue
                try:
                    wm = json.load(open(mp))
                    wins.append((int(wm["t0_ms"]), int(wm["t1_ms"]), wm))
                except (ValueError, KeyError):
                    continue
        cache[key] = wins
    out = []
    for w0, w1, wm in cache[key]:
        if w0 < t1 and w1 > t0:
            for e in wm.get("tracks", []):
                p = os.path.join(root, e["path"])
                if e.get("status") == "ok" and os.path.exists(p):
                    out.append((e["engine"], e["layer"], p))
    return out


def span_text(paths, t0, t1):
    segs = []
    for p in paths:
        for s in json.load(open(p)).get("segments", []):
            mid = (s["t0_ms"] + s["t1_ms"]) / 2
            if t0 <= mid < t1 and s.get("text"):
                segs.append((s["t0_ms"], s["text"]))
    return " ".join(t for _, t in sorted(segs))


def seg_script(text):
    """'indic' / 'latin' / None by the majority of letters (Indic block U+0900-U+0DFF); None when fewer than 3 letters."""
    letters = [c for c in (text or "") if c.isalpha()]
    if len(letters) < 3:
        return None
    return "indic" if sum(1 for c in letters if "\u0900" <= c <= "\u0dff") * 2 > len(letters) else "latin"


def script_mismatches(segs):
    """Counts of segments whose script disagrees with the lang label: en-IN labelled but mostly Indic script, or any other label
    but mostly Latin script (romanised Hindi is legitimate, so the second count is reported apart from the first)."""
    out = {"en_labelled_indic": 0, "non_en_labelled_latin": 0, "scored": 0}
    for sg in segs:
        sc = seg_script(sg.get("text"))
        if sc is None:
            continue
        out["scored"] += 1
        en = (sg.get("lang") or "").lower().startswith("en")
        if en and sc == "indic":
            out["en_labelled_indic"] += 1
        elif not en and sc == "latin":
            out["non_en_labelled_latin"] += 1
    return out


def translate_summary(track, walls):
    if not track:
        return None
    segs = track.get("segments", [])
    text = " ".join(sg.get("text") or "" for sg in segs)
    ex = track.get("extras") or {}
    return {"status": track.get("status"), "reason": track.get("reason"), "n_segments": len(segs),
            "job_wall_s": round(sum(w for _, w, _ in walls), 2) if walls else None,
            "seg_en_in": sum(1 for sg in segs if sg.get("lang") == "en-IN"),
            "seg_with_source_lang": sum(1 for sg in segs if (sg.get("extras") or {}).get("source_language_code")),
            "source_lang_mix": dict(collections.Counter((sg.get("extras") or {}).get("source_language_code") for sg in segs)),
            "translated_to": ex.get("translated_to") or track.get("translated_to"),
            "indic_share": None if indic_share(text) is None else round(indic_share(text), 4),
            "indic_segments": sum(1 for sg in segs if seg_script(sg.get("text")) == "indic")}


def koyal_overlap(root, date, room, t0, t1, cache):
    """[(window_id, status)] of koyal stt tracks, any status, on REB windows of room/date overlapping [t0, t1) ms."""
    window_tracks_overlapping(root, date, room, t0, t1, cache)
    out = []
    for w0, w1, wm in cache[(date, room)]:
        if w0 < t1 and w1 > t0:
            out += [(wm.get("window_id"), e.get("status")) for e in wm.get("tracks", []) if e.get("engine") == "koyal"]
    return out


# ---------------------------------------------------------------- the report
def build(root=REB, clips=CLIPS, ledger_dir=LEDGER, out=OUT, since=FIRST_DATE, until=None, recut=None, is_held=None, open_clip=None):
    from . import sarvam_lane as sl
    rows = {u: r for u, r in sl.latest_rows(os.path.join(clips, "index.jsonl")).items() if since <= (r.get("ist_date") or "") <= (until or "9999")}
    ledger = read_ledger(ledger_dir)
    jobs = read_joblogs(out)
    per_clip, cache = {}, {}
    for mp in sorted(glob.glob(os.path.join(root, "20??-??-??", "*", "_consults", "*", "manifest.json"))):
        date = mp.split(os.sep)[-5]
        if date < since or (until and date > until):
            continue
        m, tr = live_tracks(mp)
        stt = tr.get("stt")
        if not stt:
            continue
        uid = mp.split(os.sep)[-2]
        ex = stt["extras"]
        parts = ex.get("parts")
        audio_s = ex.get("audio_s")
        wall = sum(w for _, w, _ in jobs.get(uid, {}).get("transcribe", [])) or None
        segs = stt["segments"]
        text = " ".join(s.get("text") or "" for s in segs)
        langs = collections.Counter()
        if parts:
            for p in parts:
                langs[p.get("language_code")] += p.get("audio_s") or 0
        else:
            langs[(segs[0]["lang"] if segs else None)] += audio_s or 0
        lang = langs.most_common(1)[0][0] if langs else None
        t0, t1 = int(m["t0_ms"]), int(m["t1_ms"])
        per_clip[uid] = {
            "ist_date": date, "room": m["room_id"], "audio_s": audio_s, "job_wall_s": round(wall, 2) if wall else None,
            "realtime_factor": round(audio_s / wall, 1) if wall and audio_s else None, "jobs": len(parts) if parts else 1,
            "split": bool(parts), "translate": translate_summary(tr.get("translate"), jobs.get(uid, {}).get("translate", [])),
            "status": stt["status"], "reason": stt.get("reason"), "language_code": lang,
            "language_audio_s": {k: round(v, 1) for k, v in langs.items()},
            "language_probability": ex.get("language_probability") if not parts else [p.get("language_probability") for p in parts],
            "n_segments": len(segs), "n_speakers": ex.get("n_speakers"), "has_translate": "translate" in tr,
            "indic_share": None if indic_share(text) is None else round(indic_share(text), 3),
            "script_mismatch_segments": script_mismatches(segs), "segment_lang_mix": dict(collections.Counter(sg.get("lang") for sg in segs)),
            "_text": text, "_t0": t0, "_t1": t1, "_segs": segs, "_dir": os.path.dirname(mp)}
    return rows, per_clip, ledger, cache


def analyse(rows, per_clip, ledger, root=REB, clips=CLIPS, recut=None, is_held=None):
    from . import sarvam_lane as sl
    cache = {}
    A = {}
    ok = [c for c in per_clip.values() if c["status"] == "ok"]
    A["A1"] = {"clips_with_live_track": len(per_clip), "ok": len(ok), "empty": sum(1 for c in per_clip.values() if c["status"] == "empty"),
               "failed": sum(1 for c in per_clip.values() if c["status"] == "failed"),
               "empty_reasons": dict(collections.Counter(c["reason"] for c in per_clip.values() if c["status"] == "empty")),
               "audio_hours": round(sum(c["audio_s"] or 0 for c in per_clip.values()) / 3600, 2),
               "jobs": sum(c["jobs"] for c in per_clip.values()), "split_clips": sum(1 for c in per_clip.values() if c["split"]),
               "translate_tracks": sum(1 for c in per_clip.values() if c["has_translate"]),
               "per_date": {d: dict(collections.Counter(c["status"] for c in per_clip.values() if c["ist_date"] == d))
                            for d in sorted({c["ist_date"] for c in per_clip.values()})}}
    walls = [c["job_wall_s"] for c in per_clip.values() if c["job_wall_s"]]
    A["A2"] = {"job_wall_s": summ(walls), "realtime_factor": summ([c["realtime_factor"] for c in per_clip.values()]),
               "note": "wall = sum of submit-to-done seconds of the clip's transcribe jobs (lane job logs); not the 1 s ledger timestamps"}
    lang = collections.defaultdict(lambda: {"clips": 0, "audio_hours": 0.0})
    for c in per_clip.values():
        for k, v in c["language_audio_s"].items():
            lang[k]["audio_hours"] += v / 3600
        lang[c["language_code"]]["clips"] += 1
    A["A3"] = {"by_language_code": {k: {"clips_dominant": v["clips"], "audio_hours": round(v["audio_hours"], 2)} for k, v in lang.items()},
               "indic_share_buckets": dict(collections.Counter(bucket(c["indic_share"]) for c in per_clip.values()))}
    # A4: speakers
    reb_cmp, cut_cmp = [], []
    for uid, c in per_clip.items():
        sar = [(s["extras"]["clip_t0_s"], s["extras"]["clip_t1_s"], s["speaker"]) for s in c["_segs"]]
        # 4a: REB pyannote tracks of windows overlapping the span (consult scope has none; window scope has none on 2 Oct+)
        pw = [p for e, l, p in window_tracks_overlapping(root, c["ist_date"], c["room"], c["_t0"], c["_t1"], cache)
              if l == "diar" and e == "pyannote-local-twin"]
        if pw:
            ref = []
            for p in pw:
                for s in json.load(open(p)).get("segments", []):
                    ref.append(((s["t0_ms"] - c["_t0"]) / 1000, (s["t1_ms"] - c["_t0"]) / 1000, s.get("speaker")))
            ag, tot = agreement(sar, ref)
            reb_cmp.append({"n_speakers_sarvam": c["n_speakers"], "n_speakers_pyannote": len({r[2] for r in ref if r[1] > 0}), "agreement": ag})
        # 4b: the cutter's own pyannote turns in the clip timeline.json
        row = rows.get(uid)
        if row and not c["split"]:
            try:
                tl = json.load(open(os.path.join(clips, row["path"], "timeline.json")))
                ref = [(t["start_s"], t["end_s"], t["speaker"]) for t in tl.get("turns", []) if t.get("speaker")]
                ag, tot = agreement(sar, ref)
                cut_cmp.append({"n_speakers_sarvam": c["n_speakers"], "n_speakers_cutter": len({r[2] for r in ref}), "agreement": ag,
                                "overlap_s": round(tot, 1)})
            except (OSError, ValueError, KeyError):
                pass

    def spk(cmp, refk):
        d = [x["n_speakers_sarvam"] - x[refk] for x in cmp if x["n_speakers_sarvam"] is not None]
        return {"n": len(cmp), "agreement": summ([x["agreement"] for x in cmp]),
                "speaker_count_diff_sarvam_minus_ref": summ(d), "speaker_count_equal_share": round(sum(1 for x in d if x == 0) / len(d), 3) if d else None,
                "sarvam_speakers": summ([x["n_speakers_sarvam"] for x in cmp]), "ref_speakers": summ([x[refk] for x in cmp])}
    A["A4"] = {"method": "dominant-speaker mapping (see module docstring); split clips excluded from 4b",
               "A4a_reb_pyannote_local_twin_tracks": spk(reb_cmp, "n_speakers_pyannote"),
               "A4b_cutter_timeline_pyannote_turns": spk(cut_cmp, "n_speakers_cutter")}
    # A5: text agreement
    eng = collections.defaultdict(list)
    eng_lang = collections.defaultdict(list)
    ov_clips = collections.defaultdict(set)
    for uid, c in per_clip.items():
        if c["status"] != "ok":
            continue
        sn = norm(c["_text"])
        by = collections.defaultdict(list)
        for e, l, p in window_tracks_overlapping(root, c["ist_date"], c["room"], c["_t0"], c["_t1"], cache):
            if l == "stt":
                by[e].append(p)
        for e, paths in by.items():
            en = norm(span_text(paths, c["_t0"], c["_t1"]))
            if len(sn) >= MIN_CHARS and len(en) >= MIN_CHARS:
                d = dice(sn, en)
                eng[e].append(d)
                eng_lang[(e, c["language_code"])].append(d)
            ov_clips[e].add(uid)
    groups = {"koyal": ["koyal"], "retired": [e for e in eng if e in RETIRED or e.startswith(RETIRED_PREFIX)],
              "router_twin": [e for e in eng if e.startswith("router-twin")]}
    A["A5"] = {"formula": "Dice on character bigrams of NFKC-lowercased alphanumerics; pairs with >=%d chars on both sides" % MIN_CHARS,
               "by_engine": {e: summ(v) for e, v in sorted(eng.items())},
               "by_engine_and_sarvam_language": {f"{e}|{l}": summ(v) for (e, l), v in sorted(eng_lang.items(), key=lambda kv: str(kv[0]))},
               "overlapping_clips_by_engine": {e: len(u) for e, u in sorted(ov_clips.items())},
               "koyal_pairs": sum(len(eng[e]) for e in groups["koyal"]), "retired_engine_pairs": sum(len(eng[e]) for e in groups["retired"]),
               "router_twin_pairs": sum(len(eng[e]) for e in groups["router_twin"]),
               "note": "Koyal and the retired engines (whisper x3, indic-conformer/indic-ctc, sravaani) have no window tracks on 2 Oct or later "
                       "unless a pair count above is non-zero; router-twin tracks (the hist-bulk routers) are the only window stt tracks there."}
    # A6: ledger
    def lab(r):
        if str(r.get("job_id", "")).startswith("unrecorded-diagnostic"):
            return "unrecorded_diagnostic"
        if r.get("scope") == "room_segment":
            return "6S2_whole_window_send"
        return "lane_" + r.get("task", "?") + "_" + r.get("status", "?")
    lab_c = collections.Counter(lab(r) for r in ledger)
    lab_m = collections.defaultdict(float)
    for r in ledger:
        if r.get("status") == "ok":
            lab_m[lab(r)] += r["audio_s"] / 60
    A["A6"] = {"ledger_jobs": len(ledger), "ok_jobs": sum(1 for r in ledger if r["status"] == "ok"),
               "failed_jobs": sum(1 for r in ledger if r["status"] == "failed"), "throttled_jobs": sum(1 for r in ledger if r.get("throttled")),
               "audio_min_ok": round(sum(r["audio_s"] for r in ledger if r["status"] == "ok") / 60, 1),
               "by_label_jobs": dict(lab_c), "by_label_audio_min_ok": {k: round(v, 1) for k, v in lab_m.items()},
               "by_scope": dict(collections.Counter(r.get("scope") for r in ledger)),
               "note": "the ledger is Sarvam jobs we sent and finished; Sarvam's own bill is not visible to us"}
    # A7: not done
    done = set(per_clip)
    cut = {u: r for u, r in rows.items() if r.get("status") == "cut"}
    nd, nd_date = collections.Counter(), collections.defaultdict(collections.Counter)
    for u, r in cut.items():
        if u in done:
            continue
        if recut is not None and u in recut:
            why = "deferred_recut"
        elif is_held is not None and is_held(r["ist_date"], r["room_id"]):
            why = "blind"
        else:
            try:
                clip = sl.open_clip(r, clips)
                why = "too_long_unsplit" if (clip["span_end_ms"] - clip["span_start_ms"]) / 1000 > sl.MAX_AUDIO_S else "not_yet_sent"
            except sl.ClipRefused:
                why = "clip_mismatch"
        nd[why] += 1
        nd_date[r["ist_date"]][why] += 1
    A["A7"] = {"cut_clips_since": len(cut), "done": len(done & set(cut)), "not_done_by_reason": dict(nd), "not_done_by_date": {d: dict(c) for d, c in sorted(nd_date.items())},
               "latest_row_not_cut": dict(collections.Counter(r.get("status") for r in rows.values() if r.get("status") != "cut"))}
    # A8: translate (clips whose latest live track set has a translate track; the lane translates ist_date >= 2026-10-08 only)
    tr_all = {u: c["translate"] for u, c in per_clip.items() if c.get("translate")}
    tr_scope = [u for u, c in per_clip.items() if c["ist_date"] >= sl.TRANSLATE_FROM]
    trs = list(tr_all.values())
    nseg = sum(t["n_segments"] for t in trs)
    src = collections.Counter()
    for t in trs:
        src.update(t["source_lang_mix"])
    A["A8"] = {"clips_in_translate_scope": len(tr_scope), "clips_in_scope_without_translate_track": sum(1 for u in tr_scope if u not in tr_all),
               "tracks": len(trs), "tracks_by_status": dict(collections.Counter(t["status"] for t in trs)),
               "job_wall_s": summ([t["job_wall_s"] for t in trs if t["job_wall_s"]]), "segments": nseg,
               "share_seg_lang_en_in": round(sum(t["seg_en_in"] for t in trs) / nseg, 4) if nseg else None,
               "share_seg_with_source_language_code": round(sum(t["seg_with_source_lang"] for t in trs) / nseg, 4) if nseg else None,
               "indic_script_share_of_translate_text": summ([t["indic_share"] for t in trs]),
               "segments_indic_script": sum(t["indic_segments"] for t in trs),
               "tracks_with_any_indic_segment": sum(1 for t in trs if t["indic_segments"]),
               "source_language_mix_segments": {str(k): v for k, v in src.most_common()},
               "translated_to": dict(collections.Counter(str(t["translated_to"]) for t in trs))}
    # A9: stt mixed-language check
    okc = [c for c in per_clip.values() if c["status"] == "ok"]
    en_clips = [c for c in okc if (c["language_code"] or "").lower().startswith("en")]
    hi = [c for c in en_clips if c["indic_share"] is not None and c["indic_share"] > 0.10]
    sm = [c["script_mismatch_segments"] for c in okc]
    seg_mix = collections.Counter()
    for c in okc:
        seg_mix.update(c["segment_lang_mix"])
    A["A9"] = {"method": "file-level label = dominant language_code (audio-seconds weighted for split clips); per segment: label = segment lang, script = majority of letters "
                         "(Indic block U+0900-U+0DFF, >=3 letters); indic_share = Indic letters / all letters of the clip's stt text",
               "ok_clips": len(okc), "clips_labelled_en": len(en_clips),
               "clips_labelled_en_with_indic_share_gt_0.10": len(hi),
               "clips_labelled_en_with_indic_share_gt_0.10_by_date": dict(collections.Counter(c["ist_date"] for c in hi)),
               "indic_share_gt_0.10_all_clips": sum(1 for c in okc if c["indic_share"] is not None and c["indic_share"] > 0.10),
               "clips_with_more_than_one_segment_lang": sum(1 for c in okc if len(c["segment_lang_mix"]) > 1),
               "segment_lang_mix_total": {str(k): v for k, v in seg_mix.most_common()},
               "segments_scored": sum(x["scored"] for x in sm),
               "segments_en_labelled_but_indic_script": sum(x["en_labelled_indic"] for x in sm),
               "segments_non_en_labelled_but_latin_script": sum(x["non_en_labelled_latin"] for x in sm),
               "clips_with_en_labelled_indic_segments": sum(1 for x in sm if x["en_labelled_indic"])}
    # A10: koyal coverage of the consult clip spans
    kc, kw, kclips = collections.Counter(), set(), set()
    for uid, c in per_clip.items():
        for wid, st_ in koyal_overlap(root, c["ist_date"], c["room"], c["_t0"], c["_t1"], cache):
            kc[st_] += 1
            kw.add(wid)
            kclips.add(uid)
    A["A10"] = {"clips_with_any_koyal_track_overlapping": len(kclips), "koyal_tracks_overlapping_by_status": dict(kc), "koyal_windows": len(kw),
                "of_clips": len(per_clip), "note": "0 means no REB window overlapping any consult clip span in scope carries a koyal track (any status)"}
    return A


# ---------------------------------------------------------------- window mode (7B part 3)
# Same list as classify_windows.CLINICAL_WORDS (7A, branch palimpsest/classify-windows): whole-word, lower-case, Latin script only.
CLINICAL_WORDS = ("pain", "fever", "cough", "cold", "tablet", "tablets", "medicine", "medicines", "medication", "dose", "prescription", "report", "reports", "scan",
                  "xray", "mri", "ct", "ecg", "ultrasound", "blood", "pressure", "bp", "sugar", "diabetes", "test", "tests", "symptoms", "symptom", "days", "weeks",
                  "since", "allergy", "surgery", "operation", "vomiting", "headache", "injection", "fasting", "swelling", "breathing", "chest", "stomach", "knee")
_WORD = __import__("re").compile(r"[a-z]+")
SARVAM = "sarvam-saaras-v3"
PER_CONFIG_ENGINES = ("sravaani",)   # language-less engines run as several configs (cuda / box-twin-cpu): one row per config label, always
WINDOW_ENGINES = ("whisper-auto", "whisper-cap2", "whisper-forced-en", "indic-conformer", "sravaani", "koyal")


def clinical_hits(text):
    return sum(1 for w in _WORD.findall((text or "").lower()) if w in CLINICAL_WORDS)


def lang_base(code):
    """'hi-IN' / 'hi' -> 'hi'; None stays None."""
    return str(code).split("-")[0].lower() if code else None


def rel_s(ms, t0_ms):
    """Segment time in seconds from the window start: tracks are window-relative ms (whisper, koyal, pyannote, ...) or absolute tape ms (Sarvam, router-twin)."""
    return (ms - t0_ms if ms > 1e11 else ms) / 1000.0


def engine_group(engine):
    if engine in WINDOW_ENGINES:
        return engine
    if engine.startswith("indic-ctc-"):
        return "indic-ctc"
    if engine.startswith("router-twin"):
        return "router-twin"
    return None


def window_report(ids, root=REB):
    """-> list of per-window dicts (numbers only; text is compared in memory and dropped). Windows without a live ok Sarvam stt track are listed as such."""
    from . import reb
    rows = []
    for wid in ids:
        w = reb.load_window(wid, root=root)
        t0, t1 = int(w.t0_ms), int(w.t1_ms)
        tr = collections.defaultdict(list)
        for t in w.tracks():
            if t.status == "ok" and t.layer in ("stt", "diar"):
                tr[(t.layer, t.engine)].append(t)
        row = {"window_id": wid, "room_id": w.room_id, "ist_date": w.ist_date, "audio_s": (t1 - t0) / 1000.0, "engines": {}}
        sst = sorted(tr.get(("stt", SARVAM), []), key=lambda t: t.entry.get("finished_at") or "")
        if not sst:
            row["sarvam"] = None
            rows.append(row)
            continue
        st = sst[-1]
        sn = norm(" ".join(sg.get("text") or "" for sg in sorted(st.segments, key=lambda x: x["t0_ms"])))
        slang = lang_base((st.segments[0].get("lang") if st.segments else None))
        row["sarvam"] = {"language_code": st.segments[0].get("lang") if st.segments else None, "chars": len(sn), "n_segments": len(st.segments),
                         "n_speakers": (st.extras or {}).get("n_speakers"), "clinical_hits": clinical_hits(" ".join(sg.get("text") or "" for sg in st.segments)),
                         "indic_share": None if indic_share(" ".join(sg.get("text") or "" for sg in st.segments)) is None else round(indic_share(" ".join(sg.get("text") or "" for sg in st.segments)), 3)}
        groups = collections.defaultdict(list)
        for (layer, eng), ts in tr.items():
            g = engine_group(eng)
            if layer == "stt" and g:
                groups[g] += ts
        for g, ts in sorted(groups.items()):
            variants = []
            for t in ts:
                segs = [sg for sg in t.segments if t0 <= (sg["t0_ms"] if sg["t0_ms"] > 1e11 else sg["t0_ms"] + t0) < t1]   # router-twin spans more than the window
                text = " ".join(sg.get("text") or "" for sg in sorted(segs, key=lambda x: x["t0_ms"]))
                cfg = t.body.get("config") or {}
                lang = lang_base(cfg.get("language") or cfg.get("lang"))
                lang = None if lang == "auto" else lang   # "auto" is not a language: nothing to compare
                variants.append({"lang": lang, "label": cfg.get("backend") or cfg.get("device") or str(t.entry.get("config_hash"))[:8],
                                 "finished": t.entry.get("finished_at") or "",
                                 "norm": norm(text), "hits": clinical_hits(text), "n_segments": len(segs),
                                 "seg_langs": dict(collections.Counter(str(sg.get("lang")) for sg in segs))})
            for v in variants:
                v["dice"] = dice(sn, v["norm"]) if len(sn) >= MIN_CHARS and len(v["norm"]) >= MIN_CHARS else None

            scored = [x["dice"] for x in variants if x["dice"] is not None]

            def entry(v, basis, matched, nvar, best):
                return {"variants": nvar, "basis": basis, "matched_language": matched, "dice_matched": v["dice"] if v else None, "dice_best": best,
                        "chars": len(v["norm"]) if v else None, "clinical_hits": v["hits"] if v else None, "n_segments": v["n_segments"] if v else None,
                        "seg_langs": v["seg_langs"] if v else None, "config_language": v["lang"] if v else None}
            has_lang = any(v["lang"] for v in variants)
            if g in PER_CONFIG_ENGINES and not has_lang:   # every config of these engines is its own row, even when only one is live (7B refuter nit)
                seen = {}
                for v in sorted(variants, key=lambda x: x["finished"]):   # two live configs with the same label: the later run wins, counted
                    if v["label"] in seen:
                        row.setdefault("duplicate_labels", []).append(f"{g}__{v['label']}")
                    seen[v["label"]] = v
                for label, v in sorted(seen.items()):
                    row["engines"][f"{g}__{label}"] = entry(v, "per-config row, language not compared", None, 1, v["dice"])
            elif len(variants) == 1:   # one config: always compared as it is; the flag says whether a real language was matched
                v = variants[0]
                basis = "single config, language not compared" if v["lang"] is None else "single config"
                row["engines"][g] = entry(v, basis, None if v["lang"] is None else v["lang"] == slang, 1, v["dice"])
            elif has_lang:   # one config per forced language (indic-conformer, koyal): the one in Sarvam's language, none if there is none
                m = [v for v in variants if v["lang"] and v["lang"] == slang]
                row["engines"][g] = entry(m[0] if m else None, "language match" if m else "no config in Sarvam's language", bool(m), len(variants),
                                          max(scored) if scored else None)   # dice_best = best of ALL configs (optimistic)
            else:   # several configs, none with a language: each config is its own row, never None
                for v in sorted(variants, key=lambda x: x["label"]):
                    row["engines"][f"{g}__{v['label']}"] = entry(v, "per-config row, language not compared", None, 1, v["dice"])
        sd = sorted(tr.get(("diar", SARVAM), []), key=lambda t: t.entry.get("finished_at") or "")
        pd = sorted(tr.get(("diar", "pyannote-local-twin"), []), key=lambda t: t.entry.get("finished_at") or "")
        if sd and pd:
            sar = [(rel_s(sg["t0_ms"], t0), rel_s(sg["t1_ms"], t0), sg["speaker"]) for sg in sd[-1].segments]
            ref = [(rel_s(sg["t0_ms"], t0), rel_s(sg["t1_ms"], t0), sg.get("speaker")) for sg in pd[-1].segments]
            ag, tot = agreement(sar, ref)
            row["speakers"] = {"n_sarvam": len({x[2] for x in sar}), "n_pyannote": len({x[2] for x in ref}), "agreement": ag, "overlap_s": round(tot, 1)}
        else:
            row["speakers"] = None
        rows.append(row)
    return rows


def _hits_block(pairs):
    paired = [(s_, h) for s_, h in pairs if h is not None]
    return {"windows": len(paired), "clinical_hits": summ([h for _, h in paired]), "clinical_hits_sarvam_same_windows": summ([s_ for s_, _ in paired]),
            "sarvam_minus_engine_hits": summ([s_ - h for s_, h in paired]),
            "share_windows_sarvam_hits_ge_engine": round(sum(1 for s_, h in paired if s_ >= h) / len(paired), 4) if paired else None}


LATIN_CAVEAT = "clinical hits count Latin-script keywords only; Sarvam's hi/kn/... output is native script, so on Indic windows the Sarvam count is biased low. The en-IN-window row is the fair one."


def window_aggregates(rows):
    done = [r for r in rows if r.get("sarvam")]
    A = {"windows_asked": len(rows), "windows_with_sarvam": len(done), "audio_h_with_sarvam": round(sum(r["audio_s"] for r in done) / 3600, 2),
         "method": "Dice on character bigrams of NFKC-lowercased alphanumerics (same formula as the clip report); pairs need >= %d chars on both sides. "
                   "dice_matched = the engine config in Sarvam's detected language when the engine has one config per language (indic-conformer, koyal); "
                   "a single-config engine is compared as it is (matched_language is true/false only when its config names a real language; 'auto' or none = "
                   "'single config, language not compared'); an engine with several configs and no language (sravaani) gets one row per config label (engine__label), also when only one config is live. "
                   "dice_best = the best of all the engine's configs (optimistic; it covers every window where any config scored, so compare it with "
                   "dice_best_on_matched_windows, the same windows as dice_matched). Dice is script-sensitive (a native-script text against a Latin-script text scores ~0), "
                   "so dice_matched_en_in_windows (Sarvam heard en-IN) is the fair like-for-like row. Clinical hits: " % MIN_CHARS + LATIN_CAVEAT}
    A["sarvam"] = {"language_code": dict(collections.Counter(r["sarvam"]["language_code"] for r in done)), "indic_share": summ([r["sarvam"]["indic_share"] for r in done]),
                   "n_speakers": summ([r["sarvam"]["n_speakers"] for r in done]), "clinical_hits": summ([r["sarvam"]["clinical_hits"] for r in done]),
                   "chars": summ([r["sarvam"]["chars"] for r in done])}
    en = [r for r in done if r["sarvam"]["language_code"] == "en-IN"]
    A["en_in_windows"] = len(en)
    engines = sorted({e for r in done for e in r["engines"]})
    A["engines"] = {}
    for e in engines:
        pairs = [(r["sarvam"], r["engines"][e]) for r in done if e in r["engines"]]
        langs = collections.Counter()
        for _, x in pairs:
            for k, v in (x["seg_langs"] or {}).items():
                langs[k] += v
        hits = _hits_block([(s_["clinical_hits"], x["clinical_hits"]) for s_, x in pairs])
        hits_en = _hits_block([(r["sarvam"]["clinical_hits"], r["engines"][e]["clinical_hits"]) for r in en if e in r["engines"]])
        A["engines"][e] = {"windows_present": len(pairs), "basis": dict(collections.Counter(x["basis"] for _, x in pairs)),
                           "windows_language_matched": sum(1 for _, x in pairs if x["matched_language"] is True),
                           "dice_matched": summ([x["dice_matched"] for _, x in pairs]), "dice_best": summ([x["dice_best"] for _, x in pairs]),
                           "dice_best_on_matched_windows": summ([x["dice_best"] for _, x in pairs if x["dice_matched"] is not None]),
                           "dice_matched_en_in_windows": summ([r["engines"][e]["dice_matched"] for r in en if e in r["engines"]]),
                           "segment_language_mix": dict(langs.most_common()), **hits, "clinical_hits_en_in_windows": hits_en, "clinical_caveat": LATIN_CAVEAT}
    sp = [r["speakers"] for r in done if r.get("speakers")]
    d = [x["n_sarvam"] - x["n_pyannote"] for x in sp]
    A["speakers"] = {"windows": len(sp), "agreement": summ([x["agreement"] for x in sp]), "n_sarvam": summ([x["n_sarvam"] for x in sp]),
                     "n_pyannote": summ([x["n_pyannote"] for x in sp]), "count_diff_sarvam_minus_pyannote": summ(d),
                     "speaker_count_equal_share": round(sum(1 for x in d if x == 0) / len(d), 4) if d else None,
                     "method": "dominant-speaker mapping as in the clip report (A4); pyannote-local-twin is the reference"}
    return A


def window_table(A):
    L = ["# Sarvam vs other engines on whole windows (counts only)", "",
         f"windows asked {A['windows_asked']}, with a Sarvam track {A['windows_with_sarvam']} ({A['audio_h_with_sarvam']} h); en-IN windows {A['en_in_windows']}", "",
         A["method"], "", f"Sarvam: {A['sarvam']}", "",
         "| engine row | windows | basis | language-matched | Dice matched n/median/p10/p90 | Dice best on the same windows (median) | Dice matched, en-IN windows n/median |", "|---|---|---|---|---|---|---|"]
    for e, v in A["engines"].items():
        m = v["dice_matched"]
        L.append(f"| {e} | {v['windows_present']} | {v['basis']} | {v['windows_language_matched']} | {m['n']}/{m['median']}/{m['p10']}/{m['p90']} | {v['dice_best_on_matched_windows']['median']} | "
                 f"{v['dice_matched_en_in_windows']['n']}/{v['dice_matched_en_in_windows']['median']} |")
    L += ["", "Clinical hits per window, median (engine / Sarvam on the same windows) and share of windows with Sarvam >= engine. "
          "CAVEAT, next to every number below: " + LATIN_CAVEAT, "",
          "| engine row | all windows: n, engine / Sarvam, Sarvam>=engine | en-IN windows only: n, engine / Sarvam, Sarvam>=engine |", "|---|---|---|"]
    for e, v in A["engines"].items():
        en = v["clinical_hits_en_in_windows"]
        L.append(f"| {e} | {v['windows']}, {v['clinical_hits']['median']} / {v['clinical_hits_sarvam_same_windows']['median']}, {v['share_windows_sarvam_hits_ge_engine']} "
                 f"(Latin-only) | {en['windows']}, {en['clinical_hits']['median']} / {en['clinical_hits_sarvam_same_windows']['median']}, {en['share_windows_sarvam_hits_ge_engine']} |")
    L += ["", f"Speakers: {A['speakers']}", ""]
    for e, v in A["engines"].items():
        L.append(f"segment language mix {e}: {v['segment_language_mix']}")
    return "\n".join(L) + "\n"


def jsonable(x):
    """Dict keys to str (language codes can be None) so the document sorts and dumps."""
    if isinstance(x, dict):
        return {str(k): jsonable(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [jsonable(v) for v in x]
    return x


def table(A, n_clips):
    L = ["# Sarvam consult-clip stats (counts only)", "",
         f"clips with a live stt track: {A['A1']['clips_with_live_track']} (ok {A['A1']['ok']}, empty {A['A1']['empty']}, failed {A['A1']['failed']}); "
         f"audio {A['A1']['audio_hours']} h; jobs {A['A1']['jobs']}; split clips {A['A1']['split_clips']}; translate tracks {A['A1']['translate_tracks']}", "",
         "| date | ok | empty | failed |", "|---|---|---|---|"]
    for d, c in A["A1"]["per_date"].items():
        L.append(f"| {d} | {c.get('ok', 0)} | {c.get('empty', 0)} | {c.get('failed', 0)} |")
    a2 = A["A2"]
    L += ["", f"A2 job wall s per clip: median {a2['job_wall_s']['median']}, p90 {a2['job_wall_s']['p90']}, max {a2['job_wall_s']['max']} (n {a2['job_wall_s']['n']}); "
          f"realtime factor median {a2['realtime_factor']['median']}", "", "A3 language_code | clips (dominant) | audio h", "|---|---|---|"]
    for k, v in A["A3"]["by_language_code"].items():
        L.append(f"| {k} | {v['clips_dominant']} | {v['audio_hours']} |")
    L += ["", f"A3 indic-script share buckets: {A['A3']['indic_share_buckets']}", "", f"A4a vs REB pyannote tracks: n {A['A4']['A4a_reb_pyannote_local_twin_tracks']['n']}",
          f"A4b vs cutter pyannote turns: n {A['A4']['A4b_cutter_timeline_pyannote_turns']['n']}, agreement median "
          f"{A['A4']['A4b_cutter_timeline_pyannote_turns']['agreement']['median']} (p10 {A['A4']['A4b_cutter_timeline_pyannote_turns']['agreement']['p10']}, "
          f"p90 {A['A4']['A4b_cutter_timeline_pyannote_turns']['agreement']['p90']}); equal speaker count share "
          f"{A['A4']['A4b_cutter_timeline_pyannote_turns']['speaker_count_equal_share']}", "", "A5 text agreement (Dice) | engine | n | median | p10 | p90", "|---|---|---|---|---|"]
    for e, s in A["A5"]["by_engine"].items():
        L.append(f"| {e} | {s['n']} | {s['median']} | {s['p10']} | {s['p90']} |")
    L += [f"| (koyal pairs {A['A5']['koyal_pairs']}, retired-engine pairs {A['A5']['retired_engine_pairs']}) | | | | |", "",
          f"A6 ledger: jobs {A['A6']['ledger_jobs']}, ok {A['A6']['ok_jobs']}, failed {A['A6']['failed_jobs']}, throttled {A['A6']['throttled_jobs']}, "
          f"audio min (ok) {A['A6']['audio_min_ok']}; by label {A['A6']['by_label_jobs']}", "", f"A7 not done: {A['A7']}", "",
          f"A8 translate: {A['A8']}", "", f"A9 mixed language: {A['A9']}", "", f"A10 koyal: {A['A10']}"]
    return "\n".join(L) + "\n"


def window_main(a):
    d = json.load(open(a.windows_file))
    ids = d.get("sample_window_ids") if isinstance(d, dict) else d
    out = a.out or os.path.join(OUT, "SARVAM-WINDOWS-26-27SEP.json")
    rows = window_report(list(dict.fromkeys(ids)), root=a.root)
    A = window_aggregates(rows)
    doc = {"schema": "sarvam.window.stats.v1", "generated_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "windows": rows, "aggregates": A}
    for path, body in ((out, json.dumps(jsonable(doc), indent=1, sort_keys=True)), (os.path.splitext(out)[0] + ".md", window_table(A))):
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(body)
        os.chmod(path, 0o600)
    print(json.dumps({"out": out, "windows": len(rows), "with_sarvam": A["windows_with_sarvam"]}))
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", default=None, help="output json (default: out/SARVAM-CLIP-STATS-09-OCT.json, or out/SARVAM-WINDOWS-26-27SEP.json with --windows-file)")
    ap.add_argument("--since", default=FIRST_DATE)
    ap.add_argument("--until", default=None, help="last ist_date included (inclusive)")
    ap.add_argument("--root", default=REB, help="REB root for window mode (default ~/eta-data/reb)")
    ap.add_argument("--windows-file", help="window mode (7B part 3): the CLASSIFY json (sample_window_ids) or a JSON list of window ids")
    a = ap.parse_args(argv)
    if a.windows_file:
        return window_main(a)
    a.out = a.out or os.path.join(OUT, "SARVAM-CLIP-STATS-09-OCT.json")
    from . import sarvam_lane as sl
    from .from_hist import load_heldout
    rows, per_clip, ledger, _ = build(since=a.since, until=a.until)
    recut = sl.load_recut_pending()
    A = analyse(rows, per_clip, ledger, recut=recut, is_held=load_heldout())
    clean = {u: {k: v for k, v in c.items() if not k.startswith("_")} for u, c in sorted(per_clip.items())}
    doc = {"schema": "sarvam.clip.stats.v1", "generated_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "since": a.since, "until": a.until, "per_clip": clean, "aggregates": A}
    fd = os.open(a.out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(jsonable(doc), f, indent=1, sort_keys=True)
    os.chmod(a.out, 0o600)
    md = os.path.splitext(a.out)[0] + ".md"
    fd = os.open(md, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(table(A, len(per_clip)))
    os.chmod(md, 0o600)
    print(json.dumps({"out": a.out, "md": md, "clips": len(per_clip)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
