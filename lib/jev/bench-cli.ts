/**
 * lib/jev/bench-cli.ts — Slice J4: the command line behind scripts/jev-bench.ts, with its
 * environment, filesystem and database handed in, so a test drives the same code the CLI runs.
 *
 * SAFETY, in the order it bites:
 *   1. Default mode is `dry-run`: scratch room-days only (bench-run.ts refuses anything else).
 *   2. `--mode live` additionally needs JEV_BENCH_LIVE=V_HAS_CLEARED_J4 in the environment. That
 *      string is the code-level form of "V gave his explicit word for J4"; nothing here sets it.
 *   3. The database URL is read from APP_DATABASE_URL by NAME and is never printed, logged or
 *      put in the report. Output is counts, ids, ratios and seconds.
 */
import { BENCH_ARMS, DEFAULT_PARAMS, parseRoleLabelsCsv, parseThresholds, type BenchArm, type BenchParams } from "./bench";
import type { BenchJevSignal, BenchReader } from "./bench-reader";
import { fixtureReader } from "./bench-reader";
import { renderMarkdown, runBench, type BenchOptions } from "./bench-run";

export const LIVE_ACK_ENV = "JEV_BENCH_LIVE";
export const LIVE_ACK_VALUE = "V_HAS_CLEARED_J4";
export const DEFAULT_ROLE_LABELS_PATH = "docs/handoff/scratch/jev-role-labels.csv";

export type CliArgs = {
  room_days: string | null;
  arms: BenchArm[];
  out: string | null;
  fixture: string | null;
  mode: "dry-run" | "live";
  role_labels: string;
  native_signals: string | null;
  date: string | null;
  params: BenchParams;
  help: boolean;
};

export const USAGE = `scripts/jev-bench.ts — Jev Arm D bench (ETA-JEV-ARM-D §7, slice J4). Read-only.

  npx --no-install tsx scripts/jev-bench.ts --fixture tests/fixtures/jev/bench-fixture.json
  APP_DATABASE_URL=… npx --no-install tsx scripts/jev-bench.ts --room-days rd_scratch_a,rd_scratch_b

  --room-days <csv | file>     room_day ids (a file holds one per line; # comments allowed)
  --fixture <json>             read a fixture instead of the database (room-days default to all in it)
  --arms rules,hybrid,flash,jev[,jev-native]     default rules,hybrid,flash,jev
  --mode dry-run|live          default dry-run (scratch days only). live needs ${LIVE_ACK_ENV}=${LIVE_ACK_VALUE}
  --out <path.json>            default docs/handoff/scratch/jev-bench-<DD-MON-YYYY>.json (the .md sits beside it)
  --role-labels <csv>          default ${DEFAULT_ROLE_LABELS_PATH}; absent = role accuracy UNVERIFIED
  --native-signals <json>      { "<room_day_id>": [signal rows] } for the jev-native control arm
  --thresholds k=v,...         open_recall, open_precision, median_open_error_s, ece_p_start, role_accuracy, cost_usd_per_room_day
  --tolerance-s 180  --calib-radius-s 60  --dedupe-s 120  --truth-open-source merged|mark|pstart
  --min-truth-opens 100  --bootstrap 1000  --seed N  --usd-per-billion-tokens 42  --date <label>
`;

const need = (argv: string[], i: number, flag: string): string => {
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) throw new Error(`missing_value:${flag}`);
  return v;
};
const numArg = (v: string, flag: string): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`bad_number:${flag}`);
  return n;
};

export function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = { room_days: null, arms: ["rules", "hybrid", "flash", "jev"], out: null, fixture: null, mode: "dry-run", role_labels: DEFAULT_ROLE_LABELS_PATH, native_signals: null, date: null, params: { ...DEFAULT_PARAMS }, help: false };
  let thresholds: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    switch (f) {
      case "--help": case "-h": a.help = true; break;
      case "--room-days": a.room_days = need(argv, i++, f); break;
      case "--fixture": a.fixture = need(argv, i++, f); break;
      case "--out": a.out = need(argv, i++, f); break;
      case "--role-labels": a.role_labels = need(argv, i++, f); break;
      case "--native-signals": a.native_signals = need(argv, i++, f); break;
      case "--date": a.date = need(argv, i++, f); break;
      case "--thresholds": thresholds = need(argv, i++, f); break;
      case "--arms": {
        const arms = need(argv, i++, f).split(",").map((s) => s.trim()).filter(Boolean);
        if (arms.length === 0) throw new Error("no_arms");
        for (const x of arms) if (!(BENCH_ARMS as readonly string[]).includes(x)) throw new Error(`unknown_arm:${x}`);
        a.arms = arms as BenchArm[];
        break;
      }
      case "--mode": {
        const m = need(argv, i++, f);
        if (m !== "dry-run" && m !== "live") throw new Error(`bad_mode:${m}`);
        a.mode = m;
        break;
      }
      case "--truth-open-source": {
        const m = need(argv, i++, f);
        if (m !== "merged" && m !== "mark" && m !== "pstart") throw new Error(`bad_truth_open_source:${m}`);
        a.params.truth_open_source = m;
        break;
      }
      case "--tolerance-s": a.params.tolerance_s = numArg(need(argv, i++, f), f); break;
      case "--calib-radius-s": a.params.calib_radius_s = numArg(need(argv, i++, f), f); break;
      case "--dedupe-s": a.params.dedupe_s = numArg(need(argv, i++, f), f); break;
      case "--min-truth-opens": a.params.min_truth_opens = numArg(need(argv, i++, f), f); break;
      case "--bootstrap": a.params.bootstrap = numArg(need(argv, i++, f), f); break;
      case "--seed": a.params.seed = numArg(need(argv, i++, f), f); break;
      case "--usd-per-billion-tokens": a.params.usd_per_billion_tokens = numArg(need(argv, i++, f), f); break;
      default: throw new Error(`unknown_flag:${f}`);
    }
  }
  a.params.thresholds = parseThresholds(thresholds);
  return a;
}

export type CliDeps = {
  env: Record<string, string | undefined>;
  /** null when the file does not exist */
  readText(path: string): string | null;
  writeText(path: string, text: string): void;
  /** builds the database reader from a URL. Only called in database mode. */
  makeDbReader(url: string): BenchReader;
  now(): Date;
  log(line: string): void;
};

const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
export const dateLabel = (d: Date): string => `${String(d.getUTCDate()).padStart(2, "0")}-${MON[d.getUTCMonth()]}-${d.getUTCFullYear()}`;

function roomDayIds(spec: string, deps: CliDeps): string[] {
  const file = deps.readText(spec);
  const raw = file !== null ? file.split(/\r?\n/).map((l) => l.replace(/#.*/, "").trim()) : spec.split(",").map((s) => s.trim());
  return [...new Set(raw.filter((s) => s.length > 0))];
}

/** Returns the process exit code: 0 ran, 2 refused, 1 usage or environment error. */
export async function main(argv: string[], deps: CliDeps): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    deps.log(`error: ${e instanceof Error ? e.message : String(e)}`);
    deps.log(USAGE);
    return 1;
  }
  if (args.help) { deps.log(USAGE); return 0; }

  let reader: BenchReader;
  let ids: string[];
  if (args.fixture) {
    const text = deps.readText(args.fixture);
    if (text === null) { deps.log(`error: fixture_not_found:${args.fixture}`); return 1; }
    const fx = JSON.parse(text) as { days: { room_day_id: string }[] };
    reader = fixtureReader(fx as Parameters<typeof fixtureReader>[0]);
    ids = args.room_days ? roomDayIds(args.room_days, deps) : fx.days.map((d) => d.room_day_id);
  } else {
    const url = deps.env.APP_DATABASE_URL;
    if (!url) { deps.log("error: APP_DATABASE_URL is not set (database mode reads it by name; it is never printed)"); return 1; }
    if (!args.room_days) { deps.log("error: --room-days is required in database mode"); return 1; }
    reader = deps.makeDbReader(url);
    ids = roomDayIds(args.room_days, deps);
  }

  const labelsText = deps.readText(args.role_labels);
  const parsed = labelsText === null ? null : parseRoleLabelsCsv(labelsText);
  let native: Record<string, BenchJevSignal[]> | undefined;
  if (args.native_signals) {
    const t = deps.readText(args.native_signals);
    if (t === null) { deps.log(`error: native_signals_not_found:${args.native_signals}`); return 1; }
    native = JSON.parse(t) as Record<string, BenchJevSignal[]>;
  }

  const date = args.date ?? dateLabel(deps.now());
  const opts: BenchOptions = {
    mode: args.mode, live_ack: deps.env[LIVE_ACK_ENV] === LIVE_ACK_VALUE, arms: args.arms, room_days: ids, params: args.params,
    role_labels: parsed ? { labels: parsed.labels, invalid_rows: parsed.invalid_rows } : null, native_signals: native, date,
  };
  const report = await runBench(reader, opts);
  const out = args.out ?? `docs/handoff/scratch/jev-bench-${date}.json`;
  const md = out.replace(/\.json$/, "") + ".md";
  deps.writeText(out, JSON.stringify(report, null, 2) + "\n");
  deps.writeText(md, renderMarkdown(report));
  deps.log(`jev-bench: status=${report.status} mode=${report.mode} room_days=${report.dataset.room_days_loaded}/${report.dataset.room_days_requested} truth_opens=${report.dataset.truth_opens_common} verdict_status=${report.verdict_status}`);
  if (report.status === "refused") deps.log(`refused: ${report.refusal?.reason}`);
  deps.log(`wrote ${out}`);
  deps.log(`wrote ${md}`);
  return report.status === "refused" ? 2 : 0;
}
