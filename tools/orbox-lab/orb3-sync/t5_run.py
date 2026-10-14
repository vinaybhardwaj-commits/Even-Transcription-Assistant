"""T5 analysis: run beacon_sync v2 and --legacy-s on the wavs written by t5_sim.py.

usage: t5_run.py OUT_DIR [--ppm ...]   (prints the table; writes OUT_DIR/t5_table.json)
"""
import sys
import json
import argparse
import beacon_sync as bs
import t5_sim as S

ap = argparse.ArgumentParser()
ap.add_argument("out")
ap.add_argument("--ppm", default="0,3,-3,40,-40,150,-150")
a = ap.parse_args()
ppms = [float(p) for p in a.ppm.split(",")]
table = []
for ch in ("room", "flat"):
    base = {}
    for ppm in sorted(ppms, key=lambda p: p != 0):      # zero drift first
        e = ppm * 1e-6
        paths = [f"{a.out}/{ch}/mic1.wav", f"{a.out}/{ch}/mic2_{ppm:+g}ppm.wav"]
        for legacy in (False, True):
            r = bs.run(paths, 360, legacy_s=legacy)
            n = "mic2_%+gppm" % ppm
            n = r["mics"][1]
            if r["status"] != "ok":
                table.append({"channel": ch, "ppm": ppm, "legacy": legacy, "status": r["status"]})
                continue
            c0 = r["c0_ms"][n] * 1e-3
            if ch == "flat":
                truth = S.O2
            elif ppm == 0 and not legacy:
                base["c0_0"] = c0
                truth = c0
            else:
                truth = (1 + e) * (base["c0_0"] - S.O2) + S.O2
            row = {"channel": ch, "ppm": ppm, "legacy": legacy, "status": "ok",
                   "drift_err_ppm": r["drift_ppm"][n] - ppm, "c0_err_us": (c0 - truth) * 1e6,
                   "resid_rms_us": r["resid_rms_us"][n], "passes": [p["drift_ppm"].get(n) for p in r["passes"]],
                   "dropped": len(r["dropped"]), "interfered": len(r["interfered"])}
            table.append(row)
            print(json.dumps(row), flush=True)
json.dump(table, open(f"{a.out}/t5_table.json", "w"), indent=1)
