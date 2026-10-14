#!/usr/bin/env python3
"""E-7 full-day re-score harness (W28.2): rescore one clinic day's encounter detection against the
PQM queue truth with the SAME metric as the first 23 Sep score — found (recall), precision, splits,
merges, start/end error — with the transcript version NAMED ON THE COMMAND LINE, so the same command
re-runs the day CLARITY's first transcript improvement lands.

Usage (path-independent; the repo's 23 Sep scorer is loaded by relative path):
  python3 fullday_score.py --truth <e7-truth-DATE.csv> --hyp <out-DATE>/hyp-fused.json \
      [--hyp <out-DATE>/hyp-arm-d.json ...] --transcript <name> [--date <YYYY-MM-DD>] \
      [--out <score.md>] [--json <score.json>]

  --truth        PQM queue-truth CSV as built by studies/2026-09-24-e7-fullday/build_truth.py or the
                 23 Sep study (columns room, date, token_uid, called_at, completed_at).
  --hyp          one or more hypothesis files from the replay stage (each scored as its own arm),
                 shape {transcript_version?, smoother_version, room_days: {rd_id: {room, date,
                 energy_gap, encounters: [{id, start_ms, end_ms}]}}} — the same shape every arm of
                 e7-rescore.sh writes and the 23 Sep study files use.
  --transcript   REQUIRED. The name of the transcript version this run replays/scores (e.g.
                 "route-v2 23sep", later "CLARITY-v1"). Recorded verbatim in the report and JSON;
                 every hyp file must ACCOUNT for it:
                   - a hyp file that DECLARES transcript_version must match the name or the run
                     fails (rc=3) — a version can never be scored under the wrong name;
                   - a hyp file that declares NOTHING (pre-26 Sep artifacts) is refused unless
                     --allow-undeclared is given, and then the card says UNDECLARED for that arm —
                     the name in the title is the run's provenance, never claimed to be the file's.
  --allow-undeclared   admit hyp files with no transcript_version (they print UNDECLARED).
  --date         optional: restrict to room-days of this IST date (out of a multi-day truth).

The MATCHING RULE is verbatim e7_score.py (studies/2026-09-23-e7-pqm-truth), the 23 Sep first score:
a hypothesis matches a consult when overlap >= 50% of the SHORTER interval; splits/merges by
multiplicity; errors from the best-overlap pair; consults keyed to no replayed (room, date) are
excluded from totals exactly as e7_score.py excluded them (counted in the report line if any, so
nothing is silently dropped from a full-day run).

Error units: MINUTES (1 dp), with the identical-seconds value in parentheses so any 23 Sep card can
be checked digit for digit.

Counts, opaque ids and timings only: no transcript text, no patient identity.
"""
import argparse
import json
import os
import sys

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(REPO, "studies", "2026-09-23-e7-pqm-truth"))
import e7_score  # noqa: E402  (metric functions, unchanged — displayed side by side in the report)


def minutes(seconds):
    return round(seconds / 60.0, 1)


def err_pair(vals):
    """Median/p90 of match errors, seconds from e7_score.median_p90, minutes derived."""
    med, p90 = e7_score.median_p90(vals)  # (seconds, seconds) or (None, None)
    if med is None:
        return None
    return {"med_s": med, "p90_s": p90, "med_min": minutes(med), "p90_min": minutes(p90)}


def fmt(pair):
    if pair is None:
        return "n/a (no matches)"
    return f"{pair['med_min']}/{pair['p90_min']} min ({pair['med_s']}/{pair['p90_s']} s)"


def pct(n, d):
    return round(100.0 * n / d, 1) if d else None


def stamp(p):
    return f"{p}%" if p is not None else "n/a"


def load_hyp(path):
    with open(path) as f:
        d = json.load(f)
    if not isinstance(d.get("room_days"), dict) or not d["room_days"]:
        sys.exit(f"FAIL {path}: no room_days map — not a e7-rescore.sh hypothesis file?")
    return d


VERSION_KEYS = ("transcript_version", "smoother_version", "shadow_version", "fusion_version", "code")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--truth", required=True)
    ap.add_argument("--hyp", required=True, action="append")
    ap.add_argument("--transcript", required=True)
    ap.add_argument("--allow-undeclared", action="store_true",
                    help="admit hyp files with no transcript_version; they are marked UNDECLARED")
    ap.add_argument("--date", help="restrict to room-days of this IST date")
    ap.add_argument("--out", default="fullday-score.md")
    ap.add_argument("--json")
    args = ap.parse_args()

    hyps = {p: load_hyp(p) for p in args.hyp}

    # --transcript gate (refuter B1): every file must account for the named version; undeclared
    # files are refused unless --allow-undeclared, and are then marked UNDECLARED in the card.
    undeclared = set()
    for p, d in hyps.items():
        hv = d.get("transcript_version")
        if hv is None:
            if not args.allow_undeclared:
                print(f"FAIL {p}: declares no transcript_version and --allow-undeclared is not given")
                sys.exit(3)
            undeclared.add(os.path.basename(p))
        elif hv != args.transcript:
            print(f"FAIL {p}: declares transcript_version {hv!r}, run named {args.transcript!r}")
            sys.exit(3)

    truth = e7_score.load_truth(args.truth)
    if args.date:
        truth = [t for t in truth if t["date"] == args.date]

    arms = {}
    for p, d in hyps.items():
        room_days = d["room_days"]
        rd_lookup = {(v["room"], v["date"]): k for k, v in room_days.items()}
        truth_by_rd = {}
        for t in truth:
            truth_by_rd.setdefault(rd_lookup.get((t["room"], t["date"])), []).append(t)
        unkeyed = truth_by_rd.get(None, [])

        per_rd = {}
        tot = {"n_truth": 0, "n_hyp": 0, "found": 0, "matched_hyp": 0,
               "splits": 0, "merges": 0, "start": [], "end": []}
        for rd_id, meta in room_days.items():
            if args.date and meta.get("date") != args.date:
                continue
            rows = truth_by_rd.get(rd_id, [])
            s = e7_score.score_room_day(rows, meta["encounters"])
            s.update({"rd_id": rd_id, "room": meta["room"], "date": meta.get("date"),
                      "energy_gap": bool(meta.get("energy_gap"))})
            per_rd[rd_id] = s
            tot["n_truth"] += len(rows)
            tot["n_hyp"] += s["n_hyp"]
            tot["found"] += s["matched_truth"]
            tot["matched_hyp"] += s["matched_hyp"]
            tot["splits"] += s["splits"]
            tot["merges"] += s["merges"]
            tot["start"] += s["start_errs_s"]
            tot["end"] += s["end_errs_s"]
        arms[os.path.basename(p)] = {
            "per_rd": per_rd, "unkeyed_truth": len(unkeyed), **tot,
            "undeclared": os.path.basename(p) in undeclared,
            "start_err": err_pair(tot["start"]), "end_err": err_pair(tot["end"]),
            "versions": {k: d.get(k) for k in VERSION_KEYS},
        }

    # ── markdown report
    lines = [f"# E-7 full-day re-score — transcript version: {args.transcript}"
             + (f" — date {args.date}" if args.date else "")]
    lines.append("")
    lines.append(f"Truth: `{args.truth}` ({len(truth)} consults loaded). Hypothesis files: "
                 + ", ".join(f"`{os.path.basename(p)}`" for p in args.hyp) + ".")
    lines.append("Match rule unchanged (23 Sep first score, e7_score.py): overlap >= 50% of the "
                 "shorter interval; errors in minutes with the identical-seconds value in parentheses.")
    lines.append("")
    for name, a in arms.items():
        v = a["versions"]
        tv = ("UNDECLARED (--allow-undeclared; the hyp file carries no transcript_version)"
              if a["undeclared"] else v["transcript_version"])
        extra = ", ".join(f"{k}={v[k]}" for k in ("smoother_version", "shadow_version", "fusion_version", "code") if v[k])
        lines.append(f"- `{name}`: transcript={tv}" + (f"; {extra}" if extra else ""))
    lines.append("")
    lines.append("## Overall")
    lines.append("")
    lines.append("| Hyp file | Consults | Hyp | Found | Recall | Precision | Splits | Merges | Start err | End err |")
    lines.append("|---|---|---|---|---|---|---|---|---|---|")
    for name, a in arms.items():
        lines.append(
            f"| {name} | {a['n_truth']} | {a['n_hyp']} | {a['found']} | "
            f"{stamp(pct(a['found'], a['n_truth']))} | "
            f"{stamp(pct(a['matched_hyp'], a['n_hyp']))} | {a['splits']} | {a['merges']} | "
            f"{fmt(a['start_err'])} | {fmt(a['end_err'])} |")
    unkeyed_total = max(a["unkeyed_truth"] for a in arms.values()) if arms else 0
    if unkeyed_total:
        lines.append("")
        lines.append(f"**Outside the replayed room-days:** {unkeyed_total} consult(s) keyed to no "
                     "replayed (room, date) — counted here, never scored, never added to the totals.")
    lines.append("")
    lines.append("## Per room-day")
    lines.append("")
    lines.append("| Hyp file | Room | Date | Consults | Hyp | Found | Precision | Splits | Merges | Start err | End err |")
    lines.append("|---|---|---|---|---|---|---|---|---|---|---|")
    for name, a in arms.items():
        for rd, s in a["per_rd"].items():
            gap = " (energy gap)" if s["energy_gap"] else ""
            if s["n_hyp"]:
                prec = f"{s['matched_hyp']}/{s['n_hyp']} ({stamp(pct(s['matched_hyp'], s['n_hyp']))})"
            else:
                prec = "n/a"
            lines.append(
                f"| {name} | {s['room']}{gap} | {s['date']} | {s['n_truth']} | {s['n_hyp']} | "
                f"{s['matched_truth']}/{s['n_truth']} ({stamp(pct(s['matched_truth'], s['n_truth']))}) | "
                f"{prec} | {s['splits']} | {s['merges']} | "
                f"{fmt(err_pair(s['start_errs_s']))} | {fmt(err_pair(s['end_errs_s']))} |")
    lines.append("")
    lines.append("Counts, opaque ids and timings only; no transcript text or patient identity.")
    with open(args.out, "w") as f:
        f.write("\n".join(lines) + "\n")
    print(f"WROTE {args.out}")

    if args.json:
        payload = {
            "transcript_version": args.transcript,
            "truth": args.truth,
            "hyp": args.hyp,
            "date_filter": args.date,
            "match_rule": "overlap >= 50% of the shorter interval (e7_score.py, unchanged)",
            "arms": {name: {
                "found": a["found"], "n_truth": a["n_truth"], "n_hyp": a["n_hyp"],
                "matched_hyp": a["matched_hyp"], "splits": a["splits"], "merges": a["merges"],
                "start_err": a["start_err"], "end_err": a["end_err"],
                "undeclared": a["undeclared"],
                "transcript_version_in_file": a["versions"]["transcript_version"],
                "unkeyed_truth": a["unkeyed_truth"], "versions": a["versions"],
                "per_room_day": {rd: {"room": s["room"], "date": s["date"],
                                      "n_truth": s["n_truth"], "n_hyp": s["n_hyp"],
                                      "matched_truth": s["matched_truth"],
                                      "matched_hyp": s["matched_hyp"],
                                      "splits": s["splits"], "merges": s["merges"]}
                                 for rd, s in a["per_rd"].items()},
            } for name, a in arms.items()},
        }
        with open(args.json, "w") as f:
            json.dump(payload, f, indent=1)
        print(f"WROTE {args.json}")


if __name__ == "__main__":
    main()
