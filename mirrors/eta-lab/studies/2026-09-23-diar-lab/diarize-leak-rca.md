# eta-diarize memory leak: root cause (22 Sep 2026)

Role: debugger. Nothing on :8001, its plist, its code or ~/overnight-translate was touched. All experiments ran on a
separate copy on :8011 (killed at the end), fed synthetic `say` speech (Samantha/Daniel, 380 s, looped to 30 min for
the long test). No patient audio. Scratch: ~/dev/_fable/scratch/dz/ (res-*.tsv = raw per-request samples).

## Root cause

It is not a Python-level leak. server.py loads every model once at startup, keeps no global caches, and releases each
request's tensors (`torch.mps.current_allocated_memory()` stays at 127 MB after every request, all runs). The growth is in
**Metal driver memory owned by torch's MPS backend**, and it is triggered by **input shapes changing between calls**:

1. **pyannote segmentation LSTM on MPS (main leak, unbounded).** `nn.LSTM` on MPS leaks driver memory every time
   its input batch shape changes, and `torch.mps.empty_cache()` does not give it back. pyannote's `Inference.slide`
   feeds the segmentation model batches of 32 chunks, then a partial batch, then a 1-chunk orphan, and it does so
   twice per request (diarization + OSD). So every request changes shape about 6 times.
   - Microtest, bare LSTM (4-layer biLSTM, 32/7 batch alternating): driver 9 MB -> 12.7 GB after 10 forwards ->
     32 GB after 40. Same LSTM, fixed batch 32: flat at 2.5 GB. Conv1d, alternating: flat at 11 MB.
   - pyannote segmentation, random 180-300 s audio: 0.57 -> 7.85 GB footprint over 12 calls. Same thing with batches
     padded to 32: flat at 2.64 GB (2.63 -> 2.66).
2. **Embedding ResNet on MPS (bounded but large).** The MPS allocator keeps one pool per new embedding batch size (the
   last partial batch of each request). Random batch sizes: 1.8 -> 6.8 GB over 12 calls, in steps. Fixed 32: flat at
   3.07 GB.
3. **ECAPA (speechbrain) on MPS (small, unbounded).** Each new input length (the longest segment for each cluster)
   leaves about 50 MB of footprint behind, while driver memory stays flat, so this is probably the CPU-side MPSGraph
   cache. 40 random-length calls: 1.52 -> 3.58 GB. Same calls at a fixed length: flat at 1.67 GB. Same calls on CPU:
   about 1.3-1.4 GB with no trend, and faster (2.6 s vs 11.5 s for 40 calls).

Why it scales with traffic: every request has a different audio length, so every request brings new shapes. With the
same file sent repeatedly (fixed shapes) the base server levels off at about 7.9 GB after 3 requests (res-basefixed).
More windows per hour means more shape changes, which is why the leak sped up after translation moved off ollama.

## Evidence (top MEM = phys_footprint, :8011, 180-300 s clips of varying length, serial requests)

| variant | start -> after N requests | per-request trend | req latency |
|---|---|---|---|
| base (as deployed) | 1.7 GB -> 15 GB after 12 | about +1.1 GB/request, no plateau | 11-19 s (first 33 s) |
| + gc.collect() | 1.7 -> 14 GB after 8 | same | 12-18 s |
| + gc + torch.mps.empty_cache() | 1.7 -> 10-11 GB, then **MPS OOM at request 11** ("other allocations: 28.73 GB, max allowed: 30.19 GB") | driver memory grows about 2.4 GB/request | 9-32 s |
| DEVICE=cpu (all models) | 0.6 -> 1.2 / 4.1 / 1.8 GB | bounded | **207-258 s (about 15x slower)**, rejected |
| segmentation on CPU only | 1.7 -> 8.8 GB after 11 | about +0.6 GB/request (embedding steps) | 33-86 s (3-4x slower) |
| pad segmentation only | 5.7 -> 10 GB after 12 | steps from embedding shapes | 8-19 s |
| pad seg + gc + empty_cache | footprint 4.6 -> 5-7 GB, but driver_allocated 3.9 -> 25 GB after 13 (heading for the 30 GB OOM wall) | not safe | 9-25 s |
| **FIX: pad segmentation + pad embedding + ECAPA on CPU** | **5.51 GB -> 5.43 GB after 30 requests** (range 5.17-5.58), driver memory constant at 4.96 GB | **about 0 MB/request** | **8-25 s (same as base)** |
| FIX, exact proposed server_fixed.py, 6 windows of 1500-1800 s | 5.51 GB, then 5.33 / 5.34 / 5.60 / 5.34 / 5.37 / 5.32 GB | flat | 72-96 s per 25-30 min window |

Outputs are unchanged: on the same 240 s clip, the fixed server and the base server return identical transcript_segments
(30/30, 0 ms boundary difference), identical overlap_windows, identical speakers/labels/aggregates, and ECAPA embedding
cosine 1.00000 (CPU vs MPS). That was checked for fixall-first, fixall-last (after 30 requests) and fixed-first.

torch upgrade checked: in a scratch venv (torch/torchaudio 2.5.1, same pyannote 3.3.2), the segmentation, embedding and
ECAPA growth curves were **identical** to 2.2.2 (seg 0.59 -> 7.86 GB, emb 1.9 -> 7.1 GB, ecapa +45 MB/call). Upgrading to
2.5.1 does not fix it. Newer versions (2.6+) were not tested.

Environment: torch 2.2.2, torchaudio 2.2.2, pyannote.audio 3.3.2, speechbrain 1.0.0, Python 3.11.15, DEVICE=mps.
PYTORCH_ENABLE_MPS_FALLBACK=1 is set. PYTORCH_MPS_HIGH_WATERMARK_RATIO is **not** set (default cap about 30.2 GB on this
box). That cap is why the leak shows up as swap and memory pressure first and would only become an MPS OOM near 30 GB.

## Proposed minimal fix (not applied)

Diff: ~/dev/_fable/scratch/diarize-leak-fix.diff (full patched file: ~/dev/_fable/scratch/dz/server_fixed.py; it compiles
and was run as-is on :8011).

1. ECAPA `run_opts={"device": "cpu"}` (1 line).
2. After model load, two small wrappers pad every MPS batch up to its fixed size and slice the padding off:
   `pyannote.audio.core.inference.Inference.infer` pads to `self.batch_size` (32), which covers the diarization and
   OSD segmentation LSTMs. `PyannoteAudioPretrainedSpeakerEmbedding.__call__` pads to `diarize_pipeline.embedding_batch_size`
   (32), with zero waveforms and ones masks. Both are no-ops off MPS or for full batches.

Do NOT add per-request `torch.mps.empty_cache()`. On torch 2.2.2 it makes driver-accounted memory climb faster and
led to an MPS OOM at request 11 (gcempty run).

## Risks

- Monkeypatches pyannote internals (`Inference.infer`, `PyannoteAudioPretrainedSpeakerEmbedding.__call__`). They are tied
  to pyannote.audio 3.3.2 signatures, so re-verify after any pyannote upgrade. The module-level patch also affects any
  other pyannote Inference in the process (there are none today besides diarization and OSD).
- A small amount of extra compute: the last partial and orphan batches run as 32 chunks. The measured latency did not
  change (8-16 s vs 11-19 s base on 4-5 min clips).
- Steady-state footprint is about 5.3-5.6 GB, which is **right at the guard's 6 GB threshold**. Raise the guard's
  threshold to about 9-10 GB when this ships, or it will keep restarting a healthy service. That is a change to
  ~/overnight-translate, which this RCA did not touch.
- ECAPA on CPU changes /enroll's device too. The embeddings matched MPS at cosine 1.00000 on the test clip, but existing
  enrolled centroids were made on MPS. Expect only float-level differences.
- Tested with synthetic two-voice TTS, not real clinic audio. Real windows produce more clusters and more ECAPA calls,
  but ECAPA is now on CPU, so there are no MPS shapes left that vary per request. Watch top MEM for the first night.
- Not covered: audio shorter than one 10 s chunk still goes through the padded path (a batch of 1 padded to 32). That
  works, but it was not exercised separately.

Cleanup: :8011 killed at 13:08 and no experiment processes are left. :8001 was never touched. Its PID changed during the session (99338 -> 26337) because diarize-guard restarted it, not this work.
