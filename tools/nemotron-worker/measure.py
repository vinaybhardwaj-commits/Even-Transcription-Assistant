#!/usr/bin/env python3
"""tools/nemotron-worker/measure.py — speed and VRAM of the worker's engine on local clips. Prints counts and timings only.

  python measure.py CLIP [CLIP ...] [--finetune-ckpt PATH]

Each clip goes through the same decode (ffmpeg_decode) and engine (NemotronEngine) as the worker. Output: one JSON
line with load_s, and per clip audio_s, infer_s, s_per_audio_min, turns, speakers; then peak VRAM (torch peak
reserved, and nvidia-smi's figure for this process). Never prints paths, turns or audio content.
"""
import argparse
import json
import os
import shutil
import subprocess
import tempfile
import time

import worker
import engine_nemo


def process_vram_mib() -> int | None:
    try:
        r = subprocess.run(["nvidia-smi", "--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"],
                           capture_output=True, text=True, timeout=15)
        for line in r.stdout.splitlines():
            pid, mib = (x.strip() for x in line.split(","))
            if int(pid) == os.getpid():
                return int(mib)
    except Exception:
        pass
    return None


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("clips", nargs="+")
    p.add_argument("--finetune-ckpt")
    a = p.parse_args()
    import torch

    t0 = time.monotonic()
    eng = engine_nemo.NemotronEngine(finetune_ckpt=a.finetune_ckpt)
    load_s = time.monotonic() - t0
    torch.cuda.reset_peak_memory_stats()
    rows, peak_smi = [], 0
    tmp = tempfile.mkdtemp(prefix="nemo-measure-")
    try:
        for i, clip in enumerate(a.clips):
            wav = os.path.join(tmp, f"{i}.wav")
            audio_ms = worker.ffmpeg_decode(clip, wav)
            torch.cuda.synchronize()
            t1 = time.monotonic()
            turns = worker.to_turns(eng.diarize(wav), audio_ms)
            torch.cuda.synchronize()
            infer_s = time.monotonic() - t1
            peak_smi = max(peak_smi, process_vram_mib() or 0)
            os.remove(wav)
            rows.append({"clip": i, "audio_s": round(audio_ms / 1000, 1), "infer_s": round(infer_s, 2),
                         "s_per_audio_min": round(infer_s / (audio_ms / 60000), 3), "turns": len(turns),
                         "speakers": len({t[2] for t in turns})})
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print(json.dumps({"gpu": worker.nvidia_gpu_name(), "model": eng.model, "model_rev": eng.model_rev,
                      "config_hash": worker.config_hash(eng.config), "load_s": round(load_s, 1), "clips": rows,
                      "peak_vram_torch_reserved_mib": round(torch.cuda.max_memory_reserved() / 2**20),
                      "peak_vram_torch_allocated_mib": round(torch.cuda.max_memory_allocated() / 2**20),
                      "vram_nvidia_smi_process_mib": peak_smi}))


if __name__ == "__main__":
    main()
