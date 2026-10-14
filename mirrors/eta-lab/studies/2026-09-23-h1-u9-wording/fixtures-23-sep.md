# H-1 U9 wording trial — synthetic fixtures (23 Sep 2026)

All INVENTED, non-PHI, no real patient/doctor identity — cleared under D1a (fixtures/invented text
may go to TypeSafe; real consult transcripts, D1b, may not, and none appear here). Three languages
per H-1's order: EN, HI-EN code-mixed, KN-EN code-mixed. "Designed" columns are MY intended answer per
field when writing the fixture, for comparing against Jev's actual answer once this can be scored —
same convention as the U6 heuristic-vs-scripted-Jev bench (jev-u6-route branch).

## F1 (EN) — clear recommendation, scheduled, patient agrees
"Looking at this, I think you need a laparoscopic gallbladder removal. I'd advise doing this within
the next two to three weeks, it's not something to leave too long. We can talk to the OT desk today
and get a date fixed. The procedure itself takes about an hour, you'd be in hospital one night."
Patient: "Okay doctor, if you think it's needed let's do it soon."
Designed: recommended=yes, firmness=scheduled, patient_response=agreed, urgency=yes, cost=no, second_opinion=no

## F2 (EN) — discussed, not recommended
"There is a surgical option for this, some people do go for it, but honestly for your case I don't
think it's necessary right now. Let's manage it with medication and see how you do over the next
couple of months first."
Designed: recommended=discussed_not_recommended, firmness=not_applicable, patient_response=not_stated,
urgency=no, cost=no, second_opinion=no

## F3 (EN) — no surgical topic at all
"Your blood pressure readings look better than last time. Keep taking the same tablets, cut down on
salt, and come back in a month for a repeat check."
Designed: recommended=no, firmness=not_applicable, patient_response=not_stated, urgency=no, cost=no,
second_opinion=no

## F4 (EN, hard) — hedged / soft mention, patient declines, cost + second opinion both raised
"It's an option, some surgeons would suggest it at this stage, but it's not urgent and I won't push
you. If you want, you could also get a second opinion before deciding. It would cost somewhere around
sixty to eighty thousand depending on the hospital." Patient: "I'd rather avoid surgery if possible,
let's hold off for now."
Designed: recommended=discussed_not_recommended (hedged, offered as an option not a recommendation —
the wording-trial question this fixture is FOR), firmness=suggested (if Jev instead reads it as yes),
patient_response=declined, urgency=no, cost=yes, second_opinion=yes

## F5 (HI-EN code-mixed) — clear recommendation, firm, no schedule yet
"Dekhiye, mujhe lagta hai aapko yeh operation karwana chahiye, this is something we should not delay
too much. Recovery mein around do hafte lagenge. Aap decide kar lijiye, hum agli visit mein date fix
kar denge."
Designed: recommended=yes, firmness=advised, patient_response=will_think, urgency=yes, cost=no,
second_opinion=no

## F6 (HI-EN code-mixed) — no procedure discussed, purely medication follow-up
"Aapki reports normal hain, koi surgery ki zaroorat nahi hai abhi. Bas yeh medicine continue kariye
aur teen mahine baad follow-up karwa lijiye."
Designed: recommended=no, firmness=not_applicable, patient_response=not_stated, urgency=no, cost=no,
second_opinion=no

## F7 (HI-EN code-mixed, hard) — strongly pushed, patient agrees same visit, cost discussed
"Main strongly advise karunga ki aap yeh surgery jaldi se jaldi karwa lein, please isko taalen mat.
Cost approximately pachaas hazaar hoga, insurance se kuch cover ho sakta hai." Patient: "Theek hai doctor,
jaisa aap kahen, main taiyar hoon."
Designed: recommended=yes, firmness=strongly_advised, patient_response=agreed, urgency=yes, cost=yes,
second_opinion=no

## F8 (KN-EN code-mixed) — discussed as one of several options, patient wants to think
"Nimma case alli, surgery ondu option agide, but medication kooda try madabahudu. Nimage yenu
comfortable anno adralli decide madi. No rush, think about it and let me know next visit."
Designed: recommended=discussed_not_recommended, firmness=suggested, patient_response=will_think,
urgency=no, cost=no, second_opinion=no

## F9 (KN-EN code-mixed) — clear recommendation, scheduled, second opinion explicitly offered
"Nimma reports nodidre, ee procedure madoke sariyagide, mattu doubt idre second opinion tegondkoli
parvagilla. Naanu next week ge OT date book madtini, alright na?" Patient: "Sari doctor, please book
madi."
Designed: recommended=yes, firmness=scheduled, patient_response=agreed, urgency=no, cost=no,
second_opinion=yes

## Coverage check (9 fixtures, before scoring)
- recommended: yes x4 (F1,F5,F7,F9), discussed_not_recommended x3 (F2,F4,F8), no x2 (F3,F6)
- firmness (of the 4 "yes" + F4's edge case): scheduled x2, advised x1, strongly_advised x1
- patient_response: agreed x3, will_think x2, declined x1, not_stated x3
- urgency_stated=yes x3, cost_discussed=yes x2, second_opinion_offered=yes x2 — each field has at
  least one true AND one false case, satisfying "test fixtures through the inverse"
- F4 is deliberately the hardest: hedged wording designed to probe whether "recommended" and
  "discussed_not_recommended" separate cleanly, the same kind of edge U7's "none_named vs
  cannot_tell" trial (../2026-09-23-jev-opp/TRIALS-23-SEP.md) found a real wording gap on.
