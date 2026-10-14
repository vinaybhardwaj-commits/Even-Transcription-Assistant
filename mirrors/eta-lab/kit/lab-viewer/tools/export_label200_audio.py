#!/usr/bin/env python3
"""Export the audio of the 200 label200 clips exactly [t0,t1] (window-relative seconds) for stt-bench (Fable W27 22:00).
  python3 export_label200_audio.py --clip <label200.clip.json> --out <dir>
Read-only on sources: local chunk copies (same search as make_label200_lang.local_chunk_file) else eta-audio via wrangler `r2 object get`.
A clip can span several chunks: each overlapping chunk is decoded for its part and the parts are concatenated sample-exact.
Output codec: pcm_s16le WAV at the chunk's own sample rate/channels (a lossless decode of the source; no resample, no lossy re-encode).
Writes L###.wav (0640) + MANIFEST.tsv (id, k, t0, t1, sha256, duration) in a 0750 dir. No text/transcripts touched."""
import argparse, hashlib, importlib.util, json, os, shutil, subprocess, sys, tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("l200", str(HERE / "make_label200_lang.py"))
L = importlib.util.module_from_spec(spec); spec.loader.exec_module(L)
spec = importlib.util.spec_from_file_location("bi", str(HERE.parent.parent / "lab-vault" / "build-index.py"))
bi = importlib.util.module_from_spec(spec); spec.loader.exec_module(bi)


def spans(rec, timing):
    pd = rec.get("provenance") or {}
    sc = pd.get("source_chunks") if isinstance(pd.get("source_chunks"), list) and pd.get("source_chunks") else None
    if not sc:
        keys = (rec.get("cut") or {}).get("chunk_keys") or pd.get("source_audio_keys") or []
        sc = [dict(timing.get(k)) if (timing and k in timing and timing[k].get("started_at")) else {"r2_key": k} for k in keys]
    ws = L._dp(rec.get("start"))
    out = []
    for c in sc:
        s = L._dp(c.get("started_at"))
        e = L._dp(c.get("ended_at")) if c.get("ended_at") else (s + float(c.get("duration_ms") or 0)) if s is not None else None
        out.append((c.get("r2_key") or "", None if s is None or ws is None else (s - ws) / 1000.0, None if e is None or ws is None else (e - ws) / 1000.0))
    return out


def dur(p):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(p)], capture_output=True, text=True)
    return float(r.stdout.strip())


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--clip", required=True); ap.add_argument("--out", required=True)
    ap.add_argument("--only", default=None); a = ap.parse_args()
    clips = L.load(a.clip); timing = bi.chunk_timing()
    out = Path(os.path.expanduser(a.out)); out.mkdir(parents=True, exist_ok=True); out.chmod(0o750)
    tmp = Path(tempfile.mkdtemp(prefix="l200aud-", dir=str(out.parent))); tmp.chmod(0o700)
    recs, rows = {}, []
    try:
        for lid in sorted(clips):
            if a.only and lid not in a.only.split(","): continue
            c = clips[lid]; t0, t1 = float(c["t0"]), float(c["t1"]); win = c["k"].split("/")[3]
            if win not in recs:
                root, p = L.find_window(win)
                if not p: sys.exit(f"{lid}: window record not found")
                recs[win] = (root, json.load(open(p)))
            root, rec = recs[win]
            sp = spans(rec, timing)
            if len(sp) == 1 and sp[0][1] is None: sp = [(sp[0][0], 0.0, 1e9)]
            parts = []
            for j, (rk, s, e) in enumerate(sp):
                if s is None or e is None: sys.exit(f"{lid}: chunk {rk} has no timing")
                lo, hi = max(t0, s), min(t1, e)
                if hi - lo <= 0: continue
                src = L.local_chunk_file(root, rk); own = False
                if not src:
                    src = tmp / f"{lid}-{j}.src"; own = L.fetch_r2(rk, src)
                    if not own: sys.exit(f"{lid}: chunk {rk} not local and not in eta-audio")
                wav = tmp / f"{lid}-{j}.wav"
                r = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(src), "-ss", f"{lo - s:.6f}", "-t", f"{hi - lo:.6f}", "-c:a", "pcm_s16le", str(wav)], capture_output=True)
                if r.returncode: sys.exit(f"{lid}: ffmpeg failed")
                if own: Path(src).unlink()
                parts.append(wav)
            if not parts: sys.exit(f"{lid}: no chunk covers [{t0},{t1}]")
            dst = out / f"{lid}.wav"
            if len(parts) == 1: shutil.move(str(parts[0]), dst)
            else:
                lst = tmp / f"{lid}.txt"; lst.write_text("".join(f"file '{p}'\n" for p in parts))
                r = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", str(dst)], capture_output=True)
                if r.returncode: sys.exit(f"{lid}: concat failed")
                for p in parts: p.unlink()
            dst.chmod(0o640)
            rows.append((lid, c["k"], c["t0"], c["t1"], hashlib.sha256(dst.read_bytes()).hexdigest(), f"{dur(dst):.3f}"))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    m = out / ("MANIFEST.tsv" if not a.only else "MANIFEST.partial.tsv")
    m.write_text("id\tk\tt0\tt1\tsha256\tduration\n" + "".join("\t".join(map(str, r)) + "\n" for r in rows)); m.chmod(0o640)
    print(json.dumps({"clips": len(rows), "manifest_sha256": hashlib.sha256(m.read_bytes()).hexdigest()}))


if __name__ == "__main__":
    main()
