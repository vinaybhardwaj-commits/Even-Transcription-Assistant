/**
 * Spine artefact index writer (S3). Gated on spine_config `artefacts` (off|shadow|live; missing or malformed = off). Off runs only the
 * config query: no source table is touched. Source tables are read with SELECT only; the writes are INSERT into spine_artefact (create-only,
 * ON CONFLICT DO NOTHING) and the per-source watermark in spine_config `artefacts_cursor` (live only; shadow never persists it).
 */
import { CONFIG_SQL, CURSOR_KEY, CURSOR_UPSERT_SQL, EXISTING_SQL, INSERT_SQL, ROW_LIMIT, SOURCES, parseArtefactsMode, planArtefacts, sourceSelect } from "./artefacts";
import type { ArtefactCounts, ArtefactDraft, ArtefactsMode, ExistingArtefact, SourceRow, SourceTable } from "./artefacts";

export type SpineDb = (text: string, params?: unknown[]) => Promise<unknown[]>;
export interface IndexResult {
  mode: ArtefactsMode;
  counts: ArtefactCounts;
  inserted: number;
  /** The watermark after this run (a source that ran out of rows is reset to ""). */
  cursor: Record<string, string>;
}
const CHUNK = 200;
const emptyCounts = (): ArtefactCounts => ({ seen: 0, orphans: {}, unmapped: {}, conflicts: {}, foreign_conflict: {}, dup_source: {}, unchanged: 0, to_insert: 0 });

async function defaultDb(): Promise<SpineDb> {
  const { sql } = await import("@/lib/db");
  return (text, params) => (sql as unknown as SpineDb)(text, params ?? []);
}

/** A malformed cursor is an empty one: the sweep starts again from the top, which is idempotent. */
function parseCursor(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (v && typeof v === "object" && !Array.isArray(v)) for (const s of SOURCES) { const x = (v as Record<string, unknown>)[s]; if (typeof x === "string") out[s] = x; }
  return out;
}

export async function indexSpineArtefacts(now: Date, db?: SpineDb): Promise<IndexResult> {
  const q = db ?? (await defaultDb());
  const cfg = (await q(CONFIG_SQL, ["artefacts"])) as Array<{ value: unknown }>;
  const mode = parseArtefactsMode(cfg[0]?.value);
  if (mode === "off") return { mode, counts: emptyCounts(), inserted: 0, cursor: {} };
  const cur = (await q(CONFIG_SQL, [CURSOR_KEY])) as Array<{ value: unknown }>;
  const start = parseCursor(cur[0]?.value);
  const next: Record<string, string> = {};
  const rows: Array<{ source: SourceTable; row: SourceRow }> = [];
  for (const source of SOURCES) {
    const page = (await q(sourceSelect(source), [start[source] ?? ""])) as Array<SourceRow & { pk: string }>;
    for (const row of page) rows.push({ source, row });
    next[source] = page.length < ROW_LIMIT ? "" : page[page.length - 1].pk;
  }
  const encs = [...new Set(rows.map((r) => r.row.encounter_id).filter((e): e is string => !!e))];
  const existing = encs.length ? ((await q(EXISTING_SQL, [encs])) as ExistingArtefact[]) : [];
  const { inserts, counts } = planArtefacts(rows, existing);
  if (mode === "shadow") return { mode, counts, inserted: 0, cursor: next };
  let inserted = 0;
  const iso = now.toISOString();
  for (let i = 0; i < inserts.length; i += CHUNK) {
    const part = inserts.slice(i, i + CHUNK);
    const col = (f: (d: ArtefactDraft) => string | null) => part.map(f);
    const out = await q(INSERT_SQL, [
      iso, col((d) => d.encounter_id), col((d) => d.stage), col((d) => d.engine), col((d) => d.version), col((d) => d.cfg8), col((d) => d.cut_version),
      col((d) => d.store), col((d) => d.bucket), col((d) => d.object_key), col((d) => d.sha256), col((d) => d.status), col((d) => d.source_table),
    ]);
    inserted += out.length;
  }
  await q(CURSOR_UPSERT_SQL, [CURSOR_KEY, JSON.stringify(next), iso]);
  return { mode, counts, inserted, cursor: next };
}
