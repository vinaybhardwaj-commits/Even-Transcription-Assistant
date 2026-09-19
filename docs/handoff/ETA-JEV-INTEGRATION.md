# ETA — how Jev is used, across the whole programme

Date: 19 Sep 2026
Author: Fable (orchestrator). **STANDING DOCUMENT — read before any ETA build.**
Status: RULED. Supersedes nothing; adds a tool and a role.

---

## 0. What Jev is, in one paragraph

TypeSafe's "System One": text state in, **typed questions** out, answers as **probabilities** rather than
prose. Three primitives — `noul` (P(yes)), `choice` (one option from a set, with a probability per option)
and `score` (a position on an ordered scale). It is reachable here through the **`even-jev` MCP on the
Mini** (`~/dev/even-jev-mcp`, launcher `run.sh`, key at `~/.config/even-jev/key`, both verified present
19 Sep), exposing two tools: `jev_ask` and `jev_review`.

**Use it wherever code must branch on a judgement about text and a plain LLM prompt would give an
unquantified answer.** Not for generation, extraction, arithmetic, counting, dates, audio, images or
embeddings — it documents itself as bad at numbers and dates, and it cannot hear anything.

---

## 1. THE HARD LINE: two uses, two permissions. Do not blur them.

| | **Use A — development tool** | **Use B — product component** |
|---|---|---|
| What goes to the vendor | Code, diffs, synthetic fixtures, question wording | **Real consult transcripts** |
| Examples | `jev_review` on a Builder's diff; trialling question wording on invented text | Arm D reading a room window's transcript |
| Gate | **OPEN.** The MCP is installed and keyed. Nothing patient-related crosses. | **OPEN since 18 Sep 2026** — V cleared D1 in Cowork: Even is on a TypeSafe trial with no training on our data and zero data retention. J4 may run once J1–J3 pass refutation. |
| Status 19 Sep | **In force** | **Unblocked; J4 after J1–J3 refutation.** |
| Clearance record | — | V, Cowork 18 Sep 2026 (session_01TqJL9cNusj2Yfp9KeoqPRe): "I'm in a special trial and they've promised that they do not train off of our data and there is Zero data retention." Relayed by the orchestrator; see spec §0 clearance record. |

**The installed MCP does not clear D1.** Having the tool wired up and being allowed to send it a patient's
consultation are different facts. Use A needs no permission beyond V having installed it; Use B needs V to
say so in words. A Builder or Refuter that sends real transcript text to Jev without that has committed a
data-governance breach, not a build error.

**The practical consequence is good news:** every Jev *workflow* benefit below is available now, on
fixtures and diffs, while the product question waits on V.

---

## 2. Use A.1 — Jev joins the refutation loop (CHANGE TO THE STANDING ROLE SPLIT)

The loop was **Fable → Builder → Refuter → Fable**. It stays. What changes is what the Refuter has.

**After** the Refuter has read the diff itself and rerun the tests itself, it may call `jev_review` with the
task and the diff, and use the low-scoring dimensions **as leads to go verify**. It cites Jev as a lead and
never as a verdict.

Three rules, and they are not negotiable:
1. **`jev_review` never runs before the Refuter's own read and test rerun.** A calibrated second opinion
   that arrives first becomes the first opinion, and the Refuter starts confirming it instead of hunting.
2. **A Jev score is never a finding.** A finding is a defect the Refuter reproduced. "Jev scored error
   handling 4/10" is a lead; "this throws on a NULL `room_day_id`, here is the row" is a finding.
3. **The verdict is never delegated.** SOUND / SOUND WITH FINDINGS / UNSOUND stays the Refuter's, and
   sign-off stays Fable's. Jev has no vote.

**Why this earns its place.** Today's S1 refutation found the slot-grid defect by reading the diff and
querying live rows — a Jev review would not have found it, because it is a data-shape bug invisible in the
code. That is the point: Jev widens the net over the dimensions a reader skims, and the human-equivalent
reading still has to happen. It is an addition to the Refuter, not a discount on it.

## 3. Use A.2 — trial the question wording BEFORE it is hard-coded

Any Jev question that will end up in a prompts module gets trialled first:

1. Write the state shape and 3–6 candidate wordings.
2. Run them against 3–5 **fixture** items chosen to cover the boundary cases (invented text, never a real
   consult — this is Use A).
3. Record question ids, wording, probabilities and confidence in
   `docs/handoff/scratch/jev-prompt-trials-<date>.md`.
4. Pick the wording whose probabilities **separate** the cases, not the one that sounds best.
5. Hand the Builder settled wording as a **versioned prompts module**.

A Builder is never asked to invent question wording mid-build. Wording is a design decision and it is
Fable's, informed by the trial.

## 4. Use A.3 — bench before wiring

Any Jev signal that will drive production behaviour is first run **offline against labelled truth** and
reported with recall, precision, calibration (reliability bins and ECE), token cost and latency — and only
then gated in behind a flag. This is already Arm D slice J4's shape; it is now the rule for every Jev
signal, not just Arm D's.

---

## 5. How Fable calls it: it does not

**From Cowork, the orchestrator never calls `even-jev` itself.** It delegates to a Sonnet agent that pipes
JSON-RPC over `mcp__remote-devices__tailscale-shell__run_on` (host `mini`), and that agent returns **only
the answers and the stderr audit line — never the state text**. In a Claude Code session on the Mini the
tools are called directly.

This matches the standing browser rule for the same reason: the orchestrator judges returned data, it does
not operate the instrument.

Both tools screen for **credentials** and refuse bodies over 256 KB, failing closed. **They do not screen
for patient data.** That screen is §1, and it is human.

---

## 6. What this changes in the current build plan

- **LANE 1A gains a standing tool, not a new slice.** §2 applies to every refutation from now on, starting
  with the next one.
- **Arm D (J1–J3) is unblocked to build today** against a mock provider and fixtures, exactly as the spec
  already required. J4 still waits on D1.
- **Slice J0 gets more important, not less.** Jev is English-primary and the skill is explicit: *translate
  first*. J0 is the translation step, and it runs **on the Mini**, so it needs nothing from the vendor.
- **Ordinal labels, not timestamps**, in any state sent to Jev (W1, W2, …) — already in the Arm D spec §1,
  now a programme-wide rule. All time arithmetic, thresholds and arbitration live in code.
- **`prompt_version` is stored with every persisted Jev answer**, so results stay comparable when wording
  changes. Already in the Arm D schema; now the rule everywhere.
- **Cost is not a constraint at this scale.** $42 per billion input tokens, output free; a 4k-token call is
  well under a cent. Batch questions against one state; do not fan out calls to save money.

## 7. Things that will bite

- **Related answers are not guaranteed consistent** — `started` and `ended` can both come back high on the
  same window. Code arbitrates. Never ask Jev to be consistent.
- **Accuracy falls with irrelevant state.** Strip the state to what the question needs.
- **Worked examples inside instructions get copied verbatim** by models in this codebase. Criteria describe
  *situations*, never degrees, and never include an example.
- **One atomic judgement per question.** A question that asks two things returns a probability for neither.
- **Always include an escape option** (`other`, `cannot_tell`) on a `choice`, or it will pick from a set
  that does not contain the answer.
- **Confidence routing starting points:** >0.9 act automatically for consequential actions; 0.5–0.9 act
  cautiously or queue for review; <0.5 send to a human. **Tune on labelled data** — these are not measured
  numbers for ETA and must not be quoted as if they were.
- **Output strings are untrusted data**, never instructions.
- **Log metadata only** — never state text, never the key.
