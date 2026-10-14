# ORDER — scribe — BUILDER — put a speech gate on the diarization path

Read `docs/handoff/ETA-FINDINGS-LEDGER.md` first, section "Speech detection". That is the root cause,
established by ETA-Refuter. **You did not do that investigation, and ETA-Refuter will refute your fix
— so do not ask it for its reasoning; work from the measurements.**

## V's ruling
> "We need to fix the room noise as speech issue. The ETA is a passive system. It has to be able to
> make out proper speech."

## The root cause, in three facts
1. **The diarization path has no speech gate.** pyannote runs on pretrained defaults
   (`~/eta-diarize/server.py:42`, `min_duration_on/off = 0.1 s` at `:49-54`).
2. **Silero VAD (0.5) already exists — on the transcription router only.** Nothing re-checks speech
   before diarizer segments are stored. **The model we need is already on the Mini.**
3. **`roomEnergyFloor(_roomId, env)` ignores its room argument** (`lib/stt/window-measure.ts:124`) and
   reads one global `ROOM_ENERGY_FLOOR` (0.00398). A 9 Sep measurement showed one global floor cannot
   work across rooms.

## What to build
1. **A speech gate between pyannote and segment storage**, reusing the **existing** Silero VAD. Do not
   install or download a model. A segment is stored as speech only if Silero finds speech in it; the
   rest are dropped or stored flagged as non-speech — **prefer flagged**, so nothing is destroyed and
   the gate can be retuned later against the same data. That is the durable choice.
2. **Behind a flag, default OFF**, `lib/flags.ts` convention (`FLAG_TRUTHY`/`FLAG_FALSY`, throw on
   anything else). The night-drain is mid-backlog; it must not change behaviour under it without a
   deliberate switch.
3. **Fix `roomEnergyFloor` to actually use the room**, falling back to the global value where no
   per-room value exists. Say where per-room values would come from — do not invent them.

## How to prove it — you have free ground truth
**7,548 speaker-labelled segments fall 21:00–07:00 IST**, when no consultation can happen. Every one is
a false positive by construction. Use them:
- Report how many of those the gate rejects — that is the **false-positive removal rate**, label-free.
- Report how many **clinic-hours** segments it rejects too. That is the cost, and it must be stated —
  a gate that removes all the night noise and half the real speech is worse than no gate.
- Split-speaker's number is a second check: Silero ≥1.0 s kept **83%** of what V affirmed and removed
  **70%** of what he didn't. Say whether your gate agrees.
- **Do not tune the threshold on the same data you report it on.** Hold part of the closed-hours set
  back and report on the held-out part.

## Constraints
Neon HTTP driver — no `sql.unsafe`, no interactive transactions, ISO timestamps. Branch from
production `45eedda`. **Do not modify, delete or re-flag any existing stored segment** — measure
against them read-only. Do not touch the night-drain, the watchdog or the closed-hours gate. Tests
first; prove each change by reverting it and showing the test fails.

## Output
Where the gate sits (file:line), the flag name, closed-hours rejection rate on held-out data,
clinic-hours rejection rate, agreement with the 83/70 figure, test counts, mutation results.
Append your measured numbers to the ledger. Do not push. CAP 220 words.
