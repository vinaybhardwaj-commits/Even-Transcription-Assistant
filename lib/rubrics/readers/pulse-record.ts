/**
 * Reader pulse_record — S7-2 (it was a stub in S7-0). The signed Pulse note for ONE consult window: window -> consult_uid / warehouse_prescription_uid (Neon, bound SQL) -> the record (warehouse
 * through Metabase, ONE SELECT, lib/rubrics/evr/record.ts). Order, as every reader: the window's room-day is resolved and a held-out pair is REFUSED (blind_room_day) before the warehouse is
 * touched. Read only; never writes to Pulse; never calls parsePrescription.
 */
import { sql } from "@/lib/db";
import { blindRefusal, consultPair, isRefusal, refuse, type ReadResult } from "./common";
import { fetchPulseRecord } from "../evr/record";
import type { NormRecord } from "../evr/types";

export type PulseRecord = { consult_key: string; consult_uid: string; record: NormRecord; rec_uid: string; n_records: number; chosen: "window_uid" | "latest" };

export async function readPulseRecord(consultKey: string): Promise<ReadResult<PulseRecord>> {
  if (!/^[A-Za-z0-9_.:@-]{1,120}$/.test(consultKey)) return refuse("bad_unit_key");
  const pair = await consultPair(consultKey);
  if (isRefusal(pair)) return pair;
  const blind = blindRefusal(pair.room_id, pair.ist_date);
  if (blind) return blind;
  const rows = (await sql`
    SELECT consult_uid, warehouse_prescription_uid FROM eta_encounter_windows WHERE consult_key = ${consultKey}::text LIMIT 1
  `) as Array<{ consult_uid: string | null; warehouse_prescription_uid: string | null }>;
  const w = rows[0];
  if (!w?.consult_uid) return refuse("no_data", "the window has no consult_uid");
  const got = await fetchPulseRecord(w.consult_uid, w.warehouse_prescription_uid);
  if (!got.ok) return refuse(got.reason === "no_record" ? "no_data" : "bad_unit_key", got.reason);
  return { ok: true, data: { consult_key: consultKey, consult_uid: w.consult_uid, record: got.record, rec_uid: got.rec_uid, n_records: got.n_records, chosen: got.chosen } };
}
