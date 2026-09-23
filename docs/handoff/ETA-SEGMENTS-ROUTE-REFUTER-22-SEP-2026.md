# ETA — diarize segments route (text-free speaker timings). REFUTER VERDICT. 22 Sep 2026

`vinay/segments-route` **@ `97544f2`** (builder lx), one commit on `248c2ae`: `lib/diarize-segments.ts`, `app/api/diarize-segments/route.ts`, the MCP tool `scribe_diarize_segments` in `lib/mcp/tools/voice.ts`, the test, and a docs note. Contract: `weekA-2140.md` §lx and plan §D. Own detached worktrees `/tmp/refute-seg` and `/tmp/refute-seg-mut`; builder's worktree never written to, nothing pushed. Production reads were read-only and returned **key names and counts only — no stored value from any segment or speaker was selected.**

## PASS — no text can leak; one provenance finding. (Mutations ran on 23 Sep once the runner was fixed — see the addendum: 12 of 15 killed.)

### No text, ever — verified three independent ways

1. **By reading.** Every output object is a literal with named fields; nothing is spread from a stored row. `shapeSegments` emits exactly `start_ms, end_ms, speaker_idx, speaker_label, source, overlap` (+ `confidence` where the speaker was matched); `shapeSpeakers` emits `speaker_idx, speaker_label, matched_clinician_id?, confidence?, total_speech_ms?`. The embedding, the stored label/type/name and the service's guess never pass. `speaker_label` is computed (`S0`, `S1`, …), never copied. `source` is regex-bound, `matched_clinician_id` is id-bound.
2. **Against what is actually stored** (counts of keys, never values). `encounter.transcript_segments` — despite its name — carries **only** `start_ms`, `end_ms`, `speaker_idx`, `overlap` across **2,284** stored segments; `room_diarize_window.segments_json` carries **only** `start_ms`, `end_ms`, `speaker_idx` across **149,449**. No text is at rest in either store today, so none is even fetched. The whitelist is the guard against a future writer that adds one.
3. **By the test, which has teeth.** `diarize-segments.test.ts` stuffs rows with `text`, `transcript`, `words`, `speaker_name`, `label`, `type`, `name`, `embedding_base64`, the service guess and a `diarize_timing.note`, all carrying `POISON_TEXT_MARKER`, then asserts **both** that no forbidden key appears anywhere in the recursively walked payload **and** that the serialised JSON does not contain the marker (`:99`). A key-name check alone could miss text smuggled under an allowed key; the value check closes that.

**Both ways in share the shaper.** The HTTP route requires the MCP bearer with `read` scope (403 otherwise; `no-store`); the MCP tool is `scope: "read"`, calls the same `lookupSegments`, and sets `additionalProperties: false`. No migration. Exactly one id, validated; the session read fetches `limit + 1` rows so `truncated` is a fact.

### FINDING — `source` reads a key no row has; the real provenance is ignored

The contract asks for `source` = the diarize **provider**. `sourceOf` returns `timing.provider` when present, else `"eta-diarize"`. Live, read-only:

| `room_diarize_window.timing_json` | rows |
|---|---|
| `provider` present | **0** of 1,393 |
| `producer` present (an object: `worker: "night-drain"`, `arch: "arm64"`, `platform`, `service_device: "mps"`, `worker_version`, host) | **859** |
| neither | 534 |

`encounter.diarize_timing` carries neither key. So every payload says `source: "eta-diarize"`, and the one field the writers **do** record — `producer`, with the worker and the architecture — is never read.

**Today the answer happens to be true:** every stored row came from the Mini's eta-diarize (859 via the night-drain worker, 534 via the app). **The failure scenario is the second producer.** On 19 Sep it was ruled that the Yoga is not a diarize producer precisely because arm64 and x86_64 diarizers disagree at speaker switches. This route is the doctor-ID feed: the consumer that most needs to know which diarizer produced a timing would be handed mixed timings under one label the day a second producer's rows are stored — unless that writer happens to use the key `provider`, which no writer uses. The comment ("a stored `provider` string … if a later writer adds one, is preferred") describes a key that does not exist while the existing writer records provenance under another. **Fix:** read `producer.worker` (and `arch`) when present; keep `"eta-diarize"` as the fallback for the 534 rows with neither.

### Noted

- **The route's error log prints `e.message`**, not `e.name` — the same pattern I flagged on `vinay/join-only-clips`; the sibling overnight driver logs the name only for this reason. Low; not a proven leak.
- **`matched_clinician_id` passes while the stored label is suppressed.** Intended — the contract's `confidence?` is a voiceprint-match confidence, so the match is meant to be exposed; the heuristic `label`/`type` (which reads like an attribution) is what is kept out.

### Gate

- Mini, run under the heavy lock **before Fable's 22:50 standing change**: `typecheck` 0; `Tests 1 failed | 3663 passed | 1 skipped (3665)`, 0 timeouts; the one failure is `e31b-atomicity R58`, the long-characterised flake in a PIN-limiter test this diff cannot reach. `build ✓ 16.1s`.
- Yoga (the sanctioned runner since 22:50), targeted: `diarize-segments.test.ts` — `RESULT ok`, 282 s wall, 10.5 GB peak.

### Mutations — NOT RUN, pending a ruling

Under the standing change no vitest runs on the Mini tonight, and `yoga-test.sh` tests only a worktree's **committed HEAD**, so an in-place mutation harness cannot run through it. Committing each mutation and running it on the Yoga costs **282 s per mutation** (the runner typechecks the whole repo even under `--files`) — about **70 minutes of the Yoga's serialised CI lock per branch**, blocking every other pane. I have not done that unilaterally. The harness (15 mutations, including the two that would matter most here: spreading the stored row into a segment, and into a speaker) is ready at `docs/handoff/scratch/ETA-SEGMENTS-ROUTE-REFUTER-mutate-22-SEP-2026.py.txt` and runs the moment Fable rules.

## Jev (V's standing rule) — after my read and rerun; neutral context

Task, source diff and neutral context; none of my findings. Scores **4.7–7.1**; one `medium`.

- **correctness 4.7, `medium`** ("requested behaviour appears missing or incomplete") → **CONFIRMED**, and it is the FINDING: the requested `source (diarize provider)` is a constant, reading a key that exists on no row. Jev named no specifics; the live key count and the 19 Sep architecture ruling are what make it a finding rather than a hunch.
- **documentation 5.8** ("a changed contract is not documented clearly") → **CONFIRMED**, same root: the comment names a `provider` key the writers do not use.
- **consistency 5.7** ("related parts follow inconsistent conventions") → **partly confirmed**: `e.message` in the error log where the sibling module logs `e.name`.
- **reliability 6.7** ("errors swallowed or distorted") → **REJECTED**: the route catches, logs and returns a closed `read_failed` with a 500; nothing is swallowed silently.
- **security 7.1** — its highest; consistent with what I verified three ways.

**Verdict: PASS.** The route cannot hand out text — by construction, against the stored data, and under a test that checks values as well as keys. The one finding is provenance: `source` is right today by coincidence and would be wrong the day a second diarizer is recorded. Mutations follow when Fable rules on the runner.

---

# Addendum — mutations, 23 Sep (runner fixed)

Run through `yoga-test.sh --mutate` once scribe3 fixed the relative-patch bug. **12 of 15 killed, 0 errors.** Everything the verdict relied on is pinned: **S1 and S2 — spreading the stored row into a segment or a speaker — both die**, which is the leak protection itself; so do the neutral label, the provider regex, the `read` scope, the bearer requirement, one-id, id shape, the limit clamp, the truncation fact, the end>start rule and the confidence-only-when-matched rule.

**Three survivors, one worth acting on:**

- **S10 — `AND deleted_at IS NULL` on the encounter read is untested.** Removing it leaves the suite green, so a **soft-deleted encounter's speaker timings would be served**. `deleted_at` appears nowhere in the test file. Live today: 105 encounters, **3 soft-deleted, none of them carrying segments** — so the present exposure is nil. But the ordinary sequence is diarize first, delete later, which would put segments behind a deleted encounter, and this clause is the only thing that withholds them. One test.
- **S14 — the id-shape check on `clinician_id` is untested.** Dropping the regex lets any stored string through as `matched_clinician_id`. Today the column holds ids; the guard is what keeps the route's "an id, never a name" promise if a future writer ever puts a name there — the same class as the text whitelist, and the whitelist's *value-shape* half is the untested half.
- **S12 — `segments_stale` treating null provenance as stale is untested.** A window whose stored segments carry no run id would be reported fresh. Misreporting only.

None of these changes the verdict: the route still cannot hand out text, which was the question asked. They are three one-line tests on guards that currently hold.
