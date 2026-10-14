#!/usr/bin/env python3
"""build_v3.py — SURGERY-REVIEW-V3 final consult documents. Stages (each idempotent; patient-derived files stay under ~/eta-data, never in git):
  fetch  : for each selected id, the turns of the WHOLE span [context-before .. context-after] from lx's encounter bounds (bounds.json), with speaker labels (voiceprint-only 'doctor'),
           exact timing from the cue's epoch start_ms/end_ms, and phase = before|after for turns outside the ENCOUNTER (greyed, never scored). -> final/staging/Q##.json (RAW, 0600).
  (de-id : deid_gpu.py final/staging final/deid)
  jev    : v3.check_frozen(); Jev sees ONLY the de-identified in-encounter turns (never the greyed context): stage a/b (v3.scan), stage c (v3.detail), per-turn evidence probes, procedure phrase.
  page   : RAW orig/en for the page (ruling 61), jev block from v3.block, why, audio fields -> final/consults/Q##.json (0600).
Turn i is 0-based over the whole span (context included); evidence indices are turns[].i. start_s = seconds since the START OF THE SPAN (the whole-consult audio's second 0), so audio_full.t0_s = 0.
"""
import json, os, sys
from datetime import datetime, timezone
import fetch_turns as ft, stage_raw as sr
import finalize, build_consult as bc, v3

V3 = os.path.expanduser("~/eta-data/surgery-review-v3"); F = f"{V3}/{os.environ.get('V3_FINAL', 'final')}"
SEL = os.environ.get("V3_SEL", "selected.json"); BOUNDS = os.environ.get("V3_BOUNDS", "bounds.json")  # a candidate set (rescan / set B) runs through the same stages


def iso(ms):
    return datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat()


def span_of(b):
    lo = min([b["encounter"]["start_ms"]] + [g["start_ms"] for g in b["greyed"]])
    hi = max([b["encounter"]["end_ms"]] + [g["end_ms"] for g in b["greyed"]])
    return lo, hi


def fetch_one(q, sel, b):
    lo, hi = span_of(b)
    rd = sel["room_day_id"]
    if not ft.IDRE.match(rd):
        raise SystemExit("unexpected id characters")
    rows = ft.neon(f"""SELECT cu.at, cu.payload->>'text' AS text, cu.payload->>'language' AS lang, cu.payload->>'window' AS window,
        (cu.payload->>'start_ms')::bigint AS start_ms, (cu.payload->>'end_ms')::bigint AS end_ms, rts.speaker_idx, rts.role
        FROM cue cu LEFT JOIN room_turn_speaker rts ON rts.source_ref = cu.source_ref
        WHERE cu.type='stt_turn' AND cu.room_day_id='{rd}' AND cu.at BETWEEN '{iso(lo)}' AND '{iso(hi)}'
        ORDER BY cu.at, (cu.payload->>'start_ms')::bigint""")
    rows = [r for r in rows if (r["text"] or "").strip()]
    lab = ft.label_turns([{"at": r["at"], "text": r["text"].strip(), "lang": (r["lang"] or "").lower(), "window": r["window"], "speaker_idx": r["speaker_idx"], "role": r["role"],
                           "s": int(r["start_ms"]), "e": int(r["end_ms"] or r["start_ms"])} for r in rows])
    es, ee = b["encounter"]["start_ms"], b["encounter"]["end_ms"]
    turns = []
    for i, t in enumerate(lab):
        lang = sr.LANG.get(t["lang"], "en" if not t["lang"] else t["lang"][:2])
        d = {"i": i, "start_s": round((t["s"] - lo) / 1000, 2), "end_s": round((max(t["e"], t["s"] + 1000) - lo) / 1000, 2), "speaker": sr.contract_speaker(t["speaker"]), "lang": lang,
             "orig": t["text"], "en": t["text"] if lang == "en" else None, "at": t["at"]}
        if t["s"] < es:
            d["phase"] = "before"
        elif t["s"] >= ee:
            d["phase"] = "after"
        turns.append(d)
    return {"id": q, "span": {"start_ms": lo, "end_ms": hi}, "encounter": b["encounter"], "turns": turns}


def stage_fetch():
    S = json.load(open(f"{V3}/{SEL}")); B = {x["item_id"]: x for x in json.load(open(f"{V3}/{BOUNDS}"))}
    os.makedirs(f"{F}/staging", exist_ok=True)
    for d in (F, f"{F}/staging"):
        os.chmod(d, 0o700)
    for q in sorted(S):
        doc = fetch_one(q, S[q], B[q])
        p = f"{F}/staging/{q}.json"; json.dump(doc, open(p, "w"), ensure_ascii=False); os.chmod(p, 0o600)
        ph = [t.get("phase", "in") for t in doc["turns"]]
        print(q, "turns", len(ph), "| in", ph.count("in"), "before", ph.count("before"), "after", ph.count("after"), "| non-en", sum(1 for t in doc["turns"] if t["lang"] != "en"),
              "| span_min", round((doc["span"]["end_ms"] - doc["span"]["start_ms"]) / 60000, 1))


BEFORE_S, AFTER_S = 300.0, 120.0  # ruling 74: grey only the last 5 min before and 2 min after the encounter; the rest sits behind the page's "show earlier talk" toggle


def earlier(t, enc_s, enc_e):
    """True for an OUTSIDE turn that starts more than 5 min before the encounter or more than 2 min after it (turn times are seconds since the span start)."""
    if "phase" not in t:
        return False
    return t["start_s"] < enc_s - BEFORE_S if t["phase"] == "before" else t["start_s"] >= enc_e + AFTER_S


def apply_rules(blk, status):
    """Ruling 62: history means nothing is being proposed now, so the proposer is unclear whatever the noul said (rule in code, not wording). Marked derived."""
    if status == "history" and "proposer" in blk:
        blk["proposer"] = {"answer": "unclear", "conf": blk["status"]["conf"], "evidence": [], "derived": True}
    return blk


ALLOWED = {"firmness": {"suggested", "advised", "strongly_advised", "scheduled"}, "patient_response": {"agreed", "will_think", "declined", "not_stated"}}
STATUS_OUT = {"history": "already_done"}
RAISED_OUT = {"patient": "patient_or_family"}


def to_page_shape(blk):
    """v3.block's keys -> the shape surg-page adopted (bus #179/#184): named{answer|null, category|null}, described, status (already_done, not history), raised_by
    (patient_or_family, not patient), firmness, patient_response, cost, second_opinion. An ABSENT key = the page has no Jev proposal for it."""
    proc = blk["procedure"]
    out = {"named": {"answer": None if proc["answer"] == "not named" else proc["answer"], "category": blk.get("category", {}).get("answer"), "conf": proc["conf"], "evidence": proc["evidence"]},
           "described": blk["described"]}
    if "status" in blk:
        out["status"] = {**blk["status"], "answer": STATUS_OUT.get(blk["status"]["answer"], blk["status"]["answer"])}
    if "proposer" in blk:
        out["raised_by"] = {**blk["proposer"], "answer": RAISED_OUT.get(blk["proposer"]["answer"], blk["proposer"]["answer"])}
    for k in ("firmness", "patient_response", "cost", "second_opinion"):
        if k in blk and (k not in ALLOWED or blk[k]["answer"] in ALLOWED[k]):  # an answer outside the page's options (Jev's "not_applicable") is no proposal: the key stays ABSENT
            out[k] = blk[k]
    return out


def selftest():
    prop = v3.block({"recall_p": 0.9}, {"status": ("proposed_now", 0.9), "raised_by": ("patient_or_family", 0.8), "category": ("operation", 0.9)},
                    {"firmness": ("advised", 0.8), "patient_response": ("agreed", 0.9), "cost": ("yes", 0.9), "second_opinion": ("no", 0.9)}, {"phrase": "septoplasty", "named": True}, {"procedure": [3], "patient_reaction": [7]})
    o = to_page_shape(prop)
    assert o["named"]["answer"] == "septoplasty" and o["named"]["category"] == "operation" and o["named"]["evidence"] == [3], "named carries the phrase, the category and the evidence"
    assert o["raised_by"]["answer"] == "patient_or_family" and o["status"]["answer"] == "proposed_now" and o["firmness"]["answer"] == "advised" and o["patient_response"]["evidence"] == [7]
    assert "procedure" not in o and "proposer" not in o and "category" not in o, "no v3.block-only keys leak into the page shape"
    h = to_page_shape(apply_rules(v3.block({"recall_p": 0.9}, {"status": ("history", 0.8), "raised_by": ("this_doctor", 0.6), "category": ("intervention", 0.9)}, {"cost": ("no", 0.9)},
                                          {"phrase": "angiogram", "named": True}, {"procedure": [3]}), "history"))
    assert h["status"]["answer"] == "already_done", "history is called already_done on the page"
    assert h["raised_by"]["answer"] == "unclear" and h["raised_by"].get("derived") is True, "history => proposer unclear (ruling 62), marked derived"
    assert "firmness" not in h and "patient_response" not in h, "no firmness/response unless proposed now"
    n = to_page_shape(v3.block({"recall_p": 0.05}, None))
    assert set(n) == {"named", "described"} and n["named"]["answer"] is None and n["named"]["category"] is None and n["described"]["answer"] == "no", "nothing surgical: two keys only"
    nn = to_page_shape(v3.block({"recall_p": 0.9}, {"status": ("proposed_now", 0.9), "raised_by": ("this_doctor", 0.9), "category": ("operation", 0.9)}, {}, {"phrase": None, "named": False}, {"procedure": [1]}))
    assert nn["named"]["answer"] is None, "described but no procedure phrase: named is null (the page then asks only that question)"
    na = to_page_shape(v3.block({"recall_p": 0.9}, {"status": ("proposed_now", 0.9), "raised_by": ("this_doctor", 0.9), "category": ("minor", 0.9)},
                                {"firmness": ("not_applicable", 0.9), "patient_response": ("agreed", 0.9)}, {"phrase": "x", "named": True}, {"procedure": [1]}))
    assert "firmness" not in na and na["patient_response"]["answer"] == "agreed", "a firmness of not_applicable is dropped, never shown"
    b4 = {"phase": "before", "start_s": 0.0}; a4 = {"phase": "after", "start_s": 0.0}
    assert earlier({"phase": "before", "start_s": 99.0}, 500.0, 900.0) and not earlier({"phase": "before", "start_s": 200.0}, 500.0, 900.0), "before: earlier only beyond the last 5 min (200 s)"
    assert not earlier({"phase": "before", "start_s": 200.0 + 1e-9}, 500.0, 900.0) and earlier({"phase": "before", "start_s": 199.9}, 500.0, 900.0), "5-minute edge"
    assert earlier({"phase": "after", "start_s": 1020.0}, 500.0, 900.0) and not earlier({"phase": "after", "start_s": 1019.9}, 500.0, 900.0), "after: earlier beyond 2 min (120 s) past the encounter end"
    assert not earlier({"start_s": 0.0}, 500.0, 900.0), "an in-encounter turn is never earlier"
    print("build_v3 selftest OK: page shape (named/described/status/raised_by), history->already_done + proposer unclear derived, patient->patient_or_family, absent keys, null named")


def validate(ids):
    """Contract check of final/consults/Q##.json against surg-page's shape (#179/#184/#185) and the privacy rules. Prints ids and counts only."""
    S = json.load(open(f"{V3}/{SEL}")); bad = 0
    ok_status = {"proposed_now", "already_done", "referred", "mentioned_only"}; ok_raised = {"this_doctor", "another_doctor", "patient_or_family", "unclear"}
    for q in ids:
        raw = open(f"{F}/consults/{q}.json").read(); d = json.loads(raw); errs = []
        for k in ("id", "date", "room", "doctor", "turns", "jev", "why", "audio_full"):
            if k not in d:
                errs.append(f"missing {k}")
        priv = [S[q]["token_uid"], S[q]["room_day_id"]] + ([S[q]["booked_procedure"]] if False else [])
        errs += [f"private value in file: {x[:4]}..." for x in priv if x and x in raw]
        for banned in ("bucket", "token_uid", "individual_uid", "not_applicable"):
            if f'"{banned}"' in raw or (banned == "not_applicable" and banned in raw):
                errs.append(f"banned key/value {banned}")
        T = {t["i"]: t for t in d["turns"]}
        if [t["i"] for t in d["turns"]] != list(range(len(d["turns"]))):
            errs.append("turn i is not 0..n-1")
        if any(t["end_s"] < t["start_s"] for t in d["turns"]) or any(b["start_s"] < a["start_s"] - 1 for a, b in zip(d["turns"], d["turns"][1:])):
            errs.append("turn times out of order")
        if any("earlier" in t and "outside" not in t for t in d["turns"]):
            errs.append("earlier flag on an in-encounter turn")
        for t in d["turns"]:
            if ("outside" in t) != ("phase" in t) or t.get("phase", "before") not in ("before", "after"):
                errs.append("outside/phase mismatch"); break
        j = d["jev"]
        if set(j) - {"named", "described", "status", "raised_by", "firmness", "patient_response", "cost", "second_opinion"} or not {"named", "described"} <= set(j):
            errs.append(f"jev keys {sorted(j)}")
        if "status" in j and j["status"]["answer"] not in ok_status:
            errs.append("status value")
        if "raised_by" in j and j["raised_by"]["answer"] not in ok_raised:
            errs.append("raised_by value")
        if ("firmness" in j or "patient_response" in j) and j.get("status", {}).get("answer") != "proposed_now":
            errs.append("firmness/response without proposed_now")
        for k, v in j.items():
            for i in v["evidence"]:
                if i not in T or "outside" in T[i]:
                    errs.append(f"{k} evidence {i} is missing or outside the consult")
        for i in {i for v in j.values() for i in v["evidence"]}:
            if not (T[i]["audio"] and all(os.path.exists(f"{F}/{a}") for a in T[i]["audio"])):
                errs.append(f"evidence turn {i} has no clip file")
        a = d["audio_full"]
        if not os.path.exists(f"{F}/{a['src']}") or a["t0_s"] != 0.0 or a["duration_s"] < max(t["start_s"] for t in d["turns"]):
            errs.append("audio_full")
        if not {"source", "booked_procedure", "booked_source", "days_after_consult", "jev_scan"} <= set(d["why"]):
            errs.append("why keys")
        print(q, "OK" if not errs else f"FAIL {errs}", "| turns", len(d["turns"]), "| outside", sum(1 for t in d["turns"] if "outside" in t), "| jev keys", len(j), "| clips", sum(1 for t in d["turns"] if t["audio"]))
        bad += bool(errs)
    if bad:
        raise SystemExit(f"{bad} consult(s) failed validation")


def jev_one(q, ask=None, transport=None):
    v3.check_frozen()  # only the frozen wording scores
    doc = json.load(open(f"{F}/deid/{q}.json"))
    inn = [t for t in doc["turns"] if "phase" not in t]  # the encounter only: the greyed context is never scored
    bad = finalize.residual_identifiers(inn)
    if bad:
        raise SystemExit(f"REFUSED {q}: {len(bad)} identifier/script hits remain after de-identification")
    turns = finalize.to_bc_turns({"turns": inn})
    state = bc.state_text(turns)
    sc = v3.scan(state, ask=ask)
    a = {"recall_p": sc["recall_p"]}; b, c, ev, phrase, calls = sc["b"], None, {}, None, 0
    if sc["passed"] and sc["recall_p"] >= 0.5 and b:
        c = v3.detail(state, b["status"][0], ask=ask)
        answers = {}
        for ch in bc.chunks(bc.probe_questions(turns), bc.CHUNK):
            answers.update((ask or v3.u9.ask)(state, ch)["answers"]); calls += 1
        ev = bc.evidence_from(answers, turns)
        phrase = bc.procedure_phrase(turns, ev["procedure"], transport=transport)
    blk = apply_rules(v3.block(a, b, c, phrase, ev), b["status"][0] if b else None)
    valid = {t["i"] for t in inn}
    for k, v in blk.items():
        assert all(i in valid for i in v["evidence"]), f"{q}.{k}: evidence must point at in-encounter turns only"
    return {"jev": blk, "meta": {"wording": v3.WORDING_VERSION, "wording_sha256": v3.canonical_hash(), "recall_p": round(sc["recall_p"], 3), "passed": sc["passed"], "probe_calls": calls,
                                 "text_seen_by_jev": "de-identified, in-encounter turns only", "phrase_model": bc.TRANSLATE_MODEL}}


def stage_jev(ids):
    os.makedirs(f"{F}/jev", exist_ok=True); os.chmod(f"{F}/jev", 0o700)
    for q in ids:
        r = jev_one(q); p = f"{F}/jev/{q}.json"; json.dump(r, open(p, "w"), ensure_ascii=False, indent=1); os.chmod(p, 0o600)
        j = r["jev"]
        print(q, "recall", r["meta"]["recall_p"], "| described", j["described"]["answer"], "| status", j.get("status", {}).get("answer"), "| category", j.get("category", {}).get("answer"),
              "| proposer", j.get("proposer", {}).get("answer"), "| evidence turns", len(j["described"]["evidence"]), "| keys", len(j))


def stage_page(ids):
    import subprocess
    S = json.load(open(f"{V3}/{SEL}")); A = {a["token_uid"]: a for a in json.load(open(f"{V3}/anchors.json"))}
    conf = json.load(open(f"{V3}/confirmed_room_days.json")); os.makedirs(f"{F}/consults", exist_ok=True); os.chmod(f"{F}/consults", 0o700)
    for q in ids:
        st = json.load(open(f"{F}/staging/{q}.json")); jv = json.load(open(f"{F}/jev/{q}.json")); m = S[q]
        anc = A.get(m["token_uid"]); doctor = (anc or {}).get("doctor_name") or next((o["doctor_name"] for o in conf if o["room_day_id"] == m["room_day_id"]), None)
        jm = jv["jev"]; jst = jm.get("status", {}).get("answer")
        why = {"source": "booking" if (m["source"] == "anchor" and anc) else "jev", "booked_procedure": anc["booked_procedure"] if anc else None,
               "booked_source": anc["booked_source"] if anc else None, "days_after_consult": int(round(anc["days_after"])) if anc else None,
               "jev_scan": {"recall_p": jv["meta"]["recall_p"], "status": STATUS_OUT.get(jst, jst)}}
        mp3 = f"{F}/audio/{q}/full.mp3"
        dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp3], capture_output=True, text=True).stdout)
        enc_s, enc_e = (st["encounter"]["start_ms"] - st["span"]["start_ms"]) / 1000, (st["encounter"]["end_ms"] - st["span"]["start_ms"]) / 1000
        turns = []
        for t in st["turns"]:
            d = {"i": t["i"], "start_s": t["start_s"], "end_s": t["end_s"], "speaker": t["speaker"], "lang": t["lang"], "orig": t["orig"], "en": t["en"] if t["en"] is not None else t["orig"], "audio": []}
            if "phase" in t:
                d["outside"] = True; d["phase"] = t["phase"]  # #184 reads `outside`; `phase` (before|after) is kept for the tag
                if earlier(t, enc_s, enc_e):
                    d["earlier"] = True  # behind the "show earlier talk" toggle (ruling 74)
            turns.append(d)
        doc = {"id": q, "date": m["day"], "room": sr.room_name(m["room_day_id"]), "doctor": doctor, "turns": turns, "jev": to_page_shape(jv["jev"]), "why": why,
               "encounter": {"start_s": round(enc_s, 2), "end_s": round(enc_e, 2)}, "audio_full": {"src": f"audio/{q}/full.mp3", "t0_s": 0.0, "duration_s": round(dur, 1)}, "meta": jv["meta"]}
        p = f"{F}/consults/{q}.json"; json.dump(doc, open(p, "w"), ensure_ascii=False, indent=1); os.chmod(p, 0o600)
        print(q, "turns", len(turns), "| why", why["source"], "| audio_full", doc["audio_full"]["duration_s"], "s")


if __name__ == "__main__":
    cmd, ids = sys.argv[1], sys.argv[2:]
    {"validate": lambda: validate(ids), "selftest": lambda: selftest(), "fetch": lambda: stage_fetch(), "jev": lambda: stage_jev(ids), "page": lambda: stage_page(ids)}[cmd]()
