# ETA — room diarization to pyannote.ai. REFUTER VERDICT. 23 Sep 2026

`vinay/diarize-pyannoteai` **@ `328aaff`** (builder split-speaker), off production `95cf2c9`. Six files: `lib/diarize-engine.ts` and `lib/diarize-pyannoteai.ts` (new), tests, `.env.example`, `lib/stt/diarize-window.ts`, `lib/jobs/kinds/diarize-window.ts`. Own detached worktree `/tmp/refute-pyaai`, HEAD asserted; the builder's worktree never touched. **No pyannote.ai call made, no key read, no audio touched.** Production reads were read-only, counts only.

**Target: deploy before 21:25 IST tonight.**

## PASS-WITH-ONE-FIX on the code — plus TWO items that need V, not me, before the switch is thrown

The build is the most thorough I have reviewed today. Every point of the attack plan I sent ahead was addressed before the commit, 18 mutations written and 18 killed, and two gaps found and closed by the builder on their own first pass. What follows is what survives that.

### FIX — the provider's error body reaches our logs, and the submit body contains the signed URL

`lib/diarize-pyannoteai.ts:139`:

```ts
if (!res.ok) return { ok: false, status: res.status, detail: text.slice(0, 180) };
```

`detail` is **the provider's raw response body**, and it is logged at three sites (`:177` submit, `:199` poll, `:280` job record). The submit request is `POST /v1/diarize {url, model}` — **the body we send contains the presigned R2 URL**.

So a provider error that echoes the request — *"invalid url: https://r2…?X-Amz-Algorithm=…"*, an entirely ordinary 400 shape — puts a signed PHI-audio URL into our logs. At 180 characters the slice would very likely capture the host and **object key** (which identifies the recording) and probably truncate before the signature; "probably" depends on URL length, which is not guaranteed.

**Why the excellent test suite cannot reach this.** The test asserts `X-Amz-Signature` appears in no log line, and it passes — against the fake server, which does not echo the URL. **That test proves our code does not log the URL. It cannot prove the provider's body does not contain it**, and `detail` is precisely the channel through which provider text enters our logs. The risk lives in data we do not control, which is the one place a fake server cannot model.

**Fix, one line, covers all three sites:** scrub `https?://\S+` out of `detail` before logging. The status code and the error code carry the diagnostic value; the provider's prose does not.

### Verified rather than accepted — the rest of the attack plan holds

- **The key** is read at call time in one function and placed in the `Authorization` header only. No child process anywhere, so nothing reaches `argv` — I checked, it is `fetch` throughout. Every throw returns a code from a closed union, never a provider body.
- **The presigned URL**: 15 minutes, one object, GetObject only, through the existing `signGetUrl` rather than a second signer. The not-through-the-tunnel property is asserted **on the value** (`^https://r2\.`, and not the Mini's hosts), not on a comment.
- **The strict parser**: both halves, twelve typos each asserted to throw, including the boolean-ish `1`/`true`/`0`/`off`. The error message names the value's **length**, never the value. This is the third time today I have gone looking for an unpinned falsy half and the first time it was already there.
- **The label is derived**, and the wrinkle is real: `GET /v1/jobs/{id}` returns no `model` field, so the label is fetched from `/v2/jobs` and matched by id; absent → NULL, and the window still stores. The fake answers `precision-4-fake` while the build asks for `precision-3`, so a constant — *even the correct-looking one* — fails. That is the right way to build that test.
- **The fallback records the engine** in `timing_json.engine` on both engines, always.
- **Scope**: six files; `voice_centroid`, the encounter clock and the Mini's diarizer are untouched in code, and a test asserts the default path makes zero fetches and zero presigns.
- **The 4.5 MB question they asked me to confirm rather than take from them:** their reasoning is right — that limit is on request bodies **into** Vercel functions, not on responses we fetch outbound, and the audio no longer transits our function at all. Worth adding that the limit is now **100 MB** in any case, so it does not bind twice over.

## FOR V — two things the order did not settle, and both bear on the 21:25 decision

### 1. The cost is roughly €450–510 a month at today's volume, and the guard is inert

V accepted *"~EUR 0.11 per audio-hour"*. That is the unit price; the volume was never stated. From production, read-only:

| IST day | windows | audio-hours (at 900 s) | cost at €0.11/h |
|---|---|---|---|
| 23 Sep | 599 | 149.8 | **€16.47** |
| 22 Sep | 524 | 131.0 | €14.41 |
| 21 Sep | 618 | 154.5 | €17.00 |
| 20 Sep | 174 | 43.5 | €4.79 |
| 19 Sep | 96 | 24.0 | €2.64 |
| 18 Sep | 34 | 8.5 | €0.94 |

**≈ €15/day, ≈ €450–510/month — and the daily rate has grown roughly 18× in five days** as rooms came online. It scales linearly with the fleet.

**And there is no pre-call cost guard in effect.** split-speaker was right not to paper over the order's premise: the local path has no pre-call silence test to copy. The guard they built keys on the VAD gate, which they believe is off in production — my own 21 Sep post-deploy check found `DIARIZE_SPEECH_GATE` absent from the production env, which is a second independent indication, though **Fable holds the deploy platform and should confirm before the switch**. The only silence signal that exists otherwise is `state='no_speakers'`, which is **post-hoc** — you pay for the window to learn it — and it covers just **4.7%** (98 of 2,067).

### 2. Switching stops the supply of voice embeddings — the order says do not change voice_centroid, and this does not, in code

split-speaker flagged that pyannote.ai returns no embeddings, so every turn on a pyannote window is `no_match`, indistinguishable from a genuine miss, and named three readers that lose their input. **It reaches further than that, and this is the part I would put in front of V.**

Production, read-only: **95.1% of diarize windows (1,919 of 2,017) carry `embedding_base64` in `speakers_json`.** That is the source `build_centroid` reads — the raw material of the entire E-3 voiceprint programme, the one V spent a listening session on this morning and whose EER I re-verified at 17%.

**Every pyannote.ai window contributes nothing to it.** The order's *"do not change voice_centroid"* is honoured exactly in code and defeated in effect: the table is untouched and its input supply stops. `attribution: "voiceprint" | "none"` is the right marker and the builder is correct that it is a marker, not a fix.

So the trade V is actually choosing is: **better speaker separation tonight, against no new voiceprint material for as long as the switch is on** — plus `speaker-calibration` losing the embeddings that freeze `SPEAKER_MATCH_THRESHOLD`, and jev-role's acoustic half losing its input. That may well still be the right call; it is not the call the order describes, and it should be made knowing the E-3 cost.

## Credit, on four points

- **The media-upload decision was theirs and it is right.** They chose presigned R2 over pyannote.ai's media upload because `DELETE /v1/media/...` 404s on the live API — an upload leaves patient audio on a third party's storage with no endpoint to reclaim it. The order allowed either; that is a privacy argument made unprompted.
- **They corrected the order's premise** on the cost guard instead of inventing a rule to satisfy it, and said plainly that the net effect today is no guard at all.
- **Two mutations survived their first pass and they closed both** rather than reporting 18/18 from a clean sheet.
- **They verified the `model`-field absence against the live API** rather than trusting the docs.

**Disclosed, and immaterial:** one local `npx tsc --noEmit` while iterating, which the standing rule assigns to the Yoga. One process, not a suite; the authoritative typecheck is in the Yoga run.

## Gate

- **Mine:** static review plus production reads (counts only); no mutation run — the suite is 18/18 by the builder and my findings are in paths a mutation cannot reach.
- **The builder's:** Yoga gate running at the time of writing; **this verdict is on the code and must not deploy on a red gate.**

**Verdict: PASS-WITH-ONE-FIX on the code** — scrub URLs from `detail` before logging, which is one line. **The two items above are V's**, not mine, and I would not throw the switch tonight without a decision on the embeddings, because that one is invisible until the E-3 work next needs data and finds none.
