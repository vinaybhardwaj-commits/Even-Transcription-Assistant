#!/usr/bin/env python3
"""
VAD-trim backchannel bench (Fable rulings 11 + 29): what would a SAFE DIARIZE_VAD_TRIM setting be?

Runs the REAL /speech_regions endpoint (box eta-diarize twin, the Mini's code) on real webm windows that have BOTH pyannote.ai teacher labels and
level-log coverage, for a set of Silero/post-processing settings, under two policies:
  P_all   allow_cut = whole clip  -> what Silero alone would cut (the upper bound of harm)
  P_real  allow_cut = the app's own observedQuietSpans (15 s level-log buckets, observed, peak < 0.00398) -> what production would actually cut.
          Derived offline from P_all exactly as the endpoint's guard defines it: cuttable = allow_cut MINUS VAD speech; a VAD-empty answer
          keeps the whole clip (ruling (a): never trim on VAD alone).
Measures (numbers only, no text): labelled-speech loss (uncollared and +-0.25 s collared), windows over 2%, whole segments dropped (M2: >=0.3 s and >=80% cut),
BACKCHANNEL candidates = teacher segments < 0.5 s: kept vs dropped (dropped = <50% of the segment kept), and the same for ISOLATED candidates
(>= 1.0 s of teacher silence on both sides: the ones a trim can actually remove), plus audio saved.
"""
import argparse, base64, collections, json, os, subprocess, sys, tempfile, time

SR = 16000
FLOOR = 0.00398          # lib/stt/window-measure.ts DEFAULT_ROOM_ENERGY_FLOOR
BUCKET_MS = 15000        # lib/bench-levels.ts LEVEL_TIMELINE_BUCKET_SECONDS

BASE = dict(pad_s=0, merge_gap_s=0, min_region_s=0, threshold=0.15, min_silence_duration_ms=1200, speech_pad_ms=500, min_speech_duration_ms=250)
SETTINGS = collections.OrderedDict([
    ("S0 production defaults", {}),
    ("S1 threshold 0.10", dict(threshold=0.10)),
    ("S2 threshold 0.30", dict(threshold=0.30)),
    ("S3 min_silence 600", dict(min_silence_duration_ms=600)),
    ("S4 min_silence 2500", dict(min_silence_duration_ms=2500)),
    ("S5 speech_pad 300", dict(speech_pad_ms=300)),
    ("S6 speech_pad 1000", dict(speech_pad_ms=1000)),
    ("S7 min_speech 30", dict(min_speech_duration_ms=30)),
    ("S8 min_speech 100", dict(min_speech_duration_ms=100)),
    ("S9 post pad_s 0.5", dict(pad_s=0.5)),
    ("S10 post pad_s 1.0", dict(pad_s=1.0)),
    ("S11 protective combo", dict(threshold=0.10, min_speech_duration_ms=30, speech_pad_ms=1000, pad_s=0.5)),
    ("S12 very protective", dict(threshold=0.08, min_speech_duration_ms=30, min_silence_duration_ms=2500, speech_pad_ms=1000, pad_s=1.0)),
])


def merge(iv):
    out = []
    for s, e in sorted(iv):
        if e <= s:
            continue
        if out and s <= out[-1][1]:
            out[-1] = (out[-1][0], max(out[-1][1], e))
        else:
            out.append((s, e))
    return out


def complement(iv, total):
    out, t = [], 0
    for s, e in merge(iv):
        if s > t:
            out.append((t, s))
        t = max(t, e)
    if t < total:
        out.append((t, total))
    return out


def inter(a, b):
    out, i, j = [], 0, 0
    a, b = merge(a), merge(b)
    while i < len(a) and j < len(b):
        s, e = max(a[i][0], b[j][0]), min(a[i][1], b[j][1])
        if e > s:
            out.append((s, e))
        if a[i][1] < b[j][1]:
            i += 1
        else:
            j += 1
    return out


def cov(a, b, keep):
    c = 0
    for s, e in keep:
        if e <= a:
            continue
        if s >= b:
            break
        c += min(b, e) - max(a, s)
    return max(0, c)


def quiet_spans(rows, start_ms, end_ms):
    """Port of observedQuietSpans: 15 s buckets, peak=max, observed & peak < FLOOR -> cuttable. Returns clip-relative sample spans."""
    b = collections.defaultdict(list)
    for r in rows:
        if r["peak"] is None:
            continue
        b[int(r["t_ms"]) // BUCKET_MS].append(float(r["peak"]))
    spans = []
    for k, peaks in b.items():
        if max(peaks) >= FLOOR:
            continue
        bs = k * BUCKET_MS
        a, e = max(bs, start_ms) - start_ms, min(bs + BUCKET_MS, end_ms) - start_ms
        if e > a:
            spans.append((round(a * SR / 1000), round(e * SR / 1000)))
    return merge(spans)


def call(url, path, params, allow):
    form = ["-F", f"audio=@{path};type=audio/webm", "-F", "allow_cut=" + json.dumps(allow)]
    for k, v in params.items():
        form += ["-F", f"{k}={v}"]
    with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as t:
        out = t.name
    subprocess.run(["curl", "-s", "-m", "400", "-o", out, f"{url}/speech_regions"] + form, check=False)
    try:
        j = json.load(open(out))
    finally:
        os.remove(out)
    if not j.get("ok"):
        return None
    regs = [(r["start_sample"], r["end_sample"]) for r in j.get("regions", [])]
    return regs, int(j["total_samples"])


def classify(segs):
    """segs: unmerged teacher (start,end) seconds. Returns (short_all, short_isolated) index lists."""
    order = sorted(range(len(segs)), key=lambda i: segs[i][0])
    short_all, iso = [], []
    for i, (s, e) in enumerate(segs):
        if e - s >= 0.5:
            continue
        short_all.append(i)
        near = False
        for j, (s2, e2) in enumerate(segs):
            if j == i:
                continue
            if s2 < e + 1.0 and e2 > s - 1.0:
                near = True
                break
        if not near:
            iso.append(i)
    return short_all, iso


def metrics(kept_s, total_s, segs, short_all, iso):
    """kept_s: kept intervals in seconds."""
    tm = merge(segs)
    t_sp = sum(e - s for s, e in tm)
    cut = sum((e - s) - cov(s, e, kept_s) for s, e in tm)
    col = [(s + 0.25, e - 0.25) for s, e in tm if e - s > 0.5]
    c_sp = sum(e - s for s, e in col)
    c_cut = sum((e - s) - cov(s, e, kept_s) for s, e in col)
    dropped_segs = sum(1 for s, e in segs if e - s >= 0.3 and cov(s, e, kept_s) / (e - s) <= 0.2)

    def bc(idx):
        d = z = 0
        for i in idx:
            s, e = segs[i]
            f = cov(s, e, kept_s) / (e - s)
            if f < 0.5:
                d += 1
            if f == 0:
                z += 1
        return len(idx), d, z
    n_a, d_a, z_a = bc(short_all)
    n_i, d_i, z_i = bc(iso)
    return dict(teacher_s=t_sp, cut_s=cut, collar_teacher_s=c_sp, collar_cut_s=c_cut, dropped_segments=dropped_segs,
                short_n=n_a, short_dropped=d_a, short_zero=z_a, iso_n=n_i, iso_dropped=d_i, iso_zero=z_i,
                audio_s=total_s, kept_s=sum(e - s for s, e in kept_s))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8001")
    ap.add_argument("--work", default="/home/eta/vad/work/bench-vad")
    ap.add_argument("--ref", default="/home/eta/vad/work/vad-v3-58/data-ref")
    ap.add_argument("--settings", default=None, help="comma list of setting prefixes, e.g. S0,S11")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    W = json.load(open(f"{a.work}/windows.json"))
    if a.limit:
        W = W[:a.limit]
    rows_by = collections.defaultdict(list)
    for r in json.load(open(f"{a.work}/level_rows.json")):
        rows_by[r["wid"]].append(r)
    T = {}
    for w in W:
        segs = [(s["start"], s["end"]) for s in json.load(open(f"{a.ref}/{w['wid']}_pyannote.json"))["output"]["diarization"]]
        sa, iso = classify(segs)
        T[w["wid"]] = dict(segs=segs, short_all=sa, iso=iso, allow=quiet_spans(rows_by[w["wid"]], w["start_ms"], w["end_ms"]))
    want = a.settings.split(",") if a.settings else None
    results = {"n_windows": len(W), "settings": {}}
    for name, over in SETTINGS.items():
        if want and not any(name.startswith(p + " ") for p in want):
            continue
        params = {**BASE, **over}
        per = {"P_all": [], "P_real": []}
        t0 = time.time()
        for w in W:
            wid = w["wid"]; path = f"{a.work}/webm/{wid}.webm"
            r = call(a.url, path, params, [[0, 10 ** 9]])
            if r is None:
                print("  ERROR", name, wid); continue
            regs, total = r
            total_s = total / SR
            vad_empty = not regs
            kept_all = [(s / SR, e / SR) for s, e in regs]
            # P_all: Silero alone. Empty answer = everything cut (this is what VAD alone would do)
            per["P_all"].append({"wid": wid, "vad_empty": vad_empty, **metrics(kept_all, total_s, T[wid]["segs"], T[wid]["short_all"], T[wid]["iso"])})
            # P_real: cuttable = allow_cut minus VAD speech; empty answer keeps the whole clip
            if vad_empty:
                kept_real = [(0, total_s)]
            else:
                cuttable = inter(T[wid]["allow"], complement(regs, total))
                kept_real = [(s / SR, e / SR) for s, e in complement(cuttable, total)]
            per["P_real"].append({"wid": wid, "n_allow_spans": len(T[wid]["allow"]), "allow_s": sum(e - s for s, e in T[wid]["allow"]) / SR,
                                  **metrics(kept_real, total_s, T[wid]["segs"], T[wid]["short_all"], T[wid]["iso"])})
        agg = {}
        for pol, rows in per.items():
            ts = sum(r["teacher_s"] for r in rows); cs = sum(r["cut_s"] for r in rows)
            cts = sum(r["collar_teacher_s"] for r in rows); ccs = sum(r["collar_cut_s"] for r in rows)
            pw = [100 * r["collar_cut_s"] / r["collar_teacher_s"] for r in rows if r["collar_teacher_s"] >= 60]
            agg[pol] = dict(
                speech_loss_pct=round(100 * cs / ts, 2) if ts else 0, collared_loss_pct=round(100 * ccs / cts, 2) if cts else 0,
                worst_window_collared_pct=round(max(pw), 2) if pw else 0, windows_over_2pct=sum(1 for x in pw if x > 2), pct_regime_windows=len(pw),
                dropped_segments_ge03s=sum(r["dropped_segments"] for r in rows),
                short_n=sum(r["short_n"] for r in rows), short_dropped=sum(r["short_dropped"] for r in rows), short_zero=sum(r["short_zero"] for r in rows),
                iso_n=sum(r["iso_n"] for r in rows), iso_dropped=sum(r["iso_dropped"] for r in rows), iso_zero=sum(r["iso_zero"] for r in rows),
                audio_saved_pct=round(100 * (1 - sum(r["kept_s"] for r in rows) / sum(r["audio_s"] for r in rows)), 1),
                windows_vad_empty=sum(1 for r in rows if r.get("vad_empty")))
        results["settings"][name] = {"params": params, "agg": agg, "per_window": per}
        p, q = agg["P_all"], agg["P_real"]
        print(f"{name:26s} | P_all: loss {p['collared_loss_pct']:5.2f}% worst {p['worst_window_collared_pct']:5.1f}% >2%:{p['windows_over_2pct']:2d} iso-drop {p['iso_dropped']}/{p['iso_n']} saved {p['audio_saved_pct']}% "
              f"| P_real: loss {q['collared_loss_pct']:5.2f}% worst {q['worst_window_collared_pct']:5.1f}% >2%:{q['windows_over_2pct']:2d} short-drop {q['short_dropped']}/{q['short_n']} iso-drop {q['iso_dropped']}/{q['iso_n']} "
              f"segs>=0.3s dropped {q['dropped_segments_ge03s']} saved {q['audio_saved_pct']}%  ({time.time()-t0:.0f}s)", flush=True)
        json.dump(results, open(a.out, "w"))


if __name__ == "__main__":
    main()
