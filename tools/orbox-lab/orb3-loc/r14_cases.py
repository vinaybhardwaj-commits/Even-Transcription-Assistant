"""R14 cases A-F (refuter's simulated two-block recordings, read only) through walk_sync + locate --calib, scored against the refuter's truth.json.
usage: r14_cases.py CASE [CASE...]     outputs in ./r14/<case>/ (symlinks to the wavs; nothing is written into $ORB3_LAB_ROOT/r14)"""
import json, os, subprocess, sys
import numpy as np
SRC, PY = os.path.join(os.environ.get("ORB3_LAB_ROOT", "."), "r14"), sys.executable
MICS = np.array([[0, 0], [2.44, 0], [1.22, 3.45]])


def inside(p):
    a, b, c = MICS
    d = lambda p1, p2, p3: (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1])
    s = [d(p, a, b), d(p, b, c), d(p, c, a)]
    return not (any(x < 0 for x in s) and any(x > 0 for x in s))


for case in sys.argv[1:]:
    D = f"r14/{case}"; os.makedirs(D, exist_ok=True)
    for n in ("mic1", "mic2", "pi"):
        if not os.path.exists(f"{D}/{n}.wav"):
            os.symlink(f"{SRC}/case{case}/{n}.wav", f"{D}/{n}.wav")
    w = [f"{D}/{n}.wav" for n in ("mic1", "mic2", "pi")]
    r = subprocess.run([PY, "walk_sync.py", *w, "--out", f"{D}/walk_sync.json"], capture_output=True, text=True)
    open(f"{D}/walk_sync.out", "w").write(r.stdout + r.stderr)
    t = json.load(open(f"{SRC}/case{case}/truth.json"))
    print(f"== case {case} {t['cfg']}  walk_sync exit {r.returncode}")
    print("  " + (r.stdout + r.stderr).strip().replace("\n", "\n  "))
    if r.returncode or not any(e["kind"] == "probe" for e in t["events"]):
        continue
    r = subprocess.run([PY, "locate.py", "--sync", f"{D}/walk_sync.json", "--geometry", "geom.json", "--signal", "probe", "--calib", "1:mic1,2:mic2,3:pi",
                        "--mc", "50", "--out", f"{D}/events.json", *w], capture_output=True, text=True)
    open(f"{D}/locate.out", "w").write(r.stdout + r.stderr)
    ev = json.load(open(f"{D}/events.json"))
    truth = {}
    for e in t["events"]:
        if e["kind"] == "probe":
            truth[e["round"]] = e["P"]
    ins, out, rows = [], [], []
    for rd in sorted(truth):
        if rd <= 3:
            continue
        es = [e for e in ev["events"] if e["round"] == rd]
        if not es:
            continue
        xy = np.mean([[e["x"], e["y"]] for e in es], axis=0)
        err = float(np.hypot(*(xy - truth[rd])))
        amb = any(e["ambiguous"] for e in es)
        (ins if inside(truth[rd]) else out).append(err)
        rows.append((rd, truth[rd], err, amb))
    sp = ev.get("speakers", {})
    print(f"  rounds located {len(rows)} of {len(truth) - 3}; inside n={len(ins)} median {np.median(ins):.3f} max {max(ins):.3f} m" if ins else "  no inside rounds")
    if out:
        print("  outside: " + ", ".join(f"{p} err {e:.2f}{' AMB' if a else ''}" for _, p, e, a in rows if not inside(p)))
    print("  calibration resid rms %.0f us (info only)" % ev["calibration"]["resid_rms_us"])
    if sp:
        print(f"  speakers L ({sp['left']['x']:+.2f},{sp['left']['y']:+.2f}) R ({sp['right']['x']:+.2f},{sp['right']['y']:+.2f}) sep {sp['separation_m']:.2f} (truth L {t['spk_l']} R {t['spk_r']})"
              f"  amb L/R {sp['left']['ambiguous']}/{sp['right']['ambiguous']}")
