"""W27.2 (linker): audio of the 24 CAP-1 sample consult windows (15 confirmed + 9 probable links) for cap's CAP-2 hinted re-run.
Wrapper over the reviewed cap_ceiling.consult_audio (linker/cap-1 @ f363a3e0, bytes sha256[:8] 24f1b226): same pinned cut_window.py (0fb0eed981de2a48) + full_audio.py (cf06ca69f8075e60),
same window = link span +/-30 s (= the consult_transcripts span, called-60s..completed+60s), mp3 mono 16 kHz 32 kbps. Read-only on the tape; local only, nothing leaves the box.
Out: ~/eta-data/cap2/sample_audio/<consult_id>.mp3 (0640) + MANIFEST.tsv (window_id, consult_id, source_key, sha256, duration_s); dir 0750 group eta.
Usage: build_sample_audio.py <path to cap_ceiling.py from f363a3e0>"""
import hashlib, importlib.util, json, os, subprocess, sys
from datetime import datetime, timedelta
src = sys.argv[1]
if hashlib.sha256(open(src, "rb").read()).hexdigest()[:8] != "24f1b226":
    raise SystemExit("refused: cap_ceiling.py is not the reviewed f363a3e0 file")
spec = importlib.util.spec_from_file_location("cap_ceiling", src); cc = importlib.util.module_from_spec(spec); spec.loader.exec_module(cc)
H = os.path.expanduser("~/eta-data/")
OUT = H + "cap2/sample_audio/"
links = [l for l in map(json.loads, open(H + "cap/2026-09-25/links.jsonl")) if l["status"] in ("confirmed", "probable")]
assert len(links) == 24
os.makedirs(OUT, mode=0o750, exist_ok=True); os.chmod(OUT, 0o750)
rows_out = []
for l in sorted(links, key=lambda x: x["consult_id"]):
    cid = l["consult_id"]; mp3 = OUT + cid + ".mp3"
    cc.consult_audio(cid, l, mp3)
    os.chmod(mp3, 0o640)
    a = datetime.fromisoformat(l["span"][0]) - timedelta(seconds=cc.PAD_S - 30); b = datetime.fromisoformat(l["span"][1]) + timedelta(seconds=cc.PAD_S - 30)
    keys = []
    for line in open(cc.TAPES + "manifest.jsonl"):
        r = json.loads(line)
        if r["room_id"] != l["room"]:
            continue
        s = datetime.fromisoformat(r["started_at"].replace("Z", "+00:00")); e = s + timedelta(milliseconds=r["duration_ms"])
        if e <= a or s >= b:
            continue
        keys.append(r["r2_key"])
    dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp3], capture_output=True, text=True, check=True).stdout.strip())
    rows_out.append(("cw-" + cid, cid, ";".join(keys), hashlib.sha256(open(mp3, "rb").read()).hexdigest(), f"{dur:.1f}"))
mf = OUT + "MANIFEST.tsv"
with open(mf, "w") as f:
    f.write("window_id\tconsult_id\tsource_key\tsha256\tduration_s\n")
    for r in rows_out:
        f.write("\t".join(r) + "\n")
os.chmod(mf, 0o640)
print("files", len(rows_out), "total_s", round(sum(float(r[4]) for r in rows_out)), "manifest_sha256", hashlib.sha256(open(mf, "rb").read()).hexdigest())
