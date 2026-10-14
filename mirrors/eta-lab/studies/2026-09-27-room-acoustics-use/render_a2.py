#!/usr/bin/env python3
"""Render A2's effect-size JSON (join_and_model.py output) to a markdown section body."""
import json, sys

NAMES = {"room_yh3etjpf": "OPD 1", "room_87frpus9": "OPD 3", "room_ux92qpws": "OPD 4",
        "room_4ggnkg5x": "OPD 5", "room_pnyc9u49": "OPD 6", "room_qyzghzaf": "OPD 7",
        "room_d74hhmc4": "Third Floor", "room_bh6jtq4t": "Cardiology",
        "room_ymch4bxu": "Room 4-1", "room_jwyrr4dc": "ORB3", "room_2qe955hy": "Home Office"}
LABEL_DESC = {"empty": "empty transcript (route_outcome no_engine/engine_no_text, or 0-length text)",
             "collapse": "loop/repetition collapse (assembled_collapse units_collapsed or lines_dropped > 0)",
             "lang_mismatch": "language mismatch across probe/full-window/Sarvam opinions (bucket split or all three differ)",
             "any_issue": "any of the above, or a hard engine error"}
FEAT_DESC = {"noise_med": "noise floor (median quiet-frame dBFS)", "snr": "SNR (speech dBFS minus noise median)",
            "clip_pct": "clipping %", "zero_pct": "exact-zero sample %", "vad_speech_frac": "VAD speech fraction of window",
            "tilt": "spectral tilt (dB/octave, 200-4000 Hz)", "hf_rel_db": "high-frequency (4-8 kHz) level vs 0.3-3 kHz"}

def fmt_features(feats, min_n=20):
    rows = []
    for f, v in feats.items():
        if v["r"] is None or v["n"] < min_n: continue
        rows.append((abs(v["r"]), f, v["r"], v["cohens_d"], v["n"]))
    rows.sort(reverse=True)
    return rows

def main():
    d = json.load(open(sys.argv[1]))
    L = [f"Population: {d['n_windows_joined']} windows with both a computed acoustic profile and Neon "
        f"transcript-quality metadata (route/batch engine runs; audio pulled per-window directly from "
        f"R2 by its own `clip_r2_key`, not from the tape copy — see method note). "
        f"No artifact literally named '1,060 windows, 26 Sep' was found in Neon or on the lab; this "
        f"uses the full available route/batch population instead (see method note for what was "
        f"searched).", ""]
    L.append("### Pooled (all rooms)")
    L.append("")
    L.append("| label | n | positive % | strongest predictors (|r| >= 0.1, n >= 20) |")
    L.append("|---|--:|--:|---|")
    for lab in d["labels"]:
        p = d["pooled"][lab]
        rows = fmt_features(p["features"])
        top = "; ".join(f"{FEAT_DESC.get(f,f)}: r={r:+.2f}, d={dd if dd is not None else '-'} (n={n})"
                        for _, f, r, dd, n in rows[:3] if abs(r) >= 0.1) or "none >= 0.1"
        L.append(f"| {LABEL_DESC.get(lab,lab)} | {p['n']} | {p['positive_pct']} | {top} |")
    L.append("")
    L.append("Multivariate (standardized logistic, odds ratio per +1 SD; excludes `hf_rel_db`):")
    L.append("")
    for lab in d["labels"]:
        mv = d["pooled"][lab].get("multivariate", {})
        if "note" in mv:
            L.append(f"- **{lab}**: {mv['note']} (n={mv['n']}, positive={mv['positive']})")
        else:
            ors = ", ".join(f"{FEAT_DESC.get(f,f)}={v}" for f, v in mv["odds_ratio_per_1sd"].items())
            L.append(f"- **{lab}** (n={mv['n']}, positive={mv['positive']}): odds ratios {ors}")
    L.append("")
    L.append("### Per room (only rooms with >= 15 joined windows get effect sizes)")
    L.append("")
    for room, rd in d["by_room"].items():
        name = NAMES.get(room, room)
        if "note" in rd:
            L.append(f"- **{name}**: {rd['note']} (n={rd['n']})")
            continue
        bits = []
        for lab in d["labels"]:
            p = rd[lab]
            rows = fmt_features(p["features"], min_n=10)
            if rows and abs(rows[0][2]) >= 0.15:
                _, f, r, dd, n = rows[0]
                bits.append(f"{lab} vs {FEAT_DESC.get(f,f)} r={r:+.2f}")
        L.append(f"- **{name}** (n={rd.get('n')}): " + ("; ".join(bits) if bits else "no |r|>=0.15 association found"))
    open(sys.argv[2], "w").write("\n".join(L) + "\n")

if __name__ == "__main__":
    main()
