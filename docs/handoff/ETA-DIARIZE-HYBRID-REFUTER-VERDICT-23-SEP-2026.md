# ETA — diarize hybrid (pyannote.ai teacher + our embeddings). REFUTER VERDICT. 23 Sep 2026

`vinay/diarize-pyannoteai` **@ `286db74`** (builder split-speaker), three commits on production: `f88d53c` (the switch), `b1b8ed4` (my URL-scrub fix), `286db74` (the hybrid + teacher labels + level gate). Order: `~/dev/_fable/orders/PYANNOTEAI-SWITCH.md` plus Fable's 14:20 rulings. Own detached worktree `/tmp/refute-hyb`, HEAD asserted before every run, clean after every one. No database touched, no migration applied, no provider called.

**Mutations: 13 applied, 11 killed, 2 survived, 0 runner errors.** Baseline verified green pristine (54/54 and 91/91) before any survivor was believed. Two mutations were **void** — my sed matched nothing and the run was merely the baseline again — caught and redone under an applied-assertion; they are not counted above and neither is reported as a result.

## PASS-WITH-FIXES — two survivors, and they are the same mistake in two places

### My round-1 finding is CLOSED

**N1 dies.** Reverting `:139` to the original `detail: text.slice(0, 180)` fails a test. The scrub is applied **once, where `detail` is built**, not at the three sites that log it, and the comment gives the reason: *"a scrub that must be remembered at every site is a scrub that will be missed at the fourth."* That is the right placement, not merely a fix. **N2** (drop the bare `X-Amz-` fallback) and **N3** (drop the `https?://` form) both die, so both halves are pinned. The strongest test is `:592`, which asserts over **every captured log line** that the presigned URL and its signature appear in none — a property, not an example. The other return paths (`:144`, `:146`, `:152`) carry fixed strings, and notably `:152` returns `"timeout"`/`"network"` rather than the caught error, so a Node fetch error cannot carry the host into a log either.

### What else is genuinely pinned

| mutation | result |
|---|---|
| **M2** pyannoteai arm always claims `voiceprint` | **killed, 3 tests** |
| **M3** label conflict key → `(window_id)` alone | **killed** |
| **M4** `DO NOTHING` → `DO UPDATE SET model` | **killed** — teacher labels cannot be overwritten |
| **L2** `no_samples` read as silence | **killed** |
| **L3** `thin_coverage` read as silence | **killed** |
| **G1/G2/G3** fallback bookkeeping: block, reason, count | **killed** (4, 3 and 2 tests) |

Verified in the source rather than taken from the builder's account:

- **`server.py` is additive, and more strongly than claimed.** Backup is exactly 419 lines, live 568, `diff` of 1–419 empty. The appended block defines only `_embed_speakers_blocking` and the `@app.post("/embed_speakers")` route at module level — **no eager model load, no globals, no import-time work** — so Fable's 21:15 restart changes nothing for `/diarize`'s process.
- **The embedder is the same instance, which is better than "the same model".** The endpoint calls `_embedding_for_window` (`:477`), the identical helper `/diarize` uses (`:211`), over the module-level `ecapa`. That helper deliberately returns the **un-normalized** vector so embeddings stay byte-identical to `/enroll` for centroid *averaging*, while `_cosine` normalizes at match time. A correct reimplementation would have matched fine and averaged wrong. Reusing the helper is what makes "centroids stay comparable" true rather than intended.
- **The index trap is avoided.** `embs`, `total_sec` and the returned `row["idx"]` are all on the **caller's** numbering; only the match *order* follows speech time. Decoupled as claimed.
- **0117 is append-only**: no UPDATE/DELETE/DROP/TRUNCATE, `schema_migrations` insert present. The conflict key `(window_id, engine, run_id)` matches a real UNIQUE constraint and is well chosen — a replayed step is idempotent, a new `run_id` still accumulates, and local and teacher coexist per window, which is exactly what the teacher plan needs.

### FINDING 1 — the local arm's identity is claimed by construction (blocks merge, per Fable)

**M1 survives**: `engineProvenance` `:452`, `attribution: name === "local" ? "voiceprint" : "none"` → `"none"`, and **91/91 still pass**. The control **M2** on the pyannoteai arm kills 3 tests, so the suite sees this field sharply — M1 is a real gap, not a dead suite.

The branch's own header states the rule: *"IDENTITY MUST BE EARNED — `attribution: "voiceprint"` may only appear when embeddings really came back."* `attribution` is **new in this branch** (0 occurrences at the merge-base), so the local arm's label is this branch's claim too, not inherited. Three tests pin the new arm; none pins the old one.

Whether it is *wrong* for local is a semantics question I do not rule on: `/diarize` runs its own matcher, so "a comparison happened" is fair — **except when the `voice_print JOIN clinician` query returns no rows** for that room/day. Then nothing was compared and the row still reads `voiceprint`, which is precisely the "nobody matched" vs "nobody was compared" conflation the builder correctly closed on their own arm. At minimum unpinned; at most the same bug one arm over.

### FINDING 2 — the level gate's fail-safe is pinned inside the gate and not at the call site

**L1 survives**: `lib/jobs/kinds/diarize-window.ts:201`, `if (level.verdict === "silent")` → `if (level.verdict !== "has_sound")`, and **91/91 still pass**. Nothing pins the one line that decides whether `unknown` costs money or costs data.

The gate module itself is well built and well tested — `has_sound` is checked **before** the coverage gate so one loud bucket spares the window whatever the coverage; `active` is counted before the coverage test so the verdict reports what was seen; the floor is the shared `DEFAULT_ROOM_ENERGY_FLOOR`; and the boundary test at `:283` (`floor` vs `floor - 1e-9`) is exactly right. L2 and L3 confirm `unknown` is pinned **as a return value**.

**Why the existing tests give false comfort.** Two tests read as covering this — `:307` *"a room_day it cannot read NEVER skips — the gate fails safe"* and `:322` *"a room_day row that is missing also never skips"*. They do not reach the verdict comparison: the block is guarded by `if (rd)`, and when `resolveRoomDay` fails or the row is missing, `rd` is null and **the gate is never called**. So they pin the *resolution* failure while sounding like they pin the gate's fail-safe behaviour generally. The *judgement* failure — `verdict: "unknown"` — has no test at all.

**The consequence is the direction of the failure.** `!== "has_sound"` is precisely the shape a cost-tightening edit takes, and it reads as *more* careful ("only pay when we know there is sound"). Applied, every window whose level log is thin or absent is silently skipped, stored as `no_speakers` with `skipped: "silent_window:thin_coverage"` — a row asserting the window was **judged silent** when it was never judged at all. Clinical audio lost, no test red, and the artefact left behind is a false positive claim. One test: a window whose gate returns `unknown` is still diarized.

### The class, stated once

Both survivors are the same mistake: **the property is pinned in the module where the author was thinking, and not at the boundary where it is consumed.** M1 pins attribution for the engine under construction and not the one it also labels; L1 pins `unknown` as a return value and not as a decision. This is the fourth and fifth sighting today of the wider pattern — only one half of a binary pinned (retention R2, jev-core J2b, WAN Lab's token, and these two).

### OBSERVATION — a wire boundary with a TypeScript-shaped guard

The Python endpoint defaults `total_sec.get(i, 0.0)`. A caller omitting `total_speech_sec` silently degrades the greedy order from speech-time to array order, so the clinician goes to whoever appears first with nothing failing — the index trap one level up. Node cannot do this: `total_speech_sec` is required on `EmbedRequestSpeaker`, and the reversed-input tie-break test at `:155` is the right shape. But TypeScript does not survive the wire and this is an HTTP boundary; a 400 would be fail-closed, `0.0` is fail-open on the rule deciding which human is identified.

### Corrections to the builder's account, both minor

- *"one asserting the load path contains no JOIN"* overstates it: `lib/stt/diarize-window.ts` still joins at `:63` and `:82` (voice_print↔clinician). The test at `:330` is correctly scoped to `room_day`. The narrower claim is the true one and the one worth keeping.
- The `ON CONFLICT DO NOTHING` in `0117` is on the **`schema_migrations`** insert; the label write's clause is `lib/diarize-labels.ts:74`. Same conclusion, different file.

### Not proven, and I agree with the builder's own assessment

The Mini endpoint has never run against the real ECAPA model, its 15-check test is uncommitted, and no window has been through the hybrid end to end. I treat that half as the weakest evidence on the branch and did not test it. Migration 0117 has been applied nowhere.

## Verdict: PASS-WITH-FIXES
The switch, the scrub, the teacher labels, the fallback bookkeeping and the gate's own judgement are all sound and genuinely pinned, and two of the three things the builder flagged as traps were avoided in ways better than claimed. Both survivors are one class and both are one test each. Per Fable's ruling the restart is unblocked and the merge waits on FINDING 1; FINDING 2 is the same size and should ride with it.
