"""r2audio.py — read-only chunk audio from R2 -> an energy series shaped like bench_level_sample (lx, 24 Sep).

Lets arm d cut days that have NO level log (everything before 23 Sep: the HIST-MINING Aug-Sep visits), by computing
the energy from the recorded chunks themselves. The segmenter's threshold is relative to the room's own quiet floor
(K x 20th percentile), so only the SHAPE has to match the recorder's meter, not its scale; validated on 23 Sep
against the level log (see REPORT.md).

Credentials: ~/.claude/secrets/r2_audio_read (id / secret / endpoint), read inside Python, never printed or put on argv.
Audio is cached under ~/eta-data/encounter-first/audio/ (0700). It never goes to git.
"""
import concurrent.futures as cf, json, os, subprocess
from datetime import datetime

BUCKET = "eta-audio"
CACHE = os.path.expanduser("~/eta-data/encounter-first/audio")
SR = 16000
STEP_S = 1.0                     # one value per second (the level log is ~2.3 s; the segmenter bins at 10 s)
# FEATURE = the 90th-percentile |amplitude| of each second. Chosen by agreement with the LEVEL LOG (the independent
# reference), never with truth. On OPD 3, 23 Sep, active 10-s bins agree with the level log: p90 0.806, 2.3-s poll 0.772,
# RMS 0.757, per-second max 0.696. The max catches transients the recorder's meter misses (49 arm-a clips vs the log's 23;
# p90 gives 25). Scored once afterwards: arm d on OPD 3 = 8/11 recall, 8/23 precision (level log: 9/11, 11/22).


def _client():
    import boto3
    ident, secret, endpoint = [l.strip() for l in open(os.path.expanduser("~/.claude/secrets/r2_audio_read")).read().splitlines()[:3]]
    return boto3.client("s3", endpoint_url=endpoint, aws_access_key_id=ident, aws_secret_access_key=secret, region_name="auto")


def fetch(keys, workers=8):
    """Download chunk objects (read-only GET) into the cache; returns {key: local_path}. Existing files are reused."""
    os.makedirs(CACHE, mode=0o700, exist_ok=True)
    c = _client(); out = {}
    def one(k):
        p = os.path.join(CACHE, k.replace("/", "__"))
        if not (os.path.exists(p) and os.path.getsize(p) > 0):
            c.download_file(BUCKET, k, p + ".part"); os.replace(p + ".part", p)
        return k, p
    with cf.ThreadPoolExecutor(workers) as ex:
        for k, p in ex.map(one, keys): out[k] = p
    return out


def peaks(path):
    """Per-second 90th-percentile |amplitude| in [0, 1] of one chunk (16 kHz mono via ffmpeg; 1-in-16 subsample)."""
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", str(SR), "-f", "s16le", "-"],
                       capture_output=True)
    if r.returncode: return []
    import array
    a = array.array("h"); a.frombytes(r.stdout[: len(r.stdout) // 2 * 2])
    n = int(SR * STEP_S)
    out = []
    for i in range(0, len(a) - n + 1, n):
        v = sorted(abs(x) for x in a[i:i + n:16]); out.append(v[int(0.9 * (len(v) - 1))] / 32768.0)
    return out


def energy_series(chunks, workers=8):
    """chunks: [{r2_key, started_at (ISO or epoch ms)}] -> [(t_ms, peak)], the bench_level_sample shape."""
    paths = fetch([c["r2_key"] for c in chunks], workers)
    def one(c):
        t0 = c["started_at"] if isinstance(c["started_at"], (int, float)) else int(datetime.fromisoformat(str(c["started_at"]).replace("Z", "+00:00")).timestamp() * 1000)
        return [(int(t0 + i * STEP_S * 1000), p) for i, p in enumerate(peaks(paths[c["r2_key"]]))]
    out = []
    with cf.ThreadPoolExecutor(workers) as ex:
        for s in ex.map(one, chunks): out.extend(s)
    return sorted(out)
