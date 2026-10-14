#!/usr/bin/env python3
"""
Ruling 20: contract test for /speech_regions on the box eta-diarize twin, with REAL audio (webm/opus like production).
Re-implements the app's own validation (lib/diarize-vad-trim.ts buildRegionMap) so a pass here means the app would ACCEPT the map.
Numbers only; audio is cut to a temp dir and shredded.

  cases:  A  dense speech, no allow_cut          -> expect ok, whole clip kept (no corroboration -> no cut)
          B  sparse speech, allow_cut = whole clip (simulates a level log that calls everything quiet) -> may cut VAD-silent parts
          C  sparse speech, allow_cut = teacher-silence spans only -> cuts only inside them, never teacher speech unless VAD missed it
          D  digital silence                     -> ok, regions == [] (a real "no speech" answer), total_samples present
  invariants (from buildRegionMap): sample_rate 16000 int, regions sorted, non-overlapping, non-empty, inside the clip,
  trim_start_sample == running sum of earlier region lengths; the returned WAV has exactly sum(region lengths) samples.
"""
import base64, io, json, os, subprocess, sys, tempfile, time, wave

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8001"
DATA = "/home/eta/vad/work/vad-v3-58/data"
REF = "/home/eta/vad/work/vad-v3-58/data-ref"
SR = 16000


def teacher(wid):
    segs = json.load(open(f"{REF}/{wid}_pyannote.json"))["output"]["diarization"]
    iv = sorted((s["start"], s["end"]) for s in segs)
    out = []
    for s, e in iv:
        if out and s <= out[-1][1]:
            out[-1] = (out[-1][0], max(out[-1][1], e))
        else:
            out.append((s, e))
    return out


def mk_webm(wid, off, length, path):
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", str(off), "-t", str(length), "-i", f"{DATA}/{wid}.wav",
                    "-ac", "1", "-ar", "48000", "-c:a", "libopus", "-b:a", "24k", path], check=True)


def mk_silence(path, length):
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", f"anullsrc=r=48000:cl=mono", "-t", str(length),
                    "-c:a", "libopus", "-b:a", "24k", path], check=True)


def call(path, allow_cut):
    p = ["curl", "-s", "-m", "300", f"{URL}/speech_regions", "-F", f"audio=@{path};type=audio/webm",
         "-F", "pad_s=0", "-F", "merge_gap_s=0", "-F", "min_region_s=0", "-F", "threshold=0.15",
         "-F", "min_silence_duration_ms=1200", "-F", "speech_pad_ms=500", "-F", "min_speech_duration_ms=250",
         "-F", "allow_cut=" + json.dumps(allow_cut)]
    t0 = time.time()
    r = subprocess.run(p, capture_output=True, text=True)
    return json.loads(r.stdout), time.time() - t0


def build_region_map(regions, sr, total):
    """Port of buildRegionMap: returns (ok, reason)."""
    if not (isinstance(sr, int) and sr > 0 and isinstance(total, int) and total > 0):
        return False, "sr/total"
    exp = prev = 0
    for r in regions:
        s, e, t = r.get("start_sample"), r.get("end_sample"), r.get("trim_start_sample")
        if not all(isinstance(x, int) for x in (s, e, t)):
            return False, "non-int"
        if s < 0 or e <= s or e > total:
            return False, "empty/outside"
        if s < prev:
            return False, "unsorted/overlap"
        if t != exp:
            return False, "trim offset != running sum"
        exp += e - s
        prev = e
    return True, exp


def report(name, j, wall, tiv=None, clip_len=None, allow=None):
    ok = j.get("ok")
    if not ok:
        print(f"[{name}] ok={ok} error={j.get('error')}"); return False
    regs = j.get("regions", [])
    sr, total = j.get("sample_rate"), j.get("total_samples")
    line = f"[{name}] wall={wall:.1f}s vad_model={j.get('vad_model')!r} sr={sr} total_s={total/SR:.1f} regions={len(regs)}"
    if not regs:
        print(line + " -> EMPTY (a real 'no speech' answer)"); return True
    valid, info = build_region_map(regs, sr, total)
    if not valid:
        print(line + f" MAP REJECTED: {info}"); return False
    kept = info / SR
    w = wave.open(io.BytesIO(base64.b64decode(j["audio_b64"])), "rb")
    wav_ok = (w.getframerate() == SR and w.getnchannels() == 1 and w.getnframes() == info)
    msg = f"{line} kept={kept:.1f}s ({100*kept/(total/SR):.0f}%) map_valid=True wav_matches_regions={wav_ok}"
    if tiv is not None:
        cut_speech = 0.0
        keep = [(r['start_sample'] / SR, r['end_sample'] / SR) for r in regs]
        for a, b in tiv:
            cov = sum(max(0, min(b, e) - max(a, s)) for s, e in keep)
            cut_speech += (b - a) - cov
        tot = sum(b - a for a, b in tiv)
        msg += f" | teacher speech {tot:.0f}s, cut {cut_speech:.1f}s ({100*cut_speech/tot:.1f}%)" if tot else ""
    if allow is not None:  # nothing may be cut outside allow_cut
        keep_s = [(r['start_sample'], r['end_sample']) for r in regs]
        cut_sp, prev = [], 0
        for s, e in keep_s:
            if s > prev: cut_sp.append((prev, s))
            prev = e
        if prev < total: cut_sp.append((prev, total))
        outside = 0
        for a, b in cut_sp:
            covered = sum(max(0, min(b, y) - max(a, x)) for x, y in allow)
            outside += (b - a) - covered
        msg += f" | cut outside allow_cut: {outside} samples"
        wav_ok = wav_ok and outside == 0
    print(msg)
    return wav_ok


def main():
    tmp = tempfile.mkdtemp(prefix="sr_"); allok = True
    # A: dense speech, no allow_cut
    p = f"{tmp}/a.webm"; mk_webm("bw_amdxyq32_1790171100000_primary", 200, 120, p)
    j, w = call(p, []); t = [(a - 200, b - 200) for a, b in teacher("bw_amdxyq32_1790171100000_primary") if b > 200 and a < 320]
    allok &= report("A dense, no allow_cut", j, w, tiv=[(max(0, a), min(120, b)) for a, b in t])
    # B/C: sparse speech window (7tedad86): allow_cut = whole clip / teacher-silence spans
    wid = "bw_7tedad86_1790163900000_primary"; p = f"{tmp}/b.webm"; mk_webm(wid, 300, 120, p)
    tv = [(max(0, a - 300), min(120, b - 300)) for a, b in teacher(wid) if b > 300 and a < 420]
    total = 120 * SR
    j, w = call(p, [[0, total]]); allok &= report("B sparse, allow_cut=whole clip", j, w, tiv=tv, allow=[(0, total)])
    sil, prev = [], 0.0
    for a, b in tv:
        if a > prev: sil.append([int(prev * SR), int(a * SR)])
        prev = b
    if prev < 120: sil.append([int(prev * SR), total])
    j, w = call(p, sil); allok &= report("C sparse, allow_cut=teacher-silence", j, w, tiv=tv, allow=[tuple(x) for x in sil])
    # D: digital silence
    p = f"{tmp}/d.webm"; mk_silence(p, 20)
    j, w = call(p, []); allok &= report("D digital silence", j, w)
    for f in os.listdir(tmp):
        subprocess.run(["shred", "-u", f"{tmp}/{f}"])
    os.rmdir(tmp)
    print("\nRESULT:", "ALL CASES PASS" if allok else "FAILURES (see above)")
    sys.exit(0 if allok else 1)


if __name__ == "__main__":
    main()
