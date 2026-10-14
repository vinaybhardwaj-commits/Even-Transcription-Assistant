#!/usr/bin/env python3
"""337e: score B (Nemotron-3 turns on the wall-clock window audio) against the pyannote.ai labels for the REFERENCE windows (ruling 350). Numbers only.
pyannote.ai turns live on the production window's GAP-CLOSED axis: they are mapped to the wall clock through the window's own chunk plan (speaker_labels.closed_to_wall).
Per window: segment-level speaker agreement after the best relabelling (weighted by segment duration), unlabeled/mixed shares for both engines (rule: unlabeled < 1.0 s diarized speech in the segment), speaker counts.
usage: score_reference.py <nemo_turns.jsonl> <out.json> [--n N]  (venv with numpy; reads vault run files for segment TIMES and chunk plans only; Neon read-only for the pyannote.ai turns)"""
import json, os, statistics as st, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
STUD = os.environ.get("STUDIES_DIR", "/tmp/wt-diarlab/studies")
for d_ in ("2026-09-25-refused-speech", "2026-09-25-readability"): sys.path.insert(0, os.path.join(STUD, d_))
import speaker_labels as S
import refused_logic as R
import measure as M
ETA = os.path.expanduser("~/dev/Even-Transcription-Assistant"); SEL = os.path.expanduser("~/dev/eta-lab/kit/neon-select.mjs"); HOME = os.path.expanduser("~/eta-data")
nemo = {}
for l in open(sys.argv[1]): j = json.loads(l); nemo[j["window_id"]] = [tuple(t) for t in j["turns"]]
ref = [w for w in json.load(open(f"{HOME}/speaker-labels/reference_set.json"))["windows"] if w["window_id"] in nemo]
if "--n" in sys.argv: ref = ref[:int(sys.argv[sys.argv.index("--n") + 1])]
label_ids = [w["prod"][0]["label_id"] for w in ref]; segs_by_label = {}
for i in range(0, len(label_ids), 25):
    ids = ",".join("'%s'" % x for x in label_ids[i:i + 25])
    for r in json.loads(subprocess.run(["node", SEL, f"SELECT id, segments_json FROM diarize_window_label WHERE id IN ({ids})"], cwd=ETA, capture_output=True, text=True, check=True).stdout):
        s = r["segments_json"]; segs_by_label[r["id"]] = json.loads(s) if isinstance(s, str) else s
keymap = M.chunk_time_map(); rows = []
for w in ref:
    rec = M.ensure_timing(R.read_json(os.path.join(R.HOME, w["path"])), keymap)
    plan = R.chunk_plan(rec)                                          # [(name, chunk_start_rel_window, chunk_len)]
    axis = S.chunk_axis([(cs, cs + cl) for _, cs, cl in plan], 0.0, float(R.WINDOW_S))
    pya_closed = [(s["start_ms"] / 1000.0, s["end_ms"] / 1000.0, str(s["speaker_idx"])) for s in segs_by_label[w["prod"][0]["label_id"]]]
    pya = S.closed_to_wall(pya_closed, axis, 0.0) if not os.environ.get('NOMAP') else sorted(pya_closed)
    seg_t = [(x["start_s"], x["end_s"]) for x in rec["segments"] if not x.get("refused") and x["end_s"] > x["start_s"]]
    if not seg_t: continue
    a = S.assign(seg_t, pya); b = S.assign(seg_t, nemo[w["window_id"]]); dur = [e - s for s, e in seg_t]
    ag, nboth, _ = S.agreement([x["speaker"] for x in a], [x["speaker"] for x in b], dur)
    gap = float((rec.get("cut") or {}).get("gap_s") or 0.0) > 1.0
    rows.append(dict(window_id=w["window_id"], n_seg=len(seg_t), n_both=nboth, agreement=None if ag is None else round(ag, 3), gap_window=gap,
                     pya_speakers=len({s for _, _, s in pya}), nemo_speakers=len({s for _, _, s in nemo[w["window_id"]]}),
                     pya_unlabeled=round(sum(x["unlabeled"] for x in a) / len(a), 3), nemo_unlabeled=round(sum(x["unlabeled"] for x in b) / len(b), 3),
                     pya_mixed=round(sum(x["mixed"] for x in a) / len(a), 3), nemo_mixed=round(sum(x["mixed"] for x in b) / len(b), 3)))
ag = sorted(r["agreement"] for r in rows if r["agreement"] is not None)
summ = dict(windows=len(rows), windows_scored=len(ag), agreement_median=round(st.median(ag), 3), agreement_mean=round(st.mean(ag), 3), agreement_p10=round(ag[max(0, int(0.1 * len(ag)) - 1)], 3),
            agreement_lt_0_6=sum(x < 0.6 for x in ag), agreement_ge_0_8=sum(x >= 0.8 for x in ag),
            speaker_count_equal=sum(r["pya_speakers"] == r["nemo_speakers"] for r in rows), speaker_count_abs_diff_mean=round(st.mean(abs(r["pya_speakers"] - r["nemo_speakers"]) for r in rows), 2),
            segment_weighted_agreement=round(sum(r["agreement"] * r["n_both"] for r in rows if r["agreement"] is not None) / max(1, sum(r["n_both"] for r in rows if r["agreement"] is not None)), 3),
            unlabeled_mean=dict(pya=round(st.mean(r["pya_unlabeled"] for r in rows), 3), nemo=round(st.mean(r["nemo_unlabeled"] for r in rows), 3)),
            mixed_mean=dict(pya=round(st.mean(r["pya_mixed"] for r in rows), 3), nemo=round(st.mean(r["nemo_mixed"] for r in rows), 3)),
            gap_windows=dict(n=sum(r["gap_window"] for r in rows), agreement_median=round(st.median([r["agreement"] for r in rows if r["gap_window"] and r["agreement"] is not None] or [0]), 3)))
json.dump(dict(summary=summ, windows=rows), open(sys.argv[2], "w"), indent=1); print(json.dumps(summ, indent=1))
