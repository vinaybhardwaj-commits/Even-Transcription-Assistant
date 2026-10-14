import base64, json, os, shutil, subprocess, sys, tempfile
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from cutter import config as C

T0 = 1790000000.0                                   # a fixed epoch: the fixture tape starts here
b64 = lambda v: base64.b64encode(np.asarray(v, dtype=np.float32).tobytes()).decode()
def unit(v): return v / np.linalg.norm(v)

class FakeHO:
    @staticmethod
    def is_held_out(u, d, room): return (d, room) in u

def make_fixture(root, nchunks=10, chunk=120, room="r1", date="2026-09-20"):
    """tape root with `nchunks` real 120 s audio chunks (sine) and a manifest.jsonl; returns the manifest path."""
    os.makedirs(f"{root}/tapes/{room}/{date}", exist_ok=True); rows = []
    for i in range(nchunks):
        p = f"{room}/{date}/c{i}.webm"
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", f"sine=frequency={200 + 40 * (i % 5)}:duration={chunk}", "-ac", "1", "-c:a", "libopus", f"{root}/tapes/{p}"], check=True)
        import datetime as dt
        rows.append(dict(id=f"id{i}", room_id=room, started_at=dt.datetime.fromtimestamp(T0 + i * chunk, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"), duration_ms=chunk * 1000, path=p))
    mf = f"{root}/tapes/manifest.jsonl"; open(mf, "w").write("".join(json.dumps(r) + "\n" for r in rows)); return mf

def fake_worker(doctor_until=60.0, print_vec=None, seed=3):
    """runner(cmd, stdin_text) writing a synthetic diarizer result per job: doctor SPEAKER_00 turns every 20 s up to doctor_until, SPEAKER_01 interleaved, one overlap."""
    rng = np.random.default_rng(seed)
    def runner(cmd, stdin_text):
        for j in json.loads(stdin_text)["jobs"]:
            L = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", j["audio"]], capture_output=True, text=True).stdout)
            segs, t = [], 2.0
            while t + 8 < min(L, doctor_until + 1):
                segs.append(dict(start=t, end=t + 8, speaker="SPEAKER_00")); segs.append(dict(start=t + 9, end=t + 15, speaker="SPEAKER_01")); t += 20
            if len(segs) > 2: segs.append(dict(start=segs[0]["start"] + 6, end=segs[0]["end"] + 2, speaker="SPEAKER_01"))     # overlap with the first doctor turn
            segs.append(dict(start=1.0, end=1.3, speaker="SPEAKER_01"))                                                          # a turn under 0.5 s
            segs.sort(key=lambda s: s["start"])
            d = unit(print_vec + 0.03 * rng.normal(size=192)) if print_vec is not None else unit(rng.normal(size=192)); o = unit(rng.normal(size=192))
            clusters = {"SPEAKER_00": dict(sec=sum(s["end"] - s["start"] for s in segs if s["speaker"] == "SPEAKER_00"), emb_b64=b64(d)),
                        "SPEAKER_01": dict(sec=sum(s["end"] - s["start"] for s in segs if s["speaker"] == "SPEAKER_01"), emb_b64=b64(o))}
            te = [None if s["end"] - s["start"] < 0.5 else b64(d if s["speaker"] == "SPEAKER_00" else o) for s in segs]
            json.dump(dict(segments=segs, clusters=clusters, turn_embs=te, engine="fake"), open(j["out"], "w"))
    return runner


import pytest
@pytest.fixture(autouse=True)
def _night_gate_on_by_default(monkeypatch):
    """the suite was written for the 22:30-06:00 gate; production has it off since 08 Oct (config.GPU_WINDOW_ENABLED = False). Tests of the disabled mode switch it off explicitly."""
    monkeypatch.setattr(C, "GPU_WINDOW_ENABLED", True)
