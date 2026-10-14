"""calibrate.py: derive and pre-register the 'no background noise' threshold from real tape (ruling 369 item 1). Stdlib only.

  python3 calibrate.py stretches.json [--out calibration.json] [--margin 1.25]

stretches.json = {"stretches": [{"file": "/path/tape.pcm", "label": "empty" | "used", "room": "opd4", "from_s": 0, "to_s": 2100, "note": "..."}, ...],
                  "clinic_hours_ist": ["08:00", "20:00"]  (optional),  "source": "text saying where the tape came from"}
  file    raw headerless 16 kHz mono int16 little-endian (C270 tape.pcm); from_s/to_s optional.
  empty   a stretch where the room was empty AND the mic was healthy (e.g. OPD 4 09:00-09:35 on 25 Sep): the noise floor of a quiet room.
  used    a stretch with people in the room (consult in progress).
Per stretch: 1 s frame RMS -> min / p50 / p95 / p99.9 / max. Rule (fixed here, before any live run):
  dead_rms_max = margin x the highest 1 s RMS seen in any 'empty' stretch;  speech_rms = the lowest 5th-percentile 1 s RMS over the 'used' stretches;
  refuse to write unless dead_rms_max < the lowest 1st-percentile 1 s RMS of the 'used' stretches (a threshold that does not separate the two is not a threshold).
The output is calibration.json with status 'preregistered', its stats and its sources. COMMIT it before any live run: the commit is the pre-registration.
"""
import argparse, datetime, json, math, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mic_selftest as M


def frame_rms(pcm):
    x = M.pcm_to_floats(pcm)
    return [M._rms(x[i:i + M.SR]) for i in range(0, len(x) - M.SR + 1, M.SR)]


def pct(v, q):
    s = sorted(v)
    if not s:
        return None
    k = min(len(s) - 1, max(0, int(math.ceil(q / 100.0 * len(s))) - 1))
    return s[k]


def read_stretch(st):
    with open(st["file"], "rb") as f:
        data = f.read()
    a = int(st.get("from_s", 0) * M.SR) * 2
    b = int(st["to_s"] * M.SR) * 2 if "to_s" in st else len(data)
    return data[a:b]


def stats(rms):
    return dict(seconds=len(rms), min=min(rms), p05=pct(rms, 5), p01=pct(rms, 1), p50=pct(rms, 50), p95=pct(rms, 95), p999=pct(rms, 99.9), max=max(rms))


def calibrate(spec, margin=1.25, now=None, reader=read_stretch):
    empty, used, rows = [], [], []
    for st in spec["stretches"]:
        if st["label"] not in ("empty", "used"):
            raise ValueError(f"stretch label must be empty or used: {st.get('label')!r}")
        rms = frame_rms(reader(st))
        if not rms:
            raise ValueError(f"stretch has no full second of tape: {st['file']}")
        (empty if st["label"] == "empty" else used).append(rms)
        rows.append(dict(file=os.path.basename(st["file"]), label=st["label"], room=st.get("room"), note=st.get("note"), **{k: round(v, 6) for k, v in stats(rms).items() if k != "seconds"},
                         seconds=len(rms)))
    if not empty or not used:
        raise ValueError("need at least one 'empty' and one 'used' stretch")
    dead = margin * max(max(r) for r in empty)
    used_p01 = min(pct(r, 1) for r in used)
    speech = min(pct(r, 5) for r in used)
    if not dead < used_p01:
        raise ValueError(f"no separation: dead threshold {dead:.5f} is not below the 'used' 1st percentile {used_p01:.5f}")
    cal = dict(status="preregistered", preregistered_at=(now or datetime.datetime.now(datetime.timezone.utc)).isoformat(timespec="seconds"),
               dead_rms_max=round(dead, 6), dead_window_s=120, speech_rms=round(max(speech, dead * 1.01), 6), margin=margin,
               source=spec.get("source", ""), stretches=rows, rule="dead_rms_max = margin x max 1 s RMS over 'empty' stretches; speech_rms = min p05 over 'used'; must separate")
    if spec.get("clinic_hours_ist"):
        cal["clinic_hours_ist"] = spec["clinic_hours_ist"]
    return cal


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("spec")
    ap.add_argument("--out", default=M.DEFAULT_CAL)
    ap.add_argument("--margin", type=float, default=1.25)
    a = ap.parse_args(argv)
    with open(a.spec) as f:
        spec = json.load(f)
    try:
        cal = calibrate(spec, a.margin)
    except ValueError as e:
        print("not written:", e, file=sys.stderr)
        return 1
    with open(a.out, "w") as f:
        json.dump(cal, f, indent=1)
    print(json.dumps({k: cal[k] for k in ("status", "dead_rms_max", "dead_window_s", "speech_rms", "preregistered_at")}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
