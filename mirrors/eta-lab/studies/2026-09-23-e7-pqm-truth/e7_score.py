"""E-7 scorer: match ETA encounter hypotheses (acoustic-only today, fused later) against
PQM consult ground truth (e7-truth.csv). Match rule (orders/E7-PQM-TRUTH.md rule 2):
intervals overlap by >= 50% of the SHORTER interval. Reports recall, precision, splits,
merges, start/end error (median, p90 seconds), per room-day and overall.

Usage: python3 e7_score.py --truth e7-truth.csv --hyp hyp-acoustic.json --out e7-score-acoustic.md
The --hyp file's top-level "source" field names what's being scored (acoustic | fused);
a fused hypotheses file (E-6, not yet built) must match the same room_days->encounters
shape (list of {id, start_ms, end_ms}) to work with this script unchanged.
"""
import argparse
import csv
import json
import statistics
from datetime import datetime


def load_truth(path):
    rows = []
    with open(path) as f:
        for r in csv.DictReader(f):
            start = datetime.fromisoformat(r["called_at"])
            end = datetime.fromisoformat(r["completed_at"])
            rows.append({
                "room": r["room"],
                "date": r["date"],
                "token_uid": r["token_uid"],
                "start_ms": int(start.timestamp() * 1000),
                "end_ms": int(end.timestamp() * 1000),
            })
    return rows


def overlap_frac(a_start, a_end, b_start, b_end):
    ov = min(a_end, b_end) - max(a_start, b_start)
    if ov <= 0:
        return 0.0
    shorter = min(a_end - a_start, b_end - b_start)
    if shorter <= 0:
        return 0.0
    return ov / shorter


def pct(n, d):
    return round(100.0 * n / d, 1) if d else None


def score_room_day(truth_rows, hyps):
    """truth_rows: list of {token_uid,start_ms,end_ms}; hyps: list of {id,start_ms,end_ms}."""
    edges = []  # (truth_idx, hyp_idx, overlap_frac)
    for ti, t in enumerate(truth_rows):
        for hi, h in enumerate(hyps):
            f = overlap_frac(t["start_ms"], t["end_ms"], h["start_ms"], h["end_ms"])
            if f >= 0.5:
                edges.append((ti, hi, f))

    truth_matches = {}  # ti -> [hi,...]
    hyp_matches = {}    # hi -> [ti,...]
    for ti, hi, f in edges:
        truth_matches.setdefault(ti, []).append((hi, f))
        hyp_matches.setdefault(hi, []).append((ti, f))

    matched_truth = len(truth_matches)
    matched_hyp = len(hyp_matches)
    splits = sum(1 for ti, lst in truth_matches.items() if len(lst) > 1)
    merges = sum(1 for hi, lst in hyp_matches.items() if len(lst) > 1)

    start_errs = []
    end_errs = []
    for ti, lst in truth_matches.items():
        best_hi, _ = max(lst, key=lambda x: x[1])
        t = truth_rows[ti]
        h = hyps[best_hi]
        start_errs.append(abs(h["start_ms"] - t["start_ms"]) / 1000.0)
        end_errs.append(abs(h["end_ms"] - t["end_ms"]) / 1000.0)

    return {
        "n_truth": len(truth_rows),
        "n_hyp": len(hyps),
        "matched_truth": matched_truth,
        "matched_hyp": matched_hyp,
        "recall_pct": pct(matched_truth, len(truth_rows)),
        "precision_pct": pct(matched_hyp, len(hyps)),
        "splits": splits,
        "merges": merges,
        "start_errs_s": start_errs,
        "end_errs_s": end_errs,
    }


def median_p90(vals):
    if not vals:
        return None, None
    vals = sorted(vals)
    med = statistics.median(vals)
    idx = min(len(vals) - 1, int(round(0.9 * (len(vals) - 1))))
    p90 = vals[idx]
    return round(med, 1), round(p90, 1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--truth", default="e7-truth.csv")
    ap.add_argument("--hyp", default="hyp-acoustic.json")
    ap.add_argument("--out", default="e7-score-acoustic.md")
    args = ap.parse_args()

    truth = load_truth(args.truth)
    with open(args.hyp) as f:
        hyp_data = json.load(f)
    source = hyp_data.get("source", "unknown")
    room_days = hyp_data["room_days"]

    truth_by_rd = {}
    rd_lookup = {(v["room"], v["date"]): k for k, v in room_days.items()}
    for t in truth:
        key = (t["room"], t["date"])
        rd_id = rd_lookup.get(key)
        truth_by_rd.setdefault(rd_id, []).append(t)

    per_rd = {}
    all_start_errs = []
    all_end_errs = []
    total_truth = 0
    total_hyp = 0
    total_matched_truth = 0
    total_matched_hyp = 0
    total_splits = 0
    total_merges = 0

    for rd_id, meta in room_days.items():
        t_rows = truth_by_rd.get(rd_id, [])
        hyps = meta["encounters"]
        s = score_room_day(t_rows, hyps)
        s["room"] = meta["room"]
        s["date"] = meta["date"]
        s["energy_gap"] = meta.get("energy_gap", False)
        per_rd[rd_id] = s
        all_start_errs.extend(s["start_errs_s"])
        all_end_errs.extend(s["end_errs_s"])
        total_truth += s["n_truth"]
        total_hyp += s["n_hyp"]
        total_matched_truth += s["matched_truth"]
        total_matched_hyp += s["matched_hyp"]
        total_splits += s["splits"]
        total_merges += s["merges"]

    overall_recall = pct(total_matched_truth, total_truth)
    overall_precision = pct(total_matched_hyp, total_hyp)
    start_med, start_p90 = median_p90(all_start_errs)
    end_med, end_p90 = median_p90(all_end_errs)

    lines = []
    lines.append(f"# E-7 score — source={source} ({hyp_data.get('smoother_version', '?')})")
    lines.append("")
    lines.append(f"Match rule: interval overlap >= 50% of the shorter interval (orders/E7-PQM-TRUTH.md rule 2). "
                  f"Scored against `{args.truth}` (voiceprint-confirmed room-days only).")
    lines.append("")
    if any(m.get("energy_gap") for m in room_days.values()):
        gap_rds = [f"{m['room']} {m['date']}" for m in room_days.values() if m.get("energy_gap")]
        lines.append(f"**Energy-log gap:** {len(gap_rds)} of {len(room_days)} room-days have `encounters:0` "
                      f"because the acoustic energy signal (`bench_level_sample`) shows `no_energy_evidence` for "
                      f"21-22 Sep on every room checked, despite transcripts existing. This is a platform gap, not "
                      f"a matching failure — their recall is 0 by construction, not by acoustic-only missing a "
                      f"real signal. Affected: {', '.join(gap_rds)}.")
        lines.append("")

    lines.append("## Overall")
    lines.append("")
    lines.append(f"- PQM consults (truth): {total_truth}")
    lines.append(f"- Hypotheses ({source}): {total_hyp}")
    lines.append(f"- Recall (PQM consults with a matching hypothesis): {total_matched_truth}/{total_truth} = {overall_recall}%")
    lines.append(f"- Precision (hypotheses matching a consult): {total_matched_hyp}/{total_hyp} = {overall_precision}%" if total_hyp else "- Precision: n/a (0 hypotheses)")
    lines.append(f"- Splits (one PQM consult matched by >1 hypothesis): {total_splits}")
    lines.append(f"- Merges (one hypothesis matched by >1 PQM consult): {total_merges}")
    lines.append(f"- Start error (s): median {start_med}, p90 {start_p90} (n={len(all_start_errs)} matched pairs)")
    lines.append(f"- End error (s): median {end_med}, p90 {end_p90} (n={len(all_end_errs)} matched pairs)")
    lines.append("")
    lines.append("## Per room-day")
    lines.append("")
    lines.append("| Room | Date | Truth | Hyp | Recall | Precision | Splits | Merges | Start err med/p90 (s) | End err med/p90 (s) |")
    lines.append("|---|---|---|---|---|---|---|---|---|---|")
    for rd_id, s in per_rd.items():
        gap = " (energy gap)" if s["energy_gap"] else ""
        recall_str = f"{s['matched_truth']}/{s['n_truth']} ({s['recall_pct']}%)"
        if s["n_hyp"]:
            smed, sp90 = median_p90(s["start_errs_s"])
            emed, ep90 = median_p90(s["end_errs_s"])
            err_fmt = lambda med, p90: f"{med}/{p90}" if med is not None else "n/a (no matches)"
            precision_str = f"{s['matched_hyp']}/{s['n_hyp']} ({s['precision_pct']}%)"
            row = (f"| {s['room']}{gap} | {s['date']} | {s['n_truth']} | {s['n_hyp']} | {recall_str} | "
                   f"{precision_str} | {s['splits']} | {s['merges']} | {err_fmt(smed, sp90)} | {err_fmt(emed, ep90)} |")
        else:
            row = (f"| {s['room']}{gap} | {s['date']} | {s['n_truth']} | 0 | {recall_str} | "
                   f"n/a | 0 | 0 | - | - |")
        lines.append(row)

    zero_despite_both = [(rd_id, s) for rd_id, s in per_rd.items() if s["n_truth"] and s["n_hyp"] and not s["matched_truth"]]
    if zero_despite_both:
        lines.append("")
        lines.append("## Notable: room-days with both truth and hypotheses present, zero matches")
        lines.append("")
        for rd_id, s in zero_despite_both:
            meta = room_days[rd_id]
            hyp_span = (min(e["start_ms"] for e in meta["encounters"]), max(e["end_ms"] for e in meta["encounters"]))
            t_rows = truth_by_rd.get(rd_id, [])
            truth_span = (min(t["start_ms"] for t in t_rows), max(t["end_ms"] for t in t_rows))
            gap_min = round((truth_span[0] - hyp_span[1]) / 60000.0, 1) if truth_span[0] > hyp_span[1] else round((hyp_span[0] - truth_span[1]) / 60000.0, 1)
            lines.append(f"- **{s['room']} {s['date']}**: {s['n_hyp']} acoustic hypotheses and {s['n_truth']} PQM consults, "
                          f"but their time windows don't overlap at all (~{gap_min} min gap between the two windows) — "
                          f"not a near-miss on the 50% threshold, a genuinely disjoint time range.")

    lines.append("")
    lines.append("No transcript text or patient identifiers above; `token_uid`s and hypothesis ids are opaque.")

    with open(args.out, "w") as f:
        f.write("\n".join(lines) + "\n")
    print(f"wrote {args.out}")
    print(f"overall recall {overall_recall}% ({total_matched_truth}/{total_truth}), precision {overall_precision}")


if __name__ == "__main__":
    main()
