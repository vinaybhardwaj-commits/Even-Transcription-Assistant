"""T5b analysis: reference mic drifting against the speaker. Runs v3 (this dir) and v2 (_superseded_o10/).

usage: t5b_run.py DIR   (DIR/room holds mic1_<r>ppm.wav and mic2_<s>ppm.wav; prints rows, writes DIR/t5b_table.json)
Both drifts are absolute, against the speaker clock. Truth: c0 = O2 + (1+e2)(c0_00 - O2), c0_00 from the 0/0 v3 run.
"""
import os
import sys
import json
import importlib.util
import beacon_sync as v3
import t5_sim as S

here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("beacon_sync_v2", here + "/_superseded_o10/beacon_sync.py")
v2 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v2)

d = sys.argv[1]
refs = [40.0, -40.0, 150.0, -150.0]
sats = [150.0, -150.0]
c0_00 = v3.run([f"{d}/room/mic1.wav", f"{d}/room/mic2_+0ppm.wav"], 360)["c0_ms"]["mic2_+0ppm"] * 1e-3
rows = []
for r in refs:
    for s in sats:
        paths = [f"{d}/room/mic1_{r:+g}ppm.wav", f"{d}/room/mic2_{s:+g}ppm.wav"]
        truth = S.O2 + (1 + s * 1e-6) * (c0_00 - S.O2)
        rel = ((1 + s * 1e-6) / (1 + r * 1e-6) - 1) * 1e6
        row = {"ref_ppm": r, "sat_ppm": s}
        for tag, m in (("v3", v3), ("v2", v2)):
            o = m.run(paths, 360)
            n = o["mics"][1]
            if o["status"] != "ok":
                row[tag] = {"status": o["status"]}
                continue
            row[tag] = {"c0_err_us": (o["c0_ms"][n] * 1e-3 - truth) * 1e6, "drift_err_ppm": o["drift_ppm"][n] - rel,
                        "dropped": len(o["dropped"]), "interfered": len(o["interfered"]), "passes": len(o["passes"])}
            if tag == "v3":
                row[tag]["abs_ppm"] = o["abs_drift_ppm"]
        rows.append(row)
        print(json.dumps(row), flush=True)
json.dump({"c0_00": c0_00, "rows": rows}, open(f"{d}/t5b_table.json", "w"), indent=1)
