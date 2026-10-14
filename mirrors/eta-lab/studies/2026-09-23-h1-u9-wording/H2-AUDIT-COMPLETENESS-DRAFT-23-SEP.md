# H-2 — audit completeness wording, DRAFT (23 Sep 2026)

**STATUS: SCORED 23 Sep 2026 (jev-1.13.0) — see RESULTS-23-SEP.md.** This file is the v1 wording as drafted; the v2 firmness/urgency fix is in RESULTS. (Originally drafted before even-jev was reachable from this box.)

Per H-1's order text: "When recommended=yes: were indication, risks, alternatives (incl. conservative
management), expected recovery, and cost explained? Each yes/no/unclear with confidence. This is
U8-style completeness, not a verdict on the decision itself." U8 (note completeness, 4 nouls, one
state) was already trialled STRONG with plain noul wording and no variants needed
(../2026-09-23-jev-opp/TRIALS-23-SEP.md) — same pattern reused here rather than inventing a new shape.
"unclear" is not a third discrete Jev value: it falls out of the noul's own confidence band (plan
principle 4: ≥0.9 act / 0.5–0.9 cautious-or-review / <0.5 the other way), matching how U8's own
"unclear" cases were already read off confidence, not off a separate criterion.

Only meaningful when U9's `recommended=yes` — the caller skips asking these when recommended is
`no`/`discussed_not_recommended`, mirroring `firmness`/`patient_response`'s own `not_applicable`
handling in the U9 draft.

## The five nouls (P(yes) each)

**indication_explained** — "Did the clinician explain WHY this procedure is being recommended for
this patient (the medical reason, finding, or diagnosis behind it)? Answer only about the reason
stated in this consult, not whether the reason is medically sound."

**risks_explained** — "Did the clinician mention any risk, complication, or downside of the procedure
(even briefly, e.g. 'there is a small risk of infection')? A generic reassurance with no risk actually
named ('don't worry, it's a safe procedure') does not count."

**alternatives_explained** — "Did the clinician mention any alternative to the procedure, INCLUDING
continuing with medication or conservative management instead of surgery? Presenting the procedure as
the only option, with no alternative named, does not count."

**recovery_explained** — "Did the clinician give the patient any sense of what recovery involves —
time off, restrictions, how long until back to normal, or what to expect after the procedure?"

**cost_explained** — "Did the clinician explain the cost of the procedure — an amount, a range, or
what insurance would cover? Distinct from U9's cost_discussed: cost_discussed is whether cost came up
at all; cost_explained is whether an actual figure or coverage detail was given, not just 'we can
discuss cost later'."

## Fixtures (4, matching U8's own economical count — its trial needed no more)

All INVENTED, non-PHI. All four are `recommended=yes` consults (H-2 only applies then) — reusing the
recommended=yes shape from U9's F1/F5/F7/F9 but written fresh so every one of the five completeness
dimensions is unambiguous, per U8's own fixture-writing lesson ("F1's transcript never actually named
a drug, so the noul correctly read false even though I intended true — write what you mean, not what
you assume the reader infers").

### G1 (EN) — complete on all five
"You have gallstones, in the gallbladder, and they are causing the pain, that's WHY I'm
suggesting we remove it. There's a small risk of bleeding or infection with any surgery, and a very
small chance of bile duct injury, but it's a common, low-risk procedure. If you'd rather not operate,
we could try dietary changes and monitor it instead, though the stones won't go away on their own.
Recovery is usually one night in hospital, back to light activity in a week, no heavy lifting for
about a month. The procedure costs around forty-five thousand rupees, and your insurance should cover
most of it."
Designed: indication=yes, risks=yes, alternatives=yes, recovery=yes, cost=yes

### G2 (EN) — minimal, nothing explained
"You need this surgery. Let's get it scheduled for next week."
Designed: indication=no, risks=no, alternatives=no, recovery=no, cost=no

### G3 (HI-EN code-mixed) — indication + risks given, no alternative, recovery given, cost vague
"Aapke reports mein yeh dikha hai isliye operation zaroori hai. Thoda risk hota hai infection ka,
lekin usually theek ho jata hai. Do din hospital mein rehna padega, phir ek hafte mein normal ho
jaoge. Cost ke baare mein baad mein baat karte hain, abhi surgery pe focus karte hain."
Designed: indication=yes, risks=yes, alternatives=no, recovery=yes, cost=no (deliberately vague
"baad mein baat karenge" — cost NOT explained, only deferred, the same distinction cost_explained's
own wording calls out)

### G4 (KN-EN code-mixed, hard) — no indication, alternative offered, risk vaguely reassured (not
named), recovery not mentioned, cost explained
"Idu common procedure, don't worry, safe agide. Nimge medication continue madoke kooda option ide,
adre naanu surgery recommend madtini. Cost around thirty thousand agutte, insurance cover madutte
antha nan think."
Designed: indication=no (no reason given, just "I recommend it"), risks=no (reassurance with no risk
NAMED — the exact case the wording's own "does not count" clause exists for), alternatives=yes
(medication continuation offered), recovery=no, cost=yes

## Coverage check
Each field has at least one yes AND one no across the 4 fixtures (indication: 1/3, risks: 2/2,
alternatives: 1/3, recovery: 2/2, cost: 2/2) — thinner on indication/alternatives than U8's own 4-cell
balance; if a live trial shows a wording gap on either, a 5th fixture with indication=no,
alternatives=yes (or vice versa) isolates it. G3 and G4 are the two designed to test the "does not
count" clauses specifically (deferred cost, unnamed-risk reassurance) — the same class of edge that
made U8's own F1 an unintentional but instructive lesson rather than a clean pass.
