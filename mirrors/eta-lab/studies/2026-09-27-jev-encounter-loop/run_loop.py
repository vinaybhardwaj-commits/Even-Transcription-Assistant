"""run_loop.py — orchestrates chunker -> candidates -> jev_client -> state_machine for one room-day and
writes both outputs: `hyp-<out>/hyp-jevloop.json` (fullday_score.py harness shape) and
`~/eta-data/timeline/<room_id>/<date>.json` (lab-viewer's TIMELINE-SHAPES.md contract — W49 renamed
this from ENCOUNTERS-SHAPES.md/`/encounters`; lx only ever fills the `detected.jev_loop` key, which
is unchanged across the rename; `pqm_truth`/`cap_links` in that file are linker/cap's, not lx's).

Usage: run_loop.py --room-day <rd_id> --room <room_id> --date <YYYY-MM-DD> --out <dir>
         --transcript "<name>" [--backend jev|mock] [--timeline-dir <dir, default ~/eta-data/timeline>]

Real data (fetch_turns/fetch_translations) is only touched with --backend jev; --backend mock runs entirely
against a synthetic fixture (see selftest.sh) so this file never needs a live DB/Jev call to be exercised.
Counts, ids and timings only on stdout — no transcript text, no patient identity (pane-brief rule).
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "2026-09-24-encounter-first"))
import candidates as CAND  # noqa: E402
import chunker  # noqa: E402
import jev_client  # noqa: E402
import jev_loop_constants as K  # noqa: E402
import segmenter as S  # noqa: E402
import state_machine as SM  # noqa: E402

ETA = os.path.expanduser("~/dev/Even-Transcription-Assistant")
NEON = os.path.expanduser("~/dev/eta-lab/kit/neon-select.mjs")


def neon(sql):
    r = subprocess.run(["node", NEON, sql], cwd=ETA, capture_output=True, text=True, timeout=600)
    if r.returncode:
        raise SystemExit(f"STAGE_FAIL neon-select rc={r.returncode}: {r.stderr[:200]}")
    return json.loads(r.stdout)


def fetch_levels_labels(room_id, rd_id, date):
    """Same bench_level_sample / diarize_window_label read encounter_bounds.py already does (reuse, not
    reimplement); used only to snap boundaries to an acoustic activity edge."""
    lv = neon(f"SELECT (extract(epoch from sampled_at)*1000)::bigint AS t, peak FROM bench_level_sample "
              f"WHERE ist_date = '{date}' AND room_id = '{room_id}' ORDER BY 1")
    lb = neon(f"SELECT l.window_id, l.engine, w.start_ms, w.end_ms, l.segments_json FROM diarize_window_label l "
              f"JOIN bench_window w ON w.id = l.window_id WHERE l.room_day_id = '{rd_id}'")
    levels = [(int(x["t"]), float(x["peak"])) for x in lv]
    labels = [{**x, "start_ms": int(x["start_ms"]), "end_ms": int(x["end_ms"])} for x in lb]
    return levels, labels


def constants_sha256():
    return hashlib.sha256(open(os.path.join(HERE, "jev_loop_constants.py"), "rb").read()).hexdigest()


def run_room_day(room, date, rd_id, backend, levels=None, labels=None, turns=None, translations=None):
    """The whole pipeline for one room-day. `levels`/`labels`/`turns`/`translations` are injectable (used by
    selftest.sh's synthetic fixture); when omitted, fetched from the real sources (--backend jev only)."""
    if turns is None:
        turns = chunker.fetch_turns(rd_id)
    if translations is None:
        translations = chunker.fetch_translations(rd_id, turns) if backend == "jev" else {}
    chunks, prev_texts = chunker.build_chunks(turns, translations, room, date, rd_id)
    cands = [CAND.hits(c) for c in chunks]
    answers = [jev_client.answer_chunk(c, p, backend=backend) for c, p in zip(chunks, prev_texts)]
    states, raw_encounters = SM.run(chunks, answers, cands)
    if levels is None or labels is None:
        levels, labels = ([], []) if backend == "mock" else fetch_levels_labels(room, rd_id, date)
    encounters = SM.snap_boundaries(raw_encounters, levels, labels, date)

    n_missing = sum(1 for c in chunks if c["translation_missing"])
    coverage = "PARTIAL" if chunks and n_missing / len(chunks) > K.PARTIAL_COVERAGE_SHARE else "FULL"

    def enc_meta(e):
        mid_chunks = [(a, c) for c, a in zip(chunks, answers)
                      if a and c["start_ms"] < e["end_ms"] and c["end_ms"] > e["start_ms"]]
        confs = [a["phase_confidence"] for a, _ in mid_chunks if a["phase_confidence"] is not None]
        best = max(mid_chunks, key=lambda ac: ac[0]["phase_confidence"] or 0, default=(None, None))[0]
        return {"conf": round(sum(confs) / len(confs), 2) if confs else None,
                "phase_probs": best["phase_probs"] if best else None}

    print(f"JEVLOOP {rd_id} chunks={len(chunks)} translation_missing={n_missing} coverage={coverage} "
          f"encounters={len(encounters)} backend={backend}")
    return {"chunks": chunks, "answers": answers, "encounters": encounters, "coverage": coverage,
            "n_missing": n_missing, "meta_by_enc": [enc_meta(e) for e in encounters]}


def write_outputs(out_dir, timeline_dir, room, date, rd_id, transcript, result):
    os.makedirs(out_dir, exist_ok=True)
    hyp_path = os.path.join(out_dir, "hyp-jevloop.json")
    room_days = json.load(open(hyp_path))["room_days"] if os.path.exists(hyp_path) else {}
    room_days[rd_id] = {
        "room": room, "date": date, "energy_gap": False, "coverage": result["coverage"],
        # back_to_back_start/end (eta-refuter-2 #4633): extra fields fullday_score.py/e7_score.py
        # ignore (they read id/start_ms/end_ms only) but a separate report needs, to declare the
        # known chunk-boundary bias on back-to-back consults instead of averaging it away silently.
        "encounters": [{"id": e["id"], "start_ms": e["start_ms"], "end_ms": e["end_ms"],
                         "back_to_back_start": e.get("back_to_back_start", False),
                         "back_to_back_end": e.get("back_to_back_end", False)}
                        for e in result["encounters"]],
    }
    hyp = {"source": "jev-loop", "smoother_version": "w44-v1", "transcript_version": transcript,
           "jev_model": K.JEV_MODEL, "constants_sha256": constants_sha256(), "room_days": room_days}
    json.dump(hyp, open(hyp_path, "w"), indent=1)

    room_dir = os.path.join(os.path.expanduser(timeline_dir), room)
    os.makedirs(room_dir, exist_ok=True)
    tl_path = os.path.join(room_dir, f"{date}.json")
    # TIMELINE-SHAPES.md: pqm_truth/cap_links are linker/cap's keys, never lx's — omit them entirely
    # (not an empty list) so an untouched key reads as "not processed yet", never "checked, zero found".
    existing = json.load(open(tl_path)) if os.path.exists(tl_path) else {"schema": 1, "room_id": room,
                                                                           "date": date, "detected": {}}
    existing["detected"]["jev_loop"] = [
        {"id": e["id"], "start_ms": e["start_ms"], "end_ms": e["end_ms"], **{k: v for k, v in m.items() if v is not None}}
        for e, m in zip(result["encounters"], result["meta_by_enc"])]
    existing["source_sha256"] = hashlib.sha256(json.dumps(existing["detected"], sort_keys=True).encode()).hexdigest()
    json.dump(existing, open(tl_path, "w"), indent=1)
    return hyp_path, tl_path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--room-day", required=True, dest="rd_id")
    ap.add_argument("--room", required=True)
    ap.add_argument("--date", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--transcript", required=True)
    ap.add_argument("--backend", choices=["jev", "mock"], default="jev")
    ap.add_argument("--timeline-dir", default="~/eta-data/timeline")
    a = ap.parse_args()
    result = run_room_day(a.room, a.date, a.rd_id, a.backend)
    hyp_path, tl_path = write_outputs(a.out, a.timeline_dir, a.room, a.date, a.rd_id, a.transcript, result)
    print(f"JEVLOOP_DONE {a.rd_id} hyp={hyp_path} timeline_file={tl_path}")


if __name__ == "__main__":
    main()
