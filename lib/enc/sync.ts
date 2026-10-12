/**
 * lib/enc/sync.ts — ENC sync: R2 eta-lab-results enc/manifest.json, then enc/daily/<date>.json and enc/isolation/<date>.jsonl, into enc_room_day and enc_isolation.
 *
 * Reads through the guarded lab store (GET only, SCRIBE_LAB_R2_* env names). For each date whose manifest sha256 differs from the one recorded at the last good sync:
 * the file bytes are hashed and compared to the manifest (a mismatch writes NOTHING for that date), every row is checked against its zod schema,
 * then upserted. The date's sha is recorded only when every row of the date was valid and written. Counts and codes only; never a row.
 */
import { createHash } from "node:crypto";
import { labStore } from "@/lib/sarvam-lab";
import { IST_DATE, isolationRowSchema, manifestEntrySchema, roomDayRowSchema, type IsolationRow, type ManifestEntry, type RoomDayRow } from "@/lib/enc/schemas";
import { readSyncedShas, upsertIsolations, upsertRoomDays, writeSyncedSha, type SyncedSha } from "@/lib/enc/store";

export const ENC_MANIFEST_KEY = "enc/manifest.json";
export const encDailyKey = (d: string): string => `enc/daily/${d}.json`;
export const encIsolationKey = (d: string): string => `enc/isolation/${d}.jsonl`;
/** Most dates one run will process (the first run backfills; the next runs finish it). Newest first. */
export const MAX_DATES_PER_RUN = 40;

export const sha256Hex = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

export type DateOutcome = "ok" | "unchanged" | "missing" | "sha_mismatch" | "bad_rows" | "db_failed";
export type EncSyncResult =
  | { ok: true; dates_in_manifest: number; dates_changed: number; dates_ok: number; room_days_written: number; isolations_written: number; rows_skipped: number; outcomes: Record<string, number> }
  | { ok: false; error: "enc_unavailable" | "enc_manifest_bad" };

/** PURE. The manifest's dates, as { date -> entry }. Keys that are not dates are ignored; an entry that does not fit is dropped. null when the manifest is not a JSON object. */
export function parseManifest(body: string): { entries: Map<string, ManifestEntry>; dropped: number } | null {
  let j: unknown;
  try { j = JSON.parse(body); } catch { return null; }
  if (!j || typeof j !== "object" || Array.isArray(j)) return null;
  const entries = new Map<string, ManifestEntry>();
  let dropped = 0;
  for (const [k, v] of Object.entries(j as Record<string, unknown>)) {
    if (!IST_DATE.test(k)) continue;
    const p = manifestEntrySchema.safeParse(v);
    if (p.success) entries.set(k, p.data); else dropped++;
  }
  return { entries, dropped };
}

/** PURE. Dates whose recorded sha differs from the manifest's, newest first, capped. */
export function changedDates(entries: Map<string, ManifestEntry>, synced: Map<string, SyncedSha>, cap = MAX_DATES_PER_RUN): string[] {
  const out: string[] = [];
  for (const [d, e] of entries) {
    const s = synced.get(d);
    if (!s || s.sha256 !== e.sha256 || (e.isolation_sha256 ?? null) !== s.isolation_sha256) out.push(d);
  }
  return out.sort().reverse().slice(0, cap);
}

/** PURE. Daily file: a JSON array of enc_room_day rows. Rows that fail the schema, or carry another date, are counted and dropped. */
export function parseDaily(body: string, date: string): { rows: RoomDayRow[]; skipped: number } | null {
  let j: unknown;
  try { j = JSON.parse(body); } catch { return null; }
  if (!Array.isArray(j)) return null;
  const rows: RoomDayRow[] = [];
  let skipped = 0;
  for (const r of j) {
    const p = roomDayRowSchema.safeParse(r);
    if (p.success && p.data.ist_date === date) rows.push(p.data); else skipped++;
  }
  return { rows, skipped };
}

/** PURE. Isolation file: JSON lines of enc_isolation rows. */
export function parseIsolation(body: string, date: string): { rows: IsolationRow[]; skipped: number } {
  const rows: IsolationRow[] = [];
  let skipped = 0;
  for (const line of body.split("\n")) {
    if (line.trim() === "") continue;
    let j: unknown;
    try { j = JSON.parse(line); } catch { skipped++; continue; }
    const p = isolationRowSchema.safeParse(j);
    if (p.success && p.data.ist_date === date) rows.push(p.data); else skipped++;
  }
  return { rows, skipped };
}

export async function syncEnc(): Promise<EncSyncResult> {
  const store = labStore();
  if (!store) return { ok: false, error: "enc_unavailable" };
  let man;
  try { man = await store.get(ENC_MANIFEST_KEY); } catch { return { ok: false, error: "enc_unavailable" }; }
  if (!man) return { ok: false, error: "enc_unavailable" };
  const parsed = parseManifest(man.body);
  if (!parsed) return { ok: false, error: "enc_manifest_bad" };

  const synced = await readSyncedShas();
  const dates = changedDates(parsed.entries, synced);
  const outcomes: Record<string, number> = { ok: 0, unchanged: parsed.entries.size - dates.length, missing: 0, sha_mismatch: 0, bad_rows: 0, db_failed: 0 };
  let roomDays = 0, isolations = 0, skippedRows = 0;

  for (const d of dates) {
    const e = parsed.entries.get(d)!;
    const oc = await syncOneDate(d, e);
    outcomes[oc.outcome] = (outcomes[oc.outcome] ?? 0) + 1;
    roomDays += oc.room_days; isolations += oc.isolations; skippedRows += oc.skipped;
  }
  return { ok: true, dates_in_manifest: parsed.entries.size, dates_changed: dates.length, dates_ok: outcomes.ok ?? 0, room_days_written: roomDays, isolations_written: isolations, rows_skipped: skippedRows, outcomes };
}

async function syncOneDate(d: string, e: ManifestEntry): Promise<{ outcome: DateOutcome; room_days: number; isolations: number; skipped: number }> {
  const store = labStore();
  const none = (outcome: DateOutcome, skipped = 0) => ({ outcome, room_days: 0, isolations: 0, skipped });
  if (!store) return none("missing");
  let daily, iso = null;
  try {
    daily = await store.get(encDailyKey(d));
    if (e.isolation_sha256) iso = await store.get(encIsolationKey(d));
  } catch {
    return none("missing");
  }
  if (!daily || (e.isolation_sha256 && !iso)) return none("missing");
  if (sha256Hex(daily.body) !== e.sha256) return none("sha_mismatch");
  if (iso && sha256Hex(iso.body) !== e.isolation_sha256) return none("sha_mismatch");
  const dr = parseDaily(daily.body, d);
  if (!dr) return none("bad_rows");
  const ir = iso ? parseIsolation(iso.body, d) : { rows: [] as IsolationRow[], skipped: 0 };
  try {
    const rd = await upsertRoomDays(dr.rows);
    const is = await upsertIsolations(ir.rows);
    const skipped = dr.skipped + ir.skipped;
    // A date with a skipped row is not marked synced: the next run reads it again.
    if (skipped === 0) await writeSyncedSha(d, { sha256: e.sha256, isolation_sha256: e.isolation_sha256 ?? null });
    return { outcome: skipped === 0 ? "ok" : "bad_rows", room_days: rd, isolations: is, skipped };
  } catch (err) {
    console.error("[enc-sync] db failed", JSON.stringify({ date: d, err: String((err as Error)?.name ?? "error") }));
    return none("db_failed");
  }
}
