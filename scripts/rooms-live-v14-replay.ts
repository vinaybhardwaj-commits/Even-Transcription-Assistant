/**
 * Rooms Live v1.4 replay (READ-ONLY). Replays a window of bench_level_sample through the real lib/rooms-live/state.ts, one verdict per minute per room, and scores it
 * against the open warehouse consults; then runs buildSnapshot at one instant to see who it names.
 *
 *   DB url: ~/.config/eta-audio/db.url (never printed). Neon HTTP endpoint, SELECT only.
 *   npx vite-node --config vitest.config.ts scripts/rooms-live-v14-replay.ts [--from 2026-10-08T06:00:00Z] [--to 2026-10-08T06:45:00Z] [--at 2026-10-08T06:42:00Z] [--old /path/to/old-state.ts]
 *   --old: the previous state.ts (git show origin/main~:lib/rooms-live/state.ts) for the old-vs-new column. Output: counts and percentages only, no names.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { expandKeys, matchKey } from "@/lib/kiosk-health-read";
import { machineKeys } from "@/lib/encounter-windows/machine-keys";
import { ROOMS } from "@/lib/rooms-live/rooms";
import { buildSnapshot } from "@/lib/rooms-live/snapshot";
import { computeState, type LevelRow, type StateInput } from "@/lib/rooms-live/state";
import type { Db } from "@/lib/rooms-live/read";

const arg = (k: string, d: string): string => {
  const i = process.argv.indexOf(k);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d;
};
const FROM = Date.parse(arg("--from", "2026-10-08T06:00:00Z"));
const TO = Date.parse(arg("--to", "2026-10-08T06:45:00Z"));
const AT = Date.parse(arg("--at", "2026-10-08T06:42:00Z"));
const OLD = arg("--old", "");
const PRE_MS = 45 * 60_000;

const url = readFileSync(`${homedir()}/.config/eta-audio/db.url`, "utf8").trim();
const host = new URL(url).host.replace("-pooler", "");
const toParam = (v: unknown): unknown => (Array.isArray(v) ? `{${v.map((x) => JSON.stringify(String(x))).join(",")}}` : v instanceof Date ? v.toISOString() : v);
const db = (async (strings: TemplateStringsArray, ...vals: unknown[]) => {
  const query = strings.reduce((a, s, i) => a + s + (i < vals.length ? `$${i + 1}` : ""), "");
  const res = await fetch(`https://${host}/sql`, { method: "POST", headers: { "Content-Type": "application/json", "Neon-Connection-String": url }, body: JSON.stringify({ query, params: vals.map(toParam) }) });
  const j = (await res.json()) as { rows?: unknown[]; message?: string };
  if (!res.ok) throw new Error(`sql ${res.status}: ${String(j.message ?? "").slice(0, 120)}`);
  return j.rows ?? [];
}) as unknown as Db;
const q = (query: string, params: unknown[] = []) => (db as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<Array<Record<string, unknown>>>)(Object.assign([query], { raw: [query] }) as unknown as TemplateStringsArray, ...[]).then((r) => r, () => []) as Promise<Array<Record<string, unknown>>>;
void q;

async function raw(query: string, params: unknown[]): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`https://${host}/sql`, { method: "POST", headers: { "Content-Type": "application/json", "Neon-Connection-String": url }, body: JSON.stringify({ query, params: params.map(toParam) }) });
  const j = (await res.json()) as { rows?: Array<Record<string, unknown>>; message?: string };
  if (!res.ok) throw new Error(`sql ${res.status}: ${String(j.message ?? "").slice(0, 120)}`);
  return j.rows ?? [];
}

const pct = (n: number, d: number): string => (d === 0 ? "n/a" : `${Math.round((100 * n) / d)}%`);

async function main() {
  const ids = ROOMS.map((r) => r.room_id);
  const installs = await raw(`SELECT room_id, hostname FROM room_install WHERE room_id = ANY($1::text[]) AND retired_at IS NULL AND enrolled_at IS NOT NULL LIMIT 30`, [ids]);
  const keysOf = new Map<string, string[]>();
  for (const r of installs) if (r.hostname) keysOf.set(String(r.room_id), expandKeys(machineKeys(String(r.hostname))));
  const allKeys = [...new Set([...keysOf.values()].flat())];
  const roomOfKey = new Map<string, string>();
  for (const [room, ks] of keysOf) for (const k of ks) roomOfKey.set(matchKey(k), room);

  const lv = await raw(
    `SELECT room_id, sampled_at, peak, zero_ratio FROM bench_level_sample WHERE room_id = ANY($1::text[]) AND sampled_at > $2::timestamptz AND sampled_at <= $3::timestamptz AND session_open = true ORDER BY sampled_at LIMIT 30000`,
    [ids, new Date(FROM - PRE_MS).toISOString(), new Date(TO).toISOString()],
  );
  const levels = new Map<string, LevelRow[]>();
  for (const r of lv) {
    const list = levels.get(String(r.room_id)) ?? [];
    list.push({ t: Date.parse(String(r.sampled_at)), rms: Number(r.peak), zero: r.zero_ratio === null ? null : Number(r.zero_ratio) });
    levels.set(String(r.room_id), list);
  }
  const wh = await raw(
    `SELECT machine, t_open, t_close FROM eta_encounter_windows WHERE attribution_source = 'warehouse' AND machine = ANY($1::text[]) AND t_open < $3::timestamptz AND (t_close IS NULL OR t_close > $2::timestamptz) LIMIT 200`,
    [allKeys, new Date(FROM).toISOString(), new Date(TO).toISOString()],
  );
  const consults = new Map<string, Array<[number, number]>>();
  for (const w of wh) {
    const room = roomOfKey.get(matchKey(String(w.machine)));
    if (!room) continue;
    const list = consults.get(room) ?? [];
    list.push([Date.parse(String(w.t_open)), w.t_close ? Date.parse(String(w.t_close)) : Number.POSITIVE_INFINITY]);
    consults.set(room, list);
  }

  const oldMod = OLD ? ((await import(OLD)) as { computeState: typeof computeState }) : null;
  const known = { listener: true, install: true, session: true, heartbeat: true, ext: true, levels: true };
  const verdict = (fn: typeof computeState, rows: LevelRow[], now: number): string => {
    const newest = rows[rows.length - 1]!;
    const inp: StateInput = {
      now,
      listener: { last_poll_at: now - 1000, levels_at: newest.t, rms: newest.rms, zero: newest.zero },
      install: { flags: [], state_changed_at: null, input_device_name: "x", input_devices: ["x"] },
      session: { open: true, since: now - 3_600_000, chunk_age_s: 60 },
      heartbeat_at: now - 20_000, ext_at: now - 20_000, levels: rows, steward: null, known,
    };
    const r = fn(inp);
    return r.state;
  };

  console.log(`replay ${new Date(FROM).toISOString()} .. ${new Date(TO).toISOString()}  (1 verdict per minute; now = the newest row at or before the minute, rows older than 6 s are skipped)`);
  console.log("room | minutes | in-consult min | listening in consult | quiet outside consult | skipped(no fresh row) | old: listening in / quiet out");
  for (const def of ROOMS) {
    const rows = levels.get(def.room_id) ?? [];
    const cs = consults.get(def.room_id) ?? [];
    let inN = 0, inL = 0, outN = 0, outQ = 0, skipped = 0, oInL = 0, oOutQ = 0, total = 0;
    for (let m = FROM; m < TO; m += 60_000) {
      total++;
      const upTo = rows.filter((r) => r.t <= m + 60_000 - 1);
      const win = upTo.filter((r) => r.t > m + 60_000 - 1 - PRE_MS);
      const newest = win[win.length - 1];
      if (!newest || m + 60_000 - newest.t > 6000) { skipped++; continue; }
      const now = newest.t + 500;
      const inside = cs.some(([a, b]) => a <= m + 30_000 && m + 30_000 < b);
      const s = verdict(computeState, win, now);
      const so = oldMod ? verdict(oldMod.computeState, win, now) : null;
      if (inside) { inN++; if (s === "listening") inL++; if (so === "listening") oInL++; }
      else { outN++; if (s === "quiet") outQ++; if (so === "quiet") oOutQ++; }
    }
    console.log(`${def.label} | ${total} | ${inN} in / ${outN} out | ${inN ? pct(inL, inN) : "n/a (no consult)"} | ${outN ? pct(outQ, outN) : "n/a"} | ${skipped} | ${oldMod ? `${inN ? pct(oInL, inN) : "n/a"} / ${outN ? pct(oOutQ, outN) : "n/a"}` : "(no --old)"}`);
  }

  const snap = await buildSnapshot({ db, now: () => AT });
  console.log(`\nbuildSnapshot at ${new Date(AT).toISOString()} degraded=[${snap.degraded.join(",")}]`);
  for (const r of snap.rooms) console.log(`${r.label}: doctor=${r.doctor ? `named(${r.doctor.display === "Doctor" ? "literal" : "name"}) ${r.doctor.activity}` : "none"} doctor_known=${r.doctor_known}`);
}
main().catch((e) => { console.error("replay failed:", String(e?.message ?? e).slice(0, 200)); process.exit(1); });
