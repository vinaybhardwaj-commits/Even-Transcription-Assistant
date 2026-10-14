# JEV-414 prompt trials (split-speaker, 25 Sep 2026, box clock ~20:45-21:20)

All fixture text INVENTED (D1a). Fixtures target the boundary classes; results are
the per-question `choice` (+ prob of the chosen class, conf). Model jev-1.13.0.
Expect = the class the 337c addendum-1 rubric assigns.

## label200, 8 fixtures

V1 (per-item instructions WITHOUT the state-key binding): every fixture answered
`wrong_language` at prob ~0.27-0.35, conf 0.19-0.22 — flat, classless. FAILURE MODE
RECORDED: multi-item state requires each question to name its entry.

V2 (binding clause, first wording): f1 romanised-readable -> romanised_readable
0.89/0.85 ✓; f3 English-lyric under 'und' -> wrong_language 0.49 vs readable 0.47,
conf 0.36 (borderline); f4 ok-loop -> garbled 0.74/0.68 ✓; f8 Devanagari under 'ta'
-> readable 0.60 ✗ (expect wrong_language).

V3 = FROZEN lv1.1 (adds script-mismatch + non-clinical-register note to
wrong_language): f1 romanised_readable 0.83/0.78 ✓; f2 Kannada-script readable
0.98/0.97 ✓; f3 lyric wrong_language 1.00/0.99 ✓; f4 loop garbled 0.82/0.78 ✓;
f5 word-salad garbled 0.82/0.77 ✓; f6 single "ok" cannot_tell 0.36 conf 0.21 ✓
(correctly unsure); f7 Kannada salad garbled 0.90/0.87 ✓; f8 Devanagari-under-ta
wrong_language 0.63/0.52 ✓. 8/8 on class; the two genuinely ambiguous fixtures
(f6, f8) carry low conf as designed. Note: the f3 call's instructions accidentally
contained a doubled word ("clinical clinical") — frozen text in jevcfg414.py is
clean; V3 numbers still valid (typo did not move the answer).

## ba106, 5 invented pairs

ba-v1 (same/neither boundary weak): p1 A-good/B-salad -> A_better 0.97/0.96 ✓;
p2 both-faithful-differently-phrased -> B_better 0.48 conf 0.37 (style crept in);
p3 both-loop -> same 0.60/0.53 ✗ (expect neither_readable); p4 A-readable/B-shuffled
-> A_better 0.68/0.62 ✓ — AND **p4's answer was DROPPED by the API** (4 questions
in, 3 out). Recorded as the reason merge_answers.py aborts on any missing key.

ba-v2 (fidelity-not-style clause; same still swallowed p3): p1 A_better 0.92/0.90 ✓;
p2 B_better 0.50 conf 0.38; p3 same 0.62/0.52 ✗; p4 A_better 0.70/0.62 ✓.

ba-v3 = FROZEN bv1.1 (same = "each readable, coherent"; neither_readable carries
the "choose this and not same" priority): p3 both-loop -> cannot_tell 0.42 /
same 0.27 / neither_readable 0.12, conf 0.27 — no longer wins as `same`; the
degenerate fixture is honestly low-confidence, which my conf report exposes to
the gate scorer. p5 two-faithful-variants -> same 0.62/0.52 ✓. Accepted; ba106 is
gate-collapsed to preferred-version anyway, where {same, neither, cannot_tell} all
mean "no preference".

## rate20, 4 invented excerpts (frozen rv1.1, one shot)

r1 romanised-Hindi consult -> yes 1.00/0.99 ✓; r2 double-loop -> no 1.00/0.99 ✓;
r3 fluent-English weather/sports broadcast under 'en' -> no 0.93/0.90 (Jev treats
non-clinical broadcast as not readable AS CLINICAL SPEECH — consistent with the
frozen instruction wording; recorded because humans may split differently; rate20
is descriptive for the gate (414.4 uses label200+ba106 only)); r4 Kannada-script
consult -> yes 1.00/0.99 ✓.

## Known input-quality risk (herdr-kit #2826, 21:1x)

Google NMT returned a semantically WRONG gloss for a romanised-Tamil test phrase.
label200's biggest flagged class IS romanised Indic; Jev and V read the SAME gloss
(eta-refuter #2811 point 4). The wording judges "the LINE ITSELF (not gloss
quality)" but cannot fully cancel a shared wrong gloss; the gate report must carry
the gloss-on/off split and the 0.69-0.96 CP interval on 26/30.

## Post-fix sanity (lv1.2/bv1.2), invented fixtures, before re-freeze

g1 clinical English under 'und' -> readable 0.61/conf 0.51 ✓ (the #2838 fix 1 case;
lv1.1 said wrong_language). g3 lyric under 'und' -> wrong_language 1.00/0.99 ✓
(register clause intact). q6 A=fluent subscription-stock vs B=rough clinical ->
B_better 0.82/conf 0.76 ✓ (fix 2's fluency-bias guard bites). Verdicts recorded for
eta-refuter's two-criteria re-check. build_batches switched to PAGE SEED sources;
9/9 tests green incl. both rate20 gloss grains.
