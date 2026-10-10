/**
 * lib/fleet/results.ts — POST /api/fleet/results (TS-H3 #40, PRD §5.4).
 *
 * A result is accepted only for a command that (1) exists, (2) was issued to THE AUTHENTICATED DEVICE (the JWS signer), (3) is in state 'delivered' (it went out in a
 * poll), and (4) has no result yet. body.device_id must equal the signer. One result per command: an identical resend is 200 {duplicate:true}; a different second answer is
 * 409 RESULT_CONFLICT. `detail` is a JSON object, <= 4 KB, nested keys [a-z_][a-z0-9_]*, no PHI (the helper's per-verb schema, TS-H4, is the real gate). `upload`, when
 * present, must name an R2 key under fleet/diag/<device_id>/.
 */
import type { FleetSql } from "./device-auth";

export const MAX_BODY_BYTES = 16 * 1024;
export const MAX_DETAIL_BYTES = 4096;
export const OUTCOMES = ["ok", "refused", "failed", "unsupported"] as const;
const KEY_RE = /^[a-z_][a-z0-9_]*$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export type ResultBody = {
  cmd_id: string;
  device_id: string;
  outcome: (typeof OUTCOMES)[number];
  reason: string | null;
  started_at: string;
  finished_at: string;
  detail: Record<string, unknown>;
  upload: { kind: string; r2_key: string; bytes: number } | null;
};

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const keysOk = (v: unknown, depth = 0): boolean => {
  if (depth > 4) return false;
  if (Array.isArray(v)) return v.every((x) => keysOk(x, depth + 1));
  if (isObj(v)) return Object.keys(v).every((k) => KEY_RE.test(k) && keysOk(v[k], depth + 1));
  return !(typeof v === "number" && !Number.isFinite(v));
};

export function parseResultBody(raw: unknown): { ok: true; body: ResultBody } | { ok: false; code: string } {
  if (!isObj(raw)) return { ok: false, code: "bad_body" };
  if (typeof raw.cmd_id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(raw.cmd_id)) return { ok: false, code: "bad_cmd_id" };
  if (typeof raw.device_id !== "string" || !/^dev_[a-f0-9]{24}$/.test(raw.device_id)) return { ok: false, code: "bad_device_id" };
  if (!(OUTCOMES as readonly string[]).includes(raw.outcome as string)) return { ok: false, code: "bad_outcome" };
  if (raw.reason !== undefined && raw.reason !== null && !(typeof raw.reason === "string" && /^[a-z0-9_]{1,64}$/.test(raw.reason))) return { ok: false, code: "bad_reason" };
  for (const k of ["started_at", "finished_at"] as const) {
    const v = raw[k];
    if (typeof v !== "string" || !ISO_RE.test(v) || !Number.isFinite(Date.parse(v))) return { ok: false, code: `bad_${k}` };
  }
  const detail = raw.detail === undefined ? {} : raw.detail;
  if (!isObj(detail) || !keysOk(detail) || Buffer.byteLength(JSON.stringify(detail), "utf8") > MAX_DETAIL_BYTES) return { ok: false, code: "bad_detail" };
  let upload: ResultBody["upload"] = null;
  if (raw.upload !== undefined && raw.upload !== null) {
    const u = raw.upload;
    if (!isObj(u) || typeof u.kind !== "string" || !/^[a-z_]{1,32}$/.test(u.kind) || typeof u.r2_key !== "string" || u.r2_key.length > 256 || !Number.isInteger(u.bytes) || (u.bytes as number) < 0) return { ok: false, code: "bad_upload" };
    if (!u.r2_key.startsWith(`fleet/diag/${raw.device_id}/`) || u.r2_key.includes("..")) return { ok: false, code: "bad_upload" };
    upload = { kind: u.kind, r2_key: u.r2_key, bytes: u.bytes as number };
  }
  return {
    ok: true,
    body: {
      cmd_id: raw.cmd_id,
      device_id: raw.device_id,
      outcome: raw.outcome as ResultBody["outcome"],
      reason: (raw.reason as string | null | undefined) ?? null,
      started_at: raw.started_at as string,
      finished_at: raw.finished_at as string,
      detail,
      upload,
    },
  };
}

export type ResultOutcome = { ok: true; status: 200; duplicate: boolean } | { ok: false; status: number; code: string };

export async function recordResult(sql: FleetSql, signerDeviceId: string, machine: string, b: ResultBody): Promise<ResultOutcome> {
  if (b.device_id !== signerDeviceId) return { ok: false, status: 403, code: "device_mismatch" };
  const cmd = (await sql`SELECT cmd_id, device_id, state FROM fleet_commands WHERE cmd_id = ${b.cmd_id}`) as Array<{ cmd_id: string; device_id: string; state: string }>;
  // a command issued to another device is indistinguishable from one that does not exist
  if (!cmd[0] || cmd[0].device_id !== signerDeviceId) return { ok: false, status: 404, code: "unknown_command" };
  const same = async (): Promise<boolean> => {
    const r = (await sql`
      SELECT outcome, reason, upload_key, detail = ${JSON.stringify(b.detail)}::jsonb AS d, started_at = ${b.started_at}::timestamptz AS s, finished_at = ${b.finished_at}::timestamptz AS f
        FROM fleet_results WHERE cmd_id = ${b.cmd_id}
    `) as Array<{ outcome: string; reason: string | null; upload_key: string | null; d: boolean; s: boolean; f: boolean }>;
    const x = r[0];
    return !!x && x.outcome === b.outcome && x.reason === b.reason && x.upload_key === (b.upload?.r2_key ?? null) && x.s && x.f && x.d; // jsonb = jsonb: key order and whitespace do not matter
  };
  if (cmd[0].state === "done") return (await same()) ? { ok: true, status: 200, duplicate: true } : { ok: false, status: 409, code: "RESULT_CONFLICT" };
  if (cmd[0].state !== "delivered") return { ok: false, status: 409, code: "not_delivered" };
  const ins = await sql`
    INSERT INTO fleet_results (cmd_id, device_id, outcome, reason, started_at, finished_at, detail, upload_key)
    VALUES (${b.cmd_id}, ${signerDeviceId}, ${b.outcome}, ${b.reason}, ${b.started_at}::timestamptz, ${b.finished_at}::timestamptz, ${JSON.stringify(b.detail)}::jsonb, ${b.upload?.r2_key ?? null})
    ON CONFLICT (cmd_id) DO NOTHING
    RETURNING cmd_id
  `;
  if (ins.length === 0) return (await same()) ? { ok: true, status: 200, duplicate: true } : { ok: false, status: 409, code: "RESULT_CONFLICT" };
  await sql`UPDATE fleet_commands SET state = 'done' WHERE cmd_id = ${b.cmd_id} AND device_id = ${signerDeviceId}`;
  await sql`INSERT INTO fleet_audit (actor, action, cmd_id, machine, summary) VALUES (${`device:${signerDeviceId}`}, 'result', ${b.cmd_id}, ${machine}, ${`outcome ${b.outcome}${b.reason ? ` (${b.reason})` : ""}`})`;
  return { ok: true, status: 200, duplicate: false };
}
