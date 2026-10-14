"""encounter_bounds.py — arm-d encounter boundaries for SURGERY-REVIEW-V3 items (lx, 24 Sep; orders/SURGERY-REVIEW-V3.md §3).

Each review item is ONE whole encounter. Talk outside it (e.g. P02's private staff talk) is shown greyed and not
scored. Boundaries come from the ENCOUNTER-FIRST segmenter (segmenter.py, arm d): energy cuts from the room's level
log, kept inside the doctor's working span from the queue, with the same declared parameters that scored 14/16 on 23 Sep.

Usage:  encounter_bounds.py <items.json> <out.json>
  items.json: [{"item_id", "room_day_id", "ist_date": "YYYY-MM-DD", "called_at", "completed_at" (ISO, with offset),
                "doctor_uid" (PQM routing DOCTOR_UID; optional but needed for the working span)}]
  out.json:   per item
    basis                 "arm_d" (level log) | "arm_d_audio" (no level log, e.g. Aug-22 Sep: energy computed from the
                          room-day's R2 chunks, see r2audio.py) | "pqm_fallback" (neither) | "pqm_no_clip"
    encounter             {start_ms, end_ms}: the ONE encounter to score. Arm d decides what is cut OFF (other talk
                          it separates, like P02's staff conversation); it never shortens the consult. The encounter
                          runs from the primary clip out to the PQM edges, stopping only at another arm-d clip, and is
                          CLAMPED to the PQM interval +- SLACK_MS (eta-refuter-2 #221/#261: an unclamped arm-d clip,
                          especially from audio on label-less days, ran 60-100 min and swallowed its neighbours).
    check_reasons         why check is true (ruling 86): clamped_mid_speech (the +-3 min clamp cut talk that continues with
                          the SAME voices past the edge: the PQM interval itself may be off, eta-refuter-2 #279) /
                          clamped_talk_continues (talk continues past a clamped edge, voices unknown: weaker, review second) /
                          doctor_alone_tail (the last >= 2 min of the encounter have no other voice: grey the tail; see doctor_alone_tail) /
    snapped_to_voice_change  ["start"|"end"]: the NON-DOCTOR voice changes exactly at that PQM edge (back-to-back consults),
                          so the encounter was NOT extended past it. Informational, not a check reason.
                          two_clips / long_pqm (> 20 min: likely several consults) /
                          long_encounter (> 25 min) / speaker_turnover_inside (a voice-set change > 3 min inside the
                          edges, from the diarizer's labels; times in turnovers_inside) / no_speaker_data (no labels
                          that day and > 15 min) / no_cut
    greyed                [{start_ms, end_ms, why}]: other arm-d clips inside the PQM interval + context before/after
    check                 true when two clips each cover >= 30% of the PQM interval (a human should look, as P02)
    clips_in_pqm, pqm     for audit
Run it with ~/.venv-r2/bin/python so days without a level log can use R2 audio (boto3); plain python3 still works
and falls back to the PQM interval for those days.
Reads (read-only): bench_level_sample + diarize_window_label + bench_chunk (kit/neon-select.mjs, SELECT only);
                   R2 chunk audio (read-only key, never printed) cached in ~/eta-data/encounter-first/audio;
                   the doctor's consults that day from Metabase db 13 (read-only key file, never printed).
Prints ids, counts and times only. No text, no audio.
"""
import json, os, subprocess, sys, urllib.request
from datetime import datetime, timedelta
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import segmenter as S

ETA = os.path.expanduser("~/dev/Even-Transcription-Assistant")     # neon-select needs an ETA checkout's node_modules
NEON = os.path.expanduser("~/dev/eta-lab/kit/neon-select.mjs")
CONTEXT_MS = 5 * 60 * 1000       # greyed context shown before/after the encounter
CHECK_SHARE = 0.30
SLACK_MS = 3 * 60 * 1000         # the encounter never runs more than 3 min (arm d's boundary error) past a PQM edge
LONG_PQM_MS = 20 * 60 * 1000     # a PQM interval longer than this likely holds several consults: always check
MAX_ENC_MS = 25 * 60 * 1000      # ruling 86: flag any encounter longer than 25 min
TURN_EDGE_MS = 3 * 60 * 1000     # ruling 86: a speaker turnover more than 3 min inside the encounter's edges is flagged
NO_SPK_MS = 15 * 60 * 1000       # without diarizer labels there is no speaker guard: flag encounters longer than 15 min
EDGE_LOOK_MS = 60 * 1000         # clamped_mid_speech: look 60 s past a clamped edge (eta-refuter-2 #279)


def _pref(labels):
    """One label row per window, pyannote.ai preferred (the same rule as segmenter.turnovers)."""
    best = {}
    for r in labels:
        if r["window_id"] not in best or r["engine"] == "pyannoteai": best[r["window_id"]] = r
    return best


def _segs(r): return json.loads(r["segments_json"]) if isinstance(r["segments_json"], str) else r["segments_json"]


def _seconds(r, a, b):
    """Seconds each diarizer speaker id speaks in [a, b) inside window row r."""
    w0 = int(r["start_ms"]); d = {}
    for sg in _segs(r):
        x, y = max(w0 + sg["start_ms"], a), min(w0 + sg["end_ms"], b)
        if y > x: d[sg["speaker_idx"]] = d.get(sg["speaker_idx"], 0.0) + (y - x) / 1000
    return d


def _doctor_idx(r):
    """The window's dominant speaker: in a consult room, the doctor is the constant voice, so the same person is in the
    consult before and the consult after. Comparing voices WITH the doctor made back-to-back consults look continuous
    (V3-03, 24 Sep): the doctor must be left out."""
    d = _seconds(r, int(r["start_ms"]), int(r["end_ms"]))
    return max(d, key=d.get) if d else None


def _others(labels, a, b, min_s=10.0):
    """Non-doctor speaker ids with >= min_s seconds in [a, b), and the ONE window row they come from. Speaker ids restart
    in each diarizer window, so [a, b) must lie inside a single window; otherwise (None, None): abstain, never guess."""
    win = [r for r in _pref(labels).values() if int(r["start_ms"]) <= a and b <= int(r["end_ms"])]
    if not win: return None, None
    r = win[0]; doc = _doctor_idx(r)
    return {k for k, v in _seconds(r, a, b).items() if k != doc and v >= min_s}, r


def voice_change(labels, edge):
    """Do the NON-DOCTOR voices in the 3 min before `edge` differ from those in the 3 min after (same diarizer window)?
    True = a different person on each side (back-to-back consults); False = the same person continues; None = unknown."""
    b4, r1 = _others(labels, edge - SLACK_MS, edge); af, r2 = _others(labels, edge, edge + SLACK_MS)
    if b4 is None or af is None or r1 is not r2 or not b4 or not af: return None
    return len(b4 & af) / len(b4 | af) <= 1 / 3


def doctor_alone_tail(labels, enc_s, enc_e, min_run_min=2, max_other_s=5.0):
    """Trailing minutes of the encounter in which no non-doctor voice speaks more than max_other_s: (tail_start_ms, minutes)
    or None. Needs labels covering those minutes; the caller greys the tail, it is not trimmed here."""
    mins = []
    for m in range((enc_e - enc_s) // 60000):
        a = enc_e - (m + 1) * 60000
        o, r = _others(labels, a, a + 60000, min_s=0.0)
        if o is None: break                                   # no labels here: stop, never assume silence
        d = _seconds(r, a, a + 60000); doc = _doctor_idx(r)
        if sum(v for k, v in d.items() if k != doc) > max_other_s: break
        mins.append(a)
    return (min(mins), len(mins)) if len(mins) >= min_run_min else None


def _mid_speech(levels, labels, date, edge, outward):
    """Past a clamped edge: "same" when talk continues (energy active in the next EDGE_LOOK_MS) with the SAME NON-DOCTOR
    voice as just inside (the doctor is constant across consults, so counting them made every back-to-back pair look
    like one conversation); "unknown" when talk continues but the voices can't be compared; None when there is no talk
    or the other voice differs."""
    d0, active, _ = S.energy_bins(levels, date); B = S.BIN_S * 1000
    lo, hi = (edge, edge + EDGE_LOOK_MS) if outward > 0 else (edge - EDGE_LOOK_MS, edge)
    bins = [active[i] for i in range((lo - d0) // B, (hi - d0) // B) if 0 <= i < len(active)]
    if not bins or sum(bins) / len(bins) < 0.5: return None
    ins_span = (edge - EDGE_LOOK_MS, edge) if outward > 0 else (edge, edge + EDGE_LOOK_MS)
    ins, r1 = _others(labels, *ins_span, min_s=5.0); outs, r2 = _others(labels, lo, hi, min_s=5.0)
    if ins is None or outs is None or r1 is not r2 or not (ins and outs): return "unknown"
    return "same" if len(ins & outs) / len(ins | outs) > 1 / 3 else None


def ms(ts): return int(datetime.fromisoformat(ts).timestamp() * 1000)

def neon(q):
    r = subprocess.run(["node", NEON, q], cwd=ETA, capture_output=True, text=True)
    if r.returncode: raise SystemExit(f"STAGE_FAIL neon-select rc={r.returncode}")
    return json.loads(r.stdout)

def metabase_doctor_day(doctor_uid, date):
    """The doctor's CONSULTATION steps called on that IST date: [(called_ms, completed_ms)]. Read-only."""
    sec = os.path.expanduser("~/.claude/secrets")
    url = open(f"{sec}/metabase_url").read().strip().rstrip("/"); key = open(f"{sec}/metabase_api_key").read().strip()
    d = datetime.fromisoformat(date).date(); b = [(d + timedelta(days=k)).isoformat() for k in (-1, 0, 1)]
    if not all(c.isalnum() or c in "_-" for c in doctor_uid): raise SystemExit("STAGE_FAIL bad doctor_uid")
    sql = f"""SELECT nullif(qts.called_at,'')::timestamptz AS called_at, nullif(qts.completed_at,'')::timestamptz AS completed_at
              FROM queue_token_steps qts WHERE qts.station = 'CONSULTATION' AND qts.routing->>'DOCTOR_UID' = '{doctor_uid}'
              AND qts.cycle_bucket IN ('{b[0]}','{b[1]}','{b[2]}')"""
    req = urllib.request.Request(f"{url}/api/dataset", method="POST", headers={"Content-Type": "application/json", "x-api-key": key},
                                 data=json.dumps({"database": 13, "type": "native", "native": {"query": sql}}).encode())
    with urllib.request.urlopen(req, timeout=120) as r: res = json.load(r)
    out = []
    for c, e in res["data"]["rows"]:
        if not c or not e: continue
        cm, em = ms(str(c).replace("Z", "+00:00")), ms(str(e).replace("Z", "+00:00"))
        if datetime.utcfromtimestamp(cm / 1000 + 19800).date().isoformat() == date: out.append((cm, em))
    return out

def bounds(items):
    """[item] -> [result]; see the module docstring. Importable (fleet's selection can call it directly)."""
    results = []
    cache = {}
    for it in items:
        rd, date = it["room_day_id"], it["ist_date"]
        if not all(c.isalnum() or c == "_" for c in rd): raise SystemExit("STAGE_FAIL bad room_day_id")
        a, b = ms(it["called_at"]), ms(it["completed_at"])
        if rd not in cache:
            room = neon(f"SELECT room_id FROM room_day WHERE id = '{rd}'")
            lv = neon(f"SELECT (extract(epoch from sampled_at)*1000)::bigint AS t, peak FROM bench_level_sample "
                      f"WHERE ist_date = '{date}' AND room_id = '{room[0]['room_id']}' ORDER BY 1") if room else []
            lb = neon(f"SELECT l.window_id, l.engine, w.start_ms, w.end_ms, l.segments_json FROM diarize_window_label l "
                      f"JOIN bench_window w ON w.id = l.window_id WHERE l.room_day_id = '{rd}'")
            levels_rd, source = [(int(x["t"]), float(x["peak"])) for x in lv], "arm_d"
            if not levels_rd:                  # no level log that day: energy from the room-day's own chunk audio
                try:
                    import r2audio as R
                    d0, d1 = S.day_bounds(date)
                    ch = neon(f"SELECT c.r2_key, (extract(epoch from c.started_at)*1000)::bigint AS started_at FROM bench_chunk c "
                              f"WHERE c.session_id IN (SELECT DISTINCT session_id FROM bench_window WHERE room_day_id = '{rd}') "
                              f"AND coalesce(c.source, 'primary') = 'primary' AND c.upload_state = 'verified' ORDER BY c.started_at")
                    ch = [{"r2_key": c["r2_key"], "started_at": int(c["started_at"])} for c in ch if d0 - 300000 <= int(c["started_at"]) < d1]
                    if ch: levels_rd, source = R.energy_series(ch), "arm_d_audio"
                    print(f"AUDIO {rd} chunks={len(ch)} energy_points={len(levels_rd)}")
                except ImportError:
                    print(f"AUDIO {rd} skipped: boto3 not importable (run with ~/.venv-r2/bin/python)")
            cache[rd] = (levels_rd, [{**x, "start_ms": int(x["start_ms"]), "end_ms": int(x["end_ms"])} for x in lb], source)
        levels, labels, source = cache[rd]
        if it.get("doctor_uid"):
            dk = (it["doctor_uid"], date)            # one Metabase call per doctor-day, however many items share it
            if dk not in cache: cache[dk] = metabase_doctor_day(*dk)
            queue = list(cache[dk])
        else:
            queue = [(a, b)]
        if (a, b) not in queue: queue.append((a, b))
        rec = {"item_id": it["item_id"], "room_day_id": rd, "pqm": {"start_ms": a, "end_ms": b}}
        long_pqm = (b - a) > LONG_PQM_MS
        if not levels:
            rec.update(basis="pqm_fallback", encounter={"start_ms": a, "end_ms": b}, clips_in_pqm=[], check=long_pqm,
                       check_reasons=(["long_pqm", "no_cut"] if long_pqm else []),
                       greyed=[{"start_ms": a - CONTEXT_MS, "end_ms": a, "why": "before (context)"},
                               {"start_ms": b, "end_ms": b + CONTEXT_MS, "why": "after (context)"}])
            results.append(rec); print(f"BOUNDS {it['item_id']} basis=pqm_fallback (no level data {date})"); continue
        clips = S.arm_d(levels, labels, date, queue)
        inside = [(s, e, max(0, min(e, b) - max(s, a))) for s, e in clips if min(e, b) > max(s, a)]
        if not inside:
            rec.update(basis="pqm_no_clip", encounter={"start_ms": a, "end_ms": b}, clips_in_pqm=[], check=True,
                       check_reasons=["no_cut"] + (["long_pqm"] if long_pqm else []),
                       greyed=[{"start_ms": a - CONTEXT_MS, "end_ms": a, "why": "before (context)"},
                               {"start_ms": b, "end_ms": b + CONTEXT_MS, "why": "after (context)"}])
            results.append(rec); print(f"BOUNDS {it['item_id']} basis=pqm_no_clip (no arm-d talk inside the PQM interval)"); continue
        s0, e0, _ = max(inside, key=lambda x: x[2])          # the clip with the most time inside the PQM interval
        prev_end = max([e for s, e, _ in inside if e <= s0], default=None)
        next_start = min([s for s, e, _ in inside if s >= e0], default=None)
        enc_s = min(s0, max(a, prev_end) if prev_end is not None else a)   # extend to the PQM edge, stop at another clip
        enc_e = max(e0, min(b, next_start) if next_start is not None else b)
        raw_s, raw_e = enc_s, enc_e
        enc_s, enc_e = max(enc_s, a - SLACK_MS), min(enc_e, b + SLACK_MS)  # never more than SLACK past a PQM edge
        # BACK-TO-BACK (V3-03, 24 Sep): when the non-doctor voice changes exactly at a PQM edge, the queue edge is right
        # and the talk beyond it is another patient's. Snap to the edge instead of extending 3 min past it.
        snapped = []
        if enc_s < a and voice_change(labels, a) is True: enc_s = a; snapped.append("start")
        if enc_e > b and voice_change(labels, b) is True: enc_e = b; snapped.append("end")
        edge_calls = ([_mid_speech(levels, labels, date, enc_s, -1)] if raw_s < enc_s and "start" not in snapped else []) + \
                     ([_mid_speech(levels, labels, date, enc_e, +1)] if raw_e > enc_e and "end" not in snapped else [])
        tail = doctor_alone_tail(labels, enc_s, enc_e)
        big = [x for x in inside if x[2] >= CHECK_SHARE * (b - a)]
        greyed = [{"start_ms": s, "end_ms": e, "why": "other talk inside the PQM interval (before/after consult)"}
                  for s, e, _ in inside if (s, e) != (s0, e0)]
        lo, hi = min([enc_s] + [g["start_ms"] for g in greyed]), max([enc_e] + [g["end_ms"] for g in greyed])
        greyed += [{"start_ms": lo - CONTEXT_MS, "end_ms": lo, "why": "before (context)"},
                   {"start_ms": hi, "end_ms": hi + CONTEXT_MS, "why": "after (context)"}]
        turns, _ = S.turnovers(labels)
        t_in = [t for t in turns if enc_s + TURN_EDGE_MS < t < enc_e - TURN_EDGE_MS]
        reasons = (["clamped_mid_speech"] if "same" in edge_calls else []) \
            + (["clamped_talk_continues"] if "unknown" in edge_calls and "same" not in edge_calls else []) \
            + (["two_clips"] if len(big) >= 2 else []) + (["long_pqm"] if long_pqm else []) \
            + (["long_encounter"] if enc_e - enc_s > MAX_ENC_MS else []) \
            + (["speaker_turnover_inside"] if t_in else []) \
            + (["doctor_alone_tail"] if tail else []) \
            + (["no_speaker_data"] if not labels and enc_e - enc_s > NO_SPK_MS else [])
        rec.update(basis=source, encounter={"start_ms": enc_s, "end_ms": enc_e}, primary_clip={"start_ms": s0, "end_ms": e0},
                   check=bool(reasons), check_reasons=reasons, turnovers_inside=t_in, snapped_to_voice_change=snapped,
                   doctor_alone_tail=({"from_ms": tail[0], "minutes": tail[1]} if tail else None),
                   clips_in_pqm=[{"start_ms": s, "end_ms": e, "inside_ms": o} for s, e, o in inside], greyed=greyed)
        results.append(rec)
        print(f"BOUNDS {it['item_id']} basis={source} clips_in_pqm={len(inside)} check={rec['check']} reasons={','.join(reasons) or '-'} "
              f"encounter_min={round((enc_e - enc_s) / 60000, 1)} pqm_min={round((b - a) / 60000, 1)}")
    return results


def main():
    items = json.load(open(sys.argv[1]))
    results = bounds(items)
    json.dump(results, open(sys.argv[2], "w"), indent=1)
    print(f"BOUNDS_DONE items={len(results)} arm_d={sum(r['basis'] == 'arm_d' for r in results)} "
          f"arm_d_audio={sum(r['basis'] == 'arm_d_audio' for r in results)} "
          f"fallback={sum(r['basis'].startswith('pqm') for r in results)} check={sum(r['check'] for r in results)}")


if __name__ == "__main__":
    main()
