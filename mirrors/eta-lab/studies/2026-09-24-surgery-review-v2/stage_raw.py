#!/usr/bin/env python3
"""stage_raw.py — Lane 1 (data), orders/SURGERY-REVIEW-V2-PARALLEL.md: RAW pilot staging in the consult contract format.

Reads selection.json (select_pilot.py), pulls each consult's full turns (called_at -> completed_at) with speaker attribution from the stored diarize
output (room_turn_speaker; READ ONLY, no Mini service is touched), and writes ~/eta-data/surgery-review-v2/staging/<id>.json (0600, dir 0700):
raw "orig" and "en" — NEVER shared, surg-deid replaces them with de-identified text before Jev runs. Ids are P01.. in a seeded random order so
they do NOT encode the bucket. The token/individual link stays in pilot-key.json, never in a consult file.
Turn "i" is 0-based and is the key the page uses for evidence. Speaker labels follow the contract: doctor | A | B | ... | other; "patient_or_attender"
is NOT derivable (no patient voiceprints exist), so it is never emitted. Extra fields "at" (absolute ISO time) and "window" are kept for audio v2.1.
"""
import json, os, random, re, subprocess
from datetime import datetime, timezone, timedelta
from fetch_turns import label_turns, neon

OUT = os.path.expanduser("~/eta-data/surgery-review-v2")
IST = timezone(timedelta(hours=5, minutes=30))
LANG = {"english": "en", "en": "en", "hindi": "hi", "hi": "hi", "kannada": "kn", "kn": "kn", "telugu": "te", "te": "te", "tamil": "ta", "ta": "ta"}
IDRE = re.compile(r"^[A-Za-z0-9_\-]+$")


def norm(n):
    n = (n or "").strip().lower()
    for p in ("dr. ", "dr "):
        if n.startswith(p):
            n = n[len(p):]
    return re.sub(r"\s+", " ", n).strip()


def contract_speaker(label):
    if label == "Doctor":
        return "doctor"
    if label.startswith("Speaker "):
        return label.split(" ", 1)[1]  # A, B, C ... (window-local letters)
    return "other"


def fetch_raw(c):
    if not IDRE.match(c["room_day_id"]):
        raise SystemExit("unexpected id characters")
    rows = neon(f"""SELECT cu.at, cu.payload->>'text' AS text, cu.payload->>'language' AS lang, cu.payload->>'window' AS window,
        (cu.payload->>'start_ms')::bigint AS start_ms, (cu.payload->>'end_ms')::bigint AS end_ms, rts.speaker_idx, rts.role
        FROM cue cu LEFT JOIN room_turn_speaker rts ON rts.source_ref = cu.source_ref
        WHERE cu.type='stt_turn' AND cu.room_day_id='{c['room_day_id']}' AND cu.at BETWEEN '{c['called']}' AND '{c['done']}'
        ORDER BY cu.at, (cu.payload->>'start_ms')::bigint""")
    rows = [r for r in rows if (r["text"] or "").strip()]
    labelled = label_turns([{"at": r["at"], "text": r["text"].strip(), "lang": (r["lang"] or "").lower(), "window": r["window"],
                             "speaker_idx": r["speaker_idx"], "role": r["role"], "_dur": (int(r["end_ms"] or 0) - int(r["start_ms"] or 0)) / 1000.0} for r in rows])
    return labelled


def room_name(room_day_id):
    return neon(f"SELECT r.name FROM room_day rd JOIN room r ON r.id = rd.room_id WHERE rd.id='{room_day_id}'")[0]["name"]


def main():
    sel = json.load(open(f"{OUT}/selection.json"))["pilot"]
    rdd = json.load(open(os.path.expanduser("~/eta-data/surgery-30/room_day_doctor.json")))
    os.makedirs(f"{OUT}/staging", exist_ok=True); os.chmod(f"{OUT}/staging", 0o700)
    order = list(range(len(sel))); random.Random(2409).shuffle(order)  # ids do not follow the bucket order
    key = {}
    for n, k in enumerate(order, 1):
        c = sel[k]
        pid = f"P{n:02d}"
        turns = fetch_raw(c)
        t0 = datetime.fromisoformat(c["called"]).astimezone(IST)
        doc_name = next((o["doctor_name"] for o in rdd if o["room_day_id"] == c["room_day_id"] and o.get("confirmed")), None)
        out_turns = []
        for i, t in enumerate(turns):
            at = datetime.fromisoformat(t["at"].replace("Z", "+00:00")).astimezone(IST)
            s = round((at - t0).total_seconds(), 1)
            out_turns.append({"i": i, "start_s": s, "end_s": round(s + max(t.get("_dur") or 0, 0), 1), "speaker": contract_speaker(t["speaker"]),
                              "lang": LANG.get((t["lang"] or "").lower(), "mixed"), "orig": t["text"], "en": t["text"] if LANG.get((t["lang"] or "").lower()) == "en" else None,
                              "at": t["at"], "window": t["window"], "speaker_basis": t["speaker_basis"]})
        bucket = {"L": "lead", "F": "flag", "N": "neither"}[c["bucket"]]
        doc = {"id": pid, "date": t0.date().isoformat(), "room": room_name(c["room_day_id"]), "doctor": doc_name, "bucket": bucket, "quality": "ok", "turns": out_turns}
        p = f"{OUT}/staging/{pid}.json"
        json.dump(doc, open(p, "w"), ensure_ascii=False, indent=1); os.chmod(p, 0o600)
        key[pid] = {"token_uid": c["token_uid"], "room_day_id": c["room_day_id"], "called": c["called"], "done": c["done"], "bucket": bucket}
        from collections import Counter
        print(pid, "turns", len(out_turns), "| chars", sum(len(t["orig"]) for t in out_turns), "| speakers", dict(Counter(t["speaker"] for t in out_turns)),
              "| langs", dict(Counter(t["lang"] for t in out_turns)), "| minutes", c["minutes"])
    kp = f"{OUT}/pilot-key.json"
    json.dump(key, open(kp, "w"), indent=1); os.chmod(kp, 0o600)
    print("staged", len(key), "consults to", f"{OUT}/staging", "| key file written (bucket + token live only there)")


if __name__ == "__main__":
    main()
