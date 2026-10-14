# Nemotron /diarize endpoint (ruling 24e) — box T4, localhost :8002, NOT wired to production, DIARIZE_ENGINE untouched

- Code: `training/diar-lab/serve/nemotron_diarize_server.py` (deployed copy `/home/eta/services/nemotron-diarize/server.py`, venv `~/eta-data/nemotron/venv-nemo-main`, NeMo `cf724ac`, torch 2.14+cu126). Unit file proposed in `serve/nemotron-diarize-twin.service` (lab-mover to install; today it runs under setsid/nohup).
- Same contract as eta-diarize `POST /diarize` (audio, encounter_id, clinician_centroids, manual_relabels, batch_threshold) and same response keys/types (checked on V's 5 as webm/opus, `serve/contract_test.py`: zero shape differences; only `model_versions` values differ).
- Turns: Nemotron (offline 30.4 s setting). Embeddings: ECAPA via the pyannote twin's `/embed_speakers` on :8001 (localhost; the same model behind every enrolled centroid), longest span per speaker. Clinician match + Patient/Attender/Nurse heuristics + aggregates: the /diarize rule copied verbatim. Overlap windows: spans with >= 2 active speakers (no separate OSD). If :8001 is down the endpoint answers 502.
- Through the endpoint on V's 5 (webm/opus 24k): speaker counts 5,7,4,3,3 vs V 4,7,5,3,4 (mean abs err 0.6; 0.4 on the lossless wav in the bake-off; the pyannote twin at its production config gave 4,5,1,2,3, err 1.6). Latency per 15-min window: Nemotron 11-16 s vs pyannote twin 66-72 s (both on the shared T4).
- The cloud-built / split-speaker change (add `nemotron` as DIARIZE_ENGINE fallback + shadow, flag off) is NOT mine; it needs to call this endpoint with the same request as /diarize.

## Refuter conditions (REFUTER-2-VERDICT.md)
- **E1 fixed:** `/health` now probes the :8001 twin and returns 200 only if the model is loaded AND the twin answers ok; otherwise 503 with `embed_service` = `absent` (unreachable) or `broken`. Verified live (200) and with a simulated dead twin (503, `absent`).
- **Low fixed:** a non-JSON or non-200 twin reply, or an unreachable twin, now gives the documented 502 instead of 500.
- **E2 (Fable):** unchanged, endpoint stays localhost-only; no public hostname without auth.
