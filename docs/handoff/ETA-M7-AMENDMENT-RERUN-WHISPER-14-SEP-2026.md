# ETA — M7 AMENDMENT: stop searching, re-run whisper
**14 September 2026 · Session: `scribe3` · supersedes the "do not re-run whisper" instruction in
`ETA-M7-REAL-AUDIO-ENGINE-CC-KICKOFF-14-SEP-2026.md` §4**

## 1. Stop the search

**Abandon the whole-home `find` for `.prerepair` files.** It has run 45 minutes. You already established
the two facts that matter: the drain repo holds **0** such files, and `out/` holds only today's two job
folders plus `vad_smoke`. The 13 September corpus is not where `repair_transcripts.py:272` puts it.
Whether a stray copy exists somewhere under `Library` does not change what you should do next, so the
search has stopped earning its wall-clock. Kill it and report the two counts you already have.

## 2. The ruling: re-run whisper, and this is an upgrade, not a fallback

My kickoff said *"do not re-run whisper — its arm already exists."* **That instruction is withdrawn.**

The arithmetic makes it easy. M3 measured route at **8.30× slower than whisper alone**, and route at
**0.326–0.342× realtime** — so whisper alone is roughly **35–40 seconds per 900-second window**, and ten
windows is **about six minutes of Mini time**. Six minutes is less than the search has already spent.

And a fresh run is **better evidence than the lost backups would have been**:
- Both arms run **today, minutes apart, against the same service state**. The 13 Sep backups came from a
  different day, before M1 moved the Mini's blocking work off the FastAPI event loop — so they were never
  strictly comparable to a route arm run now.
- You control the parameters and can state them, instead of inheriting whatever the September drain used.
- Testing rule: a fixture you cannot reproduce is worth less than one you can.

**Do not substitute the repaired transcripts.** That remains absolute. The repaired text has had its loops
collapsed, which is precisely the quantity M7 exists to measure. If the raw text is not available for a
window, that window is out of the sample — say so and pick another.

## 3. What changes in the method

Everything else in the M7 kickoff stands. Specifically unchanged: **speech ratio per window reported
first** (§3.1 — still the number everything else is read against); all three repeat-ratio definitions
computed on the same data; per-segment winning engine and language; M6's script-census method unchanged;
no transcript text quoted, counts and ratios only.

Added, because you are now producing the whisper arm yourself:
- **State the whisper parameters verbatim** — model, `condition_on_previous_text`, temperature, beam,
  segment length — so the run is reproducible.
- **Run the two arms back to back per window**, whisper then route, never concurrently. `ETA_MAX_INFLIGHT=1`
  serialises anyway and contention would corrupt the timings.
- **Report whisper's wall-clock too**, not just route's. M3's 8.30× ratio was measured on one synthetic
  clip; this is the first chance to check it on real audio, and it costs nothing extra to record.

## 4. Sample selection

Ten windows from **real room audio**, spanning a range of speech density. Since you are no longer bound to
the windows that happen to have backups, pick for **spread in speech ratio** — some near-silent, some
busy. That spread is now the most valuable property of the sample, because the whole question is whether
whisper's looping tracks silence.

Say how you chose. If you cannot judge density before running, pick at random and report the spread you got.

## 5. Unchanged constraints

No git, no commit, no deploy, no flags, no migrations. Read-only on the repo. Do not touch `~/eta-router`
or restart any service. **Do not quote transcript text** — real clinical audio, counts and ratios only.
Do not run the repo test suite. `scribe` may be running a database query; it will not touch the Mini.

Report to `docs/handoff/ETA-M7-REAL-AUDIO-ENGINE-14-SEP-2026.md` as originally specified, **cap 110 lines**,
leading with the three sentences in the kickoff's §6 — speech-ratio range, IndicConformer segment count,
whisper's repeat rate against route's.
