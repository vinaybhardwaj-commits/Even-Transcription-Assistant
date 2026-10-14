# yoga-drain — local diarizer on the Yoga (V's idea, 22 Sep ~21:20 IST) — from Fable

Goal: Fable's own diarization resource on the Yoga, independent of the Mini's production eta-diarize, for E-3 experiments (doctor presence, centroids) without loading production. pyannote.ai is dropped (V) — this is LOCAL pyannote only.

Yoga facts (measured): Ubuntu, 14 GB RAM (~6 GB available), NO GPU (Intel Iris Xe) → CPU only, 392 GB disk free, Python 3.14 system (use a venv with a torch-supported Python, e.g. uv-managed 3.11/3.12). Already running there — do not disturb: eta-indic (:8082), eta-sravaani (:8085), whisper-server (:8080), whisper-shim (:8081), openbot (:8000/:8766/:8767).

Build:
1. Mirror the Mini's ~/eta-diarize service: same server.py, same pyannote pipeline + ECAPA model versions (read the Mini's requirements/lock and model ids; parity matters so results are comparable). Copy code, don't edit the Mini's copy.
2. HF gated models: reuse the Mini's existing Hugging Face token by copying the token FILE to the Yoga (~/.cache/huggingface/token, 0600). Never print it.
3. Install as systemd user service `eta-diarize-yoga.service` on port **8086**, bound to the tailnet/localhost only, with `MemoryMax=4G`, `CPUQuota` leaving ≥2 cores free, torch threads capped accordingly, Restart=on-failure. /healthz endpoint.
4. Benchmark on 3 real 15-min windows already diarized on the Mini (pick from bs_gkzmch9p): wall time, peak RSS, number of speakers, and segment-level agreement with the Mini's stored output (overlap-weighted, counts only). Also confirm ECAPA embeddings for the same segment match the Mini within 1e-3 cosine (parity check).
5. Not wired into production. No writes to production DB or voiceprint store.

Report ≤12 lines to the pane + ~/dev/_fable/scratch/yoga-diarize.md (versions, port, bench table, parity result). Keep the service running afterwards.
