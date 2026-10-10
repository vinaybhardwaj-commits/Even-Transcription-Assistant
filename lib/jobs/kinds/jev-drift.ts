/**
 * lib/jobs/kinds/jev-drift.ts — the daily drift report job (PRD §6.4, P1.7). One step, no Jev call: it only READS jev_decision / jev_call /
 * jev_gold_label and writes jev_drift_report. Enqueued once per IST day per use by the sweeper; behind JEV_WORKER_ENABLED like the rest.
 */
import { runDrift } from "@/lib/jev/worker/drift";
import { REAL_USES, workerEnabled } from "@/lib/jev/worker/flags";
import { JobArgsError, doneWith, type JobKind } from "../types";

export const JEV_DRIFT_KIND = "jev_drift";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const istToday = (): string => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

export const jevDriftKind: JobKind = {
  name: JEV_DRIFT_KIND,
  roomData: false,
  roomDataNote: "reads Jev's own decision and call tables (ids and numbers), no room data; blind/held-out guards are lifted (V, 10 Oct 2026)",
  first: "report",
  scope: "invoke",
  parseArgs: (raw) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    if (r.use !== undefined && !(REAL_USES as readonly string[]).includes(r.use as string)) throw new JobArgsError("use must be one of the real uses");
    if (r.ist_date !== undefined && !(typeof r.ist_date === "string" && DATE_RE.test(r.ist_date))) throw new JobArgsError("ist_date must be YYYY-MM-DD");
    return { ...(r.use ? { use: r.use } : {}), ist_date: (r.ist_date as string | undefined) ?? istToday() };
  },
  dedupeOn: (args) => [["use", args.use ? String(args.use) : null], ["ist_date", String(args.ist_date)]],
  run: async (ctx) => {
    if (!workerEnabled()) return doneWith({ skipped: "worker_disabled" });
    const uses = ctx.args.use ? [String(ctx.args.use)] : [...REAL_USES];
    const out = [];
    for (const u of uses) out.push(await runDrift(u, String(ctx.args.ist_date)));
    return doneWith({ ist_date: ctx.args.ist_date, reports: out.reduce((a, b) => a + b.reports, 0), alerts: out.reduce((a, b) => a + b.alerts, 0) });
  },
};
