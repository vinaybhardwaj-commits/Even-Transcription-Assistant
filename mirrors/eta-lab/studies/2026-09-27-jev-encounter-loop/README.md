# E-7 Jev encounter-boundary loop (W44) — design doc

**Owner:** lx. **Checker:** eta-refuter-2. **Merges to main:** Fable. **Order:** `/home/eta/oc/W44.txt`
(Fable, 27 Sep 12:10, design settled). **Status:** design + pre-registration, no code yet.

**Ruling incorporated (V, 27 Sep 12:55, relayed by Fable):** Jev (TypeSafe) and OpenRouter/Gemini
are both zero-data-retention for Even. The de-identification step W44 §A originally specified
("de-identify non-doctor identifiers BEFORE Jev, reuse jev-fix F1/F5 scrub") is **withdrawn**.
Chunks go to Jev as-is, no scrub. This also corrects the order's citation: there is no "jev-fix
F1/F5" in this repo — the closest real thing is `studies/2026-09-24-surgery-review-v2/deid.py`
(V's ruling RULINGS-FABLE-0935 #42/#43, 24 Sep), which is **not needed here** per the 12:55 ruling
and is not used by this design. (It stays relevant to any OTHER pipeline step that still needs it —
not this one.)

## Prior art this design reuses (verbatim where possible, per skill rule: code owns the workflow)

- **Chunk/timing primitives**: `studies/2026-09-24-encounter-first/segmenter.py` (energy levels
  `[(t_ms, peak)]`, silence-gap detection) and `encounter_bounds.py` (`_doctor_idx()` dominant-speaker
  windows from `diarize_window_label` rows). Neither carries STT text today — new work here (§A) adds
  a text-bearing chunk layer on top of the same room-day, reusing the silence-gap function for
  boundary snapping (§C) instead of reimplementing gap detection.
- **Jev call shape**: `studies/2026-09-24-voice-jev/arms/common.py:jev_call(state, questions)` and
  `arms/arm_jev.py` — the only real, working Jev HTTP call in this repo (POST
  `https://api.typesafe.ai/v1/systemone`, retries on 429/529, `--workers` threadpool, resumable via
  `input_sha`). This design's Jev client is a thin wrapper on that pattern, not a new one. (Note:
  `e7-rescore.sh` sets `TYPESAFE_API_KEY` directly for its own worktree Jev client — a second,
  divergent convention. This design follows `arms/common.py`'s key-file convention;
  flagged for Fable/refuter-2 to pick one repo-wide if it matters, not blocking this build.)
- **Truth + metric**: `studies/2026-09-23-e7-pqm-truth/e7_score.py` (matching rule: overlap ≥ 50% of
  the shorter interval; splits/merges by multiplicity; med/p90 start-end error) and
  `PQM-SOURCE.md` (`pqm-consults.csv` from Metabase db 13, `queue_token_steps` ⋈ `queue_tokens`,
  station='CONSULTATION'; columns `token_uid, doctor_uid, doctor_name, token_created_at, called_at,
  completed_at, cycle_bucket`). Room→doctor comes from voiceprint attribution /
  `room_turn_speaker.role='clinician'`, not from PQM directly.
- **Scoring harness**: `studies/2026-09-26-fullday-rescore/fullday_score.py` +
  `studies/2026-09-24-e7-fullday/arm_d.py` as the template for a new arm. Every arm writes
  `hyp-<name>.json` shaped exactly:
  ```
  {transcript_version?, smoother_version, room_days: {
    <rd_id>: {room, date, energy_gap, encounters: [{id, start_ms, end_ms}]}
  }}
  ```
  `fullday_score.py --truth <csv> --hyp hyp-jevloop.json [--hyp hyp-acoustic.json ...]
  --transcript "<name>" --date <YYYY-MM-DD>` is the exact command this design's score (§D) runs.
  `--transcript` is required and version-gated (rc=3 on mismatch) — the Jev-loop hyp file must
  declare `transcript_version` naming the STT/translation batch it read, same as every other arm.
- **Existing baselines**: `studies/2026-09-23-e7-pqm-truth/hyp-acoustic.json` (keys: `source,
  smoother_version, shadow_version, note, room_days`) and `hyp-fused.json` (adds `fusion_version,
  prompt_versions, code, replayed_at`) reproduce lx's cited 3/14 recall / 3/7 precision on 23 Sep.
  **Open item**: neither file is confirmed to have 26 Sep room-days yet (§D, open item 3).

## A. STATE per step (per ~60s chunk)

A room-day's STT is read as consecutive chunks, cut at speaker/silence boundaries (not fixed 60s —
"~60s" is a target, not a hard cut, so a chunk never splits a speaker turn). Each chunk:

```
chunk = {
  room, date, rd_id,                     # same room-day id space as the full-day harness
  chunk_id, start_ms, end_ms,
  text,                                  # English — original if already English, else the 337b
                                          # Gemini-translation pipeline's output for this segment
  orig,                                  # original-script text (kept for candidate regexes that
                                          # work in any script — rule 10 numbers/keywords in code)
  lang,                                  # source language tag
  speakers,                              # [{speaker_id, role}], role in {clinician, other, unknown}
                                          # clinician = room_turn_speaker.role='clinician' (voiceprint)
  silence_before_ms, silence_after_ms,   # from segmenter.py's existing gap detection
}
prev = { text }                          # previous chunk's `text` only, "" at a room-day's start
                                          # or after a reset the state machine has already cut
```

**Open item (blocks §D, does not block writing code against mock/offline state):** the persisted
per-room-day English-translation source is not a stable table/file I could verify in this
checkout. The real translation pipeline is the "337b" v5 Gemini/Vertex script (board item 157: on
25 Sep, English existed for 138/1,203 Indic segments; 26 Sep had ~22 more windows untranslated at
that time). This design does not send audio anywhere itself — it reads `text`/`orig` off whatever
turn-level store 337b already writes to (`deid.py`'s `TEXT_FIELDS = ("orig","en","text")` implies
the same turn-JSON shape). **Ask for Fable/linker: name the exact file/table lx reads per room-day,
and confirm 26 Sep's translation is complete before the frozen score runs** (§D open item 1). A
chunk with no `text` (untranslated) is processed on `orig` only for the regex candidate layer and
is marked `translation_missing: true` in the per-chunk trace; the Choice/Noul Jev questions are
English-language questions about `chunk.text`, so an untranslated chunk gets no Jev answer and
falls back to acoustic+regex signal alone (reported separately, never silently dropped, same
"never dropped from totals" rule the harness already follows for excluded consults).

**REB may supersede this open item (13:30 ruling, `/home/eta/oc/REB-SPEC-v1.md`, bus #4549):** the
spec's §5 Consumers list names "encounter loop (W44)" explicitly, and its `translate` layer
(Gemini text->English per Indic STT track, §3) is a cleaner, provenance-carrying answer to exactly
this open item than chasing down 337b's raw output table. REB is NOT ready to switch to yet: the
LIBRARY step (`kit/reb`) is **merged to main** (bus #4657: `reb/kit-reb-library` 18c52b9f ->
`origin/main` @a447dc36, 10/10 tests re-verified on the merged tree, importable from main now) but
step 3 (fan-out runner, Fable currently sizing wrangler-under-lock throughput before designing its
width) and step 4 (26 Sep backfill, all v1 layers) haven't started — a merged library with no data
behind it yet. `chunker.fetch_turns`/`fetch_translations` stay on the direct
`cue`/`room_turn_speaker` Neon read (the real, working convention `sets.py`/`fetch_turns.py` already
use elsewhere in this repo) as the near-term path for ≤25 Sep development. **Once REB step 4 lands
for 26 Sep**, `chunker.py`'s two data-touching functions are the natural place to re-point at
`reb.load_window(...).tracks("stt")` / `.tracks("translate")` instead — now importable from main
(`kit/reb`) rather than a branch, when that day comes. **Answered (reb, bus #4572):** step 4 is not
imminent — keep the direct Neon read for dev-day work now, don't block on REB; reb will ping lx
directly once 26 Sep is backfilled and `w.tracks(layer="translate")` has real data, which should
then answer the translation-source open item outright. The 337b-table question (README §A open item
1) therefore still needs its own answer for the near term — it is not superseded, only possibly
obsoleted later.

## B. ONE Jev request per chunk — full question set (frozen; goes in `jev_loop_constants.py`)

Per skill rule 2, all questions for a chunk are one `system_one` call. Rule 8 recommends, for
options that get confused with each other (history vs. exam vs. diagnosis, opening vs. closing,
patient-present vs. admin), a `what`/`not_for`/`examples` object per option — the table below shows
the full reasoning in that form. **B1 (eta-refuter-2 #4612), implemented differently:** the only
proven-working Choice call in this repo (`voice-jev/arms/common.py:118`) sends each option as a
plain STRING, and nothing here has tested whether Jev's real API accepts, rejects, or silently
stringifies a nested object — rather than spend a real call to find out with no Fable go for that,
`jev_loop_constants.py` folds `what` + `not_for` into one string per option and **drops `examples`
entirely** (a second, independent reason: eta-refuter-2 also flagged worked examples against the
prod prompt rule "no worked examples", arm-d-v1 leakage). The table's `examples` column is kept
here for a human reviewer's context only — it is not sent to Jev.

**`phase` (Choice, 9 options + `other`/`none_of_the_above` per rule 8):**

| option | what | not_for | examples |
|---|---|---|---|
| `greeting_or_opening` | the consultation is beginning — greeting, name/age, "what brings you", inviting them to sit | mid-consult small talk, or closing pleasantries | "Please come in, sit down" / "What is your name and age?" / "What brings you today?" |
| `history_taking` | asking about symptoms, duration, past illness, medicines, allergies, family/social history | announcing a diagnosis, or reading a prescription | "How long have you had this pain?" / "Any other medicines?" / "Family history of diabetes?" |
| `examination` | a physical exam happening or being directed — position instructions, findings said aloud, instruments | verbal-only history questions, or discussing a prior scan with no hands-on exam | "Lie down please" / "Take a deep breath" / "BP is 130 over 80" |
| `diagnosis_or_plan_discussion` | explaining what is wrong, naming a diagnosis, discussing the plan in words | history questions, or reading exact drug names/doses from a prescription | "This looks like a viral infection" / "We'll need a small procedure" |
| `prescription_or_advice_readout` | reading specific medicine names/doses/timings, diet/lifestyle advice, or test orders as instructions | explaining the diagnosis in general terms | "Take this twice a day after food" / "Avoid oily food" / "Get this test done" |
| `closing_or_follow_up_instructions` | wrapping up — follow-up date, pharmacy/billing directions, goodbye | the initial greeting, or the prescription readout itself | "Come back after 2 weeks" / "Pay at the counter" / "Thank you, take care" |
| `between_patients_or_admin` | no patient present — paperwork, calling the next token, talking to reception, dead air | any turn where a patient/attender is being addressed | "Send in the next patient" / silence with door/chair sounds |
| `staff_or_phone_talk` | doctor/staff talking to each other or on the phone about something other than the patient in the room | talking to the patient/attender about their own case | a phone call about an unrelated referral / staff discussing lunch |
| `none_of_the_above` | does not clearly fit any option above | — | unintelligible audio, or off-topic content |

**Nouls (rule 9: phrased so `true`/high = "yes"):**
- `new_patient`: "Is a different patient or attender being addressed in `chunk.text` than in
  `prev.text`? Answer yes only on a clear signal (a new name/age/greeting, an explicit reference to
  the next patient, or a distinct chief complaint that does not continue `prev.text`). Answer no if
  `prev.text` is empty or clearly the same ongoing case."
- `opening`: "Does `chunk.text` start a brand-new consultation — a greeting, taking the patient's
  name or age, asking what brings them in today, or inviting them to sit down? Answer no if this
  continues a consultation already in progress."
- `closing`: "Does `chunk.text` end a consultation — naming a follow-up date, giving final
  medicine/pharmacy/billing directions, or a goodbye? Answer no if this is still the prescription
  discussion in progress, or a mid-consult remark."
- `patient_present`: "Is a patient or their attender currently being spoken to, or spoken about as
  physically present, in `chunk.text` — as opposed to staff/admin/phone talk with nobody present?"

**State sent (corrected during build — skill rule 6, "send only what the question needs"):**
`{chunk: {text}, prev: {text}}` only. `orig`, `speakers`, `silence_before_ms`/`silence_after_ms` and
every id stay LOCAL and feed the state machine (§C) in code — none of the frozen questions above
reference them, so sending them to Jev would be irrelevant state that lowers accuracy, not a
feature. (An earlier draft of this doc listed them as sent; `jev_client.py` implements the
corrected, minimal state.) `chunk_id` / `room` / `date` are never sent to Jev (rule 4 — IDs aren't
part of the judgment); they
key the response on return. **Model pin (unconditional, per eta-refuter-2 #4464 G4):** this study
pins `jev-1.13.0` on every call regardless of whether prod is on floating `jev-latest` (W41 F2) —
a fixed model is what makes the frozen 26 Sep score reproducible. `response.model` is asserted
equal to the pin (hard error on drift, not just logged), and `jev-1.13.0` plus the
`jev_loop_constants.py` sha are both recorded in `hyp-jevloop.json` and in the per-room-day
`encounters/<room_id>/<date>.json`'s `source_sha256` provenance.

## C. CODE decides (skill rule 10 — math/counting/exact patterns stay in code)

- **Candidate generators** (regex/keyword, run on `orig` so they work pre-translation): greeting
  phrases, "next patient" / token-call phrases, follow-up / pharmacy / billing phrases — English +
  transliterated Kannada, Hindi, Tamil, Telugu, Malayalam. One module, one list per phrase class,
  reviewed like the deid.py lexicon is (a list humans can extend, not weights).
- **Boundary placement**: a small state machine (two states, `IN_ENCOUNTER` / `BETWEEN`) over, per
  chunk: the `phase` choice + probabilities (opening/closing mass), the four Nouls, the regex
  candidate hits, and acoustic cues reused from `encounter_bounds.py`'s existing dominant-speaker /
  speaker-set-change signal and `segmenter.py`'s silence-gap list. A full HMM is not justified until
  the state-machine version is scored and found short — start with the simpler machine per the
  "don't design for hypothetical future requirements" rule; escalate only if §D's score needs it.
- **Snapping**: every placed boundary snaps to the nearest silence gap from `segmenter.py`'s gap
  list (reuse, not reimplement) within a fixed window (constant, e.g. ±5 s).
- All thresholds, regex lists, and the state-machine's weights live in one `jev_loop_constants.py` —
  the file humans review and tune (rule 11).

**Development-vs-exit-test day split (per eta-refuter-2 #4464 B1 — fixing a self-contradiction: the
design previously said constants were "tuned against 26 Sep" while the pre-registered exit test IS
26 Sep):** every constant in `jev_loop_constants.py` — the snap window, the state-machine's
weights/thresholds, the regex candidate lists, the PARTIAL COVERAGE share (§D) — is developed and
tuned **only** against a room-day at or before **25 Sep** (25 Sep preferred: last day before the
26 Sep exit-test date; 22 Sep and earlier also acceptable). **26 Sep is never read, scored, or even
loaded during development** — the constants file is frozen (committed, sha named) before the first
byte of 26 Sep STT is touched by this code. This is a hard rule, not a guideline: a commit that
tunes a constant against 26 Sep invalidates the exit-test run and requires a fresh constants freeze
plus a fresh day for the next attempt (see PREREG §5, also revised).

**Known bias: back-to-back consults (declared per eta-refuter-2 #4633, not a bug to fix, a limit to
report):** when one chunk both closes an encounter and opens the next (S1 above — "take care ...
next, please sit" inside one ~60s chunk), the new consult's start lands at that chunk's `start_ms`
and the old consult's end at that same chunk's `end_ms`. If snapping doesn't find a real activity
edge between them, `snap_boundaries`'s overlap clamp pulls the new consult's start forward to the
old one's end — i.e. to the **far end** of the chunk that actually contains its true beginning.
Both edges are then late by up to one chunk's length (`CHUNK_TARGET_MS`, ≤60 s) relative to the true
moment inside that chunk. This sits inside the 2-minute exit test (§D) but it is a **systematic
bias, not noise** — it always pushes the same direction on a back-to-back pair — so it must not be
averaged invisibly into the aggregate start/end error. Every encounter carries
`back_to_back_start`/`back_to_back_end` booleans (`state_machine.run`, carried through
`snap_boundaries`, written to `hyp-jevloop.json`) precisely so §D's report can break start/end error
out separately for back-to-back cases vs. isolated ones, per eta-refuter-2's ask. The scoring script
that reads these flags to produce that split is not written yet (`fullday_score.py`/`e7_score.py`
stay unmodified and don't know about the flags) — tracked as a build item before the frozen 26 Sep
score, alongside PREREG §0.

## D. Truth + score

See `PREREG-26sep-jev-loop.md` — written and to be posted **before** anyone looks at 26 Sep data.

**Open items before the frozen score can run** (post to Fable, not blocking §A-§C code from being
written and unit-tested offline):
1. Confirm 26 Sep's per-room-day English translation (337b batch) is complete, and name the
   file/table lx reads it from (§A open item).
2. CAP consult→prescription links are **not** a stable committed artifact — board history shows an
   actively-revised linking project (`cap_link.py`/`cap_bundle.py`, false-link rate under active
   refuter-2 review, bundle versions v1→v3 each changing confirmed-link counts). This design
   registers PQM call-in/complete times as the **primary, frozen** truth (§ exit test below); CAP
   links are a secondary cross-check added only once linker's bundle has a refuter-2-PASSed sha
   Fable names — never blocking or gating the primary score.
3. Confirm `hyp-acoustic.json` / `hyp-fused.json` (or their 26 Sep equivalents) exist for 26 Sep
   room-days, else those baselines need generating first by whoever owns E-6/acoustic (not new work
   for this study) before the side-by-side report in §D can be filled in.
4. Confirm a 26 Sep PQM truth CSV exists or needs building via
   `studies/2026-09-24-e7-fullday/build_truth.py` (only a 23 Sep truth CSV is present in this repo
   today: `studies/2026-09-23-e7-pqm-truth/e7-truth-23sep.csv`). **Per eta-refuter-2 #4464 G3, this
   build step's filter (which rooms/date range/`cycle_bucket` values go in) and the resulting CSV's
   sha256 are frozen and named in the PREREG *before* any hyp file is written** — not decided
   loosely at build time.
5. The 26 Sep **room list** this study scores is frozen at the same time as the truth CSV (G3) —
   named in the PREREG, not "whichever rooms happen to have output" decided after the run.

## E. Loop scope

Runs as a backfill (all already-transcribed room-days) plus a daily job, over every transcribed
room-day. **Shadow only** — output is `hyp-jevloop.json` (harness format above) plus a per-chunk
trace file for lab-viewer (§ below); nothing reaches clinicians, no write path to production. Same
read-only-vs-production rule as the rest of lx's lane.

## lab-viewer feed (owned by lab-viewer, not lx — this section is the contract lx outputs to)

**W49 rename (bus #4548):** `/home/eta/oc/lab-viewer/TIMELINE-SHAPES.md` supersedes
`ENCOUNTERS-SHAPES.md` (`/encounters` now redirects to `/timeline`; `lab-viewer/encounters`
b1debdaf -> `lab-viewer/timeline` 7f07232c). Path moves from
`~/eta-data/encounters/<room_id>/<date>.json` to **`~/eta-data/timeline/<room_id>/<date>.json`**
(`run_loop.py --timeline-dir`, default matches). `detected.jev_loop`'s own shape is **unchanged**
across the rename: `[{id, start_ms, end_ms, conf?, phase_probs?}]`, epoch-ms, phase names from §B.

**Ownership correction:** `pqm_truth` (now with a `token` field) and `cap_links` (now with
`rx_linked`) are explicitly **linker/cap's** keys in TIMELINE-SHAPES.md, not lx's — an earlier
draft of this doc said lx would fill them "once wired"; that was wrong, corrected here. `run_loop.py`
never writes those keys (not even as an empty list — TIMELINE-SHAPES.md's own rule: an omitted key
reads as "not processed yet", an empty list would misleadingly read as "checked, zero found").
`detected.acoustic`/`detected.e6` are likewise whichever team owns those arms, and TIMELINE-SHAPES.md
adds `acoustics` (missed-speech spans, W39/A1) and `fleet` (device/room-install events) as further
keys lx never touches. lx fills only `detected.jev_loop`. Counts/ids/timings/confidences only — no
transcript text, no drug/diagnosis text, no doctor/patient name/id. `hyp-jevloop.json`
(harness-standard shape, §"Scoring harness" above) stays the separate scoring-harness input. lx
posts the timeline directory path on the bus once files exist for 26 Sep; empty/omitted lanes are
fine (page shows "not processed yet"), so this is not a build blocker.

## Build status

`jev_loop_constants.py, candidates.py, chunker.py, jev_client.py, state_machine.py, run_loop.py,
selftest_checks.py, selftest.sh` are written and `bash selftest.sh` is green (32/32), fully offline —
no database, no real Jev call. `jev_client.py` wraps `voice-jev/arms/common.py:jev_call` rather than
re-implementing the HTTP call; the offline suite includes an end-to-end check that scores
`run_loop.py`'s output through the REAL, unmodified `fullday_score.py`/`e7_score.py` against a
synthetic fixture, and a direct check of `e7_score.py`'s live split-pairing behavior (G2).

**eta-refuter-2 #4612 fixes (before this build's second review):**
- **B1**: `PHASE_OPTIONS` flattened to strings, `examples` dropped — see §B above.
- **S1**: `state_machine.run` re-checks the opening signal immediately after a chunk closes an
  encounter, so "take care ... next, please sit" in one chunk no longer silently drops the next
  consult's start (tested: `test_back_to_back`).
- **Minor**: `state_machine.snap_boundaries` now distrusts a snap that would invert a span (falls
  back to the raw, un-snapped edges) and clamps a successor that a snap left overlapping its
  predecessor, raising loudly if clamping still can't produce a valid span (tested:
  `test_snap_guards`).

**Not yet done, before any real Jev spend or 26 Sep run:** `chunker.fetch_translations` refuses on
purpose (README §A open item 1 — the 337b English source isn't named yet); a real room-day has not
been run against the real Jev API; PREREG §0 (room list + truth CSV sha) is still blank.
