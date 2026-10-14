# Synthetic emotion validation — run 2 results (W45.2, 27 Sep 2026)

Pass bar, method, and label mapping: see `DESIGN.md` (pre-registered before this run). Full data:
`emotion_suite.py`, `~/eta-data/tone/emotion-validate/run2/report.json` (per-cell numbers),
`results-clean.json`/`results-room.json` (raw wavlm output). 144 clips scored (72 clean + 72
room-acoustic proxy), 0 unscorable on either condition. n=2 per cell (one doctor line, one patient
line) — thin; read per-cell YES/no as directional, not a tight estimate. Real ElevenLabs
spend: 4,980 chars (ledger 50,490 → 55,470 of 60,000; run 1's shorter-line attempt is excluded, see
DESIGN.md's run log — it was gate-broken, not a finding).

## Headline: reliable by delivery, not uniformly
| delivery | cells reliable (of 12 = 6 langs x clean/room) |
|---|---:|
| neutral | 5/12 |
| happy | 4/12 |
| calm | 3/12 |
| **anxious** | **0/12** |
| **angry** | **0/12** |
| **sad** | **0/12** |
| overall | 12/72 |

**anxious, angry, and sad never clear the pre-registered bar, in any language, clean or room-
acoustic.** Not "sometimes wrong" — `mean_accept_score` for these three is typically 0.01-0.09
(vs. 0.3-0.7 for the labels that do pass), i.e. wavlm essentially never assigns weight to
fear/anger/sadness for these deliveries on invented, TTS-performed speech. `calm` inherits
`neutral`'s target (no calm concept in the model, pre-registered as a ceiling) and still only
passes 3/12 — even the easiest-to-hit mapping isn't reliable everywhere.

## By language (all 6 deliveries x clean/room = 12 cells each)
| en | hi | kn | ta | te | ml |
|---:|---:|---:|---:|---:|---:|
| 0/12 | 1/12 | 1/12 | 2/12 | 4/12 | 4/12 |

Counter to a naive "English is the model's best language" prior: **English scored 0/12**, the
worst of the six, while Telugu and Malayalam scored best. Reported as-is, not explained — this
suite can't separate "wavlm genuinely reads te/ml prosody better" from "ElevenLabs' en delivery
under these voice/tag settings is flatter than its te/ml delivery," and picking one story over the
other without more evidence would be exactly the overclaim DESIGN.md's "what this does NOT do"
section warns against.

## Confusion pattern (clean condition, collapsed across language)
Requested `anxious` and `sad` clips predominantly score top-label `neutral` (not fear/sadness) —
the model reads distressed-sounding TTS delivery as flat/calm far more often than as the
intended emotion. Requested `angry` splits between `neutral` and `disgust`. This is the useful
shape for W45.4: a "distress" acoustic signal built naively off wavlm's `fear`+`sadness` scores
would systematically under-fire on exactly the deliveries meant to represent patient distress.

## What this means for shadow output (W45.4, not yet built)
Per DESIGN.md's pre-registration: do not surface (even in shadow) a wavlm-derived "distress" or
"upset" signal without accounting for this — on this evidence, low fear/sadness/anger scores are
not strong evidence of a calm patient, they're close to wavlm's default read regardless of
delivery. `neutral`/`happy` separation is the acoustic lane's real strength; lead with that, treat
the negative-affect labels as weak/unreliable until shown otherwise on more than n=2/cell.

## Arm 2: Gemini 3.8 Flash as the listener (27 Sep, same 144 clips, 0 new ElevenLabs spend)
Same clips, same pre-registered bar shape, `emotion_judge_gemini.py` (ZDR route reused verbatim
from `lang_judge.py`). 144/144 judged, 0 errors.

| by delivery | wavlm | Gemini | | by language | wavlm | Gemini |
|---|---:|---:|---|---|---:|---:|
| neutral | 5/12 | **0/12** | | en | **0/12** | 5/12 |
| calm | 3/12 | **7/12** | | hi | 1/12 | 4/12 |
| anxious | 0/12 | 0/12 | | kn | 1/12 | 1/12 |
| angry | 0/12 | **6/12** | | ta | 2/12 | 5/12 |
| sad | 0/12 | 2/12 | | te | **4/12** | **0/12** |
| happy | 4/12 | 2/12 | | ml | 4/12 | 2/12 |
| **overall** | **12/72** | **17/72** | | | | |

**Neither engine is uniformly better — they fail on different labels and different languages.**
Gemini fixes `angry` (0→6/12) and helps `sad` a little (0→2/12) but goes to zero on `neutral`
(5→0/12, it reads plain delivery as something else almost every time) and stays at zero on
`anxious`. wavlm's best language (Telugu, 4/12) is Gemini's worst (0/12), and vice versa for
English (wavlm 0/12, Gemini 5/12) — the per-language ranking is an artifact of which engine is
being asked, not a property of the language; **do not read either engine's per-language numbers
as "this model handles Telugu/English well," full stop.**

**`anxious` is unreliable on BOTH engines, in every language, both conditions (0/12 each).** That
is the one label neither acoustic approach can currently be trusted on.

Gemini's separate 0-3 distress rating (not part of the forced-choice bar) orders sensibly by
requested emotion: angry 0.83, anxious 0.54, sad 0.33, neutral 0.29, calm 0.12, happy 0.04 — a
monotonic-ish read even on deliveries where the forced 6-way label missed. Worth carrying forward
as its own signal for W45.4 rather than discarding just because the label vote failed.

## Caveats (pre-registered, not discovered after seeing results)
- n=2/cell is thin. A larger suite (more case/line pairs per language) would tighten this; not
  built this session given the shared 60k-char ledger's remaining ~4.5k headroom.
- Room-acoustic condition is a software proxy (parallel-comb reverb matched to OPD 1's measured
  RT60/SNR), not the physical SELFTEST rig — see DESIGN.md.
- Acted/TTS delivery is a ceiling on real-room reliability, not a floor — see DESIGN.md.
