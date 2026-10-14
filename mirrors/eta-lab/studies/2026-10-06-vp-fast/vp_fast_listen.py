#!/usr/bin/env python3
"""vp-fast step 3: the listening set for V. Per MINTED doctor: 5 clips of 8-12 s from the mint's highest-purity segments (<= 1 per window, >= 2 days where possible, <= 3 per day)
plus 2 DECOY clips (a different recurring voice from the same room: another doctor's mint if one exists in that room, else the strongest recurring non-mint group of the doctor's own
windows; never within cos 0.45 of the doctor's mint). All clips are shuffled; the key (clip -> doctor, mint/decoy, window, times, purity) is written separately (0600) and is NOT in the manifest.
ADDENDUM 1 deliverable: ~/eta-data/consult/voicecheck-06oct/{clips/<slug>_<k>.wav, manifest.json, KEY-DO-NOT-SHIP.json}, dir 0700; 7 clips per doctor, 8-12 s, mono 16 kHz WAV, loudness-normalised (two-pass EBU R128 loudnorm, I=-18 LUFS, linear), k = 1..7 SHUFFLED per doctor; the manifest has NO mint/decoy flag. Run with the eta-diarize venv (speechbrain ECAPA, CPU):
  ~/services/eta-diarize/venv/bin/python3 vp_fast_listen.py <export.jsonl>
Pass rule (fixed): a doctor is CONFIRMED if V says yes to >= 4 of the 5 mint clips AND no to both decoys; else REJECTED (vp_fast_score.py)."""
import collections, glob, hashlib, json, os, random, subprocess, sys, time
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vp_fast_mint as vm                      # reuses loaders (needs sklearn: the eta-diarize venv has it)
E = vm.E; OUT = vm.OUT
sys.path.insert(0, f"{E}/manoj-package-work")
import manoj_diarize as md
CLIP_MIN, CLIP_MAX, GAP = 8.0, 12.0, 1.0

def runs(w, spks):
    """merged non-overlapped runs of the speakers `spks` (gap <= 1 s) that are >= 8 s, as (start, end)."""
    p = sorted(vm.pieces(w, spks)); p.sort(); out = []
    for a, b in p:
        if out and a - out[-1][1] <= GAP: out[-1] = (out[-1][0], max(out[-1][1], b))
        else: out.append((a, b))
    return [(a, b) for a, b in out if b - a >= CLIP_MIN]

def candidates(windows_spks, centroid, step=2.0):
    """windows_spks: [(window, speaker set)]. -> list of dict(window, start, end, purity) with 8-12 s clips scored by ECAPA cos to the centroid."""
    out = []
    for w, spks in windows_spks:
        wav = None
        for a, b in runs(w, spks):
            if wav is None: wav, sr = md.load_audio(f"{OUT}/audio/{w['cid']}.m4a")
            L = min(CLIP_MAX, b - a); s = a
            best = None
            while s + CLIP_MIN <= b + 1e-6:
                e = min(s + L, b)
                if e - s >= CLIP_MIN:
                    emb = md.embedding_for_window(wav, sr, s, e)
                    if emb is not None:
                        c = float(np.dot(vm.nrm(emb), centroid))
                        if best is None or c > best["purity"]: best = dict(window=w, start=round(s, 2), end=round(e, 2), purity=round(c, 4))
                s += step
            if best: out.append(best)
    return out

def pick(cands, k, per_day=3):
    """top-k by purity, <= 1 per window, <= per_day per day; then, if only one day was used but another day has candidates, swap the lowest-purity pick for the best other-day candidate."""
    cands = sorted(cands, key=lambda c: -c["purity"]); chosen, days, wins = [], collections.Counter(), set()
    for c in cands:
        if len(chosen) >= k: break
        if c["window"]["cid"] in wins or days[c["window"]["day"]] >= per_day: continue
        chosen.append(c); days[c["window"]["day"]] += 1; wins.add(c["window"]["cid"])
    if len(chosen) < k:                                  # second pass: another run of an already used window (time-disjoint), same per-day cap
        for c in cands:
            if len(chosen) >= k: break
            if c in chosen or days[c["window"]["day"]] >= per_day: continue
            if any(x["window"]["cid"] == c["window"]["cid"] and not (c["end"] <= x["start"] or c["start"] >= x["end"]) for x in chosen): continue
            chosen.append(c); days[c["window"]["day"]] += 1
    if len(chosen) < k:                                  # last resort: lift the per-day cap
        for c in cands:
            if len(chosen) >= k: break
            if c in chosen or any(x["window"]["cid"] == c["window"]["cid"] and not (c["end"] <= x["start"] or c["start"] >= x["end"]) for x in chosen): continue
            chosen.append(c)
    if k > 1 and len(chosen) == k and len({c["window"]["day"] for c in chosen}) < 2:
        other = [c for c in cands if c["window"]["day"] != chosen[0]["window"]["day"] and c["window"]["cid"] not in wins]
        if other: chosen[-1] = other[0]
    return chosen

def cut_clip(w, s, e, out):
    src = ["-ss", f"{s:.2f}", "-t", f"{e - s:.2f}", "-i", f"{OUT}/audio/{w['cid']}.m4a"]
    p1 = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", *src, "-af", "loudnorm=I=-18:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"], capture_output=True, text=True)
    m = json.loads(p1.stderr[p1.stderr.rindex("{"):p1.stderr.rindex("}") + 1])
    af = (f"loudnorm=I=-18:TP=-1.5:LRA=11:measured_I={m['input_i']}:measured_TP={m['input_tp']}:measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *src, "-af", af, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", out], check=True, capture_output=True)

def slug(name): return "".join(ch if ch.isalnum() else "-" for ch in name.lower().replace("dr.", "").replace("dr ", "")).strip("-").replace("--", "-")

def main():
    tier = sys.argv[1] if len(sys.argv) > 1 else "strict"               # strict = the ordered deliverable; tier2 = absorption-only-flagged doctors, SEPARATE dir, not part of the deliverable
    rep = json.load(open(f"{OUT}/mint_report.json")); M = np.load(f"{OUT}/mints.npz"); M2 = np.load(f"{OUT}/mints_tier2.npz"); W = vm.load_windows()
    allm = {**{u: M[u] for u in M.files}, **{u: M2[u] for u in M2.files}}; mints = {u: M[u] for u in M.files} if tier == "strict" else {u: M2[u] for u in M2.files}
    names = {u: d["name"] for u, d in rep["doctors"].items()}
    root = f"{E}/consult/voicecheck-06oct" if tier == "strict" else f"{E}/consult/voicecheck-06oct-TIER2-absorption-flagged"; os.makedirs(f"{root}/clips", mode=0o700, exist_ok=True); os.chmod(root, 0o700); os.chmod(f"{root}/clips", 0o700)
    rnd = random.Random(int.from_bytes(os.urandom(8), "big")); manifest, key, notes = [], {}, {}
    for u, mint in mints.items():
        d = rep["doctors"][u]; room = next(r for r, l in vm.LAB.items() if l == d["room"])
        use = "clean" if d.get("windows_used") == "clean" else None
        cw = [w for w in W.values() if w["uid"] == u and (use is None or w["quality"] == "clean") and w["room"] == room]
        ws = [(w, {c["spk"] for c in w["clusters"] if c["emb"] is not None and float(np.dot(c["emb"], mint)) >= vm.COS}) for w in cw]
        mc_ = pick(candidates(ws, mint), 5); notes[u] = dict(mint_clips=len(mc_), days=len({c["window"]["day"] for c in mc_}))
        dec = []
        for u2, m2 in allm.items():                                         # (a) another doctor's mint (strict or tier-2) in the same room
            if u2 == u or rep["doctors"][u2]["room"] != d["room"] or float(np.dot(m2, mint)) >= 0.45: continue
            w2 = [w for w in W.values() if w["uid"] == u2 and w["quality"] == "clean" and w["room"] == room]
            ws2 = [(w, {c["spk"] for c in w["clusters"] if c["emb"] is not None and float(np.dot(c["emb"], m2)) >= vm.COS}) for w in w2]
            cc = pick(candidates(ws2, m2), 2)
            for c_ in cc: dec.append(("other_doctor_mint:" + u2, c_))
        if len(dec) < 2:                                                     # (b) strongest recurring non-mint group in the doctor's own windows
            rest = [dict(clip_id=w["cid"], date=w["day"], room=room, speaker_raw=c["spk"], total_speech_sec=c["sec"], n_segments_scored=1, embedding=c["raw"]) for w in cw for c in w["clusters"]
                    if c["emb"] is not None and c["sec"] >= vm.MIN15 and float(np.dot(c["emb"], mint)) < vm.COS]
            for gr in sorted(vm.groups_at(rest), key=lambda g: -g["n_sessions"]):
                if len(dec) >= 2: break
                if gr["n_sessions"] < 2: continue                           # a decoy must be a RECURRING voice
                if float(np.dot(gr["centroid"], mint)) >= 0.45 or any(float(np.dot(gr["centroid"], allm[x.split(":")[1]])) >= 0.55 for x, _ in dec if x.startswith("other_doctor_mint")): continue
                byw = collections.defaultdict(set)
                for m_ in gr["members"]: byw[m_["clip_id"]].add(m_["speaker_raw"])
                cc = pick(candidates([(W[cid], s) for cid, s in byw.items()], gr["centroid"]), 1)
                if cc: dec.append((f"non_mint_group(n_windows={gr['n_sessions']})", cc[0]))
        notes[u]["decoys"] = [x for x, _ in dec]
        if len(dec) < 2:                                                     # (c) fallback: any non-mint voice of the doctor's own windows (even present in only 1 window), flagged in the key
            rest1 = [dict(clip_id=w["cid"], date=w["day"], room=room, speaker_raw=c["spk"], total_speech_sec=c["sec"], n_segments_scored=1, embedding=c["raw"]) for w in cw for c in w["clusters"]
                     if c["emb"] is not None and c["sec"] >= 8.0 and float(np.dot(c["emb"], mint)) < vm.COS]
            for gr in sorted(vm.groups_at(rest1), key=lambda g: -sum(m_["total_speech_sec"] for m_ in g["members"])):
                if len(dec) >= 2: break
                if float(np.dot(gr["centroid"], mint)) >= 0.45: continue
                byw = collections.defaultdict(set)
                for m_ in gr["members"]: byw[m_["clip_id"]].add(m_["speaker_raw"])
                cc = pick(candidates([(W[cid], s) for cid, s in byw.items()], gr["centroid"]), 1)
                if cc: dec.append((f"WEAK non_mint_voice(n_windows={gr['n_sessions']})", cc[0]))
        dec = dec[:2]; notes[u]["decoys"] = [x for x, _ in dec]
        sl = slug(names[u]); clips = [("mint", c, None) for c in mc_] + [("decoy", c, src) for src, c in dec]
        order = list(range(1, len(clips) + 1)); rnd.shuffle(order)
        for (kind, c, src), k in zip(clips, order):
            fn = f"{sl}_{k}.wav"; cut_clip(c["window"], c["start"], c["end"], f"{root}/clips/{fn}")
            dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f"{root}/clips/{fn}"], capture_output=True, text=True).stdout)
            manifest.append(dict(doctor_name=names[u], slug=sl, k=k, file=f"clips/{fn}", duration_s=round(dur, 2)))
            key.setdefault(sl, {})[str(k)] = dict(kind=kind, decoy_source=src, window=c["window"]["cid"], day=c["window"]["day"], start=c["start"], end=c["end"], purity=c["purity"])
    manifest.sort(key=lambda m: (m["slug"], m["k"]))
    for fn, obj in (("manifest.json", manifest), ("KEY-DO-NOT-SHIP.json", dict(rule="CONFIRMED = yes to >= 4 of the 5 mint clips AND no to both decoys; else REJECTED", key=key, notes=notes))):
        fd = os.open(f"{root}/{fn}", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as fh: json.dump(obj, fh, indent=1)
    for f in glob.glob(f"{root}/clips/*"): os.chmod(f, 0o600)
    print("voicecheck set", root, "clips", len(manifest), "per doctor", notes, "manifest sha16", hashlib.sha256(open(f"{root}/manifest.json", "rb").read()).hexdigest()[:16], flush=True)

if __name__ == "__main__": main()
