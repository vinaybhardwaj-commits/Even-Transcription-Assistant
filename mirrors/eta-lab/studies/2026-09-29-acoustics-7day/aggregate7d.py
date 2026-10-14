#!/usr/bin/env python3
"""T-ACOUSTICS-20 step 2: aggregate chunk_metrics_7d.jsonl into room-acoustic-baseline v2 (numbers only).
Reuses W34.2 aggregate.profile. Days are IST days. Mic per chunk = session_mic.json label where the session is
known, else the install rule from the W39 handover (marked mic_source)."""
import argparse, collections, datetime, hashlib, json, os, sys
from datetime import timedelta, timezone

sys.path.insert(0, os.path.expanduser("~/dev/eta-lab/studies/2026-09-27-room-acoustics"))
import aggregate as ag  # noqa: E402

IST = timezone(timedelta(hours=5, minutes=30))
W = os.path.expanduser("~/eta-data/acoustics/work")
HOME_OFFICE = "room_2qe955hy"
DIETARY = "room_ymch4bxu"
DIETARY_FORMER = "Room 4-1 (after cards, before 5)"


def ist_iso(iso):
    return datetime.datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(IST).isoformat()


def rule_mic(room, ist_day):
    if room in ("room_jwyrr4dc", HOME_OFFICE):
        return "TONOR TM20"
    if room == "room_87frpus9":
        return "TONOR TM20" if ist_day >= "2026-09-26" else "C270 webcam"
    if room == "room_bh6jtq4t":
        return "TONOR TM20" if ist_day <= "2026-09-22" else "C270 webcam"
    return "C270 webcam"


def entry(p, mic_src):
    return {
        "room_label": p["room"], "mic": p["mic"], "mic_source_chunks": mic_src,
        "noise_dbfs_median": p.get("noise_median_dbfs"), "noise_dbfs_p10": p.get("noise_floor_p10_dbfs"),
        "clipping_pct": p.get("clip_pct_ge_0.999"),
        "exact_zero_share": round((p.get("exact_zero_sample_pct") or 0) / 100, 6),
        "rt60_s_blind": (p.get("rt60_blind") or {}).get("median_s"),
        "rt60_n_decays": (p.get("rt60_blind") or {}).get("n_decays"),
        "snr_db_vad_free": (p.get("snr_vad_free_db") or {}).get("median"),
        "snr_db_vad": (p.get("snr_db") or {}).get("median"),
        "speech_level_dbfs_median": p.get("speech_level_dbfs_median"),
        "chunks_no_vad_speech_pct": p.get("chunks_no_vad_speech_pct"),
        "mute_signature_chunk_pct": p.get("mute_signature_chunk_pct"),
        "basis": {"chunks": p.get("chunks"), "chunks_ok": p.get("chunks_ok"), "hours": p.get("hours"), "days": p.get("days")},
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=os.path.expanduser("~/oc/acoustics/t-acoustics-20"))
    ap.add_argument("--out", default=os.path.expanduser("~/oc/acoustics/baselines/room-acoustic-baseline-v2.1.json"))
    a = ap.parse_args()
    meta = json.load(open(os.path.join(a.dir, "selection_meta.json")))
    frozen = {}
    for l in open(meta["frozen_manifest"]):
        r = json.loads(l)
        frozen[r["id"]] = r
    sm = {r["id"]: ag.mic_class(r["mic_label"]) for r in json.load(open(f"{W}/session_mic.json"))}
    rows = [json.loads(l) for l in open(os.path.join(a.dir, "chunk_metrics_7d.jsonl")) if l.startswith("{")]
    groups = collections.defaultdict(list)
    src_count = collections.Counter()
    msrc = collections.defaultdict(collections.Counter)
    agree = collections.Counter()
    for r in rows:
        f = frozen.get(r["id"])
        if not f:
            continue
        r = dict(r)
        r["started_at"] = ist_iso(f["started_at"])
        day = r["started_at"][:10]
        rule = rule_mic(r["room_id"], day)
        if r["session_id"] in sm and sm[r["session_id"]] != "unknown":
            mic, src = sm[r["session_id"]], "session_mic"
            agree[mic == rule] += 1
        else:
            mic, src = rule, "install_rule"
        src_count[src] += 1
        groups[(r["room_id"], mic)].append(r)
        msrc[(r["room_id"], mic)][src] += 1
    names = dict(ag.ROOMS)
    names[HOME_OFFICE] = "Home Office"
    names[DIETARY] = "Dietary Room"
    order = [rid for rid, _ in ag.ROOMS] + [HOME_OFFICE]
    rooms = {}
    for rid in order:
        ents = []
        for (g, mic), rr in sorted(groups.items()):
            if g == rid:
                ents.append(entry(ag.profile(rr, names[rid], mic), dict(msrc[(g, mic)])))
        if not ents:
            continue
        if rid == DIETARY:
            for e in ents:
                e["former_name"] = DIETARY_FORMER
        if rid == HOME_OFFICE:
            for e in ents:
                e["supplementary_out_of_window"] = True
        rooms[rid] = ents[0] if len(ents) == 1 else ents
    blind_days = collections.defaultdict(list)
    for k, n in meta["blind_skipped_by_day_room"].items():
        d, rid = k.split(" ")
        blind_days[rid].append({"ist_day": d, "chunks_skipped": n})
    out = {
        "schema": "room-acoustic-baseline", "version": 2.1,
        "generated": datetime.datetime.now().isoformat(timespec="seconds"),
        "task": "T-ACOUSTICS-20", "supersedes_version": 2, "v2_1_change": "wording only: Home Office note now lists 19 Sep plus 1 chunk on 29 Sep; no data change",
        "window": {"basis": "7 complete IST days", "ist_days": meta["window_ist_days"]},
        "tape_manifest_sha256": meta["frozen_manifest_sha256"], "heldout_union_sha16": meta["union_sha16"],
        "chunks": {"in_window_plus_home_office_selected": meta["selected"], "aggregated": len(rows),
                   "blind_skipped": meta["blind_skipped_total"], "reused_from_w342": meta["reused"]},
        "blind_room_days_skipped": dict(blind_days),
        "mic_source_chunks": dict(src_count),
        "mic_rule_vs_session_mic_agreement": {"agree": agree[True], "disagree": agree[False]},
        "no_data": {"Home Office": "no tape in the 7-day window (tape exists for 19 Sep only, plus 1 chunk on 29 Sep); entry, if present, is supplementary out-of-window"},
        "room_id_notes": {DIETARY: "Dietary Room (Scribe name; renamed from '" + DIETARY_FORMER + "'); measured in the window, see rooms",
                          HOME_OFFICE: "Home Office; tape 19 Sep plus 1 chunk on 29 Sep",
                          "room_7egw2my6": "Home Office Ubuntu (disabled, tape 14-18 Sep only); out of the window, not missed"},
        "note": "DSP only (level, noise floor, SNR, clip share, exact-zero share, silero VAD quiet/speech split, blind RT60). "
                "Field names as v1. A room with two mics in the window carries a LIST of entries. Days are IST. "
                "Rooms with blind room-days removed carry fewer days in basis.days; see blind_room_days_skipped. "
                "SNR/noise caveats N1/N2 from ROOM-PROFILES-2026-09-27 still apply (TONOR rooms: noise includes undetected speech).",
        "rooms": rooms,
    }
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    json.dump(out, open(a.out, "w"), indent=1)
    os.chmod(a.out, 0o640)
    print("wrote", a.out, len(rooms), "rooms", hashlib.sha256(open(a.out, "rb").read()).hexdigest()[:16])


if __name__ == "__main__":
    main()
