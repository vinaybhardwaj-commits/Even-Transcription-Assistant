"""classify_windows.py: READ-ONLY classification of REB windows by signals we already have (ORDERS-PALIMPSEST-7A).

No Sarvam call, no new transcription, nothing written to the store. Reads manifests and live (non-quarantined) tracks of the 2026-09-26/27 windows that
carry the full retired stt stack. Output: one JSON (mode 0600) + a counts-only markdown table. Window text is only read in memory (item 5) and never written.

Population: windows dated D whose live ok tracks include stt for ALL of whisper-auto, whisper-cap2, whisper-forced-en, indic-conformer, sravaani
(koyal presence is counted, not required). Blind room-days / spans (heldout.py via from_hist.load_heldout, fail closed) are excluded and counted
BEFORE any track is read.

Signals (per window; ids, room, date, times and numbers only)
1. audio_s = (t1_ms - t0_ms)/1000. speech_s = seconds covered by the UNION of diar.pyannote-local-twin turns (latest-finished live ok track).
   A live pyannote track with status "empty" (pyannote ran and found no speech, 0 segments) means speech_s = 0 and the window is QUIET; only a window
   with NO pyannote track at all, or only failed/skipped ones, is NO_DIAR (unclassifiable).
   acoustics.room_profile_acoustics carries no speech-fraction field (it has level_dbfs, clip_share, noise_floor_dbfs, snr_db, mute_span), so
   the union of pyannote turns is the speech measure. speech_frac = speech_s / audio_s.
2. n_speakers_10s = distinct pyannote speakers whose own turn union is >= 10 s.
   longest_turn_taking_s: turns sorted by start; consecutive turns of the SAME speaker with gap <= 5 s are merged into a speaker run. Two
   consecutive runs LINK when they have different speakers, the gap run[i].start - RUNNING_END is <= 5 s, and the speaker change interval
   run[i].start - run[i-1].start is <= 60 s (speakers change at least every 60 s). RUNNING_END is the latest end seen so far in the chain (7A final
   ruling #10706), not the previous run's end, so a short interjection inside a longer ongoing turn does not break the chain; an overlap counts as gap 0.
   A stretch is a maximal chain of linked runs (>= 2 runs hence >= 2 distinct speakers alternating). Its length is last_end - first.start, where
   last_end = max(running end before the last run, min(last.end, last.start + 60)): the 60 s change limit also caps the LAST run (7A amend #10696), so a short
   exchange followed by one long monologue does not count the monologue in full. The longest stretch is the signal; 0 if none.
   This rule is a PROPOSAL: tune it only with the architect's word.
3. Clinic-wide consult overlap (the warehouse has no room field): from an optional visits file (--visits; JSONL or CSV with called_at, completed_at,
   doctor_uid only; ISO with offset, a naive time is read as IST). Per window: overlap_visits = number of visits whose [called_at, completed_at]
   intersects the window, overlap_min = sum of the intersection minutes. Without the file: consult overlap is NOT AVAILABLE.
4. Labels. CONSULT-LIKE: overlap_visits > 0 AND longest_turn_taking_s >= TT_MIN_S (90 s since the architect's 7A ruling #10693; the report keeps
   120 s and 180 s as sensitivity rows). STAFF/OTHER: speech_frac >= 0.2 and not CONSULT-LIKE. QUIET: speech_frac < 0.2.
   label_turn_only is the same without the overlap condition (CONSULT-LIKE = longest_turn_taking_s >= TT_MIN_S, 90 s). If the visits file is absent, `label` equals
   label_turn_only and the report says overlap is NOT AVAILABLE.
   Weak hint (never a gate): usual_room_hint = sum, over the doctors whose usual room on the window's IST weekday includes the window's room,
   of that room's share (in/doctor-usual-room-2-9oct.json, CONSULT clip index 2-9 Oct). It says "a doctor who usually sits here", not "was consulting".
   Agreement metrics (per threshold, numbers only): catch rate = share of cue windows (clinical_score >= 1.0 per minute; 2.0 as a sensitivity row) labelled
   CONSULT-LIKE; no-cue share = share of CONSULT-LIKE windows with clinical_score 0.
5. Cross-check (numbers only): clinical_score = (count of CLINICAL_WORDS whole-word hits + count of "?") per audio minute, from the window's existing whisper-auto text.
   Reported: median score per label and the share of CONSULT-LIKE windows in the top half of the score ranking.
Sample: 150 windows from the CONSULT-LIKE set (label_turn_only when overlap is not available), proportional allocation over strata
(room, day, IST start hour; largest remainder), seeded random choice within each stratum. The window_ids are in the JSON only.
"""
import argparse
import collections
import csv
import datetime
import glob
import json
import os
import random
import re
import statistics
import sys

from . import reb
from .from_hist import IST, load_heldout, window_held

DATES = ("2026-09-26", "2026-09-27")
RETIRED_STT = ("whisper-auto", "whisper-cap2", "whisper-forced-en", "indic-conformer", "sravaani")
OUT = "/home/eta/oc/palimpsest/out"
IN_DIR = "/home/eta/oc/palimpsest/in"
GAP_S, CHANGE_S, TT_MIN_S, SPEAKER_MIN_S, QUIET_FRAC = 5.0, 60.0, 90.0, 10.0, 0.2
SENSITIVITY_S = (90.0, 120.0, 180.0)
WEEKDAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
CLINICAL_WORDS = ("pain", "fever", "cough", "cold", "tablet", "tablets", "medicine", "medicines", "medication", "dose", "prescription", "report", "reports", "scan",
                  "xray", "mri", "ct", "ecg", "ultrasound", "blood", "pressure", "bp", "sugar", "diabetes", "test", "tests", "symptoms", "symptom", "days", "weeks",
                  "since", "allergy", "surgery", "operation", "vomiting", "headache", "injection", "fasting", "swelling", "breathing", "chest", "stomach", "knee")
_WORD = re.compile(r"[a-z]+")


# ---------------------------------------------------------------- pure helpers
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


def pct(vals, p):
    if not vals:
        return None
    v = sorted(vals)
    k = (len(v) - 1) * p
    lo, hi = int(k), min(int(k) + 1, len(v) - 1)
    return round(v[lo] + (v[hi] - v[lo]) * (k - lo), 4)


def summ(vals):
    vals = [x for x in vals if x is not None]
    return {"n": len(vals), "min": pct(vals, 0), "p10": pct(vals, 0.1), "median": pct(vals, 0.5), "p90": pct(vals, 0.9), "max": pct(vals, 1)}


def speaker_runs(turns):
    """turns: [(t0_s, t1_s, speaker)] -> [[start, end, speaker]] with same-speaker neighbours (gap <= GAP_S) merged."""
    runs = []
    for a, b, sp in sorted(turns):
        if runs and runs[-1][2] == sp and a - runs[-1][1] <= GAP_S:
            runs[-1][1] = max(runs[-1][1], b)
        else:
            runs.append([a, b, sp])
    return runs


def longest_turn_taking(turns):
    """Seconds of the longest chain of linked speaker runs (see module docstring, item 2). 0.0 if there is no change of speaker."""
    runs = speaker_runs(turns)
    best, start, run_end = 0.0, None, 0.0
    for i in range(1, len(runs)):
        p, r = runs[i - 1], runs[i]
        if start is None:
            run_end = p[1]                       # a candidate chain begins at p
        if r[2] != p[2] and r[0] - run_end <= GAP_S and r[0] - p[0] <= CHANGE_S:
            if start is None:
                start = p[0]
            best = max(best, max(run_end, min(r[1], r[0] + CHANGE_S)) - start)   # the last run counts at most CHANGE_S from its own start
            run_end = max(run_end, r[1])
        else:
            start = None
    return round(best, 3)


def diar_features(turns, audio_s):
    """turns: [(t0_s, t1_s, speaker)] window-relative seconds."""
    allu = merge([(a, b) for a, b, _ in turns])
    per = collections.defaultdict(list)
    for a, b, sp in turns:
        per[sp].append((a, b))
    speech = covered(allu)
    return {"speech_s": round(speech, 3), "speech_frac": round(speech / audio_s, 4) if audio_s else None,
            "n_speakers_10s": sum(1 for iv in per.values() if covered(merge(iv)) >= SPEAKER_MIN_S),
            "n_speakers": len(per), "longest_turn_taking_s": longest_turn_taking(turns)}


def label_of(speech_frac, tt_s, overlap_visits, tt_min=None):
    """overlap_visits None = NOT AVAILABLE (then the overlap condition is dropped)."""
    if speech_frac is None:
        return "NO_DIAR"
    consult = tt_s >= (TT_MIN_S if tt_min is None else tt_min) and (overlap_visits is None or overlap_visits > 0)
    if consult:
        return "CONSULT-LIKE"
    return "QUIET" if speech_frac < QUIET_FRAC else "STAFF/OTHER"


def clinical_score(text, audio_s):
    words = _WORD.findall((text or "").lower())
    hits = sum(1 for w in words if w in CLINICAL_WORDS) + (text or "").count("?")
    return round(hits / (audio_s / 60.0), 4) if audio_s else None


# ---------------------------------------------------------------- visits (clinic-wide overlap)
def _parse_time(v):
    if isinstance(v, (int, float)) or (isinstance(v, str) and v.strip().lstrip("-").isdigit()):
        x = float(v)
        return int(x if x > 1e11 else x * 1000)
    d = datetime.datetime.fromisoformat(str(v).strip().replace("Z", "+00:00"))
    if d.tzinfo is None:
        d = d.replace(tzinfo=IST)
    return int(d.timestamp() * 1000)


def load_visits(path):
    """-> [(called_ms, completed_ms)]. Only called_at, completed_at (and doctor_uid, ignored here) are read; rows without both are dropped and counted."""
    rows = []
    with open(path) as f:
        if path.endswith(".csv"):
            rows = list(csv.DictReader(f))
        else:
            rows = [json.loads(l) for l in f if l.strip()]
    out, dropped = [], 0
    for r in rows:
        try:
            a, b = _parse_time(r["called_at"]), _parse_time(r["completed_at"])
        except (KeyError, ValueError, TypeError):
            dropped += 1
            continue
        if b > a:
            out.append((a, b))
        else:
            dropped += 1
    return out, dropped


def visit_overlap(visits, t0_ms, t1_ms):
    n, mins = 0, 0.0
    for a, b in visits:
        o = min(b, t1_ms) - max(a, t0_ms)
        if o > 0:
            n += 1
            mins += o / 60000.0
    return n, round(mins, 3)


# ---------------------------------------------------------------- weak hint: usual room by weekday
def load_usual_room(path):
    """-> (table, state). table = {(weekday, room_id): summed share over doctors} from doctor-usual-room-2-9oct.json (table rows: doctor_uid, weekday,
    rooms[{room_id, share}]); state is "ok", "not_present" (no such file) or "unreadable" (any other read/parse/shape error); table is None unless "ok"."""
    try:
        tab = json.load(open(path))["table"]
        out = collections.defaultdict(float)
        for r in tab:
            for rm_ in r.get("rooms") or []:
                out[(r.get("weekday"), rm_.get("room_id"))] += float(rm_.get("share") or 0)
    except FileNotFoundError:
        return None, "not_present"
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return None, "unreadable"
    return dict(out), "ok"


def usual_room_hint(table, t0_ms, room_id):
    if table is None:
        return None
    wd = WEEKDAYS[datetime.datetime.fromtimestamp(t0_ms / 1000, IST).weekday()]
    return round(table.get((wd, room_id), 0.0), 4)


# ---------------------------------------------------------------- the run
def window_paths(root, dates):
    for d in dates:
        for mp in sorted(glob.glob(os.path.join(root, d, "*", "*", "manifest.json"))):
            if os.sep + "_" not in mp[len(root):]:
                yield mp


def run(root=None, dates=DATES, is_held=None, visits=None, sample_n=150, seed=7, with_text=True, usual_room=None):
    root = root or reb.DEFAULT_ROOT
    is_held = is_held or load_heldout()   # fail closed
    pop, c = [], collections.Counter()
    for mp in window_paths(root, dates):
        w = reb.Window(root, json.load(open(mp)), mp)
        if w.source_kind != "room_tape":
            continue
        c["windows_total"] += 1
        if window_held(is_held, w.room_id, w.t0_ms, w.t1_ms):
            c["blind_excluded"] += 1
            continue
        live = collections.defaultdict(list)
        for t in w.tracks():
            if t.status == "ok":
                live[(t.layer, t.engine)].append(t)
        if not all(("stt", e) in live for e in RETIRED_STT):
            c["not_full_stack"] += 1
            continue
        c["full_stack"] += 1
        c["koyal_present"] += 1 if ("stt", "koyal") in live else 0
        audio_s = (w.t1_ms - w.t0_ms) / 1000.0
        row = {"window_id": w.window_id, "room_id": w.room_id, "ist_date": w.ist_date, "t0_ms": w.t0_ms, "t1_ms": w.t1_ms, "audio_s": audio_s,
               "hour_ist": datetime.datetime.fromtimestamp(w.t0_ms / 1000, IST).hour}
        dg = sorted(live.get(("diar", "pyannote-local-twin"), []), key=lambda t: t.entry.get("finished_at") or "")
        diar_any = sorted([t for t in w.tracks(layer="diar", engine="pyannote-local-twin") if t.status != "quarantined"], key=lambda t: t.entry.get("finished_at") or "")
        row["diar_status"] = "ok" if dg else (diar_any[-1].status if diar_any else "absent")
        if dg:
            turns = [(s["t0_ms"] / 1000.0, s["t1_ms"] / 1000.0, str(s.get("speaker"))) for s in dg[-1].segments]
            row.update(diar_features(turns, audio_s))
        elif row["diar_status"] == "empty":   # pyannote ran and found no speech: a measured zero, not a missing signal
            c["diar_empty"] += 1
            row.update(diar_features([], audio_s))
        else:
            c["no_diar"] += 1
            row.update({"speech_s": None, "speech_frac": None, "n_speakers_10s": None, "n_speakers": None, "longest_turn_taking_s": None})
        row["usual_room_hint"] = usual_room_hint(usual_room, w.t0_ms, w.room_id)
        if visits is not None:
            row["overlap_visits"], row["overlap_min"] = visit_overlap(visits, w.t0_ms, w.t1_ms)
        else:
            row["overlap_visits"], row["overlap_min"] = None, None
        row["label"] = label_of(row["speech_frac"], row["longest_turn_taking_s"] or 0, row["overlap_visits"])
        row["label_turn_only"] = label_of(row["speech_frac"], row["longest_turn_taking_s"] or 0, None)
        if with_text:
            wa = live[("stt", "whisper-auto")][-1]
            row["clinical_score"] = clinical_score(" ".join(s.get("text") or "" for s in wa.segments), audio_s)
        pop.append(row)
    return pop, c


def sample_stratified(rows, n, seed, label_key):
    cand = [r for r in rows if r[label_key] == "CONSULT-LIKE"]
    if len(cand) <= n:
        return sorted(r["window_id"] for r in cand)
    strata = collections.defaultdict(list)
    for r in cand:
        strata[(r["room_id"], r["ist_date"], r["hour_ist"])].append(r)
    keys = sorted(strata)
    quota = {k: n * len(strata[k]) / len(cand) for k in keys}
    take = {k: int(quota[k]) for k in keys}
    left = n - sum(take.values())
    for k in sorted(keys, key=lambda k: (-(quota[k] - take[k]), k))[:left]:
        take[k] += 1
    rng = random.Random(seed)
    out = []
    for k in keys:
        pool = sorted(r["window_id"] for r in strata[k])
        out += rng.sample(pool, min(take[k], len(pool)))
    return sorted(out)


def load_room_labels(path):
    """{room_id: label} from room-labels.json ({"rooms": [{"room_id", "label"}]}); {} if the file is absent or unreadable (labels are cosmetic)."""
    try:
        return {r["room_id"]: r["label"] for r in json.load(open(path))["rooms"]}
    except (OSError, ValueError, KeyError, TypeError):
        return {}


def clinical_check(pop, labels):
    """Item 5 for one labelling: labels = {window_id: label}. Median score per label; share of CONSULT-LIKE in the top half by score vs overall."""
    sc = [r for r in pop if r.get("clinical_score") is not None]
    ranked = sorted(sc, key=lambda r: (r["clinical_score"], r["window_id"]))
    top = ranked[len(ranked) // 2:]
    return {"n": len(sc), "median_score_by_label": {k: pct([r["clinical_score"] for r in sc if labels[r["window_id"]] == k], 0.5) for k in sorted({labels[r["window_id"]] for r in sc})},
            "share_consult_like_in_top_half": round(sum(1 for r in top if labels[r["window_id"]] == "CONSULT-LIKE") / len(top), 4) if top else None,
            "share_consult_like_overall": round(sum(1 for r in sc if labels[r["window_id"]] == "CONSULT-LIKE") / len(sc), 4) if sc else None}


CUE_SCORES = (1.0, 2.0)


def agreement_metrics(pop, labels):
    """7A (#10701), numbers only, for one labelling {window_id: label}.
    catch rate = share of cue windows (clinical_score >= cue, per minute) that the rule labels CONSULT-LIKE, at cue 1.0 (primary) and 2.0 (sensitivity);
    no_cue_share = share of CONSULT-LIKE windows whose clinical_score is 0."""
    sc = [r for r in pop if r.get("clinical_score") is not None]
    out = {"catch_rate": {}}
    for cue in CUE_SCORES:
        cues = [r for r in sc if r["clinical_score"] >= cue]
        hit = sum(1 for r in cues if labels[r["window_id"]] == "CONSULT-LIKE")
        out["catch_rate"][f">={cue}"] = {"cue_windows": len(cues), "labelled_consult_like": hit, "share": round(hit / len(cues), 4) if cues else None}
    cl = [r for r in sc if labels[r["window_id"]] == "CONSULT-LIKE"]
    zero = sum(1 for r in cl if r["clinical_score"] == 0)
    out["no_cue"] = {"consult_like_windows": len(cl), "with_score_0": zero, "share": round(zero / len(cl), 4) if cl else None}
    return out


def aggregates(pop, c, visits_info, sample_ids, label_key, room_labels=None, hint_available=False, hint_state=None):
    room_labels = room_labels or {}
    A = {"counts": dict(c), "overlap": visits_info, "windows": len(pop), "audio_h": round(sum(r["audio_s"] for r in pop) / 3600, 2),
         "turn_taking_threshold_s": TT_MIN_S}
    A["per_room"] = {k: {"label": room_labels.get(k), "windows": n, "audio_h": round(h / 3600, 2)} for k, (n, h) in
                     sorted({k: (sum(1 for r in pop if r["room_id"] == k), sum(r["audio_s"] for r in pop if r["room_id"] == k)) for k in {r["room_id"] for r in pop}}.items())}
    for key in ("label", "label_turn_only"):
        by = collections.defaultdict(lambda: [0, 0.0])
        for r in pop:
            by[r[key]][0] += 1
            by[r[key]][1] += r["audio_s"]
        A[key + "_counts"] = {k: {"windows": v[0], "hours": round(v[1] / 3600, 2)} for k, v in sorted(by.items())}
        for dim in ("room_id", "ist_date"):
            t = collections.defaultdict(collections.Counter)
            for r in pop:
                t[r[dim]][r[key]] += 1
            A[f"{key}_by_{dim}"] = {k: dict(v) for k, v in sorted(t.items())}
    A["distributions"] = {"speech_frac": summ([r["speech_frac"] for r in pop]), "n_speakers_10s": summ([r["n_speakers_10s"] for r in pop]),
                          "longest_turn_taking_s": summ([r["longest_turn_taking_s"] for r in pop])}
    # sensitivity: the turn-taking-only labelling (and the text cross-check) at each threshold; the overlap condition is not applied here
    A["sensitivity_turn_only"] = {}
    for thr in SENSITIVITY_S:
        labels = {r["window_id"]: label_of(r["speech_frac"], r["longest_turn_taking_s"] or 0, None, thr) for r in pop}
        cnt, hrs = collections.Counter(labels.values()), collections.Counter()
        for r in pop:
            hrs[labels[r["window_id"]]] += r["audio_s"] / 3600
        A["sensitivity_turn_only"][str(int(thr))] = {
            "label_counts": dict(sorted(cnt.items())), "label_hours": {k: round(v, 2) for k, v in sorted(hrs.items())},
            "clinical_cross_check": clinical_check(pop, labels), "agreement": agreement_metrics(pop, labels)}
    A["agreement_primary"] = agreement_metrics(pop, {r["window_id"]: r[label_key] for r in pop})
    A["clinical_cross_check"] = {"words": list(CLINICAL_WORDS), "score": summ([r["clinical_score"] for r in pop if r.get("clinical_score") is not None]),
                                 "label_key": label_key, **clinical_check(pop, {r["window_id"]: r[label_key] for r in pop})}
    if hint_available:
        hv = [r["usual_room_hint"] for r in pop]
        cl = [r["usual_room_hint"] for r in pop if r[label_key] == "CONSULT-LIKE"]
        A["weak_hint_usual_room"] = {"available": True, "label_gate": False, "note": "share-weighted count of doctors whose usual room that weekday is the window's room (2-9 Oct)",
                                     "all_windows": summ(hv), "windows_with_hint_gt_0": sum(1 for x in hv if x > 0),
                                     "consult_like": {**summ(cl), "with_hint_gt_0": sum(1 for x in cl if x > 0), "n": len(cl)},
                                     "by_weekday_note": "27 Sep 2026 is a Sunday: the table has one Sunday row, so its hints are mostly 0"}
    else:
        A["weak_hint_usual_room"] = {"available": False, "label_gate": False, "state": hint_state or "not_present",
                                     "note": ("NOT AVAILABLE: in/doctor-usual-room-2-9oct.json is present but UNREADABLE (read/parse error)" if hint_state == "unreadable"
                                              else "NOT AVAILABLE: in/doctor-usual-room-2-9oct.json not present") + "; never used as the label gate"}
    A["sample"] = {"n": len(sample_ids), "label_key": label_key, "from_consult_like": sum(1 for r in pop if r[label_key] == "CONSULT-LIKE"),
                   "by_room": dict(collections.Counter(r["room_id"] for r in pop if r["window_id"] in set(sample_ids))),
                   "by_day": dict(collections.Counter(r["ist_date"] for r in pop if r["window_id"] in set(sample_ids)))}
    return A


def table(A):
    L = ["# Window classification 26-27 Sep (counts only)", "",
         f"windows in population {A['windows']} ({A['audio_h']} h); counts {A['counts']}", f"consult overlap (clinic-wide): {A['overlap']}", f"weak hint (usual room 2-9 Oct): {A['weak_hint_usual_room']}", "", "| room | name | windows | audio h |", "|---|---|---|---|"]
    L += [f"| {k} | {v['label'] or ''} | {v['windows']} | {v['audio_h']} |" for k, v in A["per_room"].items()]
    for key in ("label", "label_turn_only"):
        L += ["", f"{key}: windows | hours", "|---|---|---|"] + [f"| {k} | {v['windows']} | {v['hours']} |" for k, v in A[key + "_counts"].items()]
        L += ["", f"{key} by day: {A[key + '_by_ist_date']}", f"{key} by room: {A[key + '_by_room_id']}"]
    L += ["", f"distributions: {A['distributions']}", "", f"clinical cross-check (threshold {A['turn_taking_threshold_s']} s): {A['clinical_cross_check']}"]
    for thr, v in A["sensitivity_turn_only"].items():
        L += ["", f"sensitivity, turn-taking >= {thr} s: windows {v['label_counts']}, hours {v['label_hours']}", f"  cross-check {v['clinical_cross_check']}", f"  agreement {v['agreement']}"]
    L += ["", f"sample: {A['sample']}"]
    return "\n".join(L) + "\n"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", default=os.path.join(OUT, "CLASSIFY-26-27SEP.json"))
    ap.add_argument("--visits", help="counts-only per-visit time file (called_at, completed_at, doctor_uid), JSONL or CSV")
    ap.add_argument("--room-labels", default=os.path.join(IN_DIR, "room-labels.json"))
    ap.add_argument("--usual-room", default=os.path.join(IN_DIR, "doctor-usual-room-2-9oct.json"))
    ap.add_argument("--sample", type=int, default=150)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--root", default=None)
    a = ap.parse_args(argv)
    visits, info = None, {"available": False, "note": "NOT AVAILABLE: no visits file; label = label_turn_only"}
    if a.visits:
        visits, dropped = load_visits(a.visits)
        info = {"available": True, "visits": len(visits), "dropped_rows": dropped, "naive_times_read_as": "IST"}
    usual, hint_state = load_usual_room(a.usual_room)
    pop, c = run(root=a.root, visits=visits, usual_room=usual)
    key = "label" if visits is not None else "label_turn_only"
    ids = sample_stratified(pop, a.sample, a.seed, key)
    A = aggregates(pop, c, info, ids, key, load_room_labels(a.room_labels), hint_available=usual is not None, hint_state=hint_state)
    doc = {"schema": "classify.windows.v1", "generated_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "seed": a.seed,
           "windows": pop, "aggregates": A, "sample_window_ids": ids}
    for path, body in ((a.out, json.dumps(doc, indent=1, sort_keys=True)), (os.path.splitext(a.out)[0] + ".md", table(A))):
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(body)
        os.chmod(path, 0o600)
    print(json.dumps({"out": a.out, "windows": len(pop), "counts": dict(c), "sample": len(ids)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
