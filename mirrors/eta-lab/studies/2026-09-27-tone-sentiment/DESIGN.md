# Text sentiment via Jev — design + live-validated question shapes (W45.3, owner: tone)

**Status: piloted end to end on real 24 Sep patient audio via `tone/run_real.sh` (20 turns Jev-
scored, full results and the role-terminology correction below in `REPORT.md`). Question wording
first validated on 4 invented probes (kept below for the record), then confirmed sensible on real
data in the pilot.**

## V ruling 27 Sep 12:55 (supersedes the order text)
Jev (TypeSafe) is ZDR for Even; OpenRouter/Gemini is also ZDR. No de-identification step before
sending consult text to Jev. This withdraws the "de-identified first" clause in W45.3 (and the
same clause in W41/W44/W46). Design below sends `transcript_english` turn text as-is.

## Unit of work
One call per speaker turn (not per consult): state = `{turn: {speaker_role, text_en}}`, where
`speaker_role` comes from the `room_turn_speaker` join already designed in
`studies/2026-09-23-emotion-audit/TONE-DESIGN.md` and `text_en` is the turn's English (translated)
text.

**Corrected against real data (pilot, `REPORT.md`): `room_turn_speaker.role` only ever takes the
value `"clinician"` (voiceprint match) or is NULL.** There is no "patient"/"attender" role value —
non-clinician speakers are never identified, exactly as `TONE-DESIGN.md` warned ("a two-speaker
room isn't proof the other voice is the patient"). `speaker_role` passed to Jev is therefore
`"clinician"` or `"unattributed"` (carry the unattributed cases through, never guess by
elimination), not the doctor/patient/attender vocabulary this section originally assumed.

## Questions (one Jev call handles any role; code reads only the answers that apply — rule 2)
Validated live 27 Sep against jev-1.13.0, invented turns (fearful patient, empathetic doctor,
purely clinical doctor instruction — no real patient data used for validation):

- `distress` (Score, 4 levels: calm/matter-of-fact → mild worry → clear anxiety/urgency → acute
  distress/panic). Instructions gate on role: "If `turn.speaker_role` is unattributed (not the
  clinician), how distressed... If the speaker is the clinician, judge as calm/neutral (lowest
  level)." Invented-probe clinician turns scored 0.00-0.01, an invented fearful patient turn
  scored 2.55/3. On the real pilot (n=10 unattributed): mean 0.68/3, and the single highest-scoring
  real turn (2.28, high confidence) was a genuine fear expression, not a false alarm.
- `satisfaction` (Score, 3 levels: frustrated/dissatisfied → neutral → reassured/satisfied). Same
  role-gating pattern. Real pilot mean (n=10 unattributed): 0.64/2.
- `empathy` (Noul, true=yes; clinician turns only, false otherwise). Invented-probe empathetic
  clinician turn scored 0.99, purely clinical instruction 0.02. Real pilot mean (n=10 clinician):
  0.17 — low because most real clinician speech in a consult is procedural, and the single highest
  turn (0.62) was a genuine reassurance during a pre-procedure explanation, not a scoring
  accident. Full numbers: `REPORT.md`.

Kept `distress` and `satisfaction` as two separate Score axes rather than one combined
distress↔satisfaction dimension (order's phrasing: "distress/satisfaction") — they are not
opposite ends of one line (a patient can be distressed about symptoms and still satisfied with
the doctor); rule 7 (one dimension per Score) argues against forcing them into one axis. Combine
in code downstream if a single number is ever wanted; keep both raw values.

## What this does NOT do
No aggregate "doctor's empathy score today" surfaced anywhere yet — same two-flag discipline as
the emotion lane (`EMOTION_ENABLED` vs `EMOTION_SURFACE_ENABLED`): compute and store first, surface
is V's call later, per the order's own "shadow only" line.
No sentiment computed on non-English source text — translation quality is a separate, unmeasured
variable (scribe3's Jev findings on English coverage: only 12.7% of windows pass a native-English
rule outright; most `text_en` is machine-translated). Report translation engine per turn alongside
the sentiment scores so a bad translation isn't misread as a bad sentiment signal.
No averaging acoustic (wavlm) and text (Jev) affect into one number — the order says "combine in
code, report both, never average them away"; store both, let the consult-level view (item 4) show
them side by side.

## Resolved (27 Sep, Fable + pilot)
1. **No per-turn English text exists for room audio** (confirmed by schema check) — worked around,
   not fixed at the source: `extract_turns.py` merges `room_diarize_window.segments_json` micro-
   segments into turns and `turn_translate.py` gets English directly from each turn's audio via
   Gemini 3.8 Flash (ZDR route), rather than waiting for a text alignment step. **This is a
   stopgap**: V's approved Room Evidence Bundle (REB, `/home/eta/oc/REB-SPEC-v1.md`, 13:30) will
   ship real per-turn text with provenance and lists "Gemini audio→English direct" as its own test
   arm — the same idea. When REB ships, retire `turn_translate.py`/`extract_turns.py` and consume
   REB's track instead of maintaining a parallel path.
2. **Target day**: piloted on 24 Sep (Fable 13:22, option b — 26 Sep had 0 transcribed/diarized
   windows as of 27 Sep ~13:15). Switch to 26 Sep once hist-bulk's backfill (W45.1) reaches it.

## Still open
1. Rate limit: ~8 workers max per the Jev skill; a full day's turns across all rooms could be
   thousands of calls — needs a batch size / backlog plan before scaling past pilot size, same
   shape as hist-bulk's window backlog (newest-first, tracked, not a single unbounded sweep). Same
   applies to the Gemini translation step (sequential in `turn_translate.py` today).
2. Translation accuracy at scale is unverified beyond spot-reading the pilot's 153 outputs — no
   ground truth run against it yet (unlike `lang_judge.py`'s own SELFTEST validate mode, which this
   script doesn't have an equivalent of for translation *content*, only for the route itself).
3. `previousEvaluation`-style iteration doesn't apply here (that's jev_review's loop, not
   jev_ask/system_one scoring) — no action needed, noting only to avoid confusing the two Jev
   entry points.
