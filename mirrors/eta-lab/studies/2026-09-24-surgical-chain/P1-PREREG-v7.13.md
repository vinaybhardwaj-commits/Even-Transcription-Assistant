# SURGICAL-CHAIN-LINKER P1: pre-registration v7.13 (linker, 24 Sep 2026): the ruling-200 coverage pass on the below-floor items (diagnostic only)

Addendum to v7.12; nothing earlier is edited. **Class key sealed, no class join.** Code: `p1/link3_coverage.py`, committed with this file, before it runs. It also commits the language-limited fix of v7.12 that a first run had missed (an early exit in the scorer skipped the flagged chain; removed).

## R1. What it is, and what it is not
Fable ruling 200 (A): the eight below-floor items may have the right audio outside the pre-registered candidates (the plus or minus 10 minute window, a clock offset between calendar and tape, a room outside the shortlist). This pass tests that **as a diagnostic stratum, never as a link-3 result**. **The floor (0.50) and the question (`LINK_QUESTION_V2`, v7.6) are unchanged.** The pass reads no truth and no class.

## R2. The rule, fixed now
1. **Widen** to the consult plus or minus 60 minutes and to **every room that has text** for that day in the widened span: production text (Neon `stt_turn` cues) and finished HIST outputs, **kept apart per room, never mixed inside a room**. The own prescription text is the one already de-identified in the main run.
2. **De-identify and gate before any call** (same redactor and gate as the main run); only English turns are scored; a document that fails the gate is skipped and counted.
3. **Slide 10-minute sub-windows, step 5 minutes**, over the widened span; score a sub-window against the own prescription only if it has at least 3 English turns and 60 characters. Record per item the **best score, its room label (pseudonymous), its source, and its offset from the Rx time** (sub-window centre minus the prescription's `timestamp`, in minutes), plus the number of rooms with text per source and the number of calls.
4. **Report the offset distribution** and the best score per item beside the item's best score in the pre-registered window. A best score at or above 0.50 at a non-zero offset means a coverage or clock problem; below 0.50 everywhere means the visit is not in the text that exists (or not matched by a complaint-and-diagnosis-only prescription).

## R3. Limit, stated
Text exists in the widened span only where production STT ran (four of the eight items, August days, one or two rooms) or HIST outputs already exist (one to five rooms, mostly the link-3 windows). **This pass is not "every room with audio that day": that needs new transcription** (a window list was requested from hist-miner, #826). The pass is re-run when it lands.

## R4. Part B of the ruling (translate the language-limited items) is not run
De-identification omits Indic-script fields by design (the model finds no person names in Indic script): of the 134 non-English turns in the 11 rooms over half non-English, 102 are Indic script and 32 Latin script. De-identify-then-translate would reach only the 32. Which of the alternatives to use is Fable's decision (#826); nothing is sent to an external model until then.
