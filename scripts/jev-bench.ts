/**
 * scripts/jev-bench.ts — run one Jev question set over a fixed list of past subjects and print a bench report (PRD P2.1). Operator-run, bench mode only:
 * it writes jev_call ledger rows (cost is counted) and NEVER a decision. Output is ids, option keys and numbers: no text.
 *
 *   JEV_WORKER_ENABLED=1 ETA_JEV_TEXT_LANE=1 ETA_JEV_ENABLED=1 TYPESAFE_API_KEY=... DATABASE_URL=... \
 *     npx tsx scripts/jev-bench.ts --use consult_rubric --set pitch-detect@v0 --subjects subjects.json [--labels labels.json] [--out report.json] [--concurrency 2]
 *
 *   subjects.json  ["consult_key", ...]  or  [{"subject_id": "ck#p1", "at_s": 312, "hint": "investigation"}, ...]   (pitch/doubt subjects need at_s; a doubt may carry "text")
 *   labels.json    [{"subject_id": "...", "question_id": "...", "label": "<option key, or a row label for u10_end_row>"}, ...]
 * Exit 0 with a report; 2 on a refusal (flags, unsynced set, no subjects). A DRAFT set is bench-only by design. Dev numbers are IN-SAMPLE.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { runBench, BenchRefused } from "../lib/jev/worker/bench";
import { syncQuestionSets } from "../lib/jev/worker/sync";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const use = arg("use"), set = arg("set"), subjectsFile = arg("subjects");
  const m = set ? /^([a-z][a-z0-9_-]+)@([A-Za-z0-9._-]+)$/.exec(set) : null;
  if (!use || !m || !subjectsFile) { console.error("usage: --use <use> --set <id@version> --subjects <file.json> [--labels file.json] [--out file.json] [--concurrency n]"); return 2; }
  const subjects = JSON.parse(readFileSync(subjectsFile, "utf8")) as unknown[];
  const labelsFile = arg("labels");
  const labels = labelsFile ? (JSON.parse(readFileSync(labelsFile, "utf8")) as Array<{ subject_id: string; question_id: string; label: string }>) : undefined;
  try {
    await syncQuestionSets();   // idempotent: a new file lands as draft, an unchanged one is untouched
    const report = await runBench({ use, setId: m[1]!, version: m[2]!, subjects: subjects as never, labels, concurrency: Number(arg("concurrency") ?? 2) });
    const out = arg("out");
    if (out) writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(out ? { written: out, counts: report.counts, stopped: report.stopped ?? null } : report, null, 2));
    return 0;
  } catch (e) {
    if (e instanceof BenchRefused) { console.error(`bench refused: ${e.message}`); return 2; }
    const code = (e as { code?: unknown })?.code;
    console.error(`bench failed (${typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? `db_error:${code}` : (e as Error)?.name ?? "error"})`);
    return 1;
  }
}
main().then((c) => process.exit(c), () => process.exit(1));
