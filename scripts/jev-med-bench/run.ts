/**
 * scripts/jev-med-bench/run.ts — CLI for the medication-note bench (W27.7b / W30.3).
 *
 *   npx -y tsx scripts/jev-med-bench/run.ts generate [--out DIR] [--seed S] [--lines N]
 *   npx -y tsx scripts/jev-med-bench/run.ts run      [--out DIR] [--split dev|test|both] [--concurrency 4]
 *   npx -y tsx scripts/jev-med-bench/run.ts score    [--out DIR]
 *   npx -y tsx scripts/jev-med-bench/run.ts selftest            (mock oracle, no network, no key)
 *
 * `run` makes REAL Jev calls (ETA_JEV_ENABLED=1 and TYPESAFE_API_KEY in the environment, loaded by
 * the caller — this script never reads a secret file). Text is invented (D1a); nothing here touches
 * real transcripts. persist:false, so jev_decision is not polluted. Resumable: answered cases in
 * results.jsonl are skipped. Errors are logged by class only (safeJevErrorMessage).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generate, type Excerpt } from "./generate";
import { buildReport, formatReport, joinResults } from "./score";

const args = process.argv.slice(2);
const cmd = args[0] ?? "";
const opt = (name: string, def: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : def;
};
const OUT = opt("out", path.join(os.homedir(), "eta-data", "notesafe-bench", "v1"));
const SEED = opt("seed", "notesafe-med-bench-v1");
const LINES = Number(opt("lines", "100"));
const paths = { data: path.join(OUT, "cases.jsonl"), results: path.join(OUT, "results.jsonl"), report: path.join(OUT, "report.md") };

function readJsonl<T>(p: string): T[] {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as T);
}
function loadResults(p: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of readJsonl<{ case_id: string; p: number }>(p)) out[r.case_id] = r.p;
  return out;
}

async function cmdGenerate(): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  const ex = generate({ seed: SEED, linesPerSplit: LINES });
  fs.writeFileSync(paths.data, ex.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const sents = ex.flatMap((e) => e.sentences);
  console.log(JSON.stringify({ excerpts: ex.length, sentences: sents.length, supported: sents.filter((s) => s.label === "supported").length, seed: SEED, out: paths.data }));
}

async function runExcerpts(excerpts: Excerpt[], concurrency: number, resultsPath: string): Promise<void> {
  const { askJev } = await import("../../lib/jev/ask");
  const { safeJevErrorMessage } = await import("../../lib/jev/safe-error");
  await import("../../lib/jev/prompts/note-safety-v1");
  const { NOTE_FAITHFULNESS_PROMPT_VERSION } = await import("../../lib/jev/prompts/note-safety-v1");
  const done = loadResults(resultsPath);
  const todo = excerpts.filter((e) => e.sentences.some((s) => done[s.case_id] === undefined));
  console.log(`excerpts to run: ${todo.length} of ${excerpts.length}`);
  let next = 0;
  let failed = 0;
  const worker = async () => {
    while (next < todo.length) {
      const e = todo[next++]!;
      try {
        const out = await askJev(
          { transcript_excerpt: e.excerpt },
          e.sentences.map((s, i) => ({ answerKey: s.case_id, subjectType: "note_sentence" as const, subjectId: s.case_id, questionId: "note_sentence_supported", promptVersion: NOTE_FAITHFULNESS_PROMPT_VERSION, args: [`s${i}`, s.text] })),
          { persist: false },
        );
        const lines: string[] = [];
        for (const s of e.sentences) {
          const r = out.results[s.case_id];
          if (r && r.answer.type === "noul") lines.push(JSON.stringify({ case_id: s.case_id, p: r.answer.noul, model: out.model, latency_ms: out.latencyMs }));
        }
        if (lines.length) fs.appendFileSync(resultsPath, lines.join("\n") + "\n");
      } catch (err) {
        failed++;
        console.warn(`excerpt ${e.excerpt_id} failed: ${safeJevErrorMessage(err)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  console.log(`done; failed excerpts: ${failed}`);
}

async function cmdRun(): Promise<void> {
  const ex = readJsonl<Excerpt>(paths.data);
  if (!ex.length) throw new Error(`no cases at ${paths.data}; run generate first`);
  const split = opt("split", "both");
  await runExcerpts(ex.filter((e) => split === "both" || e.split === split), Number(opt("concurrency", "4")), paths.results);
}

function cmdScore(): void {
  const ex = readJsonl<Excerpt>(paths.data);
  const results = loadResults(paths.results);
  const total = ex.reduce((n, e) => n + e.sentences.length, 0);
  const scored = joinResults(ex, results);
  const rep = buildReport(scored, total - scored.length);
  const md = formatReport(rep);
  fs.writeFileSync(paths.report, md + "\n");
  console.log(md);
}

async function cmdSelfTest(): Promise<void> {
  // Mock oracle: P(supported) = 0.9 for supported, 0.1 for unsupported, with a fixed 6% of each flipped.
  process.env.ETA_JEV_MOCK = "1";
  const { setMockJevAnswers } = await import("../../lib/jev/mock");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "med-bench-"));
  const ex = generate({ seed: SEED, linesPerSplit: LINES });
  const answers: Record<string, { type: "noul"; noul: number }> = {};
  let i = 0;
  for (const e of ex) {
    for (const s of e.sentences) {
      const flip = (i++ * 2654435761) % 100 < 6;
      const supported = (s.label === "supported") !== flip;
      answers[s.case_id] = { type: "noul", noul: supported ? 0.9 : 0.1 };
    }
  }
  setMockJevAnswers(answers);
  const rp = path.join(dir, "results.jsonl");
  await runExcerpts(ex, 2, rp);
  const scored = joinResults(ex, loadResults(rp));
  console.log(formatReport(buildReport(scored, ex.reduce((n, e) => n + e.sentences.length, 0) - scored.length)));
}

const main = async () => {
  if (cmd === "generate") return cmdGenerate();
  if (cmd === "run") return cmdRun();
  if (cmd === "score") return cmdScore();
  if (cmd === "selftest") return cmdSelfTest();
  console.error("usage: run.ts generate|run|score|selftest");
  process.exit(2);
};
main().catch((e) => {
  console.error(`fatal: ${e instanceof Error ? e.name : "error"}`);
  process.exit(1);
});
