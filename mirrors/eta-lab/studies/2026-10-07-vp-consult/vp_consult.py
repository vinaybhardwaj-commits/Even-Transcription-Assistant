#!/usr/bin/env python3
"""vp-consult-01 (07 Oct): isolate ONE live consult and split Ankit's voice from the others. No transcription, no external API; audio stays under ~/eta-data (0700).
Target: OPD 7 (room_qyzghzaf) consult_uid 9esuf3kfd3p4uknmolh6igpd60, warehouse doctor Dr Ankit P Bhojani (F092iDIAfwXKtLCqP8HS), presence window 2026-10-07T04:13:22.522Z..04:15:38.436Z (unclosed: true end unknown).
Span: start = t_open - 60 s (lead-in), never before tape start; search end = the earlier of t_open + 20 min, the tape end (chunks mirrored so far) and - when given with --next-open - the next OPD 7 consult window;
end = last Ankit speech turn + 30 s. Ankit = every cluster with cos >= 0.55 to his PROVISIONAL print (prints-provisional-06oct.json); the other voices are S1, S2... by speech seconds.
Run (GPU under flock):  flock /home/eta/gpu.lock env DIAR_DEVICE=cuda PYANNOTE_CACHE=~/.cache/torch/pyannote HF_HUB_OFFLINE=1 ~/services/eta-diarize/venv/bin/python3 vp_consult.py"""
import argparse, collections, datetime as dt, json, os, subprocess, sys, tempfile
import numpy as np
E = os.path.expanduser("~/eta-data"); IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "2026-10-06-vp-fast"))
CID, ROOM, UID = "9esuf3kfd3p4uknmolh6igpd60", "room_qyzghzaf", "F092iDIAfwXKtLCqP8HS"
T_OPEN = dt.datetime(2026, 10, 7, 4, 13, 22, 522000, tzinfo=dt.timezone.utc).timestamp(); T_CLOSE = dt.datetime(2026, 10, 7, 4, 15, 38, 436000, tzinfo=dt.timezone.utc).timestamp()
COS = 0.55; LEAD = 60.0; TAIL = 30.0; MAXSEARCH = 1200.0; GAP = 0.3
OUT = f"{E}/consult/clips-07oct/{CID}"; WORK = f"{E}/vp-consult-work"
iso = lambda t: dt.datetime.fromtimestamp(t, IST).strftime("%Y-%m-%d %H:%M:%S") + (f".{int(round((t % 1) * 1000)):03d}")

def normalize(src_args, out):
    """two-pass loudnorm to -18 LUFS (linear), mono 16 kHz WAV; src_args = ffmpeg input args."""
    p1 = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", *src_args, "-af", "loudnorm=I=-18:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"], capture_output=True, text=True)
    m = json.loads(p1.stderr[p1.stderr.rindex("{"):p1.stderr.rindex("}") + 1])
    af = f"loudnorm=I=-18:TP=-1.5:LRA=11:measured_I={m['input_i']}:measured_TP={m['input_tp']}:measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *src_args, "-af", af, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", out], check=True, capture_output=True)

def concat(pieces, wav_src, out):
    """pieces: [(start_s, end_s)] of wav_src (clip-relative); concatenated with 0.3 s silence gaps, then normalised."""
    tmp = tempfile.mkdtemp(prefix="vpc_", dir=WORK); lst = []
    try:
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", f"anullsrc=r=16000:cl=mono", "-t", f"{GAP}", f"{tmp}/gap.wav"], check=True, capture_output=True)
        for i, (a, b) in enumerate(pieces):
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{a:.3f}", "-t", f"{b - a:.3f}", "-i", wav_src, "-ac", "1", "-ar", "16000", f"{tmp}/p{i:04d}.wav"], check=True, capture_output=True)
            lst += [f"{tmp}/p{i:04d}.wav"] + ([f"{tmp}/gap.wav"] if i < len(pieces) - 1 else [])
        open(f"{tmp}/c.txt", "w").write("".join(f"file '{p}'\n" for p in lst))
        normalize(["-f", "concat", "-safe", "0", "-i", f"{tmp}/c.txt"], out)
    finally:
        for f in os.listdir(tmp): os.remove(f"{tmp}/{f}")
        os.rmdir(tmp)

def subtract(turns_a, turns_b):
    """pieces of turns_a not overlapped by any turn of turns_b; pieces >= 0.3 s."""
    out = []
    for a, b in turns_a:
        cur = [(a, b)]
        for oa, ob in turns_b:
            nxt = []
            for x, y in cur:
                if ob <= x or oa >= y: nxt.append((x, y)); continue
                if oa > x: nxt.append((x, oa))
                if ob < y: nxt.append((ob, y))
            cur = nxt
        out += [(x, y) for x, y in cur if y - x >= 0.3]
    return sorted(out)

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--next-open", help="epoch seconds of the next OPD 7 consult window open (optional)"); a = ap.parse_args()
    sys.path.insert(0, f"{E}/drtpqma"); import heldout as ho; union, usha = ho.load_union()
    day = dt.datetime.fromtimestamp(T_OPEN, IST).strftime("%Y-%m-%d"); assert not ho.is_held_out(union, day, ROOM), "BLIND ROOM-DAY: STOP"
    import vp_fast_extract as vx
    for d in (OUT, WORK): os.makedirs(d, mode=0o700, exist_ok=True); os.chmod(d, 0o700)
    by = vx.chunks_by_room(); chunks = by[ROOM]; today = [c for c in chunks if c[0] >= T_OPEN - 3600 and c[0] <= T_OPEN + 3600]
    tape_start = min(c[0] for c in today); tape_end = max(c[1] for c in today)
    span_start = max(T_OPEN - LEAD, tape_start); search_end = min(T_OPEN + MAXSEARCH, tape_end, float(a.next_open) if a.next_open else 1e18)
    why_search = "t_open + 20 min" if search_end == T_OPEN + MAXSEARCH else ("tape end (chunks mirrored so far)" if search_end == tape_end else "next OPD 7 consult window open")
    pieces, cov = vx.plan(by, ROOM, span_start, search_end); work = f"{WORK}/{CID}_search.m4a"; vx.cut(pieces, work)
    sys.path.insert(0, f"{E}/manoj-package-work"); sys.path.insert(0, f"{E}/centroid-mint")
    import manoj_diarize as md, extract_embeddings as ee
    os.environ.setdefault("DIAR_DEVICE", "cuda")
    segs = md.local_diarize(work); wav, sr = md.load_audio(work)
    by_spk = collections.defaultdict(list)
    for s in segs: by_spk[s["speaker"]].append(s)
    prints = {p["doctor_uid"]: (p["display_name"], np.array(p["centroid_192_l2"], dtype=np.float32)) for p in json.load(open(f"{E}/consult/prints-provisional-06oct.json"))["prints"]}
    nrm = lambda v: v / np.linalg.norm(v); ank = nrm(prints[UID][1])
    clusters = {}
    for spk, ss in by_spk.items():
        emb, n = md.embedding_for_cluster(wav, sr, [(s["start"], s["end"]) for s in ss])
        sec = sum(s["end"] - s["start"] for s in ss)
        clusters[spk] = dict(sec=round(sec, 1), n_turns=len(ss), cos={prints[u][0]: round(float(np.dot(nrm(emb), nrm(p))), 3) for u, (_, p) in prints.items()} if emb is not None else None,
                             cos_ankit=None if emb is None else round(float(np.dot(nrm(emb), ank)), 3))
    ankit_clusters = {s for s, c in clusters.items() if c["cos_ankit"] is not None and c["cos_ankit"] >= COS}
    others = sorted([s for s in clusters if s not in ankit_clusters], key=lambda s: -clusters[s]["sec"]); label = {s: "Ankit" for s in ankit_clusters}; label.update({s: f"S{i + 1}" for i, s in enumerate(others)})
    # end of the span: the last Ankit turn in the search interval + 30 s
    ank_turns = sorted((s["start"], s["end"]) for s in segs if s["speaker"] in ankit_clusters)
    assert ank_turns, "no Ankit turn found"
    rel_open, rel_close = T_OPEN - span_start, T_CLOSE - span_start; last_ank = ank_turns[-1][1]
    end_rel = min(last_ank + TAIL, search_end - span_start); span_end = span_start + end_rel
    gaps = [(round(b0 - a1, 1), round(a1 + span_start - T_OPEN, 1)) for (a0, a1), (b0, b1) in zip(ank_turns, ank_turns[1:]) if b0 - a1 >= 45.0]   # long Ankit silences: (gap s, seconds after t_open)
    # per-turn cos
    turns = []
    for s in sorted(segs, key=lambda s: s["start"]):
        if s["start"] >= end_rel: continue
        e = min(s["end"], end_rel); emb = md.embedding_for_window(wav, sr, s["start"], e)
        turns.append(dict(start_s=round(s["start"], 3), end_s=round(e, 3), start_ist=iso(span_start + s["start"]), end_ist=iso(span_start + e), speaker=label[s["speaker"]], cluster=s["speaker"],
                          cos_to_ankit_print=None if emb is None else round(float(np.dot(nrm(emb), ank)), 3), short_lt_0p5s=emb is None))
    # outputs
    normalize(["-t", f"{end_rel:.3f}", "-i", work], f"{OUT}/consult.wav")
    wav16 = f"{WORK}/{CID}_search16.wav"; subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", work, "-ac", "1", "-ar", "16000", wav16], check=True, capture_output=True)
    at = [(s["start"], min(s["end"], end_rel)) for s in segs if s["speaker"] in ankit_clusters and s["start"] < end_rel]; ot = [(s["start"], min(s["end"], end_rel)) for s in segs if s["speaker"] not in ankit_clusters and s["start"] < end_rel]
    ap_, op_ = subtract(at, ot), subtract(ot, at)
    concat(ap_, wav16, f"{OUT}/ankit_only.wav"); concat(op_, wav16, f"{OUT}/others.wav")
    a_s = sum(b - x for x, b in at); o_s = sum(b - x for x, b in ot); a_trim = sum(b - x for x, b in ap_); o_trim = sum(b - x for x, b in op_)
    meas = [t for t in turns if t["speaker"] == "Ankit" and t["cos_to_ankit_print"] is not None]; low = [t for t in meas if t["cos_to_ankit_print"] < COS]
    tl = dict(consult_uid=CID, room=ROOM, doctor_uid=UID, union16=usha, span=dict(start_utc=dt.datetime.fromtimestamp(span_start, dt.timezone.utc).isoformat(), end_utc=dt.datetime.fromtimestamp(span_end, dt.timezone.utc).isoformat(),
              start_ist=iso(span_start), end_ist=iso(span_end), minutes=round((span_end - span_start) / 60, 2), t_open_ist=iso(T_OPEN), t_close_ist=iso(T_CLOSE), t_open_rel_s=round(rel_open, 1), t_close_rel_s=round(rel_close, 1)),
              how_end_was_chosen=f"last Ankit speech turn (ends {last_ank:.1f} s after span start, {iso(span_start + last_ank)}) + {TAIL:.0f} s, capped by the search end ({why_search}; search end {iso(search_end)}, tape end {iso(tape_end)}); next OPD 7 window open "
                                  + ("given" if a.next_open else "NOT known (no warehouse path on the box)") + f"; Ankit silences >= 45 s after t_open (gap s, seconds after t_open): {gaps}",
              tape_coverage_of_search=round(cov, 3), clusters=clusters, ankit_clusters=sorted(ankit_clusters), labels=label, turns=turns, ankit_print="provisional 06 Oct, doctor_uid " + UID,
              overlap_handling="ankit_only.wav / others.wav drop the parts of a turn that overlap a turn of the other side; consult.wav is untouched")
    for fn, obj in (("timeline.json", tl),):
        fd = os.open(f"{OUT}/{fn}", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as fh: json.dump(obj, fh, indent=1)
    sp = collections.Counter(); [sp.update({t["speaker"]: t["end_s"] - t["start_s"]}) for t in turns]; tot = sum(sp.values())
    rep = [f"# vp-consult-01 REPORT (box, 07 Oct) consult {CID} OPD 7, Dr Ankit P Bhojani",
           f"1 SPAN {iso(span_start)} to {iso(span_end)} IST = {(span_end - span_start) / 60:.1f} min (lead-in 60 s before t_open {iso(T_OPEN)}); presence t_close {iso(T_CLOSE)} was {(span_start + last_ank - T_CLOSE) / 60:.1f} min before Ankit's last turn.",
           f"2 END: last Ankit turn + 30 s, search capped at {why_search}; next OPD 7 window open " + ("given." if a.next_open else "UNKNOWN (no warehouse path on the box): please confirm no other patient is inside the span."),
           f"3 ANKIT SHARE of diarized speech: {100 * sp['Ankit'] / max(tot, 1e-9):.0f}% ({sp['Ankit'] / 60:.1f} min of {tot / 60:.1f} min); clusters: " + "; ".join(f"{label[s]} {clusters[s]['sec']} s cos_ankit {clusters[s]['cos_ankit']}" for s in sorted(clusters, key=lambda s: -clusters[s]['sec'])) + ".",
           f"4 OTHER SPEAKERS: {len(others)} (" + ", ".join(label[s] for s in others) + f"); best cos of any non-Ankit cluster to the other 5 provisional prints: {max([max(v for k, v in (clusters[s]['cos'] or {}).items() if 'Bhojani' not in k) for s in others if clusters[s]['cos']] or [0]):.2f}.",
           f"5 ANKIT TURNS: {sum(1 for t in turns if t['speaker'] == 'Ankit')} turns, {len(meas)} long enough to score; cos to his print: median {np.median([t['cos_to_ankit_print'] for t in meas]) if meas else float('nan'):.2f}, min {min([t['cos_to_ankit_print'] for t in meas] or [float('nan')]):.2f}; {len(low)} turns below 0.55 (cluster-assigned but turn-level cos low).",
           f"6 FILES in {OUT}: consult.wav ({(span_end - span_start) / 60:.1f} min), ankit_only.wav ({a_trim / 60:.1f} min), others.wav ({o_trim / 60:.1f} min), timeline.json; all mono 16 kHz, -18 LUFS; overlapped parts dropped from ankit_only/others ({(a_s - a_trim):.0f} s / {(o_s - o_trim):.0f} s).",
           f"7 CAVEAT: Ankit silences >= 45 s after t_open: {gaps if gaps else 'none'}; a later patient would show as a new voice after such a gap. No transcription, no external API."]
    open(f"{OUT}/REPORT.md", "w").write("\n".join(rep) + "\n"); os.chmod(f"{OUT}/REPORT.md", 0o600)
    for f in os.listdir(OUT): os.chmod(f"{OUT}/{f}", 0o600)
    print("\n".join(rep))

if __name__ == "__main__": main()
