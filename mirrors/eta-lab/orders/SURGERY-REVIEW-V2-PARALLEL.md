# SURGERY-REVIEW-V2: parallel build (V wants the pilot sooner). New target: pilot live 12:30 IST
This supersedes the 16:00 target in SURGERY-REVIEW-V2.md. The design there is unchanged; this file splits the work across three sessions working at once.

## The contract: one JSON file per consult
Files go in ~/eta-data/surgery-review-v2/consults/<id>.json on the box (never in git):
```
{ "id":"P01", "date":"2026-09-23", "room":"<room name>", "doctor":"<doctor display name or null>",
  "bucket":"lead|flag|neither",               // HIDDEN from reviewers; Fable strips it before seeding
  "quality":"ok|poor",                        // fleet's own read: poor = STT mostly unusable
  "turns":[ {"i":0,"start_s":12.4,"end_s":18.0,
             "speaker":"doctor|patient_or_attender|other|A|B|C",
             "lang":"en|hi|kn|te|ta|mixed",
             "orig":"<original text, de-identified>","en":"<English, de-identified>"} ],
  "jev":{ "discussed":{"answer":"yes|no","conf":0.0,"evidence":[3,4]},
          "kind":{"answer":"recommendation_now|history|referral|staff_talk|none","conf":0.0,"evidence":[]},
          "procedure":{"answer":"<name or 'not named'>","conf":0.0,"evidence":[]},
          "proposer":{"answer":"this_doctor|another_doctor|patient|unclear","conf":0.0,"evidence":[]},
          "firmness":{"answer":"suggested|advised|strongly_advised|scheduled|not_applicable","conf":0.0,"evidence":[]},
          "patient_response":{"answer":"agreed|will_think|declined|not_stated","conf":0.0,"evidence":[]},
          "cost":{"answer":"yes|no","conf":0.0,"evidence":[]},
          "second_opinion":{"answer":"yes|no","conf":0.0,"evidence":[]} } }
```
Firmness follows the R1 default wording; "kind" follows the R2 default. Both are V-final.

## Three lanes, all working now

**Lane 1, fleet (data):**
- Pick the 5 pilot consults: 3 surgery-lead + 2 neither, from 23 Sep.
- Pull the full consult turns with speaker attribution from the diarize hybrid output, and the Gemini translation.
- Leave "orig"/"en" RAW in a staging dir, never shared. surg-deid replaces them with de-identified text before Jev runs.
- Then run Jev U9 on the de-identified English, fill "jev", and write the final files.
- Target: raw staging by 11:00, final files by 12:00.

**Lane 2, surg-deid (NEW session):** build the local de-identification step specified in orders/RULINGS-FABLE-0935.md (rulings 42–43), as a CLI:
- `deid.py in.json out.json` rewrites every turn's orig + en;
- doctors are whitelisted from the EPI physician roster;
- it's measured on 30 real turns.
- Run it on fleet's staging files as soon as they land.
- Hand fleet the de-identified files.
- Target: tool ready 11:00, pilot files de-identified 11:30. eta-refuter-2 refutes the tool in parallel.

**Lane 3, surg-page (NEW session):** build the review page as ONE HTML file.
- tools/surgery-review/v2-page.html; the page has no patient data, so git is fine.
- Pattern: exactly like tools/surgery-review/v1-artifact.html, a claude.ai artifact page reading db collection "consults" through `claude.use("db")`, answers saved to `ratings/<viewer id>` via `claude.use("user")`. Keep its capability usage and theme tokens. The layout is new.
- **Layout per consult:**
  - Top card: Jev's 8 answers, each with confidence, **Agree** / **Correct**. Correct opens that question's options or a text box. Evidence chips jump to and highlight the turns.
  - Below: the whole consult as a chat-style transcript. Speaker label and colour per turn (Doctor / Patient or attender / Other / Speaker A–C). English first, and the original under a "show original" toggle per turn.
  - A "Transcript too poor to judge" button.
  - Consult navigation.
- The owner-only Agreement tab shows Jev accuracy per question = the share of Agree.
- Develop against 2 MOCK consult files that you write yourself (invented text, no real data).
- Target: page ready 11:30. Fable seeds the real data and publishes it at the existing artifact URL.

## Hand-off at 12:00–12:30
fleet reports "final files ready". Fable reviews one file, strips "bucket", seeds the db, publishes v2-page.html at the same artifact URL, and opens it for V.

## Rules
- No patient text in git.
- No lab load on the Mini's whisper, diarize or emotion services 08:00–20:30. Read stored outputs only.
- Jev only ever sees de-identified text.
