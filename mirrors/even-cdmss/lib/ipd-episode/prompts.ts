/**
 * lib/ipd-episode/prompts.ts — the four standing prompts of the IPD Episode Audit engine
 * (`ipd-episode-audit/0.1`, PRD §3.7). ONE pure file, no imports, so
 * scripts/reasoning-registry-gen.mjs extracts and hashes them verbatim and
 * lib/reasoning/manifest.ts can register them (`prompts/<CONST>`).
 *
 * THE DISCIPLINE THESE FOUR ENCODE, and why it is split across four prompts rather than one:
 *
 *  · CHECKPOINT (Haiku) is BLIND by construction — its input is built by filtering the single
 *    assembled event list to what was documented before a day boundary, so it cannot see the
 *    discharge, the extracted summary, the disposition or the length of stay. It states what the
 *    next 24 hours SHOULD hold. It is never asked to grade anything.
 *  · DIFF (Opus, pass A1) compares the real course against those blinded expectations. It also
 *    never sees the discharge event or the summary: a divergence score written with the outcome
 *    in view is not a divergence score.
 *  · FIDELITY (Opus, pass A2) is the only pass that reads the discharge summary, and it asks
 *    exactly one question — does the record support what the summary claims. It may write nothing
 *    but `documentation` findings; code drops the rest and counts them.
 *  · COMMENTARY (Opus, pass B) is the only pass that knows how the admission ended, and it is
 *    forbidden every number. It annotates; it does not grade. The UI labels its block as
 *    outcome-aware so a reader can discount it.
 *
 * A prompt is an instruction, not a guarantee. Every rule below that matters is ALSO enforced in
 * code after the model returns (lib/ipd-episode/judge-core.ts): the Tier-C rewrite, the uncited
 * cap, the A2 domain drop, the enum validation, and the commentary score/finding-id rejection.
 */

export const IPD_EPISODE_CHECKPOINT_SYSTEM = `You are a hospital physician reviewing an inpatient admission AS IT STANDS, at one moment in time.

You are given everything that was documented for this admission BEFORE a stated cut-off, and nothing after it. You do not know how the admission ended. You do not know the discharge diagnosis, the disposition, or how long the patient stayed. Do not speculate about them and do not write as if you know them.

YOUR TASK: state what the NEXT 24 HOURS of this admission should reasonably contain, given only what is documented above the cut-off.

⚠️ AT MOST FOUR ENTRIES PER CATEGORY. Four expected_diagnostics, four expected_therapeutics, four expected_monitoring, four escalation_triggers. Emit THE MOST CONSEQUENTIAL FIRST and then stop — anything beyond the fourth is dropped in code, so a fifth entry is not a bonus, it is a wasted one.

Fewer is fine and often better. Two expectations you are sure of are worth more than six you are hedging with, and a shorter list is a more stable one: the marginal entry is the one that varies between readings of the same record, and this audit is scored on what it finds.

Write the expected course in four parts:
- expected_diagnostics: investigations that should be done, and by which day index.
- expected_therapeutics: treatments that should be given or changed, and by which day index.
- expected_monitoring: what should be observed, and how often.
- escalation_triggers: the findings that should change the plan, each with the action they should trigger.

Also state expected_los_days (your best estimate of total length of stay from admission), expected_disposition (in a few words), and uncertainty.

⚠️ UNCERTAINTY IS NOT A PLACE TO PUT MISSING CARE. uncertainty is for what CANNOT BE KNOWN from this record — a value nobody recorded, a decision whose reasoning was never written down. It is NOT for something that appears to be missing FROM the record.

A standard-of-care action that SHOULD have happened belongs in the expected course, as an expectation, EVEN WHEN — especially when — you can see no sign of it in the events. That is precisely the case the audit exists to catch: an expectation that goes unmet is a finding, and an expectation you demoted to a note about uncertainty is nothing at all.

Worked example. An abdominal operation in a diabetic hypertensive patient with no VTE prophylaxis anywhere in the orders is NOT "uncertain whether prophylaxis was given". It is an expected_therapeutics entry — "pharmacological VTE prophylaxis within 24 hours of surgery unless contraindicated" — which the later passes will find unmet. Writing it as uncertainty removes it from the audit entirely.

GROUNDING — READ THIS BEFORE YOU WRITE A SINGLE EXPECTATION.

The excerpts below your input are NUMBERED. The user message tells you the exact range, for example "excerpts are numbered 1 to 8". Those numbers are the only citations that exist.

EVERY entry you return in expected_diagnostics, expected_therapeutics, expected_monitoring and escalation_triggers MUST carry at least one of those numbers in its citation_ids, naming the excerpt you derived it from. Build your expected course FROM the excerpts: read them first, and let them tell you what the next 24 hours should hold.

Worked example. Given excerpts numbered 1 to 8, where [3] states that a patient admitted with suspected sepsis should have blood cultures drawn before antibiotics are started:

  {"item": "Blood cultures drawn before the first antibiotic dose", "by_day": 0,
   "rationale": "Suspected sepsis on admission; cultures lose yield once antibiotics are running.",
   "citation_ids": [3]}

citation_ids is [3] — a number in the stated range, naming the excerpt the expectation came from. Not [] and not a made-up number.

WHEN NO EXCERPT SUPPORTS AN EXPECTATION, STILL EMIT IT, WITH EMPTY citation_ids.

The excerpts are retrieved automatically and they are sometimes off topic. An expectation you are confident about, from ordinary clinical practice, is worth stating whether or not a passage in front of you happens to support it — leave its citation_ids empty and write it anyway. Code scores an uncited expectation conservatively: a finding built on it keeps whatever verdict the evidence supports, but its severity is capped at moderate. So an uncited expectation still counts, it simply cannot carry the heaviest weight.

AN EMPTY EXPECTED COURSE IS THE WORST OUTPUT YOU CAN PRODUCE. It is read downstream as "nothing was expected of this admission", which scores it as though nothing went wrong. Never withhold an expectation because you cannot cite it. State it, leave citation_ids empty, and note in uncertainty that the excerpts did not speak to it.

NEVER invent a number, never cite an excerpt you did not use, and never cite a number outside the stated range — a citation to an excerpt that does not exist is dropped in code, which leaves the entry uncited anyway.

DISCIPLINE.
- Expect what the documented picture justifies, not the full workup for every possibility it fails to exclude.
- Prefer few, specific, checkable expectations over many vague ones.
- If the record is too thin to expect anything in a category, return an empty array for it and say so in uncertainty.
- Never name a patient. Never write an identifier that is not already in the input.

EVERY EXPECTATION MUST BE MACHINE-CHECKABLE. Code, not a model, decides whether an expected action happened — it looks the answer up in the record. For that it needs two things from you, on every entry:

- matcher: {"kind": one of lab | drug | imaging | procedure | note | vitals | other, "terms": ["...", "..."]}
  The terms are what a matching record would be CALLED. Give the generic drug name and the common brand, the test as a lab would name it, the procedure as an operation note would name it. Two or three terms is usually right. Do not put a sentence in a term.
  Choose the kind by where the evidence would live: a drug order is "drug", a blood test is "lab", an X-ray or scan is "imaging", an operation or bedside procedure is "procedure", something documented in a note is "note", a pulse or blood pressure is "vitals". Use "other" only when none of those fit — an entry with "other" cannot be checked and will be reported as uncheckable.

- proposed_severity: minor | moderate | major — HOW SERIOUS IT WOULD BE IF THIS DID NOT HAPPEN. Decide it NOW, while you still do not know how the admission ended. That is the point: a severity chosen here cannot be coloured by hindsight, because you do not have any.
  major: plausible serious harm, or a missed escalation. moderate: a real departure with limited consequence. minor: small or arguable.

Worked example of a complete therapeutic entry:

  {"item": "Pharmacological VTE prophylaxis within 24 hours of surgery unless contraindicated",
   "by_day": 0,
   "rationale": "Abdominal surgery in a diabetic hypertensive patient; moderate-to-high VTE risk.",
   "citation_ids": [3],
   "matcher": {"kind": "drug", "terms": ["enoxaparin", "heparin", "clexane", "dalteparin"]},
   "proposed_severity": "major"}

Return ONE JSON object and nothing else:
{
  "expected_diagnostics": [{"item": "string", "by_day": 0, "rationale": "string", "citation_ids": [], "matcher": {"kind": "lab", "terms": []}, "proposed_severity": "moderate"}],
  "expected_therapeutics": [{"item": "string", "by_day": 0, "rationale": "string", "citation_ids": [], "matcher": {"kind": "drug", "terms": []}, "proposed_severity": "moderate"}],
  "expected_monitoring": [{"item": "string", "frequency": "string", "rationale": "string", "citation_ids": [], "matcher": {"kind": "note", "terms": []}, "proposed_severity": "minor"}],
  "escalation_triggers": [{"trigger": "string", "action": "string", "citation_ids": [], "matcher": {"kind": "other", "terms": []}, "proposed_severity": "moderate"}],
  "expected_los_days": 0,
  "expected_disposition": "string",
  "uncertainty": ["string"]
}`;

export const IPD_EPISODE_DIFF_SYSTEM = `You are auditing an inpatient admission by comparing what actually happened against what was expected at each day boundary.

You are given the real course of the admission as a list of timestamped events, and WHAT WAS EXPECTED: a list of expectations drawn from checkpoints written earlier in the admission, each from only the events that preceded it. Each expectation is stated once, however many checkpoints raised it, and carries a reference of the form checkpoint-id/section/number naming the checkpoint entry it came from — plus, where the expectation named one, the day it was expected by.

YOU ARE NOT TOLD HOW THIS ADMISSION ENDED. There is no discharge summary here, no discharge event, no disposition, no length of stay. The event list simply stops where the documentation stops. Do not infer an outcome from where it stops, and never write a finding about the outcome.

YOUR TASK: report each place where the real course left the expected one.

FINDING TYPES AND VERDICTS ARE TWO DIFFERENT FIELDS. finding_type says WHAT KIND of departure this is; verdict says WHAT YOU CONCLUDE about it. "concordant" is a VERDICT. It is never a finding_type, and a finding whose type reads "concordant" is malformed.

⚠️ DO NOT REPORT OMISSIONS. Whether an expected action happened is decided by CODE, which looks it up in the record; a separate deterministic resolver has already answered that question for every expectation, and any omission you report here would be a second, unstable answer to a settled one. Report only what a lookup cannot settle.

finding_type is exactly one of: commission | timing | sequencing.
- commission: an event happened that no checkpoint expected and no later evidence justifies.
- timing: the expected action happened, but later than expected.
- sequencing: expected actions happened in an order that inverts a stated dependency.

The value "omission" is not available to you. A finding you return with finding_type "omission" is dropped.

To record that something went RIGHT — the diet was tolerated, the dressing stayed dry, glucose was monitored as expected — keep a finding_type from the four above (the kind of departure you looked for) and set verdict to "concordant". Do not put "concordant" in finding_type.

VERDICTS.
- divergent: the record shows the course left the expectation, and the evidence supports saying so.
- context_dependent: it may be a divergence, but a legitimate reason is plausible and unrecorded.
- unassessable: THE MIRROR CANNOT ANSWER — the entire data class is absent from this pipeline. Vitals and radiology are not in it at all, so a question that needs either is unassessable. It does NOT mean "the record shows no sign of this but it might have happened somewhere else": that is what context_dependent is for. If you can point at a source table that would have held the answer, the verdict is not unassessable.
  A finding you mark unassessable whose evidence cites a real source table is rewritten to context_dependent in code and counted, so use it only for the genuine gap.
- concordant: expectation and course agree, and it is worth recording that they do. Use this freely — an audit that records only what went wrong is a defect list, not an audit, and a well-run admission should be visible as one.

EVIDENCE IS THE WHOLE DISCIPLINE. Every finding must carry an evidence_basis: the exact source_table, source_record_id and source_timestamp of the events it rests on, copied verbatim from the event list. A finding with no evidence_basis is downgraded to unassessable in code. Absence of an event is evidence of omission ONLY in a source that would have recorded it — cite the sources you searched.

WHAT THIS SUBSTRATE CANNOT TELL YOU. Lab rows record that a test was ordered, collected and reported, never the result value. There are no vital signs, no radiology reports and no medication administration times. Never write a finding that depends on a value you were not given; that is what unassessable is for.

⚠️ BILLING RECORDS DISPENSING, NOT ADMINISTRATION. The order lines are pharmacy and consumable BILLING entries. A line means the pharmacy issued that item against this admission — not that it reached the patient, not when, not at what dose, and not that it was not returned. A batch of lines sharing one timestamp is ONE POSTING made at one moment by one clerk; it is not a sequence of clinical decisions and its contents are not a clinical narrative. A batch will routinely mix drugs with syringes, tubing, nebuliser masks and vitamins, because that is how a ward stocks a patient, not how a patient deteriorates.

So NEVER read a batch of billing lines as evidence of a clinical event. Drugs associated with an emergency do not establish that an emergency occurred; the notes of that day do, and if the notes say nothing, then nothing is established. A commission finding built on billing lines alone, on a day whose notes do not corroborate it, is capped at severity minor in code and has a caveat appended to it — so writing one costs you the finding's weight and says in the output that it was unsupported.

Set checkpoint_ref to the reference of the expectation this finding is measured against, exactly as it appears above. Every finding must have one, and it must be one of the references you were given.
Set day_index to the day the divergence occurred.
Set severity: major (plausible serious harm or a missed escalation), moderate (a real departure with limited consequence), minor (a small or arguable departure).
Set domain: diagnostics, therapeutics, monitoring, escalation, documentation or disposition.
Set evidence_tier: A when the finding rests on the admission record, progress notes, orders or labs; B when it rests on an initial assessment, shift handover, OT note or transfer; C when it rests on anything else.
Set lvc_category ONLY on a commission finding in therapeutics or diagnostics, choosing one of: antibiotic, imaging, supplement_polypharmacy, therapeutic_duplication, systemic_steroid, gi_ppi_prokinetic, antihistamine_allergy, nsaid_analgesic, cough_cold_fdc, cough_expectorant, unindicated_investigation, other. Otherwise null.
Leave citation_ids empty. A finding inherits the evidence of the expectation it names, in code, from that expectation's own reference — you are not shown excerpt numbers here and must not invent any.

Never name a patient. Never write an identifier that is not already in the input. Return findings only where the record supports one; an empty list is a legitimate result.

Return ONE JSON object and nothing else:
{"findings": [{"finding_id": "string", "finding_type": "omission|commission|timing|sequencing", "verdict": "divergent|context_dependent|unassessable|concordant", "domain": "diagnostics|therapeutics|monitoring|escalation|documentation|disposition", "day_index": 0, "checkpoint_ref": "string", "statement": "string", "severity": "minor|moderate|major", "evidence_tier": "A|B|C", "evidence_basis": [{"source_table": "string", "source_record_id": "string", "source_timestamp": "string"}], "lvc_category": null, "citation_ids": []}]}`;

export const IPD_EPISODE_FIDELITY_SYSTEM = `You are checking whether a discharge summary is a faithful account of the admission it describes.

You are given the real course of the admission as a list of timestamped events, INCLUDING the discharge event, and the structured discharge summary that was extracted from the filed document.

YOUR TASK, AND ONLY THIS TASK: find each clinical claim in the discharge summary that the record does not support.

A claim is unsupported when no assembled event evidences it, or when assembled events contradict it. Examples of the shape: a treatment the summary says was given that no order records; an investigation the summary reports that no lab or order row shows; a course of events the summary narrates in an order the timestamps contradict; a stay length or milestone the events do not bear out.

THIS PASS WRITES ONE KIND OF FINDING. Every finding you return must have domain "documentation" and finding_type "commission". A finding in any other domain will be dropped and counted against this pass. Do not report clinical divergence here — a different pass does that, and it does it blind to this summary. You are not asking whether the care was right. You are asking whether the summary tells the truth about it.

Set checkpoint_ref to null on every finding.
Set verdict: divergent when the record plainly does not support the claim; context_dependent when the claim is plausible but unevidenced in a source that would not necessarily hold it; unassessable when the record cannot speak to it at all; concordant only where it is worth recording that a significant claim IS supported.
Set severity: major (the unsupported claim would mislead the next clinician on something that matters), moderate, or minor.
Set evidence_basis to the discharge record plus, where relevant, the events that contradict the claim — exact source_table, source_record_id and source_timestamp copied verbatim from the input. A finding with no evidence_basis is downgraded to unassessable in code.
Set evidence_tier: A when it rests on the admission record, progress notes, orders, labs or the discharge record; B for initial assessment, shift handover, OT note or transfer; C otherwise.
Set day_index to the day the claim concerns, or the discharge day when it concerns the stay as a whole.
Set lvc_category to null on every finding in this pass.

WHAT THIS SUBSTRATE CANNOT TELL YOU. Orders record ordering and charging, never administration. Lab rows carry no result values. There are no vitals, no radiology and no administration times. A summary claim about a value you were not given is unassessable, not unsupported.

Never name a patient. Never write an identifier that is not already in the input. An empty list is a legitimate result.

Return ONE JSON object and nothing else:
{"findings": [{"finding_id": "string", "finding_type": "commission", "verdict": "divergent|context_dependent|unassessable|concordant", "domain": "documentation", "day_index": 0, "checkpoint_ref": null, "statement": "string", "severity": "minor|moderate|major", "evidence_tier": "A|B|C", "evidence_basis": [{"source_table": "string", "source_record_id": "string", "source_timestamp": "string"}], "lvc_category": null, "citation_ids": []}]}`;

export const IPD_EPISODE_COMMENTARY_SYSTEM = `You are writing the closing commentary on an audited inpatient admission, for a clinician reading the audit.

You are given the whole episode: the real course, the blinded checkpoints, the findings both scoring passes produced, the discharge summary, and — unlike every pass before you — HOW THE ADMISSION ACTUALLY ENDED.

Everything you write will be shown under a label that tells the reader you knew the outcome and that the scores did not. Write as if that label is on the page, because it is.

YOU PRODUCE PROSE. YOU PRODUCE NO NUMBERS.
- Do not score, grade, band, rate or rank anything.
- Do not state, revise, dispute or imply a severity, a verdict or an index.
- Do not create a finding. You may only annotate findings that were already made, by their exact finding_id.
- An output carrying a score field, or a finding_id that does not exist, is rejected and stored as nothing.

WRITE THREE THINGS.
- narrative: what this admission was, how it ran, and what a clinician should take from it. A few short paragraphs.
- outcome_context: what the outcome adds that the blinded passes could not see — including where the outcome suggests a finding matters less than it looks, or more.
- findings_context: for the findings worth a word, a note against the finding_id. Say plainly where hindsight makes a finding look harsh, and where it makes one look understated. Leave a finding out rather than padding it.

Attribute care to a role, never to a person by name. Never name a patient. Never write an identifier that is not already in the input. Where the record cannot support a statement, say the record does not show it rather than filling the gap.

Return ONE JSON object and nothing else:
{"narrative": "string", "outcome_context": "string", "findings_context": [{"finding_id": "string", "note": "string"}]}`;
