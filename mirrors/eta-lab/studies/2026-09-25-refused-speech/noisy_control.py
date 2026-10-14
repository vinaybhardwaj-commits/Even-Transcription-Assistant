"""noisy_control.py: the NOISY-SILENCE control added by dated addendum (eta-refuter #1831), declared before the 30 refused-window results were opened.
The exact-zero controls are digital silence, so they cannot show whether a detector fires on steady room noise or hum. This adds real-microphone windows in which the router
found NO text at all (vault status no_text), measured over the whole 900 s with the SAME detectors as the main run.

  N1 (night): 8 windows, IST 01:00-05:00, in the rooms of the 30 drawn windows, all of the kind the router found no text in. NO such window exists since 22 Sep (the C270 webcam-mic period), so
     the 33 candidates are 14-20 Sep (the same recorder period as 27 of the 30 drawn windows). Drawn with seed SEED+3.
  N2 (C270 period): 6 windows dated >= 22 Sep (any hour) in the drawn rooms with status no_text (pool 19; the C270 mics). Drawn with seed SEED+4. CAVEAT: these are daytime windows in which the
     router found no text, and the router's VAD is known to miss low-SNR speech, so a window here may hold real speech; N2 is reported, with no pass/fail.
  Criterion (frozen now, N1 only): primary (webrtcvad mode 3) speech fraction median <= 0.05 AND at most 1 of the 8 at >= 0.10. If N1 fails, the primary detector fires on room noise and the
  30-window counts overstate speech; that is then the finding.

  python3 noisy_control.py draw    --out-dir D    (no audio)
  python3 noisy_control.py measure --draw D/noisy_draw.json --out D/noisy_results.json      (run with /home/eta/vad/venv/bin/python)
"""
import argparse, json, os, sys
from datetime import datetime, timedelta, timezone

import refused_logic as R
import measure as M

IST = timezone(timedelta(hours=5, minutes=30))
N1, N2 = 8, 6
N1_MEDIAN_MAX, N1_HIGH_FRAC, N1_HIGH_MAX = 0.05, 0.10, 1


def ist_hour(start):
    if not start:
        return None
    d = datetime.fromisoformat(start.replace("Z", "+00:00"))
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d.astimezone(IST).hour


def candidates(rows, rooms):
    nt = [r for r in rows if r["status"] == "no_text" and r["room_id"] in rooms]
    n1 = sorted(r["window_id"] for r in nt if ist_hour(r.get("start")) is not None and 1 <= ist_hour(r["start"]) < 5 and r["ist_date"] < "2026-09-22")
    n2 = sorted(r["window_id"] for r in nt if r["ist_date"] >= "2026-09-22")
    return n1, n2


def cmd_draw(main_draw, out_dir):
    doc = R.read_json(main_draw)
    rooms = set(doc["chosen"])
    n1, n2 = candidates(R.read_jsonl(R.VIEW_INDEX), rooms)
    out = dict(seed=R.SEED, logic_sha256=R.sha256_file(R.__file__), rooms=sorted(rooms), pool_n1=len(n1), pool_n2=len(n2),
               n1=R.pick(n1, N1, R.SEED + 3), n2=R.pick(n2, N2, R.SEED + 4),
               declared="post-hoc: written after the first ~10 progress lines of the main run were visible (primary fractions 0.004-0.033), before results.json was opened")
    os.makedirs(out_dir, mode=0o700, exist_ok=True)
    M.write_private(os.path.join(out_dir, "noisy_draw.json"), json.dumps(out, indent=1) + "\n")
    print("pools", len(n1), len(n2), "| drawn", len(out["n1"]), len(out["n2"]))


def rec_path(wid):
    found = []
    for root in R.ROOTS:
        for dp, _dn, fn in os.walk(os.path.join(R.HOME, root)):
            if wid + ".json" in fn:
                found.append(os.path.relpath(os.path.join(dp, wid + ".json"), R.HOME))
    if not found:
        raise SystemExit(f"no record file for {wid}")
    return sorted(found)[-1]


def cmd_measure(draw_path, out_path):
    os.nice(15)
    import numpy as np, torch, webrtcvad
    from silero_vad import load_silero_vad, get_speech_timestamps
    torch.set_num_threads(2)
    model = load_silero_vad()
    doc = R.read_json(draw_path)
    if doc["logic_sha256"] != R.sha256_file(R.__file__):
        raise SystemExit("refused_logic.py changed since the draw was frozen: measurement refused")
    keymap = M.chunk_time_map()
    rows = []
    for grp in ("n1", "n2"):
        for wid in doc[grp]:
            r = M.measure_window(wid, rec_path(wid), "whole", np, torch, model, get_speech_timestamps, webrtcvad, keymap)
            r["group"] = grp
            rows.append(r)
            print(grp, wid, r.get("D1b_webrtc3_frac", r.get("error")), flush=True)
    ok = [r for r in rows if "error" not in r]
    n1 = sorted(r["D1b_webrtc3_frac"] for r in ok if r["group"] == "n1")
    med = None if not n1 else (n1[len(n1) // 2] if len(n1) % 2 else (n1[len(n1) // 2 - 1] + n1[len(n1) // 2]) / 2)
    high = sum(x >= N1_HIGH_FRAC for x in n1)
    verdict = dict(n1_measured=len(n1), n1_median_primary_frac=med, n1_windows_at_or_above_0_10=high, n1_pass=bool(n1 and med <= N1_MEDIAN_MAX and high <= N1_HIGH_MAX),
                   n2_measured=sum(r["group"] == "n2" for r in ok), windows_without_chunk_timing=len(rows) - len(ok))
    out = dict(seed=doc["seed"], verdict=verdict, windows=rows)
    M.write_private(out_path, json.dumps(out, indent=1) + "\n")
    print(json.dumps(verdict, indent=1))


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("draw"); d.add_argument("--main-draw", required=True); d.add_argument("--out-dir", required=True)
    m = sub.add_parser("measure"); m.add_argument("--draw", required=True); m.add_argument("--out", required=True)
    a = ap.parse_args()
    cmd_draw(a.main_draw, a.out_dir) if a.cmd == "draw" else cmd_measure(a.draw, a.out)
