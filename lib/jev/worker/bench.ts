/**
 * lib/jev/worker/bench.ts — the BENCH RUNNER (PRD P2.1, calibration spec §2-§3).
 *
 * Runs one question set over a FIXED list of subjects (past consults, windows, segments, pitches or doubts), building each state from our own stored data through the
 * set's registered builder, asks Jev with the worker's own call path, and returns a report. It WRITES LEDGER ROWS (jev_call, mode='bench', so cost is counted) and
 * NEVER WRITES DECISIONS: askSubject writes none in bench mode. Nothing here is used by anything else.
 *
 * GATED like every worker path: JEV_WORKER_ENABLED (+ ETA_JEV_TEXT_LANE for a text set), then ETA_JEV_ENABLED inside the client before any fetch. The set must be synced;
 * any status but `retired` runs in bench (a DRAFT is bench-only by design). The model is the set's pin, whatever ETA_JEV_MODEL says. Labels, when given, come from a
 * file the operator supplies at run time; none are kept in the repo (labels name option keys and row labels, never text, but they are the clinicians').
 */
import { parseFlag } from "@/lib/flags";
import { loadSetForMode } from "@/lib/jobs/kinds/jev-ask";
import { JEV_INPUT_TOKEN_COST_USD } from "../counters";
import { askSubject, type BenchRow } from "./call";
import { buildBenchReport, type BenchLabel, type BenchReport, type SubjectOutcome } from "./bench-report";
import { setLocator } from "./builders/locators";
import "./register";
import { modeGate, REAL_USES, type RealUse } from "./flags";
import { getUse, type JevUseDef } from "./uses";

export type BenchSubject = { subject_id: string; at_s?: number; hint?: string; text?: string };
export class BenchRefused extends Error {
  constructor(public reason: string, public detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason);
  }
}

export async function runBench(input: {
  use: string; setId: string; version: string; subjects: ReadonlyArray<BenchSubject | string>; labels?: ReadonlyArray<BenchLabel>; concurrency?: number; signal?: AbortSignal;
}, deps: { getUse?: (use: string, setId: string) => JevUseDef | undefined } = {}): Promise<BenchReport> {
  if (!(REAL_USES as readonly string[]).includes(input.use)) throw new BenchRefused("bad_use");
  const use = input.use as RealUse;
  const gate = modeGate(use, "bench");
  if (!gate.ok) throw new BenchRefused(gate.reason);
  const def = (deps.getUse ?? getUse)(use, input.setId);
  if (!def) throw new BenchRefused("no_use_registered", `${use}/${input.setId}`);
  const loaded = await loadSetForMode(use, "bench", input.setId, input.version);
  if (!loaded.ok) throw new BenchRefused("set_not_allowed", loaded.detail);
  const subjects = input.subjects.map((s) => (typeof s === "string" ? { subject_id: s } : s));
  if (subjects.length === 0) throw new BenchRefused("no_subjects");
  for (const s of subjects) if (s.at_s !== undefined) setLocator(s.subject_id, { at_ms: Math.round(s.at_s * 1000), ...(s.hint ? { hint: s.hint } : {}), ...(s.text ? { text: s.text } : {}) });

  const outcomes: SubjectOutcome[] = new Array(subjects.length);
  let stopped: string | undefined;
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= subjects.length || stopped) return;
      const id = subjects[i]!.subject_id;
      const build = await def.build(id).catch(() => null);
      if (build === null) { outcomes[i] = { subject_id: id, status: "no_state", reason: "no_state", rows: [], tokens: 0, calls: 0 }; continue; }
      const out = await askSubject({ jobId: `bench_${id.slice(0, 40)}`, set: loaded.set, defs: loaded.defs, mode: "bench", subjectId: id, build, signal: input.signal });
      const evidence = "evidence" in build ? build.evidence : {};
      if (out.kind === "deferred") { stopped = out.why; outcomes[i] = { subject_id: id, status: "deferred", reason: out.why, rows: [], tokens: 0, calls: out.calls }; continue; }
      if (out.kind === "failed") { outcomes[i] = { subject_id: id, status: "failed", reason: out.errorClass, rows: [], tokens: 0, calls: out.calls }; continue; }
      const status = out.abstained ? "abstained" : "tooLarge" in build ? "too_large" : "asked";
      outcomes[i] = { subject_id: id, status, ...(out.abstained ? { reason: out.abstained } : "tooLarge" in build ? { reason: "state_too_large" } : {}), rows: out.bench as BenchRow[], evidence, tokens: out.inputTokens, calls: out.calls };
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(4, input.concurrency ?? 2)) }, worker));
  const done = outcomes.map((o, i) => o ?? { subject_id: subjects[i]!.subject_id, status: "deferred" as const, reason: stopped ?? "not_run", rows: [], tokens: 0, calls: 0 });
  return buildBenchReport({
    set: { id: loaded.set.id, version: loaded.set.version, sha: loaded.set.sha, use: loaded.set.use }, defs: loaded.defs, outcomes: done, labels: input.labels,
    resolve: def.resolve, mock: parseFlag("ETA_JEV_MOCK"), usdPerToken: JEV_INPUT_TOKEN_COST_USD, stopped,
  });
}
