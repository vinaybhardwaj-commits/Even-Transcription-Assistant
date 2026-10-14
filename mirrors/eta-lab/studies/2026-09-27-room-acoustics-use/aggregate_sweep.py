#!/usr/bin/env python3
"""W39 A1 follow-up: aggregate vad_threshold_sweep.py output. Numbers only.
Applies the pre-registered decision rule from PREREG-vad-threshold-sweep.md."""
import json, sys

def main():
    rows = [r for r in json.load(open(sys.argv[1])) if "error" not in r]
    thresholds = sorted(rows[0]["by_threshold"].keys(), key=float, reverse=True)
    tot_ref = sum(r["ref_speech_s"] for r in rows)
    out = {"n_chunks": len(rows), "ref_speech_s_total": round(tot_ref, 1), "by_threshold": {}}
    baseline = None
    for th in thresholds:
        reached = sum(r["by_threshold"][th]["ref_speech_reached_s"] for r in rows)
        missed = sum(r["by_threshold"][th]["ref_speech_missed_s"] for r in rows)
        nonspeech = sum(r["by_threshold"][th]["non_speech_reached_s"] for r in rows)
        methods_nonempty = sum(1 for r in rows if r["by_threshold"][th]["method"] == "silero-vad")
        row = {"pct_missed": round(100 * missed / tot_ref, 1), "pct_reached": round(100 * reached / tot_ref, 1),
               "reached_s": round(reached, 1), "missed_s": round(missed, 1),
               "non_speech_reached_s": round(nonspeech, 1), "silero_nonempty_chunks": methods_nonempty}
        # deltas are ALWAYS vs the 0.5 (production) baseline, never chained between adjacent thresholds
        if baseline is None:
            row["delta_recovered_s"] = 0.0; row["delta_non_speech_s"] = 0.0
            baseline = {"reached": reached, "nonspeech": nonspeech}
        else:
            row["delta_recovered_s"] = round(reached - baseline["reached"], 1)
            row["delta_non_speech_s"] = round(nonspeech - baseline["nonspeech"], 1)
        out["by_threshold"][th] = row
    # pre-registered decision rule: >=10pp recovery vs 0.5 baseline AND added-noise:added-speech <= 2:1
    baseline_missed_pct = out["by_threshold"]["0.5"]["pct_missed"]
    verdict = []
    for th in thresholds:
        if th == "0.5": continue
        r = out["by_threshold"][th]
        recovered_pp = baseline_missed_pct - r["pct_missed"]
        added_speech = r["delta_recovered_s"]  # vs 0.5 baseline, per row above
        added_noise = r["delta_non_speech_s"]
        ratio_ok = (added_noise <= 2 * added_speech) if added_speech > 0 else False
        clears = recovered_pp >= 10 and ratio_ok
        verdict.append({"threshold": th, "recovered_pp": round(recovered_pp, 1),
                        "added_noise_s": added_noise, "added_speech_s": added_speech,
                        "noise_to_speech_ratio": round(added_noise / added_speech, 2) if added_speech > 0 else None,
                        "clears_prereg_rule": clears})
    out["prereg_verdict"] = verdict
    json.dump(out, open(sys.argv[2], "w"), indent=1)
    print(json.dumps(out, indent=1))

if __name__ == "__main__":
    main()
