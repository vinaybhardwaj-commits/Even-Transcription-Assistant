/**
 * lib/consult-index/sync.ts — the hourly sync of CONSULT's name-free index into consult_index (0150). The FIRST run is the backfill: the mirror holds every consult already cut, and each run reads all of it.
 *
 * Reads R2 eta-lab-results consult/index/latest.jsonl + manifest.json through the guarded lab store (GET of exactly those two keys; SCRIBE_LAB_R2_* env names), checks sha256(latest.jsonl) against the manifest
 * (a mismatch writes NOTHING and records consult_index_integrity), and upserts. Every run leaves a consult_index_sync row (counts and reasons, never content). A missing store or object is
 * consult_index_unavailable; an error is cleared only by the success of the next run.
 */
import { labStore, CONSULT_INDEX_KEYS } from "@/lib/sarvam-lab";
import { parseIndex } from "@/lib/consult-index/parse";
import { finishSync, startSync, upsertIndexRows } from "@/lib/room-access/consult-index-store";

export type SyncResult =
  | { ok: true; sync_id: number; manifest_rows: number | null; rows_read: number; rows_written: number; inserted: number; changed: number; migrated_results: number; rows_skipped: number; skipped: Record<string, number> }
  | { ok: false; sync_id: number; error: "consult_index_unavailable" | "consult_index_integrity" | "sync_failed" };

export async function syncConsultIndex(): Promise<SyncResult> {
  const id = await startSync();
  const fail = async (error: "consult_index_unavailable" | "consult_index_integrity" | "sync_failed", extra: { manifest_sha256?: string | null } = {}): Promise<SyncResult> => {
    try { await finishSync(id, { status: "failed", error_code: error, ...extra }); } catch { /* the failure itself is returned either way */ }
    return { ok: false, sync_id: id, error };
  };
  const store = labStore();
  if (!store) return fail("consult_index_unavailable");
  let latest, man;
  try {
    latest = await store.get(CONSULT_INDEX_KEYS[0]);
    man = await store.get(CONSULT_INDEX_KEYS[1]);
  } catch {
    return fail("consult_index_unavailable");
  }
  if (!latest || !man) return fail("consult_index_unavailable");
  const got = parseIndex(latest.body, man.body);
  if (!got.ok) return fail(got.error);
  try {
    const { inserted, changed, migrated } = await upsertIndexRows(got.parsed.rows, got.manifest.sha256);
    const skipped = Object.values(got.parsed.skipped).reduce((a, b) => a + b, 0);
    await finishSync(id, { status: "ok", manifest_sha256: got.manifest.sha256, manifest_rows: got.manifest.rows, rows_read: got.parsed.read, rows_written: got.parsed.rows.length, rows_changed: changed, rows_skipped: skipped, skipped: got.parsed.skipped });
    return { ok: true, sync_id: id, manifest_rows: got.manifest.rows, rows_read: got.parsed.read, rows_written: got.parsed.rows.length, inserted, changed, migrated_results: migrated, rows_skipped: skipped, skipped: got.parsed.skipped };
  } catch (e) {
    console.error("[consult-index] sync failed", JSON.stringify({ sync_id: id, err: String((e as Error)?.name ?? "error") }));
    return fail("sync_failed", { manifest_sha256: got.manifest.sha256 });
  }
}
