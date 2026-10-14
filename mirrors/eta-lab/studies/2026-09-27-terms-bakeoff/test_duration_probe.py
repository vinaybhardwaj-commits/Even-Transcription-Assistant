"""Real end-to-end test against an actual generated audio file (ffmpeg/ffprobe are both present on this box)."""
import subprocess
import tempfile
import os

from duration_probe import probe_duration_s


def test_probe_matches_a_real_generated_file():
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        path = f.name
    try:
        subprocess.run(
            ["ffmpeg", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "2.5", "-y", path, "-loglevel", "error"],
            check=True, timeout=30,
        )
        assert abs(probe_duration_s(path) - 2.5) < 0.05
    finally:
        os.unlink(path)
