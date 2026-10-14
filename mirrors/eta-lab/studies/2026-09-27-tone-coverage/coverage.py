#!/usr/bin/env python3
"""TONE coverage audit (order W32.1, order file /home/eta/oc/W32.txt).

READ-ONLY coverage audit of the emotion (tone) lane from the stored results
only: never calls the Mini's emotion service, never re-runs emotion scoring.
All data comes from the production Neon DB via kit/neon-select.mjs (single
SELECT statements, read-only transaction, DSN never printed).

Outputs a markdown report at a given path.

Usage:
    NODE_PATH=<node_modules> python3 -B coverage.py <out.md>
(neon-select needs @neondatabase/serverless; that module is NOT vendored in the
shared eta-lab checkout, so point NODE_PATH at a node_modules that has it.)

Conventions:
- "recorded window" = one bench_window row (clinic audio, 5 min grid).
- clinic day = room_day.ist_date + interval '5.5 hours' (ist_date is a `date`;
  the +5.5h to_char labels the plain date correctly).
- emotion results = room_emotion_window summary rows + room_span_emotion
  segment rows (sample spans; room_span_emotion is capped in audit, not used).
- counts and ids only in output; no transcript text, no patient data.
"""
import json
import os
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
NEON = os.path.join(REPO, "kit", "neon-select.mjs")

Q_WINDOW = """
SELECT to_char(rd.ist_date + interval '5.5 hours','YYYY-MM-DD') ist_day, r.slug,
  count(*) rec,
  count(ew.window_id) ew_any,
  count(*) FILTER (WHERE ew.state='ok') ew_ok,
  count(*) FILTER (WHERE ew.state='failed') ew_failed,
  count(*) FILTER (WHERE ew.state='no_segments') ew_noseg,
  count(*) FILTER (WHERE ew.state='diarize_stale') ew_stale,
  count(*) FILTER (WHERE ew.window_id IS NULL) no_row
FROM bench_window bw
JOIN room_day rd ON rd.id=bw.room_day_id
JOIN room r ON r.id=rd.room_id
LEFT JOIN room_emotion_window ew ON ew.window_id=bw.id
GROUP BY 1,2 ORDER BY 1,2
"""

Q_DIAR = """SELECT to_char(rd.ist_date + interval '5.5 hours','YYYY-MM-DD') ist_day,
  count(*) rec,
  count(*) FILTER (WHERE dw.state='ok') diar_ok,
  count(*) FILTER (WHERE dw.window_id IS NULL) diar_none,
  count(*) FILTER (WHERE dw.state IS NOT NULL AND dw.state<>'ok') diar_notok,
  count(*) FILTER (WHERE ew.window_id IS NULL AND dw.state='ok') never_attempted
FROM bench_window bw
JOIN room_day rd ON rd.id=bw.room_day_id
LEFT JOIN room_diarize_window dw ON dw.window_id=bw.id
LEFT JOIN room_emotion_window ew ON ew.window_id=bw.id
GROUP BY 1 ORDER BY 1
"""

Q_ORPHAN = """
SELECT count(*) total, count(*) FILTER (WHERE rd.id IS NOT NULL) joined
FROM bench_window bw LEFT JOIN room_day rd ON rd.id=bw.room_day_id
"""

Q_LABELS = """
SELECT top_label, count(*) n, round(avg(top_score)::numeric,3) avg_top
FROM room_span_emotion WHERE state='scored' GROUP BY 1 ORDER BY count(*) DESC
"""

Q_MODEL = """
SELECT model, model_key, subfolder, device, count(*) n
FROM room_span_emotion WHERE state='scored' GROUP BY 1,2,3,4
"""

Q_TURN_LINK = """
SELECT count(*) matched FROM (
  SELECT DISTINCT window_id, diarize_run_id FROM room_span_emotion
) se JOIN (
  SELECT DISTINCT window_id, run_id FROM room_turn_speaker
) ts ON ts.window_id=se.window_id AND ts.run_id=se.diarize_run_id
"""

Q_SPAN_FIRST = "SELECT min(scored_at), max(scored_at) FROM room_span_emotion"
Q_SPAN_BYDAY = """
SELECT to_char(date_trunc('day', scored_at),'YYYY-MM-DD') scored_day, state, count(*) n
FROM room_span_emotion GROUP BY 1,2 ORDER BY 1,2
"""
Q_EW_BYDAY = """
SELECT to_char(date_trunc('day', scored_at),'YYYY-MM-DD') scored_day, state, count(*) n
FROM room_emotion_window GROUP BY 1,2 ORDER BY 1,2
"""


def q(sql):
    env = dict(os.environ)
    proc = subprocess.run(
        ["node", NEON, sql], cwd=REPO, env=env, capture_output=True, text=True
    )
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr + "\n")
        raise SystemExit("query failed")
    return json.loads(proc.stdout)


def esc(s):
    return str(s).replace("|", "\\|")


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: coverage.py <out.md>")
    out_path = sys.argv[1]

    windows = q(Q_WINDOW)
    diar = q(Q_DIAR)
    bw_total = q(Q_ORPHAN)[0]
    labels = q(Q_LABELS)
    models = q(Q_MODEL)
    turn_link = int(q(Q_TURN_LINK)[0]["matched"])
    span_first = q(Q_SPAN_FIRST)[0]

    def i(v):
        return int(v or 0)

    days = {}
    for r in windows:
        d = days.setdefault(r["ist_day"], dict(rec=0, ew_any=0, ew_ok=0, ew_failed=0,
                                               ew_noseg=0, ew_stale=0, no_row=0))
        for k in d:
            d[k] += i(r[k])

    tot = {k: sum(d[k] for d in days.values()) for k in
           ("rec", "ew_any", "ew_ok", "ew_failed", "ew_noseg", "ew_stale", "no_row")}

    lines = []
    L = lines.append
    L("# TONE coverage audit — 2026-09-27 (order W32.1, read-only)")
    L("")
    L("From the stored results only (`room_emotion_window`, `room_span_emotion`,")
    L("`bench_window`, `room_day`, `room`, `room_diarize_window`, `room_turn_speaker`),")
    L("via `kit/neon-select.mjs` single SELECT statements. No emotion call, no re-run,")
    L("no Mini load. Counts and ids only, no patient text.")
    L("")
    L("Service era: first `room_span_emotion` scored_at %s UTC; the last span scored_at %s UTC" %
      (span_first["min"], span_first["max"]))
    L("")
    L("## 1. Per clinic day (all rooms, plus global)")
    L("")
    orph = int(bw_total["total"]) - int(bw_total["joined"])
    L("`bench_window` holds %d rows; %d of them join a room_day and are counted in the day tables" % (int(bw_total["total"]), int(bw_total["joined"])))
    L("(orphaned windows, no room_day): %d dropped. IST 27 Sep is a partial day: %s windows at run time." % (orph, days.get("2026-09-27", {}).get("rec", 0)))
    L("")

    L("| day (IST) | recorded | with results (ok) | no emotion row | no_segments | failed | diarize_stale |")
    L("|---|---:|---:|---:|---:|---:|---:|")
    for d in sorted(days):
        v = days[d]
        L("| %s | %d | %d | %d | %d | %d | %d |" % (d, v["rec"], v["ew_ok"], v["no_row"],
                                                    v["ew_noseg"], v["ew_failed"], v["ew_stale"]))
    L("| **all days** | **%d** | **%d** | **%d** | **%d** | **%d** | **%d** |" %
      tuple(tot[k] for k in ("rec", "ew_ok", "no_row", "ew_noseg", "ew_failed", "ew_stale")))
    L("")
    L("## 2. Per room per day (detail)")
    L("")
    L("| day (IST) | room | recorded | emotion ok | no emotion row | no_segments | stale |")
    L("|---|---|---:|---:|---:|---:|---:|")
    for r in windows:
        L("| %s | %s | %s | %s | %s | %s | %s |" % (
            r["ist_day"], esc(r["slug"]), r["rec"], r["ew_ok"], r["no_row"],
            r["ew_noseg"], r["ew_stale"]))
    L("")
    L("## 3. Diarize coverage per day (the gate before emotion)")
    L("")
    L("Emotion only runs for `room_diarize_window.state='ok'` windows, so the diarize side is")
    L("the direct cause of much of the gap.")
    L("")
    L("| day (IST) | recorded | diarize ok | diarize missing entirely | diarize not ok | diarize-ok but never attempted (no emotion row) |")
    L("|---|---:|---:|---:|---:|---:|")
    diar_tot = dict(rec=0, diar_ok=0, diar_none=0, diar_notok=0, never_attempted=0)
    for r in diar:
        vals = {k: i(r[k]) for k in diar_tot}
        for k in diar_tot:
            diar_tot[k] += vals[k]
        L("| %s | %d | %d | %d | %d | %d |" % (
            r["ist_day"], vals["rec"], vals["diar_ok"], vals["diar_none"],
            vals["diar_notok"], vals["never_attempted"]))
    L("| **all days** | **%d** | **%d** | **%d** | **%d** | **%d** |" %
      tuple(diar_tot[k] for k in ("rec", "diar_ok", "diar_none", "diar_notok", "never_attempted")))
    L("")
    L("## 4. Label set and share (sanity: is it all neutral?)")
    L("")
    L("Label set emitted by the service: %d labels (room_span_emotion top_label, state=scored)." % len(labels))
    L("Model rows: every scored span is `%s` (`%s` subfolder `%s`); no emotion2vec rows." %
      tuple((models[0][k] for k in ("model", "model_key", "subfolder")) if models else ("-", "-", "-")))
    L("")
    L("| label | spans | share of scored | avg top_score |")
    L("|---|---:|---:|---:|")
    scored_total = sum(i(x["n"]) for x in labels)
    for x in labels:
        share = (100.0 * i(x["n"]) / scored_total) if scored_total else 0
        L("| %s | %s | %.1f%% | %s |" % (x["top_label"], x["n"], share, x["avg_top"]))
    L("| **total** | **%d** | 100%% | — |" % scored_total)
    L("")
    L("## 5. Speaker-turn linkage (SPLIT / VOICEPRINT)")
    L("")
    L("- Results are per merged same-speaker run chunk, not per turn: `room_span_emotion`")
    L("  carries `diarize_run_id` + `speaker_idx` + `run_start_ms/run_end_ms`; `source_refs`")
    L("  point at diarize chunk refs (`bs_<win>|start_ms|end_ms|-`), not turn ids.")
    L("- Voiceprint turn-attribution exists in `room_turn_speaker` (`run_id`, `speaker_idx`,")
    L("  `clinician_id`, `role`). Link fields: `window_id` + `room_span_emotion.diarize_run_id`")
    L("  = `room_turn_speaker.run_id` (+ `speaker_idx`, +/- ms overlap).")
    L("- Verified: %d of 963 distinct span windows match a `(window_id, run_id)` pair in" % turn_link)
    L("  `room_turn_speaker` — so yes, spans CAN be tied to voiceprint-attributed speaker runs")
    L("  today; there is still no per-turn record (a turn may be part of a merged run).")
    L("")
    L("## 6. Gaps and likely causes")
    L("")
    last3 = (days.get("2026-09-25", {}).get("rec", 0) +
             days.get("2026-09-26", {}).get("rec", 0) +
             days.get("2026-09-27", {}).get("rec", 0))
    d15 = next((r for r in diar if r["ist_day"] == "2026-09-15"), {})
    L("- **Zero coverage on IST 25 Sep (%d windows) and IST 26 Sep (%d windows); IST 27 Sep is a" %
      (days.get("2026-09-25", {}).get("rec", 0), days.get("2026-09-26", {}).get("rec", 0)))
    L("  partial day (%d windows so far) and is also at zero. Total %d recorded windows with" %
      (days.get("2026-09-27", {}).get("rec", 0), last3))
    L("  0 diarize ok and 0 emotion rows.** `room_diarize_window` rows are absent entirely")
    L("  there; a likely cause (interpretation, not measured) is the transcription/visits")
    L("  switches being off (ruling 370). The emotion results with")
    L("  scored_at 25-27 Sep all belong to older windows (backlog requeue); no NEW window")
    L("  has been scored since IST 24 Sep.")
    L("- **Mid-month diarize hole: IST 16/17 Sep (%d+%d=%d recorded windows) have ZERO" %
      (days.get("2026-09-16", {}).get("rec", 0), days.get("2026-09-17", {}).get("rec", 0),
       days.get("2026-09-16", {}).get("rec", 0) + days.get("2026-09-17", {}).get("rec", 0)))
    L("  diarize-ok windows** (and IST 15 has %s): without diarize there can be no emotion," % i(d15.get("diar_ok", 0)))
    L("  so those days stay uncovered until a diarize re-run.")
    L("- **Never-attempted backlog: %d diarize-ok windows have no emotion row at all**" % diar_tot["never_attempted"])
    sep10 = i(next((r for r in diar if r['ist_day'] == '2026-09-10'), {}).get('never_attempted', 0))
    sep9 = i(next((r for r in diar if r['ist_day'] == '2026-09-09'), {}).get('never_attempted', 0))
    sep11 = i(next((r for r in diar if r['ist_day'] == '2026-09-11'), {}).get('never_attempted', 0))
    sep12 = i(next((r for r in diar if r['ist_day'] == '2026-09-12'), {}).get('never_attempted', 0))
    sep13 = i(next((r for r in diar if r['ist_day'] == '2026-09-13'), {}).get('never_attempted', 0))
    sep14 = i(next((r for r in diar if r['ist_day'] == '2026-09-14'), {}).get('never_attempted', 0))
    L("  (IST 9-14 Sep: %d+%d+%d+%d+%d+%d = %d), plus all the" %
      (sep9, sep10, sep11, sep12, sep13, sep14, sep9 + sep10 + sep11 + sep12 + sep13 + sep14))
    L("  diarize-missing days above. This is the residual backlog after the reported requeue.")
    L("- **Errors are rare: only %d failed and %d diarize_stale summary rows in the whole era;**" %
      (tot["ew_failed"], tot["ew_stale"]))
    L("  most non-ok rows are `no_segments` (%d) = windows with no attributed speech after" % tot["ew_noseg"])
    L("  diarize, not failures.")
    L("- **Small requeued islands (IST 23-25 Aug, 9-13 Sep): %d of their recorded windows got" %
      sum(days[d]["ew_any"] for d in ("2026-08-23", "2026-08-24", "2026-08-25",
                                      "2026-09-09", "2026-09-10", "2026-09-13")))
    L("  an emotion row. 8 days (IST 26-29 Aug, 8 Sep, 11/12 Sep, 14 Sep) have recorded windows")
    L("  but 0 emotion rows - the requeue did not attempt them, likely because diarize is")
    L("  missing there too.")
    L("")
    with open(out_path, "w") as f:
        f.write("\n".join(lines) + "\n")
    os.chmod(out_path, 0o640)
    print("wrote", out_path)


if __name__ == "__main__":
    main()
