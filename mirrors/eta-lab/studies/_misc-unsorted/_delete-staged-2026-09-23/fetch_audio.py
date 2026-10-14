#!/usr/bin/env python3
"""Download+concat+trim one bench-window manifest into a WAV clip.
Usage: fetch_audio.py <manifest.json> <out_wav>
Manifest: {window_id, session_id, room_slug, start, end, chunks:[{idx,url,offset,duration}]}
"""
import sys, os, json, subprocess, tempfile, shutil

FFMPEG = shutil.which("ffmpeg") or "/opt/homebrew/bin/ffmpeg"
CURL = shutil.which("curl") or "/usr/bin/curl"

def main():
    manifest_path, out_wav = sys.argv[1], sys.argv[2]
    with open(manifest_path) as f:
        m = json.load(f)
    chunks = m["chunks"]
    total_duration = sum(c["duration"] for c in chunks)

    with tempfile.TemporaryDirectory() as td:
        local_paths = []
        for c in chunks:
            lp = os.path.join(td, f"chunk_{c['idx']:06d}.webm")
            r = subprocess.run([CURL, "-sS", "-m", "60", "-o", lp, c["url"]], capture_output=True)
            if r.returncode != 0 or not os.path.exists(lp) or os.path.getsize(lp) == 0:
                print(f"FAIL download idx={c['idx']}: {r.stderr.decode()[:300]}", file=sys.stderr)
                sys.exit(2)
            local_paths.append(lp)

        # If only one chunk, skip concat demuxer.
        if len(local_paths) == 1:
            concat_path = local_paths[0]
        else:
            listfile = os.path.join(td, "list.txt")
            with open(listfile, "w") as lf:
                for lp in local_paths:
                    lf.write(f"file '{lp}'\n")
            concat_path = os.path.join(td, "concat.webm")
            r = subprocess.run(
                [FFMPEG, "-y", "-f", "concat", "-safe", "0", "-i", listfile, "-c", "copy", concat_path],
                capture_output=True,
            )
            if r.returncode != 0 or not os.path.exists(concat_path):
                # fall back: re-encode concat (handles slight codec/timestamp mismatches)
                r2 = subprocess.run(
                    [FFMPEG, "-y", "-f", "concat", "-safe", "0", "-i", listfile,
                     "-ar", "16000", "-ac", "1", concat_path.replace(".webm", ".wav")],
                    capture_output=True,
                )
                if r2.returncode != 0:
                    print(f"FAIL concat: {r.stderr.decode()[:500]}\n{r2.stderr.decode()[:500]}", file=sys.stderr)
                    sys.exit(3)
                concat_path = concat_path.replace(".webm", ".wav")

        offset = chunks[0]["offset"]
        r = subprocess.run(
            [FFMPEG, "-y", "-ss", str(offset), "-i", concat_path, "-t", str(total_duration),
             "-ar", "16000", "-ac", "1", "-vn", out_wav],
            capture_output=True,
        )
        if r.returncode != 0 or not os.path.exists(out_wav):
            print(f"FAIL trim: {r.stderr.decode()[:500]}", file=sys.stderr)
            sys.exit(4)

    os.chmod(out_wav, 0o600)
    # report actual duration
    r = subprocess.run(
        [FFMPEG.replace("ffmpeg", "ffprobe"), "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", out_wav],
        capture_output=True, text=True,
    )
    dur = r.stdout.strip()
    print(f"OK {m['window_id']} -> {out_wav} duration={dur}s requested={total_duration}s")

if __name__ == "__main__":
    main()
