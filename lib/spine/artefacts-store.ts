/**
 * Spine artefact index writer (S3). Gated on spine_config `artefacts` (missing or malformed = off; off makes no query at all).
 * Source tables are read with SELECT only; the sole write is INSERT into spine_artefact, create-only (ON CONFLICT DO NOTHING).
 */
import { CONFIG_SQL, EXISTING_SQL, INSERT_SQL, SOURCES, parseArtefactsMode, planArtefacts, sourceSelect } from "./artefacts";
import type { ArtefactCounts, ArtefactDraft, ArtefactsMode, ExistingArtefact, SourceRow, SourceTable } from "./artefacts";

export type SpineDb = (text: string, params?: unknown[]) => Promise<unknown[]>;
export interface IndexResult {
  mode: ArtefactsMode;
  counts: ArtefactCounts;
  inserted: number;
}
const CHUNK = 200;
const EMPTY: ArtefactCounts = { seen: 0, orphans: {}, unmapped: {}, conflicts: {}, unchanged: 0, to_insert: 0 };

async function defaultDb(): Promise<SpineDb> {
  const { sql } = await import("@/lib/db");
  return (text, params) => (sql as unknown as SpineDb)(text, params ?? []);
}

export async function indexSpineArtefacts(now: Date, db?: SpineDb): Promise<IndexResult> {
  const q = db ?? (await defaultDb());
  const cfg = (await q(CONFIG_SQL, ["artefacts"])) as Array<{ value: unknown }>;
  const mode = parseArtefactsMode(cfg[0]?.value);
  if (mode === "off") return { mode, counts: { ...EMPTY }, inserted: 0 };
  const rows: Array<{ source: SourceTable; row: SourceRow }> = [];
  for (const source of SOURCES) for (const row of (await q(sourceSelect(source), [])) as SourceRow[]) rows.push({ source, row });
  const existing = (await q(EXISTING_SQL, [SOURCES])) as ExistingArtefact[];
  const { inserts, counts } = planArtefacts(rows, existing);
  if (mode === "shadow") return { mode, counts, inserted: 0 };
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
  return { mode, counts, inserted };
}
