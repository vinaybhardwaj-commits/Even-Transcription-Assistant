/**
 * scripts/jev-u6-bench.ts — U6 clinical-or-not routing (order JEV-U6-ROUTE, PLAN-v3 §A): "a
 * 50-window bench against V-free heuristics (count per class, no text)".
 *
 * FLAGGED DESIGN CALL: this sandbox has no live production DB or ETA_JEV_ENABLED access (a real
 * DB read was denied by Claude Code's own auto-mode classifier this session — "Production Reads"
 * — before any connection was made), so this bench cannot pull 50 REAL bench_window rows. Instead
 * it runs 50 SYNTHETIC, non-PHI fixture texts (below) through the REAL askJev() code path —
 * registry lookup, confidence banding, the U6 question exactly as registered — with ETA_JEV_MOCK
 * seeded per-item via setMockJevAnswers (the same seam every unit test in this repo uses, not a
 * bench-only shortcut). The "Jev answer" for each fixture is therefore SCRIPTED to the label the
 * fixture was written to represent — it stands in for what a working U6 call should return, not
 * a live model output. Once real jev_window_text rows and ETA_JEV_ENABLED exist, this same
 * scoring path (scoreJevBench/formatJevBenchReport) is what a live 50-window pull would call —
 * only the fixture-building half of this file changes.
 *
 * scoreJevBench treats the heuristic's own output as `expected` (the V-free proxy, per
 * lib/jev/clinical-route-heuristic.ts's own header) and the (scripted) Jev answer as `predicted`
 * — measuring AGREEMENT with a proxy, not accuracy, exactly as that file documents.
 *
 * Usage: npx tsx scripts/jev-u6-bench.ts
 */
process.env.ETA_JEV_MOCK = "1";

import { askJev } from "../lib/jev/ask";
import { setMockJevAnswers, clearMockJevAnswers } from "../lib/jev/mock";
import { jevCounterSnapshot } from "../lib/jev/counters";
import { heuristicClinicalRoute } from "../lib/jev/clinical-route-heuristic";
import { registerEncounterQuestions, U6_OPTIONS, U6_PROMPT_VERSION, U6_QUESTION_ID, type U6Option } from "../lib/jev/prompts/encounter-v1";
import { windowState } from "../lib/encounter-clock/fusion-state";
import { scoreJevBench, formatJevBenchReport, type BenchItem } from "../lib/jev/bench";

type Fixture = { id: string; text: string; jevChoice: U6Option; jevConfidence: number };

// 50 synthetic, non-PHI fixture texts — invented dialogue, never real transcript content.
// jevChoice/jevConfidence is the SCRIPTED stand-in answer (see file header) — what a correct U6
// call is expected to return for this fixture, used to seed the mock client per item.
const FIXTURES: Fixture[] = [
  // clinical_consultation (10) — the heuristic's CLINICAL_MARKERS should catch these too.
  { id: "w01", text: "The patient reports fever and cough for three days, prescribe medicine and rest.", jevChoice: "clinical_consultation", jevConfidence: 0.93 },
  { id: "w02", text: "On examination there is mild tenderness, the diagnosis is likely a minor infection.", jevChoice: "clinical_consultation", jevConfidence: 0.91 },
  { id: "w03", text: "Please note any known allergy before we start the injection today.", jevChoice: "clinical_consultation", jevConfidence: 0.88 },
  { id: "w04", text: "Take one tablet twice daily after food, and check your blood pressure weekly.", jevChoice: "clinical_consultation", jevConfidence: 0.9 },
  { id: "w05", text: "The symptom started last week, mostly a dull headache with occasional dizziness.", jevChoice: "clinical_consultation", jevConfidence: 0.86 },
  { id: "w06", text: "We will increase the dosage slightly and review the examination findings next visit.", jevChoice: "clinical_consultation", jevConfidence: 0.89 },
  { id: "w07", text: "Any allergy to this medicine before, or any reaction to a previous prescription.", jevChoice: "clinical_consultation", jevConfidence: 0.87 },
  { id: "w08", text: "The cough has worsened, let us examine the chest and check for any infection.", jevChoice: "clinical_consultation", jevConfidence: 0.92 },
  { id: "w09", text: "This tablet is for the fever, take it with food, avoid it on an empty stomach.", jevChoice: "clinical_consultation", jevConfidence: 0.9 },
  { id: "w10", text: "The diagnosis suggests a mild allergy, we will prescribe a low dose to start.", jevChoice: "clinical_consultation", jevConfidence: 0.85 },
  // staff_or_admin_talk (8) — STAFF_MARKERS.
  { id: "w11", text: "Please check the token number before sending the next patient in.", jevChoice: "staff_or_admin_talk", jevConfidence: 0.84 },
  { id: "w12", text: "Send in the next patient once this room is free, thank you.", jevChoice: "staff_or_admin_talk", jevConfidence: 0.82 },
  { id: "w13", text: "We need to schedule an appointment slot for next Tuesday morning.", jevChoice: "staff_or_admin_talk", jevConfidence: 0.8 },
  { id: "w14", text: "Can you find the file for this patient, it should be in the front desk tray.", jevChoice: "staff_or_admin_talk", jevConfidence: 0.83 },
  { id: "w15", text: "Please register the new patient before the doctor is free again.", jevChoice: "staff_or_admin_talk", jevConfidence: 0.81 },
  { id: "w16", text: "The token number on the screen does not match the file, please double check.", jevChoice: "staff_or_admin_talk", jevConfidence: 0.85 },
  { id: "w17", text: "We are running behind schedule today, please inform the waiting patients.", jevChoice: "staff_or_admin_talk", jevConfidence: 0.78 },
  { id: "w18", text: "The appointment slot for tomorrow is already full, please offer the next day.", jevChoice: "staff_or_admin_talk", jevConfidence: 0.8 },
  // phone_call (8) — PHONE_MARKERS.
  { id: "w19", text: "Hello, can you hear me, the line keeps cutting out on my end.", jevChoice: "phone_call", jevConfidence: 0.9 },
  { id: "w20", text: "Sorry, the network here is very weak today, one moment please.", jevChoice: "phone_call", jevConfidence: 0.87 },
  { id: "w21", text: "I will call you back later once I am free to talk properly.", jevChoice: "phone_call", jevConfidence: 0.86 },
  { id: "w22", text: "Hold on, let me step outside, the signal is better near the window.", jevChoice: "phone_call", jevConfidence: 0.84 },
  { id: "w23", text: "Are you there, I think we got disconnected for a moment just now.", jevChoice: "phone_call", jevConfidence: 0.88 },
  { id: "w24", text: "Hello, can you hear me now, it was breaking up earlier.", jevChoice: "phone_call", jevConfidence: 0.89 },
  { id: "w25", text: "The network dropped again, give me a second to call back.", jevChoice: "phone_call", jevConfidence: 0.85 },
  { id: "w26", text: "Hold on, someone is at the door, I will call you back later.", jevChoice: "phone_call", jevConfidence: 0.83 },
  // social_chatter (8) — the heuristic has NO marker list for this class; it should fall through
  // to cannot_tell every time, which is the exact gap this bench exists to surface.
  { id: "w27", text: "It has been raining a lot this week, quite unusual for this time of year.", jevChoice: "social_chatter", jevConfidence: 0.75 },
  { id: "w28", text: "Did you watch the cricket match last night, what a finish that was.", jevChoice: "social_chatter", jevConfidence: 0.78 },
  { id: "w29", text: "My cousin's wedding is next month, the whole family is travelling for it.", jevChoice: "social_chatter", jevConfidence: 0.72 },
  { id: "w30", text: "Traffic on the way here was terrible, took almost an hour longer than usual.", jevChoice: "social_chatter", jevConfidence: 0.7 },
  { id: "w31", text: "This new coffee place near the market is surprisingly good, you should try it.", jevChoice: "social_chatter", jevConfidence: 0.74 },
  { id: "w32", text: "The kids are on holiday now, the house is much noisier than usual these days.", jevChoice: "social_chatter", jevConfidence: 0.73 },
  { id: "w33", text: "I finally finished painting the front room, took the whole weekend to do it.", jevChoice: "social_chatter", jevConfidence: 0.71 },
  { id: "w34", text: "We are planning a short trip next week if the weather stays good enough.", jevChoice: "social_chatter", jevConfidence: 0.76 },
  // garbled_or_no_real_speech (8) — short or mostly non-letter, matching looksGarbled's own logic.
  { id: "w35", text: "mm hm", jevChoice: "garbled_or_no_real_speech", jevConfidence: 0.6 },
  { id: "w36", text: "...", jevChoice: "garbled_or_no_real_speech", jevConfidence: 0.55 },
  { id: "w37", text: "12 34 56 78 90 12 34 56 78 90", jevChoice: "garbled_or_no_real_speech", jevConfidence: 0.65 },
  { id: "w38", text: "uh uh", jevChoice: "garbled_or_no_real_speech", jevConfidence: 0.58 },
  { id: "w39", text: "-- -- -- --", jevChoice: "garbled_or_no_real_speech", jevConfidence: 0.6 },
  { id: "w40", text: "ok ok", jevChoice: "garbled_or_no_real_speech", jevConfidence: 0.57 },
  { id: "w41", text: "hmm", jevChoice: "garbled_or_no_real_speech", jevConfidence: 0.56 },
  { id: "w42", text: "99 00 11 22 33", jevChoice: "garbled_or_no_real_speech", jevConfidence: 0.62 },
  // cannot_tell (8) — long enough and coherent, but no marker list fires and no clear category
  // was intended when writing the fixture either, so heuristic and script should agree here.
  { id: "w43", text: "So then I said we should probably just wait and see what happens next.", jevChoice: "cannot_tell", jevConfidence: 0.5 },
  { id: "w44", text: "It is hard to say exactly, I suppose it depends on a few different things.", jevChoice: "cannot_tell", jevConfidence: 0.48 },
  { id: "w45", text: "I am not really sure what to make of that, let us think about it later.", jevChoice: "cannot_tell", jevConfidence: 0.52 },
  { id: "w46", text: "There was some back and forth about it, but nothing was really decided.", jevChoice: "cannot_tell", jevConfidence: 0.49 },
  { id: "w47", text: "Well, that is one way of looking at it, I suppose, but I am not certain.", jevChoice: "cannot_tell", jevConfidence: 0.51 },
  { id: "w48", text: "It could go either way honestly, hard to tell from just this much.", jevChoice: "cannot_tell", jevConfidence: 0.5 },
  { id: "w49", text: "That is a fair point, though I would want to think it over a bit more.", jevChoice: "cannot_tell", jevConfidence: 0.47 },
  { id: "w50", text: "Something like that, more or less, though the details are a bit fuzzy still.", jevChoice: "cannot_tell", jevConfidence: 0.53 },
];

function scriptedAnswer(choice: U6Option, confidence: number) {
  const probabilities: Record<string, number> = {};
  for (const o of U6_OPTIONS) probabilities[o] = o === choice ? confidence : (1 - confidence) / (U6_OPTIONS.length - 1);
  return { type: "choice" as const, choice, probabilities, confidence };
}

async function main() {
  registerEncounterQuestions();
  const items: BenchItem[] = [];
  const heuristicByCategory: Record<string, number> = {};
  const jevByCategory: Record<string, number> = {};

  for (const fx of FIXTURES) {
    const expected = heuristicClinicalRoute(fx.text);
    heuristicByCategory[expected] = (heuristicByCategory[expected] ?? 0) + 1;

    // setMockJevAnswers is keyed by the ASK's answerKey ("kind" below), not by questionId — the
    // mock resolves fixture[id] against req.questions's own keys, which askJev builds from
    // ask.answerKey. Getting this wrong silently falls through to defaultAnswerFor (this bug
    // was caught on the first run: every item came back "clinical_consultation", the first
    // registered criterion, because the fixture map was keyed by U6_QUESTION_ID and never hit).
    setMockJevAnswers({ kind: scriptedAnswer(fx.jevChoice, fx.jevConfidence) });
    const before = jevCounterSnapshot().byQuestion[U6_QUESTION_ID]?.inputTokens ?? 0;
    const out = await askJev(
      windowState(fx.text),
      [{ answerKey: "kind", subjectType: "window", subjectId: fx.id, questionId: U6_QUESTION_ID, promptVersion: U6_PROMPT_VERSION }],
      { persist: false },
    );
    const after = jevCounterSnapshot().byQuestion[U6_QUESTION_ID]?.inputTokens ?? 0;
    clearMockJevAnswers();

    const answer = out.results.kind!.answer;
    if (answer.type !== "choice") throw new Error(`fixture ${fx.id}: expected a choice answer`);
    jevByCategory[answer.choice] = (jevByCategory[answer.choice] ?? 0) + 1;

    items.push({
      subjectId: fx.id,
      expected,
      predicted: answer.choice,
      confidence: out.results.kind!.confidence,
      latencyMs: out.latencyMs,
      inputTokens: after - before,
    });
  }

  const metrics = scoreJevBench(items);
  console.log(`counts (heuristic / proxy "expected"): ${JSON.stringify(heuristicByCategory)}`);
  console.log(`counts (scripted Jev / "predicted"):   ${JSON.stringify(jevByCategory)}`);
  console.log("");
  console.log(formatJevBenchReport({ use: "U6 clinical-or-not routing (SCRIPTED bench, see file header)", questionId: U6_QUESTION_ID, promptVersion: U6_PROMPT_VERSION, metrics }));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
