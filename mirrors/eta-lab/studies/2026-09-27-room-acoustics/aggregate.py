#!/usr/bin/env python3
"""W34.2 step 2: aggregate chunk_metrics.jsonl into per-room profiles (numbers only).
Usage: aggregate.py [--out-dir ~/eta-data/acoustics] [--stt stt_route.json]
"""
import json, os, sys, argparse, collections, datetime
import numpy as np

W = os.path.expanduser("~/eta-data/acoustics/work")
ROOMS = [("room_yh3etjpf","OPD 1"),("room_87frpus9","OPD 3"),("room_ux92qpws","OPD 4"),("room_4ggnkg5x","OPD 5"),
         ("room_pnyc9u49","OPD 6"),("room_qyzghzaf","OPD 7"),("room_d74hhmc4","Third Floor"),("room_bh6jtq4t","Cardiology"),
         ("room_ymch4bxu","Room 4-1 (after cards, before 5)"),("room_jwyrr4dc","ORB3")]
NOTAPE = [("Dietary","no room row in Neon `room`, no install and no tape in lab copies"),
          ("Home Office (room_2qe955hy)","TONOR TM20 on the production Mini; its tape is not in the lab copy (~/eta-data/tapes has no room_2qe955hy). Becomes the reference room once its first self-test lands (V ruling 27 Sep 09:55)")]
HB = np.arange(121) - 120  # dB bin lower edges -120..0

def mic_class(label):
    l = label or ""
    if "TONOR" in l or "0d8c:0134" in l: return "TONOR TM20"
    if "C270" in l: return "C270 webcam"
    return "unknown"

def hpct(h, q):
    h = np.asarray(h, float); c = h.cumsum()
    if c[-1] == 0: return None
    i = int(np.searchsorted(c, q / 100 * c[-1]))
    return float(HB[min(i, 120)])

def wq(vals, w, q):
    o = np.argsort(vals); v = np.asarray(vals)[o]; ww = np.asarray(w)[o]; c = ww.cumsum()
    return float(v[np.searchsorted(c, q / 100 * c[-1])])

def pq(v, q):
    return None if len(v) == 0 else round(float(np.percentile(v, q)), 2)

def spectral(psd_rows, noise_rows):
    """psd_rows: list of (psd, n). Returns tilt, bandwidth numbers."""
    if not psd_rows: return None
    ws = np.array([n for _, n in psd_rows], float)
    P = np.average(np.array([p for p, _ in psd_rows]), axis=0, weights=ws)
    f = np.linspace(0, 24000, len(P))
    Pdb = 10 * np.log10(np.maximum(P, 1e-20))
    band = lambda a, b: (f >= a) & (f < b)
    ref = 10 * np.log10(P[band(300, 3000)].mean())
    sel = band(200, 4000)
    slope = float(np.polyfit(np.log2(f[sel]), Pdb[sel], 1)[0])
    out = {"tilt_db_per_octave_200_4000": round(slope, 2),
           "hf_4_8k_vs_300_3k_db": round(float(10 * np.log10(P[band(4000, 8000)].mean()) - ref), 1),
           "hf_8_16k_vs_300_3k_db": round(float(10 * np.log10(P[band(8000, 16000)].mean()) - ref), 1)}
    # highest freq (>=300 Hz) where band-smoothed speech PSD >= ref-30 dB (smooth over 5 bins)
    sm = np.convolve(10 ** (Pdb / 10), np.ones(5) / 5, "same"); smdb = 10 * np.log10(sm)
    ok = np.where((f >= 300) & (smdb >= ref - 30))[0]
    out["bw_minus30db_hz"] = int(f[ok[-1]]) if len(ok) else None
    if noise_rows:
        N = np.average(np.array([p for p, _ in noise_rows]), axis=0, weights=[n for _, n in noise_rows])
        nsm = 10 * np.log10(np.convolve(N, np.ones(5) / 5, "same"))
        ok2 = np.where((f >= 300) & (smdb >= nsm + 6))[0]
        out["bw_6db_over_noise_hz"] = int(f[ok2[-1]]) if len(ok2) else None
    cum = np.cumsum(P[f >= 100]); ff = f[f >= 100]
    out["f95_energy_rolloff_hz"] = int(ff[np.searchsorted(cum, .95 * cum[-1])])
    out["psd_db_rel_by_band"] = {f"{a}-{b}": round(float(10*np.log10(P[band(a,b)].mean()) - ref), 1)
                                 for a, b in [(100,300),(300,1000),(1000,2000),(2000,3000),(3000,4000),(4000,6000),(6000,8000),(8000,12000),(12000,20000)]}
    return out

def profile(rows, label, mic):
    ok = [r for r in rows if "error" not in r]
    p = {"room": label, "mic": mic, "chunks": len(rows), "chunks_ok": len(ok),
         "hours": round(sum(r["dur_s"] for r in ok) / 3600, 2),
         "days": sorted({r["started_at"][:10] for r in ok})}
    if not ok: return p
    hq = np.sum([r["hist_quiet"] for r in ok if r.get("hist_quiet")], axis=0) if any(r.get("hist_quiet") for r in ok) else None
    hs = np.sum([r["hist_speech"] for r in ok if r.get("hist_speech")], axis=0) if any(r.get("hist_speech") for r in ok) else None
    p["quiet_frames_h"] = round(float(hq.sum()) / 3600, 2) if hq is not None else 0
    p["speech_frames_h"] = round(float(hs.sum()) / 3600, 2) if hs is not None else 0
    p["vad_speech_share_pct"] = round(100 * sum(r["vad_speech_s"] for r in ok) / sum(r["dur_s"] for r in ok), 2)
    if hq is not None:
        hq = hq.copy(); hq[0] = 0  # drop the -120 (digital zero / mute) bin from noise percentiles
    p["noise_floor_p10_dbfs"] = hpct(hq, 10) if hq is not None and hq.sum() else None  # "floor" only
    p["noise_median_dbfs"] = hpct(hq, 50) if hq is not None and hq.sum() else None  # primary noise level
    p["speech_frame_rms_median_dbfs"] = hpct(hs, 50) if hs is not None else None
    sl = [(r["speech_dbfs"], r["vad_speech_s"]) for r in ok if "speech_dbfs" in r and r["vad_speech_s"] >= 5]
    p["speech_level_dbfs_median"] = round(wq([a for a, _ in sl], [b for _, b in sl], 50), 1) if sl else None
    snr = [r["speech_dbfs"] - r["noise_med"] for r in ok if "speech_dbfs" in r and "noise_med" in r
           and r["vad_speech_s"] >= 5 and r["n_quiet_frames"] >= 10 and r["noise_med"] > -119]
    p["snr_db"] = {"basis": "speech power dBFS minus median quiet-frame dB, VAD chunks only", "n_chunks": len(snr),
                   "share_of_chunks_pct": round(100 * len(snr) / len(ok), 1), "p10": pq(snr, 10), "median": pq(snr, 50), "p90": pq(snr, 90)}
    # VAD-free: p95 of 1-s frame dB (speech proxy) minus p20 (noise proxy), from hist_all, per chunk with >=200 frames
    vf = []
    for r in ok:
        h = np.array(r["hist_all"]); h[0] = 0
        if h.sum() >= 200:
            a, b = hpct(h, 95), hpct(h, 20)
            if a is not None and b is not None: vf.append(a - b)
    p["snr_vad_free_db"] = {"basis": "p95 minus p20 of 1-s frame dB per chunk (>=200 frames, -120 bin dropped); includes non-speech events, an upper bound of dynamic range", "n_chunks": len(vf), "p10": pq(vf, 10), "median": pq(vf, 50), "p90": pq(vf, 90)}
    p["chunks_dur_mismatch_gt1s"] = sum(1 for r in ok if abs(r["dur_s"] - r["dur_ms"] / 1000) > 1)
    p["chunks_no_vad_speech_pct"] = round(100 * sum(1 for r in ok if r["vad_speech_s"] == 0) / len(ok), 1)
    tot = sum(r["n"] for r in ok)
    p["clip_pct_ge_0.999"] = round(100 * sum(r["clip_share_999"] * r["n"] for r in ok) / tot, 5)
    p["clip_pct_ge_0.98"] = round(100 * sum(r["clip_share_98"] * r["n"] for r in ok) / tot, 5)
    p["peak_max"] = round(max(r["peak"] for r in ok), 3)
    p["exact_zero_sample_pct"] = round(100 * sum(r["zero_sample_share"] * r["n"] for r in ok) / tot, 4)
    p["exact_zero_frame_pct"] = round(100 * sum(r["frame_zero_share"] * r["n_frames"] for r in ok) / sum(r["n_frames"] for r in ok), 4)
    bps = [r["size_bytes"] / (r["dur_ms"] / 1000) for r in rows if r.get("dur_ms")]
    p["mute_signature_chunk_pct"] = round(100 * float(np.mean([b < 1000 for b in bps])), 2)  # ~708 B/s = opus of digital zero (lab-mover)
    spec = spectral([(np.array(r["psd_speech"]), r["psd_speech_n"]) for r in ok if r.get("psd_speech")],
                    [(np.array(r["psd_noise"]), 1) for r in ok if r.get("psd_noise")])
    p["spectrum"] = spec
    rt = [x for r in ok for x in r.get("rt60", [])]
    p["rt60_blind"] = {"n_decays": len(rt), "median_s": pq(rt, 50), "p25_s": pq(rt, 25), "p75_s": pq(rt, 75)}
    if rt:
        T = np.median(rt); p["c50_db_from_median_rt60"] = round(float(10 * np.log10(np.expm1(13.8155 * 0.05 / T))), 1)
    # per-day noise/speech for drift
    pd = {}
    for d in p["days"]:
        rr = [r for r in ok if r["started_at"][:10] == d]
        h2 = [r["hist_quiet"] for r in rr if r.get("hist_quiet")]
        s2 = [r["speech_dbfs"] for r in rr if "speech_dbfs" in r and r["vad_speech_s"] >= 5]
        pd[d] = {"hours": round(sum(r["dur_s"] for r in rr) / 3600, 1),
                 "noise_p10": hpct(np.sum(h2, 0), 10) if h2 else None, "speech_dbfs_med": pq(s2, 50)}
    p["per_day_utc"] = pd
    return p

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--out-dir", default=os.path.expanduser("~/eta-data/acoustics"))
    ap.add_argument("--stt", default=None)
    a = ap.parse_args()
    sm = {r["id"]: mic_class(r["mic_label"]) for r in json.load(open(f"{W}/session_mic.json"))}
    rows = [json.loads(l) for l in open(f"{W}/chunk_metrics.jsonl")]
    names = dict(ROOMS)
    groups = collections.defaultdict(list)
    for r in rows: groups[(r["room_id"], sm.get(r["session_id"], "unknown"))].append(r)
    profs = []
    for rid, lab in ROOMS:
        for (g, mic), rr in sorted(groups.items()):
            if g == rid: profs.append(profile(rr, lab, mic))
    stt = json.load(open(a.stt)) if a.stt else None
    out = {"generated": datetime.datetime.now().isoformat(timespec="seconds"), "source": "lab tape copies ~/eta-data/tapes (25-27 Sep 2026 UTC start dates)",
           "n_chunks": len(rows), "profiles": profs, "no_tape": NOTAPE, "stt_route_by_room": stt}
    os.makedirs(a.out_dir, exist_ok=True)
    jp = os.path.join(a.out_dir, "room-profiles-2026-09-27.json")
    json.dump(out, open(jp, "w"), indent=1); os.chmod(jp, 0o640)
    print("wrote", jp, len(profs), "profiles")

if __name__ == "__main__": main()
