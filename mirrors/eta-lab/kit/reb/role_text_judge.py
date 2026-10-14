"""role_text_judge.py: role layer from the Sarvam TEXT (ORDERS-PALIMPSEST-6S9): doctor | patient | attendant | unknown per Sarvam speaker. Never voiceprints.

No Sarvam call. Per consult clip with a live ok stt.sarvam-saaras-v3 track (and, for 8 Oct+ clips, the translate track's English turns):
  Judge A = Jev, one choice question per clip ("which speaker id is the doctor?" over the speaker ids + an escape option), then per remaining speaker with >= 10 s
            of talk "patient or attendant?" (+ escape). Jev sees ONLY speaker id + turn text in order: no names, no cutter fields, no times.
            Thresholds live here: a choice counts only if its probability P >= 0.80 and the runner-up < 0.20; otherwise A abstains.
  Judge B = deterministic heuristic, no model, independent of A (see heuristic_scores: question, instruction-verb, dose and keyword rates, talk share). It can only VETO or confirm; it never assigns a role alone.
Final role per speaker (RULE v1):
  - doctor: A names a doctor, B does not name a different speaker, and fewer than 3 speakers are "comparable" (see below). Otherwise nobody is doctor and
    every speaker is "unknown" (abstain).
  - patient / attendant: only when a doctor was assigned, for speakers with >= 10 s of talk, from A's per-speaker choice (same thresholds); else "unknown".
  - speakers with < 10 s of talk are "unknown".
  - comparable: speakers with >= 10 s of talk whose talk share is within 10 percentage points of the top speaker's; 3 or more of them (the top included) -> abstain.
Track: layer "role", engine "text-judge", version "v1", window_id consult-<uid>, written with writer.write_track into the clip's _consults/<uid>/ dir.
cfg8 = writer.config_hash({stt_sha256, translate_sha256, rule params, jev model id}). Segments = one per stt turn {t0_ms, t1_ms, speaker, role}: NO text anywhere in
the track. Metadata logging only: the state text and the key are never logged or stored.

The real Jev client is NOT in this module yet (6S9 hold: no real consult text to Jev until V confirms). The judge takes any object with
.choose(state, question, options, escape) -> {option: probability}; tests use a fake.
"""
import argparse
import collections
import hashlib
import json
import os
import random
import re
import sys

from . import jev_client
from . import sarvam_lane as sl
from . import writer
from .from_hist import GuardUnavailable, load_heldout, window_held
from .schema import SCHEMA_VERSION
from .validate import validate_track

REB = os.path.expanduser("~/eta-data/reb")
ENGINE, VERSION, LAYER = "text-judge", "v1", "role"
SRC_ENGINE = sl.ENGINE
RULE = {"rule": "v1", "p_min": 0.80, "runner_up_max": 0.20, "min_talk_s": 10.0, "comparable_points": 10.0, "comparable_n": 3,
        "b_min_score": 1.0, "b_margin": 0.25}
ESCAPE = "none / cannot tell"
CLINICAL_WORDS = ("pain", "fever", "cough", "cold", "tablet", "tablets", "medicine", "medicines", "medication", "dose", "prescription", "report", "reports", "scan",
                  "xray", "mri", "ct", "ecg", "ultrasound", "blood", "pressure", "bp", "sugar", "diabetes", "test", "tests", "symptoms", "symptom", "days", "weeks",
                  "since", "allergy", "surgery", "operation", "vomiting", "headache", "injection", "fasting", "swelling", "breathing", "chest", "stomach", "knee")
INSTRUCTION_VERBS = ("take", "avoid", "come", "continue", "stop", "apply", "drink", "eat", "check", "repeat", "start", "use", "follow", "rest", "walk", "reduce", "increase",
                     "bring", "show", "visit", "return", "monitor", "book", "get")
_WORD = re.compile(r"[a-z]+")
_DOSE = re.compile(r"\b\d+(?:\.\d+)?\s?(?:mg|mcg|ml|g|iu|units?)\b|\b(?:od|bd|tds|qid|sos|hs)\b|\b(?:once|twice|thrice)\s+(?:a\s+)?(?:daily|day)\b|\b\d\s?-\s?\d\s?-\s?\d\b", re.I)
COUNTERS = ("clips", "judged", "written", "would_write", "skipped_existing", "no_stt", "signature_mismatch", "blind_refused", "errors", "doctor_assigned",
            "abstain_jev", "abstain_comparable", "abstain_disagree", "abstain_no_speaker", "b_no_call", "jev_calls")


# ---------------------------------------------------------------- input: speaker turns
def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for blk in iter(lambda: f.read(1 << 20), b""):
            h.update(blk)
    return h.hexdigest()


def live_track(root, row, layer):
    """(relative path, absolute path, track) of the latest-finished live ok <layer>.sarvam-saaras-v3 track of the clip, or None."""
    wd = writer._window_dir(root, row["ist_date"], row["room_id"], "consult-" + row["consult_uid"])
    try:
        m = json.load(open(os.path.join(wd, "manifest.json")))
    except (OSError, ValueError):
        return None
    best = None
    for e in m.get("tracks", []):
        if e.get("layer") != layer or e.get("engine") != SRC_ENGINE or e.get("status") != "ok":
            continue
        p = os.path.join(root, e["path"])
        if os.path.exists(p) and (best is None or (e.get("finished_at") or "") >= (best[0] or "")):
            best = (e.get("finished_at"), e["path"], p)
    return (best[1], best[2], json.load(open(best[2]))) if best else None


def align_english(stt_segs, tr_segs):
    """English text per stt segment from the translate track: the translate segment with the largest tape-time overlap (None when none overlaps)."""
    out = []
    for s in stt_segs:
        best, bo = None, 0
        for t in tr_segs:
            o = min(s["t1_ms"], t["t1_ms"]) - max(s["t0_ms"], t["t0_ms"])
            if o > bo:
                best, bo = t, o
        out.append(best.get("text") if best else None)
    return out


def speaker_turns(stt, translate=None):
    """-> [(speaker, text, english_or_None, t0_ms, t1_ms)] in order of start time. english only for clips that have a translate track."""
    segs = sorted(stt["segments"], key=lambda x: (x["t0_ms"], x["t1_ms"]))
    eng = align_english(segs, translate["segments"]) if translate else [None] * len(segs)
    return [(str(s["speaker"]), s.get("text") or "", e, s["t0_ms"], s["t1_ms"]) for s, e in zip(segs, eng)]


def talk_seconds(turns):
    """Seconds of talk per speaker (union of the speaker's own intervals)."""
    iv = collections.defaultdict(list)
    for sp, _, _, a, b in turns:
        iv[sp].append((a / 1000.0, b / 1000.0))
    out = {}
    for sp, xs in iv.items():
        tot, cur = 0.0, None
        for a, b in sorted(xs):
            if cur and a <= cur[1]:
                cur[1] = max(cur[1], b)
            else:
                if cur:
                    tot += cur[1] - cur[0]
                cur = [a, b]
        if cur:
            tot += cur[1] - cur[0]
        out[sp] = tot
    return out


def build_state(turns, english=True):
    """The ONLY text Jev sees: speaker id and turn text, in order. English text replaces the original where a translate turn exists."""
    lines = []
    for sp, text, en, _, _ in turns:
        t = (en if english and en else text).strip()
        if t:
            lines.append(f"[{sp}] {t}")
    return "\n".join(lines)


# ---------------------------------------------------------------- judge B: deterministic heuristic
def heuristic_scores(turns, talk):
    """Per speaker, Latin-script words only (Indic text counts only through its English translate turns):
    question_rate (? per 100 words), instruction_rate (instruction verbs per 100 words), dose_rate (drug/dose patterns per 100 words),
    keyword_rate (7A clinical keywords per 100 words; low weight, because patients describe symptoms too), talk_share.
    score = 2*question_rate + 2*instruction_rate + 1*dose_rate + 0.5*keyword_rate + 10*talk_share. The weights are a first proposal; step 2 measures A against B."""
    words, q, kw, dose, iv = (collections.defaultdict(int) for _ in range(5))
    for sp, text, en, _, _ in turns:
        t = (en or text or "").lower()
        ws = _WORD.findall(t)
        words[sp] += len(ws)
        q[sp] += t.count("?")
        kw[sp] += sum(1 for w in ws if w in CLINICAL_WORDS)
        dose[sp] += len(_DOSE.findall(t))
        iv[sp] += sum(1 for w in ws if w in INSTRUCTION_VERBS)
    total = sum(talk.values()) or 1.0
    out = {}
    for sp in set(talk) | set(words):
        n = max(words[sp], 1)
        r = {"question_rate": 100.0 * q[sp] / n, "instruction_rate": 100.0 * iv[sp] / n, "dose_rate": 100.0 * dose[sp] / n, "keyword_rate": 100.0 * kw[sp] / n,
             "talk_share": talk.get(sp, 0.0) / total, "words": words[sp]}
        r["score"] = 2 * r["question_rate"] + 2 * r["instruction_rate"] + r["dose_rate"] + 0.5 * r["keyword_rate"] + 10.0 * r["talk_share"]
        out[sp] = {k: round(v, 4) if isinstance(v, float) else v for k, v in r.items()}
    return out


def judge_b(scores, talk):
    """-> speaker id B names as doctor, or None. Only speakers with >= min_talk_s qualify; B names the top score when it is >= b_min_score and beats the runner-up
    by more than b_margin (relative: top - second > b_margin * top)."""
    cand = sorted(((v["score"], sp) for sp, v in scores.items() if talk.get(sp, 0) >= RULE["min_talk_s"]), reverse=True)
    if not cand or cand[0][0] < RULE["b_min_score"]:
        return None
    if len(cand) > 1 and cand[0][0] - cand[1][0] <= RULE["b_margin"] * cand[0][0]:
        return None
    return cand[0][1]


# ---------------------------------------------------------------- judge A: Jev choice with an escape
def confident(probs):
    """(option, p) when the top option has P >= p_min and the runner-up < runner_up_max, else (None, top p)."""
    items = sorted(((p, o) for o, p in probs.items()), reverse=True)
    if not items:
        return None, 0.0
    top = items[0]
    run = items[1][0] if len(items) > 1 else 0.0
    if top[0] >= RULE["p_min"] and run < RULE["runner_up_max"]:
        return top[1], top[0]
    return None, top[0]


def judge_a(jev, state, speakers, talk):
    """-> {'doctor': id or None, 'p_doctor': float, 'others': {speaker: (role or None, p)}, 'calls': n}. The escape option never counts as a role."""
    calls = 0
    probs = jev.choose(state, "Which speaker id is the doctor?", list(speakers), ESCAPE)
    calls += 1
    pick, p = confident(probs)
    doctor = pick if pick in speakers else None
    others = {}
    if doctor is not None:
        qs = {sp: (f"Speaker {sp} is not the doctor. Is speaker {sp} the patient or an attendant (someone accompanying the patient)?", ["patient", "attendant"], ESCAPE)
              for sp in speakers if sp != doctor and talk.get(sp, 0) >= RULE["min_talk_s"]}
        if qs:   # ONE request for all the remaining speakers (the state is sent once); a judge without choose_many is asked one by one
            if hasattr(jev, "choose_many"):
                prs = jev.choose_many(state, qs)
                calls += 1
            else:
                prs = {}
                for sp, (q, o, e) in qs.items():
                    prs[sp] = jev.choose(state, q, o, e)
                    calls += 1
            for sp, pr in prs.items():
                r, pp = confident(pr)
                others[sp] = (r if r in ("patient", "attendant") else None, pp)
    return {"doctor": doctor, "p_doctor": round(p, 4), "others": others, "calls": calls}


# ---------------------------------------------------------------- final decision
def comparable_count(talk):
    big = {sp: t for sp, t in talk.items() if t >= RULE["min_talk_s"]}
    if not big:
        return 0
    total = sum(talk.values()) or 1.0
    top = max(big.values()) / total * 100.0
    return sum(1 for t in big.values() if t / total * 100.0 >= top - RULE["comparable_points"])


def decide(speakers, talk, a, b_doctor, scores):
    """-> (map, abstain_reason). map = {speaker: {role, confidence, abstain, judge_a, judge_b}}."""
    reason = None
    if not any(t >= RULE["min_talk_s"] for t in talk.values()):
        reason = "no_qualifying_speaker"
    elif comparable_count(talk) >= RULE["comparable_n"]:
        reason = "comparable_speakers"
    elif a["doctor"] is None:
        reason = "jev_abstain"
    elif b_doctor is not None and b_doctor != a["doctor"]:
        reason = "a_b_disagree"
    out = {}
    for sp in sorted(speakers):
        ja = {"p_doctor": a["p_doctor"] if sp == a["doctor"] else None, "named_doctor": sp == a["doctor"]}
        jb = {"is_top": sp == b_doctor, "score": scores.get(sp, {}).get("score"), "talk_share": scores.get(sp, {}).get("talk_share")}
        if reason is None and sp == a["doctor"]:
            role, conf = "doctor", a["p_doctor"]
        elif reason is None and sp in a["others"] and a["others"][sp][0]:
            role, conf = a["others"][sp][0], round(a["others"][sp][1], 4)
            ja["role"] = role
        else:
            role, conf = "unknown", None
        out[sp] = {"role": role, "confidence": conf, "abstain": role == "unknown", "judge_a": ja, "judge_b": jb}
    return out, reason


# ---------------------------------------------------------------- the track
def build_track(row, stt_rel, stt_sha, stt, tr_sha, mp, turns, jev_name, reason, jev_reported=None):
    """jev_name = the CONFIGURED judge model name (e.g. "jev-latest"), the only judge identity in the cfg8: it is known before any call, so the track hash does not
    depend on processing order. The model id the server reports goes in extras.judge.reported only."""
    uid = row["consult_uid"]
    config = {"stt_sha256": stt_sha, "translate_sha256": tr_sha, "rule": RULE, "jev": jev_name}
    cfg = writer.config_hash(config)
    role_of = {sp: v["role"] for sp, v in mp.items()}
    segs = [{"t0_ms": t0, "t1_ms": t1, "speaker": sp, "role": role_of.get(sp, "unknown")} for sp, _, _, t0, t1 in turns]
    t = {"schema": SCHEMA_VERSION, "window_id": "consult-" + uid, "layer": LAYER, "engine": ENGINE, "model": jev_name or "heuristic-only", "version": VERSION,
         "config": config, "config_hash": cfg, "machine": "box-role-text-judge", "status": "ok" if segs else "empty", "reason": None if segs else "stt track has no turns",
         "segments": segs,
         "extras": {"rule": RULE["rule"], "rule_params": RULE, "map": mp, "abstain_reason": reason, "judge": {"jev": jev_name, "reported": jev_reported},
                    "derived_from": {"stt_path": stt_rel, "stt_sha256": stt_sha, "translate_sha256": tr_sha}, "consult_uid": uid, "clip_signature": row["signature"]}}
    validate_track(t)
    return t


def role_path(root, row, track):
    wd = writer._window_dir(root, row["ist_date"], row["room_id"], "consult-" + row["consult_uid"])
    return os.path.join(wd, "tracks", writer.track_filename(LAYER, ENGINE, VERSION, track["config_hash"]))


# ---------------------------------------------------------------- run
class Budget:
    """--limit N: at most N clips actually go to Jev (decided abstains, which make no Jev call, do not spend it)."""

    def __init__(self, n):
        self.n, self.taken = n, 0

    def take(self):
        if self.n and self.taken >= self.n:
            return False
        self.taken += 1
        return True


def process(row, root, is_held, write, cnt, jev=None, clips_root=sl.CLIPS, budget=None):
    """One clip. jev=None runs the guards, the input extraction and judge B only (a dry run that calls nothing).
    Data minimisation: no transcript text is read before BOTH heldout checks (day+room, then span) pass, and Jev is called only when its answer can change
    the outcome (never for a clip that abstains anyway: 3+ comparable speakers, or nobody with >= 10 s of talk)."""
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
        stt_found = live_track(root, row, "stt")   # the transcript is opened only now
        if not stt_found:
            cnt["no_stt"] += 1
            return
        stt_rel, stt_abs, stt = stt_found
        if (stt.get("config") or {}).get("clip_signature") != row["signature"]:
            cnt["signature_mismatch"] += 1
            return
        tr_found = live_track(root, row, "translate")
        tr = tr_found[2] if tr_found and (tr_found[2].get("config") or {}).get("clip_signature") == row["signature"] else None
        tr_sha = sha256_file(tr_found[1]) if tr else None
        turns = speaker_turns(stt, tr)
        talk = talk_seconds(turns)
        speakers = sorted(talk)
        if not speakers:
            cnt["abstain_no_speaker"] += 1
            return
        scores = heuristic_scores(turns, talk)
        b_doc = judge_b(scores, talk)
        if b_doc is None:
            cnt["b_no_call"] += 1
        if jev is None:
            cnt["judged"] += 1
            return
        if comparable_count(talk) >= RULE["comparable_n"] or not any(t >= RULE["min_talk_s"] for t in talk.values()):
            a = {"doctor": None, "p_doctor": 0.0, "others": {}, "calls": 0}   # the outcome is already an abstain: the text does not leave the box
        else:
            if budget is not None and not budget.take():
                cnt["limit_reached"] += 1
                return
            a = judge_a(jev, build_state(turns), speakers, talk)
        cnt["jev_calls"] += a["calls"]
        mp, reason = decide(speakers, talk, a, b_doc, scores)
        cnt["judged"] += 1
        if reason:
            cnt[{"comparable_speakers": "abstain_comparable", "jev_abstain": "abstain_jev", "a_b_disagree": "abstain_disagree",
                 "no_qualifying_speaker": "abstain_no_speaker"}[reason]] += 1
        else:
            cnt["doctor_assigned"] += 1
        track = build_track(row, stt_rel, sha256_file(stt_abs), stt, tr_sha, mp, turns, getattr(jev, "model", None), reason, getattr(jev, "model_id", None))
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
    except jev_client.JevError as e:   # counted by reason code only (no text, no key in a JevError)
        cnt["errors"] += 1
        cnt["jev_error_" + e.reason] += 1
    except Exception:   # noqa: BLE001 - one bad clip must not stop the run; counted, class only
        cnt["errors"] += 1


def run(args, root=None, is_held=None, jev=None, index_path=sl.CLIP_INDEX, clips_root=sl.CLIPS):
    root = root or REB
    is_held = is_held or load_heldout()   # fail closed before anything is read
    cnt = collections.Counter({k: 0 for k in COUNTERS})
    if jev is not None and not getattr(jev, "model", None):
        raise SystemExit("judge has no configured model name: refusing to build tracks")
    if jev is not None and hasattr(jev, "warm_up"):
        jev.warm_up()   # one synthetic call so the reported model id is known for extras.judge.reported (it is NOT part of the cfg8)
    rows = sl.select(args, index_path)
    limit, seed = getattr(args, "limit", 0), getattr(args, "seed", None)
    if seed is not None:   # a seeded random order, so a --limit sample is not just the oldest clips
        random.Random(seed).shuffle(rows)
    budget = Budget(limit) if (jev is not None and limit) else None
    for r in rows:
        process(r, root, is_held, args.write, cnt, jev, clips_root, budget)
    return dict(cnt)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--consult")
    g.add_argument("--date")
    g.add_argument("--since")
    ap.add_argument("--write", action="store_true", help="write role tracks: refused until the architect's GO for step 2")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--jev", choices=("none", "real"), default="none", help="real = call Jev (V rulings O6/O7); needs --limit")
    ap.add_argument("--limit", type=int, default=0, help="at most N clips go to Jev")
    ap.add_argument("--seed", type=int, default=None, help="seeded random clip order (use with --limit)")
    ap.add_argument("--root")
    a = ap.parse_args(argv)
    if a.write:
        ap.error("--write is not enabled: step 2 (write + measurement) needs the architect's GO after the refuter's PASS of the real-Jev dry run")
    if a.jev == "real" and not a.limit:
        ap.error("--jev real needs --limit N (the dry run is capped)")
    a.min_minutes, a.identified = 0, False
    client, logf = None, None
    if a.jev == "real":
        import threading
        import time
        lock = threading.Lock()
        path = os.path.join(sl.OUT_DIR, "jev-calls-" + time.strftime("%Y%m%dT%H%M%S") + ".jsonl")
        os.makedirs(sl.OUT_DIR, exist_ok=True)
        logf = os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600), "a")

        def log(meta):   # one 0600 JSONL line per call: status, latency, attempt, tokens. Never the state, the questions or the key.
            with lock:
                logf.write(json.dumps({"ts": time.strftime("%H:%M:%S"), "use": "6S9", **meta}, sort_keys=True) + "\n")
                logf.flush()
        client = jev_client.JevClient(log=log)
    try:
        out = {"counts": run(a, root=a.root, jev=client)}
    finally:
        if logf:
            logf.close()
    if client:   # cost / latency: metadata only
        out["jev_call_log"] = path
        st = client.stats
        lat = sorted(st["latency_s"])
        out["jev"] = {"model": client.model_id, "calls": st["calls"], "ok": st["ok"], "retries": st["retries"], "errors": st["errors"],
                      "input_tokens": st["input_tokens"], "output_tokens": st["output_tokens"],
                      "latency_median_s": lat[len(lat) // 2] if lat else None, "latency_p90_s": lat[int(len(lat) * 0.9)] if lat else None,
                      "latency_max_s": lat[-1] if lat else None}
    print(json.dumps(out, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
