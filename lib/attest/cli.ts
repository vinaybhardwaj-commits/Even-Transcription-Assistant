/**
 * lib/attest/cli.ts — the loader's command line, with every dependency injected so a test can drive it.
 *
 *   attest-loader --file sheet.csv --attested-by "<who>"      validate; print what WOULD be written (dry run)
 *   attest-loader --file - --attested-by "<who>"              the same, sheet on stdin
 *   attest-loader --workload                                  size of the human task, from the data alone
 *   attest-loader --write ...                                 REFUSED (see WRITE_REFUSED)
 *
 * DRY RUN IS THE ONLY MODE. Every statement issued is a SELECT (the test asserts it), nothing is
 * written anywhere, and the output is counts, row numbers and reason codes: never a clinician's name,
 * because a refusal has to name the offending ROW, and the row number is enough.
 *
 * EXIT CODES: 0 clean; 1 usage; 2 one or more refusals; 3 --write asked for.
 */
import { createHash } from "node:crypto";
import { loadReference, workloadFrom, type SqlFn } from "./reference";
import { blockBoundsMs, parseSheet } from "./sheet";
import { validateAttestations } from "./validate";

/**
 * WHY THERE IS NO WRITE. The brief said: write through the existing path (scribe_set_visit_clinician /
 * operator_pin), and if it cannot express what is needed, say so and stop rather than bypass it.
 * It cannot, for the existing corpus, and this is the evidence:
 *  - scribe_post_cue and scribe_pin_visit both take the cue door's LIVE path, which files the cue on
 *    TODAY's room-day from the server clock, "not the cue's `at`" (app/api/brain/cues/route.ts:347-348).
 *    An attestation for 22 Aug would land on today's room-day.
 *  - Naming a room_day_id explicitly is refused unless the day is scratch (route.ts:321, 409
 *    not_a_scratch_day). Every corpus room-day is non-scratch.
 *  - scribe_pin_visit has no clinician argument at all (lib/mcp/tools/brain.ts:377-406): it carries a
 *    visit phase only. scribe_set_visit_clinician acts on ONE EXISTING visit (lib/mcp/tools/fuse.ts:206)
 *    and 17 of the 18 diarized room-days have none.
 *  - Neither records WHO attested: the audit row is actor system/mcp with a free-text note.
 */
export const WRITE_REFUSED =
  "WRITE REFUSED. No existing door can attach an attestation to a past room-day: the cue door files on TODAY's room-day (app/api/brain/cues/route.ts:347-348) and refuses a named non-scratch day (:321); scribe_pin_visit carries no clinician (lib/mcp/tools/brain.ts:377-406); scribe_set_visit_clinician needs an existing visit (lib/mcp/tools/fuse.ts:206). Nothing was written. A ruling on the write door is needed.";

export type CliDeps = {
  argv: string[];
  sql: SqlFn;
  readInput: (path: string) => string;
  out: (line: string) => void;
  now: () => Date;
};

type Args = { file: string | null; attestedBy: string | null; write: boolean; workload: boolean; help: boolean; unknown: string[] };

function parseArgs(argv: string[]): Args {
  const a: Args = { file: null, attestedBy: null, write: false, workload: false, help: false, unknown: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]!;
    if (t === "--file") a.file = argv[++i] ?? null;
    else if (t === "--attested-by") a.attestedBy = argv[++i] ?? null;
    else if (t === "--write") a.write = true;
    else if (t === "--dry-run") continue; // the only mode; accepted so the first use can say it out loud
    else if (t === "--workload") a.workload = true;
    else if (t === "--help" || t === "-h") a.help = true;
    else a.unknown.push(t);
  }
  return a;
}

const HELP = [
  "attest-loader --file <sheet.csv|-> --attested-by <who> [--dry-run]     validate a sheet; print what would be written",
  "attest-loader --workload                                              how many diarized room-days need a row",
  "sheet columns (exactly): room,date,start,end,clinician   date YYYY-MM-DD, times HH:MM 24h, India Standard Time",
  "template: docs/attestation/attestation-sheet-template.csv",
];

export async function runLoader(deps: CliDeps): Promise<number> {
  const { out } = deps;
  const args = parseArgs(deps.argv);

  if (args.write) { out(WRITE_REFUSED); return 3; }
  if (args.help) { HELP.forEach(out); return 0; }
  if (args.unknown.length) { out(`unknown argument(s): ${args.unknown.length}. See --help.`); return 1; }

  if (args.workload) {
    const ref = await loadReference(deps.sql, { fromMs: 0, toMs: 4_102_444_800_000 });
    const w = workloadFrom(ref);
    out("attestation workload (from the data alone; nothing is written)");
    out(`diarized room-days to attest: ${w.diarized_room_days} | across ${w.distinct_rooms} rooms and ${w.distinct_dates} dates | ${w.diarized_windows} diarized windows`);
    out(`already attested over diarized audio: ${w.already_attested_over_diarized_audio} of ${w.diarized_room_days}`);
    out(`nothing we hold links any clinician to a room-day, so the task cannot be narrowed below all ${w.diarized_room_days}.`);
    return 0;
  }

  if (!args.file) { out("--file is required (or --workload). See --help."); return 1; }
  const by = (args.attestedBy ?? "").trim();
  if (by === "" || by.length > 64 || /[\u0000-\u001f]/.test(by)) { out("--attested-by is required: who is attesting (1-64 characters, no control characters)."); return 1; }

  const text = deps.readInput(args.file);
  const batchId = createHash("sha256").update(text).digest("hex").slice(0, 12);
  const parsed = parseSheet(text);

  out("attestation loader: DRY RUN (nothing is written; every statement issued is a SELECT)");
  out(`batch_id ${batchId} (sha256 of the sheet) | attested_by ${by} | attested_at ${deps.now().toISOString()} (would be stamped at write time)`);

  let result;
  if (parsed.rows.length === 0) {
    result = validateAttestations([], { rooms: [], clinicians: [], windows: [], roomDays: [], existing: [], diarizedRoomDayIds: new Set() }, parsed.refusals);
  } else {
    const bounds = parsed.rows.map((r) => blockBoundsMs(r.date, r.start, r.end)!);
    const ref = await loadReference(deps.sql, { fromMs: Math.min(...bounds.map((b) => b.startMs)), toMs: Math.max(...bounds.map((b) => b.endMs)) });
    result = validateAttestations(parsed.rows, ref, parsed.refusals);
  }

  const c = result.counts;
  out(`rows read ${c.rows_read} | clean ${c.rows_clean} | refusals ${c.refusals}`);
  if (result.refusals.length > 0) {
    out("REFUSED. Fix these rows and run again; nothing would be written:");
    for (const r of result.refusals) out(`  ${r.row === null ? "sheet" : `row ${r.row}`}  ${r.reason}${r.detail ? ` (${r.detail})` : ""}`);
    out(`by reason: ${Object.entries(c.by_reason).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    out("would write: 0 attestation records");
    return 2;
  }
  out(`would write: ${result.records.length} attestation records, each basis=attested with attested_by, attested_at and batch_id above`);
  out(`  rooms ${c.rooms} | clinicians ${c.clinicians} | room-days ${c.room_days} | windows under the blocks ${c.windows_under_blocks} (diarized ${c.diarized_windows_under_blocks})`);
  out(`  diarized room-days covered: ${c.diarized_room_days_covered} of ${c.diarized_room_days_total}`);
  return 0;
}
