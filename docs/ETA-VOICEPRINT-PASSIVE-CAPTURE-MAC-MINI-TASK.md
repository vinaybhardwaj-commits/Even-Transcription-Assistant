# ETA · Voiceprint passive capture — Mac Mini `/diarize` change (Sprint B)

> **Status:** ✅ DONE + VERIFIED — 31 May 2026. V applied this on the Mac Mini (`server.py` new sha `a2f1f643…`, backup `server.py.bak.20260531-052952`, pinned venv untouched). `/diarize` now returns a per-speaker `embedding_base64` (raw un-normalized ECAPA float32[192], byte-identical to `/enroll`). **Independently re-verified from the Evenscribe sandbox** (flite-TTS webm → public `/diarize`): HTTP 200, speaker carries `embedding_base64` = 1024 b64 chars → 768 bytes → float32[192], **L2 norm 311.62** (≠1 → raw, correct). The Evenscribe `/process` passive-capture hook (`f72e3d7`) is now unblocked and active. Only remaining piece = V's real-encounter app-side smoke test (record a consult as a matched clinician → confirm a `passive` sample appears in the admin Voice samples panel). The steps below are retained as the record of what was applied.

**Why you (V) must run it:** the Cowork sandbox can reach the public HTTPS URL but **not** the home LAN, and this edits `~/eta-diarize/server.py`. ~10–15 min. ⚠️ Do **not** `pip`/`brew upgrade` anything — the diarize venv is pinned (see `ETA-MAC-MINI-BACKEND-HANDOVER.md` §3). This is a pure response-shape addition.

## What changes
`/diarize` already computes a 192-d ECAPA embedding for **each speaker cluster** (that's how it matches a speaker to an enrolled `clinician_centroid`). Today it throws those vectors away after matching. The change: **include each speaker's embedding in the response** so Evenscribe can retain the doctor's own voice from real consults.

Target service: `~/eta-diarize/server.py`, launchd label `uk.llmvinayminihome.eta-diarize`, port 8001, public `https://diarize.llmvinayminihome.uk`.

## Contract change (additive)
In the `POST /diarize` response, add one field to every object in `speakers[]`:

```jsonc
"speakers": [
  {
    "idx": 0, "label": "Clinician", "type": "clinician", "source": "auto",
    "clinician_id": "doc_gkldkeu8", "confidence": 0.83,
    "total_speech_sec": 41.2, "first_heard_at_sec": 0.4,
    "embedding_base64": "<768-byte little-endian float32[192], base64>"   // <-- ADD THIS
  }
]
```

- **Same byte format as `/enroll`**: raw, un-normalized 192-d ECAPA vector, little-endian float32 (`<f4`) = 768 bytes → base64 (~1024 chars). (Evenscribe stores raw and L2-normalizes at compare time — keep it raw, identical to `/enroll`.)
- Add it for **every** speaker (matched or not); Evenscribe only keeps the one whose `clinician_id` equals the encounter's clinician.
- Purely additive — existing consumers ignore the new key.

## Implementation sketch (server.py)
You already have, per speaker cluster, the ECAPA embedding used for the cosine match against `clinician_centroids`. Wherever the per-speaker `dict` that becomes `speakers[]` is built:

1. Keep a handle to that speaker's raw ECAPA vector (a `numpy` `float32` array of shape `(192,)`, **before** any L2-normalization used for comparison).
2. Serialize it exactly like `/enroll` does:
   ```python
   import base64, numpy as np
   def emb_b64(vec):  # vec: np.ndarray float32 (192,)
       return base64.b64encode(np.asarray(vec, dtype="<f4").tobytes()).decode("ascii")
   ```
3. Set `speaker["embedding_base64"] = emb_b64(raw_vec)` when building each speaker object.

(If the matcher computes embeddings on normalized vectors, capture the **pre-normalization** vector — match `/enroll`, which returns the raw embedding. If only a normalized copy is available, returning that is still usable but document it; raw is preferred for averaging.)

## Reload + verify
```bash
DOM=gui/$(id -u)
launchctl kickstart -k $DOM/uk.llmvinayminihome.eta-diarize
launchctl print $DOM/uk.llmvinayminihome.eta-diarize | grep -E "state =|pid ="

# real clip → confirm each speaker now carries embedding_base64 (~1024 chars)
curl -s https://diarize.llmvinayminihome.uk/diarize \
  -F audio=@/path/to/a/real/short.webm -F encounter_id=test_emb \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print([{k:(len(v) if k=='embedding_base64' else v) for k,v in s.items() if k in ('idx','type','confidence','embedding_base64')} for s in d['speakers']])"
```
Expect each speaker to show `embedding_base64` of length ~1024.

## After you've run it — what happens automatically
- On every encounter submit, if the doctor's speaker is matched with **confidence ≥ 0.82** (env `PASSIVE_VOICEPRINT_GATE`, default 0.82), Evenscribe inserts a **passive** `voice_sample` (the doctor's embedding + a reference to that encounter's recording) and re-averages the voiceprint. Matches below the gate are **retained but not averaged** (visible + downloadable in the admin "Voice samples" panel; deletable). One passive sample per encounter (deduped).
- Patient/attender voices are never stored as samples — only the **matched doctor's** embedding is kept, and the downloadable "audio" for a passive sample is the existing encounter recording (already in R2), not a fresh patient clip.
- No app deploy is needed; the hook is already live and waiting for the embedding.

## Tuning / rollback
- Make capture stricter/looser: set Vercel env `PASSIVE_VOICEPRINT_GATE` (default `0.82`).
- Rollback the Mini change: revert `server.py` (`cp` your backup) + `launchctl kickstart -k`. The app reverts to no-op automatically (no passive samples captured).

**Tell me the verify output (embedding_base64 length per speaker) and I'll confirm Sprint B is fully live + watch the first passive captures.**
