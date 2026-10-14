# Box replica — done, running on GPU, parity confirmed

**Status:** DONE. Fable rsynced `~/eta-emotion` from the Mini (git-snapshotted `da329f2`).
Requirements needed Python 3.12 (freeze pins `networkx==3.6.1`, requires >=3.11; box system
python is 3.10) — installed via `uv python install 3.12`, venv at `/home/eta/eta-emotion/venv`.

Server on port 8790 (`EMOTION_PORT=8790`, `EMOTION_MAX_DURATION_S=60` to match the Mini's launchd
config, local-only `EMOTION_SEGMENTS_SECRET`), not behind `flock` (long-running server, per the
order). Launcher: `start-box-replica.sh`.

## GPU migration (23 Sep, later same day — Fable: replica was burning ~3.4 CPU cores, slowing CI)

Immediate mitigation: capped at 2 threads (`torch.set_num_threads(2)`/`OMP_NUM_THREADS=2`) while
fixing the real thing. Root fix: freeze's `torch==2.14.0` ships CUDA 13.0; this box's driver
(550.90) is CUDA 12.4 — no wheel index has 2.14.0 for 12.4, so **downgraded to `torch==2.6.0+cu124`
/ `torchaudio==2.6.0+cu124`** (matched pair — mismatched torch/torchaudio ABI was the first failure)
in both this venv and the separate VAD venv. `torch.cuda.is_available()` now True in both.

Two more blockers surfaced and were fixed:
- `libcudart.so.13: cannot open shared object` — a leftover cu13 runtime path from the original
  install wasn't on the loader's search path even though the file existed; fixed with
  `LD_LIBRARY_PATH` pointing at it (see the launcher script).
- **`app.py`'s `pick_device()` has no `cuda` branch at all** (only `mps`/`cpu` — it was written for
  the Mini, Apple Silicon only). Added one, mirroring the existing `mps` branch exactly, marked
  `BOX-REPLICA-ONLY PATCH` in a comment — **not synced back to the Mini's copy**, since that
  wasn't asked for and the Mini has no CUDA to branch to anyway.

Re-ran the parity check after the migration (1 real clip, Mini vs box-GPU): same top label, score
diff 0.0000 — the version downgrade and device change didn't change the model's output. CPU on the
box is now idle during inference (was 344%, `torch.set_num_threads` no longer even the binding
constraint since compute moved to the GPU).

## Parity: 10 real 8s clips (bake20 audio) through Mini `/inference/wavlm` vs box, same clips

**10/10 agree.** 4 clips unscorable on both sides with the identical reason (3x `near_silent`,
1x `insufficient_speech` — same `silence_gate` thresholds, same verdict). 6 clips scored on both:
same top label every time, max score difference across all 7 labels **~0.0000** (well inside the
order's ±0.01 tolerance — floating-point noise between CPU and `mps`, not a real divergence).
Raw clip audio deleted after scoring (real room audio, not kept); aggregate-only results at
`/home/eta/eta-emotion/parity-clips/results.json` on the box (counts/labels/scores, no audio).

## gcp-l4 replica + three-way parity (24 Sep, L7 follow-up, Fable 02:00 order)

Built a second replica on gcp-l4 (`~/eta-lab-night/lab-mover/eta-emotion`, L4 GPU, localhost only, port 8790) from the SAME
pinned `requirements-freeze.txt` as the Mini (torch 2.14.0 with CUDA 13 works unmodified on gcp-l4's driver, unlike the box's
CUDA 12.4). One gcp-specific gap: the app shells out to `ffmpeg`, which gcp-l4 lacks (same gap that broke H1 earlier); fixed with the
static binary bundled in `imageio-ffmpeg`, symlinked into a `bin/` dir put first on the server's PATH. The `pick_device()` cuda branch is
the box-only patch already in the copied code (not for the Mini).
Parity: 12 fresh 8 s clips from the bake20 audio (seed 20260924; 9 from labelled-speech regions, 3 from gaps), the same clips through the
box replica, the gcp-l4 replica and the Mini's production `/inference/wavlm` (read-only inference; nothing written anywhere).
**12/12 clips: same scored/unscorable status, same skip reason, same top label on all three.** Max score difference across the 7 labels on
jointly scored clips: box vs Mini 0.0000, gcp-l4 vs Mini 0.0001, box vs gcp-l4 0.0001 (tolerance 0.01). 4 clips unscorable on all three
(2 `insufficient_speech`, 2 `near_silent`). Weakness: 6 of the 7 scored clips are `neutral`, so label agreement alone is a low bar; the
near-identical scores across all 7 labels are the stronger evidence. Raw clips shredded; results are labels/scores only
(`parity-3way-2026-09-24*.json`). The gcp-l4 server was stopped after the check (restart: `PATH=$PWD/bin:$PATH EMOTION_DEVICE=cuda
EMOTION_PORT=8790 venv/bin/python3 app.py` in that directory). Nothing was pointed at production.
