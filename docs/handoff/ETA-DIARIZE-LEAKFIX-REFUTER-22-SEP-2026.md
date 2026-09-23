# ETA — diarize leak fix. REFUTER VERDICT (post-hoc). 22 Sep 2026

`~/eta-diarize/server.py` (live since 13:11 IST, deployed without review) against `server.py.bak-20260922-leakfix`. The live file is **byte-identical** to the RCA's tested `~/dev/_fable/scratch/dz/server_fixed.py`. Environment: pyannote.audio 3.3.2, torch 2.2.2, speechbrain 1.0.0, all **pinned** in `requirements.txt`.

Tests ran on **:8012 only**, one instance at a time, from copies in `/tmp/refute-dz`, on **synthetic two-voice `say` TTS** — no patient audio. Production `:8001` was never touched: pid **32510** before and after, no guard restart.

## PASS

The fix does what it claims on all five checks, and production has now confirmed it on real audio. Two hardening items below; neither is a defect in the deployed behaviour.

### Pre-flight hazard, avoided — worth knowing for anyone who tests this service

`diarize-guard.mjs` finds its target with `pgrep -f "eta-diarize/.venv/bin/uvicorn"` and takes the **first** match, then runs `launchctl kickstart -k` on **production**. A second instance started with that `uvicorn` script would match the pattern; if its PID sorted first, the guard would read the test instance's memory and restart production. The **old** code climbs about 1.1 GB per request and would pass the guard's 10 GB threshold within ten requests. I launched with `.venv/bin/python -m uvicorn`, which does not contain the pattern, and checked on every start: the pattern matched **only 32510**.

### (a) Padding and unpadding — CORRECT, by reading and by output

Read against the installed pyannote 3.3.2 source:

- `Inference.infer(chunks)` moves the batch to the device, runs the model, applies the per-row conversion and returns a numpy array or a tuple of them. The wrapper pads on the input's own device with `new_zeros`, then slices `[:n]` on each output (tuple-aware). The models run in eval mode, and the conversion is per-row, so there is no cross-row interaction; padded rows cannot change real ones.
- `PyannoteAudioPretrainedSpeakerEmbedding.__call__(waveforms, masks)` returns `embeddings.cpu().numpy()`. The wrapper pads waveforms with zeros and masks with ones — full-length masks, so no too-short or NaN path for the padding — and slices `[:n]`. `masks=None` is passed through unpadded.
- Both are no-ops off MPS and for batches at or above the fixed size.

Clip lengths were chosen to hit every batch shape. Segmentation uses a 10 s window and a 1 s step:

| clip | segmentation batches | old vs new |
|---|---|---|
| 5 s | trailing chunk only → **batch of 1** | identical |
| 10.5 s | 1 chunk + trailing → **two batches of 1** | identical |
| 41 s | exactly **32** → full batch, wrapper is a no-op | identical |
| 42 s | 32 + **1** | identical |
| 73 s | exactly 2 × 32 | identical |
| 180 s | 5 × 32 + **partial 11** | identical |

**Identical** means `transcript_segments` equal to the millisecond, `overlap_windows` and `aggregates` equal, and speaker metadata equal (count, labels, first-heard, total speech), on all six clips.

### (b) Output identical, old vs new — CONFIRMED

The same six clips through the old code and the new code on :8012: identical on every field above. Latency is unchanged (0.7–9.0 s old, 0.7–8.6 s new, on these clips).

### (c) CPU ECAPA compatible with the stored MPS-made voiceprints — CONFIRMED, quantified

`/enroll` embeddings and every `/diarize` per-speaker embedding, old (ECAPA on MPS) against new (ECAPA on CPU), same clip — 16 vector pairs, dimension 192:

- **not** bit-identical (0 of 16); largest component difference **5.5 × 10⁻⁵**;
- **1 − cosine ≤ 3.5 × 10⁻¹³** on every pair.

The room match threshold is 0.65 and real print scores sit between about 0.4 and 0.94, so this difference is about twelve orders of magnitude below any decision. Existing centroids need no re-enrolment.

### (d) Memory stays flat — CONFIRMED, synthetic and in production

**Synthetic, :8012, 20 requests of random length (69–288 s):** 5.06 → 5.46 GB over the first two, then **5.495–5.513 GB from request 3 to 20**. For contrast, the old code went **1.74 → 7.15 GB in six requests**.

**Production, real clinic audio** (the case the RCA flagged as untested — more clusters, more ECAPA calls): since the 13:11 deploy, **one process (pid 32510) for 6 h 20 min, 121 `/diarize` requests, 77 guard samples, median 5.29 GB, max 6.13 GB, zero restarts.** Before the fix the same service reached 11 GB within 37 minutes of a restart and 34 GB overnight. The guard's live threshold is 10 GB, so the RCA's warning about the old 6 GB threshold was acted on.

### (e) What breaks on a pyannote upgrade

`requirements.txt` pins `pyannote.audio==3.3.2` and `torch==2.2.2`, so an upgrade is a deliberate act, not an accident. What it would break, loudest first:

1. **Loud, safe.** A renamed or moved `Inference` or `PyannoteAudioPretrainedSpeakerEmbedding` → `ImportError` at startup → the service does not come up. A changed `infer` or `__call__` signature → `TypeError` on the first request.
2. **Silent, dangerous — the patch becomes a no-op and the leak returns:**
   - `slide()` stops routing through `Inference.infer`;
   - **embedding dispatch order.** The pipeline's embedding id contains both `pyannote` and `wespeaker`. It reaches the patched class only because `PretrainedSpeakerEmbedding` tests `"pyannote" in embedding` *before* `"wespeaker" in embedding`. Reorder that, or name the model without the `pyannote/` prefix, and it routes to `ONNXWeSpeakerPretrainedSpeakerEmbedding` — unpatched. The flat memory in (d) is the empirical proof it currently lands on the patched class;
   - `infer` returning something other than a numpy array or tuple (for example a dict) would break the `[:n]` slice.
3. **Latent today.** The patch is **class-level**. `Inference.infer` is also called with `waveform[None]` on the `window="whole"` and `crop` paths, where that single row is the **entire file**; under the patch it would be padded to 32 copies of the whole recording. `server.py` creates no such `Inference` today, so it is unreachable — but any future whole-window use in this process would hit it.

**Nothing detects the silent cases.** The only signal would be memory creeping back until the guard fires at 10 GB, hours later.

## Hardening recommended (not defects)

1. **A startup self-check.** After patching, assert that `diarize_pipeline._embedding` is an instance of `_PyaEmbedding`, and log one line saying the fixed-shape patch is active. This turns silent case 2 into a loud one.
2. **A regression test.** The service has **none**; the fix was verified only by running it. One test that pads a synthetic partial batch and a batch of 1, and asserts `[:n]` equals the unpadded output, would pin (a) and catch an upgrade that changes the return shape.
3. Scope the `infer` wrapper to sliding-window calls, or skip it when `self.window == "whole"`, to close the latent hazard.

## Jev — on the diff and installed pyannote excerpts

Scores 3.5–6.4.

- **testQuality 3.5 (lowest, medium)** — **confirmed**: there is no test, and it is the root of why the silent upgrade failures in (e) would go unnoticed. Recommendations 1 and 2.
- **observability 5.3** — **confirmed**, same point: a no-op patch would be invisible.
- **compatibility 5.9** ("assumes a version not established") — **confirmed**: that is (e); pinned, so deliberate.
- **coupling 5.5** ("a global dependency") — consistent with the class-level patch and the whole-window hazard, but **not independent**: I annotated those whole-window callers in the excerpt I sent.
- **documentation 5.0** — **partly rejected**: the code comments explain the mechanism well; what is missing is a note next to the pin saying "re-verify the leak patch before changing this".
- **reliability 5.7** ("a race or concurrency assumption") — **rejected**: the patch is applied once at import, before the app serves any request.

## Evidence

`/tmp/refute-dz/out_server_old.json` and `out_server_new.json` (response shapes and embeddings from synthetic clips only), `run.py` (the harness), and the production series from `~/overnight-translate/diarize-guard.log`. Nothing is left running; :8012 is free.
