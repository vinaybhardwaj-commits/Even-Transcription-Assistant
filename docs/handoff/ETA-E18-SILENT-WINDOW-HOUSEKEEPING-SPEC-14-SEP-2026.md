# ETA-E18 — silent windows: stop paying for them, stop miscounting them · SPEC · 14 Sep 2026

Depends on E11 being merged. Read `ETA-E11-FINAL-RULINGS-AND-SCRIBE-ORDER-14-SEP-2026.md` §4.

E11 made a silent window finish cleanly instead of failing. Three consequences were priced but not
paid. This round pays them. **Small, bounded, and it should not need a second opinion on design.**

## 1. `silent_window` becomes a durable fact on the window

Today it lives only in job progress. It needs to be on `bench_window` so other stages can read it.
Next free migration number — **check `schema_migrations` first; E1's plan also wants 0094.**

Additive column, default false, backfilled false. No existing row changes meaning.

## 2. The diarize scan skips silent windows

`enqueueDiarizeWindows` (`lib/stt/diarize-job.ts:128-131`) selects on `clip_r2_key IS NOT NULL`. A
silent window now satisfies that, so the diarize job downloads the clip, calls the service **without
looking for turns** (`diarize-window.ts:52-63`), and records `no_speakers`.

At the live run's rate — 21 of 25 windows silent — **most of the Mini's diarize queue would be spent on
silence, at 47–71 seconds each.** That queue is the only one feeding emotion.

Exclude `silent_window = true` from the scan. **Do not** make the diarize *job* refuse them — the scan
is the right place, and a job that can still be asked to diarize silence by hand is correct.

## 3. `words_ms` stops counting silence as words

`lib/stt/room-reads.ts:94,103` counts a silent window as transcribed **and adds its full 900 s to
`words_ms`**. A window with no speech contributing 900 seconds of "words" overstates every speech
figure built on it, and those figures are what a room card shows.

A silent window is **covered**, not **spoken**. Keep it counted as transcribed — that is true and it is
how the day view distinguishes "looked at" from "never looked at". Stop adding its span to `words_ms`.

**Check whether any other reader does the same thing** before you call this done; `words_ms` is unlikely
to be the only place a span length stands in for speech.

## 4. NOT in this round

- **The two Whisper calls per silent window** (language probe, then full). The full call returns in
  about 4 seconds on silence, so the waste is small and the probe cannot safely be trusted to speak for
  the other 870 seconds. **Measure before optimising; not tonight.**
- Anything in `lib/emotion/` — E16 owns that.
- Anything in `auto-drain.ts` — E17 owns that.

## 5. VERIFY

- **V1** A window finished by the silent branch has `silent_window = true` on `bench_window`, readable
  by a query you show.
- **V2** The diarize scan does not select it. Behavioural: run the scan over a fixture containing one
  silent and one spoken window and assert exactly which comes back.
- **V3** A spoken window is **still** selected. Rule 7 — prove the exclusion is not universal.
- **V4** A silent window adds **0** to `words_ms` and is **still** counted as transcribed. Both halves.
- **V5** The migration is additive and idempotent, and re-running it changes nothing.
- **V6 Mutation check** on the scan predicate, the flag write and the `words_ms` branch.

## 6. OUTPUT

`docs/handoff/ETA-E18-REPORT-14-SEP-2026.md` — diff, migration number used, V1–V6 with mutation count,
and any other reader of span-length-as-speech you found. **Cap: 80 lines.** Commit on green; no push,
no merge, no deploy. Do not turn `ROOM_AUTO_DRAIN_ENABLED` on. Do not quote transcript text.
