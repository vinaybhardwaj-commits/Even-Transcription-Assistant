# Diarization timing probe — 22 August 2026

**Verdict: H1**, and the failure that motivated this measurement **does not reproduce**.

Measured against production `44eb222`, service reached via `DIARIZE_BASE_URL`, on real room
audio from `bs_j4c2yekh` (Home Office, 22 Aug). Probe ran while an overnight recording
(`bs_g3dwud4p`) was live on the same Mac Mini — see the load caveat below.

No code was changed and no code is committed. `DIARIZE_TIMEOUT_MS` was raised **by environment
only** for the probe process (`lib/diarize.ts` still reads a 90 000 default, untouched).

---

## The headline, before the numbers

The premise of this measurement was that Ankit Bhojani's six complete encounters all showed
`diarize_status: failed` with `timeout_90000ms`. **They do not, today.** Read from the admin
API on 22 Aug:

| encounter | duration | diarize_status | error |
|---|---|---|---|
| `enc_su3fhbqg8j` | 171 s | complete | — |
| `enc_bn5ttmn7qm` | **482 s** | **complete** | — |
| `enc_3acaggx727` | 139 s | complete | — |
| `enc_qvzyd6kkkc` | 153 s | complete | — |
| `enc_38tffdgvd2` | 174 s | complete | — |
| `enc_7kszcrtwzc` | 288 s | **failed** | `timeout_90000ms` |

**Five of six succeeded, and the LONGEST one succeeded.** The single failure is a 288 s file,
shorter than the 482 s file that completed. Length is therefore not the discriminator, which
rules out "too slow at this length" on the historical data as well as on today's.

All six were recorded on **1 June 2026**, spread from 11:36 to 12:33 — 6 to 16 minutes apart,
so they were not queued behind one another either. The service has since had at least one
relevant fix (the launchd `PATH`/ffmpeg bug found and fixed in Phase 9, per the handover).

---

## The measurements

Serial, never overlapping. Wall time is measured around the real `runDiarize`;
`service_latency_ms` is the service's own reported figure, so wall − service is transfer plus
HTTP.

| probe | audio | wall | service `latency_ms` | wall RTF | speakers | outcome |
|---|---|---|---|---|---|---|
| **P1** (cold) | 90.06 s | 17 797 ms | 16 264 ms | 0.198 | 3 | completed |
| **P1b** (warm, same clip) | 90.06 s | **5 753 ms** | 4 328 ms | **0.064** | 3 | completed |
| **P2** | 299.88 s | 17 613 ms | 14 848 ms | **0.059** | 2 | completed |
| **P3** | 899.81 s | 58 367 ms | 41 915 ms | **0.065** | 5 | completed |

Every probe completed. Nothing timed out, at any length, including 15 minutes.

Model versions returned on every call: `pyannote/speaker-diarization-3.1`,
`pyannote/segmentation-3.0`, `speechbrain/spkrec-ecapa-voxceleb`.

---

## Q1 — Does wall time scale with audio length? **Yes, linearly.**

Warm service time per audio-second is flat across a 10× range:

```
  90.06 s ->  4 328 ms    48.1 ms per audio-second
 299.88 s -> 14 848 ms    49.5 ms per audio-second
 899.81 s -> 41 915 ms    46.6 ms per audio-second

 linear fit:  service_ms = 46.42 x seconds + 148
```

**The intercept is 148 ms.** That is the fixed per-call cost when the service is warm, and it
is negligible — three orders of magnitude below the per-call work on any clip we care about.

This is the answer that decides the build. P1b (90 s) takes 5.8 s while P2 (300 s) takes
17.6 s — a 3.3× difference for a 3.3× longer clip. If the bottleneck were fixed overhead, those
two would be close together. They are not.

**H2 is refuted.**

## Q2 — Is the model held warm between calls? **Yes. The cold cost is a one-off.**

P1 17 797 ms → P1b 5 753 ms on the identical clip, back to back: **Δ 12 044 ms**.

That 12 s is model load, paid once after an idle period or a restart, not per request. It is at
the low end of the handover's "cold start adds ~20–30 s" (§8), consistent with the service
having been touched recently by other traffic. The handover independently states the design:
*"models load once into memory (pyannote + OSD + ECAPA)"*.

Note the practical consequence: **the first call after an idle spell pays ~12–30 s.** Any
timeout must clear that on top of the real work, and a caller that sees one slow call followed
by fast ones is seeing warm-up, not degradation.

## Q3 — Is the GPU actually engaged? **I could not observe it, and I am not going to infer it.**

I have no shell on the Mac Mini and no metrics endpoint beyond `/health`, which reports
`device: "mps"` — a configured string, exactly the thing the question says not to trust. I did
not observe GPU utilisation, power, or per-op placement. **H3 is neither confirmed nor ruled
out by this probe.**

Two things worth recording rather than concluding from:

- The handover (§"The MPS gotcha") documents that `PYTORCH_ENABLE_MPS_FALLBACK=1` is
  **required**, because SpeechBrain's ECAPA front-end uses `torch.stft` → `aten::_fft_r2c`,
  which torch 2.2.2 has not implemented for MPS. So **part of the pipeline runs on CPU by
  design**, silently. A partial fallback is the expected state here, not a fault.
- 46 ms per audio-second for pyannote-3.1 plus OSD plus ECAPA is fast enough to be consistent
  with GPU acceleration, but I am not treating that as evidence. Publishable proof needs
  `powermetrics --samplers gpu_power` or `asitop` on the Mini during a call.

**To settle Q3, someone with shell on the Mini should run one 15-minute diarize while watching
GPU power.** That is a five-minute job and it is the only thing that will answer it.

## Q4 — Real-time factor and recommended timeout

**Warm wall RTF ≈ 0.065** (includes upload over the tunnel). Service-side compute alone is
≈ 0.047.

For the 403 s case the question names, the fit predicts **≈ 18.9 s of service time**, or roughly
**26 s of wall time** once transfer is included — against a 90 000 ms timeout. There is no
length in normal clinic use that comes close to the current limit when the service is warm and
uncontended.

Transfer is not free and grows with the file: wall − service was 1.5 s at 1.45 MB, 2.8 s at
4.8 MB, and **16.5 s at 14.5 MB** (≈ 1.1 s/MB over the tunnel). For a 15-minute window, transfer
is 28% of the wall time.

> ### Recommended `DIARIZE_TIMEOUT_MS = 300000` (5 minutes)
> **Measured under load (M0a).** This must be re-measured on a quiet machine before it is
> committed anywhere.
>
> The reasoning, since the number should not be a guess: worst realistic call is a 15-minute
> window (58 s observed) + a cold start (12–30 s) + transfer headroom, and then roughly 3×
> margin for contention with whisper/IndicConformer on the same Mini. 300 s gives ~5× headroom
> on the observed 15-minute figure and ~11× on a 403 s encounter. Raising it costs nothing when
> calls succeed — the timeout only binds on failure — and the current 90 s is tight enough that
> a single cold start plus a busy Mini can breach it, which is the most likely explanation for
> the one historical failure.

## Q5 — Concurrency: **it serialises.** (From the docs, not tested — correctly.)

I did not load-test the service; a recording was running. The handover is explicit
(§"Known issues", line 250):

> *"Service is single-process / single-worker. uvicorn with one worker; models load once into
> memory (pyannote + OSD + ECAPA). Concurrent requests are serialized through the GIL + MPS.
> Fine for a demonstrator; not load-tested."*

**Implications for a later queue design:**

1. Concurrency on the caller side buys nothing and actively hurts. Two 15-minute windows sent
   together finish no sooner than sent one after the other, but **each sees the other's time
   added to its own timeout budget** — the second call's clock starts when it is sent, not when
   it begins executing. That is how a 90 s timeout gets breached by work that only takes 26 s.
2. The queue must therefore be **on our side, with a depth of one**, and the timeout must cover
   queue wait + execution, or the queue must not start the clock until the call is dispatched.
   The latter is much better.
3. The Mini also serves whisper, IndicConformer and Pyannote. Serialisation is across the
   *machine's* GPU, not just this service.

## Q6 — Thermals: **no evidence of throttling, and P3 is not disproportionately slow.**

P3's RTF (0.065) sits *between* P1b (0.064) and P2 (0.059) — it is not an outlier, and 15
minutes of continuous MPS work produced no measurable slowdown. Per-audio-second cost actually
*fell* slightly at 900 s (46.6 vs 49.5 ms), which is the opposite of throttling.

**What would distinguish throttling from H4** if it ever appears: run P3 four or five times
back to back and watch whether RTF climbs monotonically with each repeat (throttling) or stays
flat (genuine hardware limit). Confirm with `pmset -g thermlog` or `powermetrics --samplers
smc` on the Mini during the run. A single P3 cannot tell them apart, and this one did not need
to, because neither showed up.

---

## Verdict

**H1 — the timeout was too short for the conditions, and the service scales linearly.**

- **Not H2.** Fixed per-call cost when warm is **148 ms**. Overhead is a one-off ~12 s model
  load, not a per-request tax.
- **Not H4.** 15 minutes of real room audio diarized in **58 s** while a recording ran on the
  same machine.
- **H3 unresolved and untested** — see Q3. It needs someone with shell on the Mini.

### Sub-window diarization: **do not build it for performance.**

The cause is H1, so sub-windows would *work* — but they buy nothing and cost something:

- A 15-minute window already completes in 58 s, against a proposed 300 s timeout. There is no
  performance problem left to solve at this length.
- The service **serialises** (Q5), so ten pieces run one after another. The compute is linear,
  so the total is the same **plus** ten lots of transfer setup, ten HTTP round trips, and the
  stitching logic.
- Speaker clusters would then have to be stitched across pieces, which is a real accuracy risk:
  pyannote assigns cluster labels *per call*, so "speaker 1" in piece 3 has no relation to
  "speaker 1" in piece 4. Stitching them needs ECAPA centroid matching across boundaries — new
  machinery, new failure modes, in exchange for a speed problem that is not there.

**What to do instead:** raise the timeout, make the caller queue depth-1 and start the timeout
clock at dispatch rather than at enqueue, and re-run `enc_7kszcrtwzc` to confirm it now
succeeds. That is a configuration change and a small scheduling change, not a build.

If sub-windows are wanted for a *different* reason — incremental results during a long room
day, or bounding peak memory — that is a legitimate argument, but it is not this one, and it
should be made on its own terms.

---

## M0b — the tape, sampled throughout

Session `bs_g3dwud4p` (Home Office), started 16:00:33Z. **No stall, no gap, no stale listener at
any point.** The tape was never disturbed.

| sample | time (UTC) | chunks | backup | gap_ms | status | listener | age |
|---|---|---|---|---|---|---|---|
| S0 baseline | 16:05:14 | 0 | 0 | 0 | recording | true | 1 581 ms |
| S1 pre-setup | 16:05:51 | 1 | 1 | 0 | recording | true | 44 ms |
| S2 clips built | 16:06:33 | 1 | 1 | 0 | recording | true | 1 606 ms |
| S3 pre-P1 | 16:07:21 | 1 | 1 | 0 | recording | true | 1 357 ms |
| S4 post-P1 | 16:07:49 | 1 | 1 | 0 | recording | true | 1 109 ms |
| S5 post-P1b | 16:07:56 | 1 | 1 | 0 | recording | true | 1 320 ms |
| S6 post-P2 | 16:08:26 | 1 | 1 | 0 | recording | true | 151 ms |
| S7 post-P3 | 16:09:35 | 1 | 1 | 0 | recording | true | 432 ms |
| S8 final | 16:11:31 | 2 | 2 | 3 | recording | true | 1 772 ms |
| S9 closing | 16:12:55 | 2 | 2 | 3 | recording | true | 387 ms |

Chunk 0 landed at ~16:05:33 and chunk 1 at ~16:10:33 — both on the 5-minute rotation, to the
second. The 3 ms `gap_ms` at S8 is the normal 1–4 ms accrued at a rotation boundary, the same
figure every healthy session shows.

## Method notes

- Audio: primary chunks 0/1/2 of `bs_j4c2yekh`, fetched by presigned GET from the session
  manifest. **Backup-lane chunks were not used** — they carry near-silence (≈40 KB against
  ≈2.76 MB for the same span) and would have measured nothing.
- Clips built locally with `ffmpeg -c copy` (no re-encode): 90.06 s, 299.88 s, 899.81 s, all
  Opus 48 kHz mono. The Cloudflare join service was deliberately not used.
- Probe called the real `runDiarize` from `lib/diarize.ts`, so this measures the production
  client path rather than a re-implementation of it.
- `DIARIZE_TIMEOUT_MS=1200000` was set **in the probe process environment only**.

## Caveats

1. **Every absolute timing here is an upper bound** (M0a). A recording was running on the same
   Mac Mini throughout, and that machine also hosts whisper and IndicConformer. The **ratio**
   answers — Q1 linearity, Q2 warm-versus-cold, Q6 no-throttling — are robust to a constant
   background load and stand as stated. **The RTF and the recommended timeout are not**, and
   both need re-measuring on a quiet machine before any number is committed.
2. **One sample per length.** No variance, no confidence interval. The linearity is clean
   enough across a 10× range to carry the H1/H2 decision, but a production timeout should rest
   on repeats.
3. **Q3 is unanswered**, not answered negatively.
4. The probe used **room audio** (Home Office, conference mic). Ankit's failures were
   **doctor-app encounters** — a different microphone, a different acoustic scene, possibly a
   different speaker count. Diarization cost is not obviously content-dependent, but this probe
   did not test that, and the one historical failure was on that other kind of audio.
