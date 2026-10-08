/**
 * lib/rooms-live/snapshot.ts — assembles the `now` response (SPEC-v1 §2): the bounded reads, the per-room state, the PHI-free row shape, the degraded path and the
 * 2-second memo (one database fan-out per 2 s per instance, whatever the number of open screens).
 *
 * Two phases: (1) listener, install, sessions, levels, steward in parallel; (2) once the installs name the machines: heartbeat, extension events, occupancy.
 * Every read has its own 5 s timeout. A failed read is named in `degraded` and the rooms that need it come back "unknown"; the response is never a 500.
 */
import { expandKeys, matchKey } from "@/lib/kiosk-health-read";
import { machineKeys } from "@/lib/encounter-windows/machine-keys";
import { raceTimeout } from "@/lib/steward/timeout";
import { autoClearDue, claimResolved, resolvedStreak, toView, CLEAR_AFTER_POLLS, forgetStreaksExcept, type ClaimView, type ClaimsPort } from "./claims";
import { ROOMS as ROOMS_DEFAULT, type RoomDef } from "./rooms";
import { loadRoster, resetRosterForTests } from "./roster";
import {
  STATEMENT_TIMEOUT_MS,
  istDateOf,
  readExt,
  readHeartbeats,
  readInstalls,
  readLevels,
  readListeners,
  readOccupancy,
  readSessions,
  readSteward,
  readStewardActions,
  readStewardConfig,
  readStewardLog,
  readWarehouseConsults,
  type Db,
  type ExtRow,
  type HeartbeatRow,
  type InstallRow,
  type LevelDbRow,
  type ListenerRow,
  type SessionRow,
  type StewardLogRow,
  type StewardRow,
  type WarehouseConsultRow,
} from "./read";
import { STATUS_KEYS, statusFromRows } from "./steward-status";
import { cardLine, isChange, lineOf, type StewardLine, type StewardStatus } from "./steward-lines";
import { computeState, type LevelRow, type RoomStateName, type StateInput } from "./state";

export type RoomRow = {
  room_id: string;
  label: string;
  doctor: { display: string; activity: "In consultation" | "Signed in" | `Last consult ${string}` } | null;
  /** false when the occupancy read failed: the doctor is UNKNOWN, not absent (FIX-1 F1) */
  doctor_known: boolean;
  state: RoomStateName;
  state_since: string | null;
  detail_code: string | null;
  level: { rms: number | null; zero: number | null; at: string | null; stale: boolean };
  baseline_rms: number | null;
  device: { name: string | null; missing: boolean };
  session: { open: boolean; since: string | null; chunk_age_s: number | null };
  steward: { action: string; mode: string; at: string } | null;
  /** v1.7 S2: the one plain-words Steward line for the card (newest action of the last 60 min, else the hold line), or null */
  steward_line: StewardLine | null;
  /** v1.7 S4: this room's last 20 non-ok decisions, newest first (the Details view) */
  steward_log: StewardLine[];
  claim: ClaimView | null;
  ages_s: { listener: number | null; heartbeat: number | null; ext: number | null };
};
/** v1.7 S3: a Steward action or alert (live or shadow) of today, tagged "Steward" */
export type ChangeRow = StewardLine & { room_id: string; label: string; tag: "Steward" };
export type Snapshot = {
  generated_at: string;
  rooms: RoomRow[];
  degraded: string[];
  /** v1.7 S1: the strip's data; the page says "Steward status unavailable" for state "unavailable" */
  steward_status: StewardStatus;
  /** v1.7 S3: today's Steward changes, newest first, at most 50 */
  changes_today: ChangeRow[];
};
export const CHANGES_MAX = 50;

export const MEMO_MS = 2000;
/** a warehouse consult closed longer ago than this is no longer "in consultation" */
export const CONSULT_CLOSE_GRACE_MS = 2 * 60_000;
/** v1.5: between patients, a consult closed within this long ago still names the doctor ("Last consult HH:MM") */
export const LAST_CONSULT_WINDOW_MS = 90 * 60_000;

/** HH:MM, 24 h, Asia/Kolkata */
const istHm = (t: number): string => {
  const m = Math.floor(((t + 19_800_000) % 86_400_000) / 60_000);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

const ms = (x: string | null | undefined): number | null => {
  if (!x) return null;
  const t = Date.parse(x);
  return Number.isFinite(t) ? t : null;
};
const r1 = (n: number | null): number | null => (n === null ? null : Math.round(n * 10) / 10);
const r5 = (n: number | null): number | null => (n === null ? null : Math.round(n * 100000) / 100000);

/** state_flags jsonb -> the flag names */
export function flagsOf(raw: unknown): string[] {
  let v: unknown = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return [];
    }
  }
  const f = v && typeof v === "object" ? (v as { flags?: unknown }).flags : null;
  return Array.isArray(f) ? f.filter((x): x is string => typeof x === "string") : [];
}
/** input_devices jsonb -> device names; null when the list is not a list (an app that does not report it) */
export function deviceNamesOf(raw: unknown): string[] | null {
  let v: unknown = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(v)) return null;
  return v.map((d) => (typeof d === "string" ? d : d && typeof d === "object" && typeof (d as { name?: unknown }).name === "string" ? (d as { name: string }).name : "")).filter(Boolean);
}

export type Deps = { db: Db; now?: () => number; timeoutMs?: number; claims?: ClaimsPort; /** the rooms to show; default = loadRoster (F29) */ rooms?: readonly RoomDef[] };

export async function buildSnapshot(deps: Deps): Promise<Snapshot> {
  const now = (deps.now ?? Date.now)();
  const asOf = new Date(now).toISOString();
  const tmo = deps.timeoutMs ?? STATEMENT_TIMEOUT_MS;
  const degraded: string[] = [];
  const safe = async <T>(name: string, fn: () => Promise<T>): Promise<{ v: T | null; ok: boolean }> => {
    try {
      return { v: await raceTimeout(fn, tmo), ok: true };
    } catch {
      if (!degraded.includes(name)) degraded.push(name); // v1.7: the Steward's three decision reads share one name
      return { v: null, ok: false };
    }
  };
  const today = istDateOf(now);
  const yesterday = istDateOf(now - 86_400_000);
  const ROOMS: readonly RoomDef[] = deps.rooms ?? (await raceTimeout(() => loadRoster(deps.db, now), tmo).catch(() => ROOMS_DEFAULT));
  const ROOM_IDS = ROOMS.map((r) => r.room_id);

  const istDayStart = new Date(Math.floor((now + 19_800_000) / 86_400_000) * 86_400_000 - 19_800_000).toISOString();
  const [lis, ins, ses, lev, ste, clm, scf, slog, sact] = await Promise.all([
    safe("bench_listener", () => readListeners(deps.db, ROOM_IDS)),
    safe("room_install", () => readInstalls(deps.db, ROOM_IDS)),
    safe("bench_session", () => readSessions(deps.db, ROOM_IDS, asOf)),
    safe("bench_level_sample", () => readLevels(deps.db, ROOM_IDS, asOf, today, yesterday)),
    safe("steward_decisions", () => readSteward(deps.db, ROOM_IDS, asOf)),
    safe("rooms_live_claim", async () => (deps.claims ? await deps.claims.open() : [])),
    safe("steward_config", () => readStewardConfig(deps.db, STATUS_KEYS)),
    safe("steward_decisions", () => readStewardLog(deps.db, ROOM_IDS, asOf)),
    safe("steward_decisions", () => readStewardActions(deps.db, ROOM_IDS, asOf, istDayStart)),
  ]);
  // v1.7: a failed or unreadable steward_config is "Steward status unavailable" on the page; the cards still render
  const stewardStatus: StewardStatus = scf.ok && scf.v ? statusFromRows(scf.v) : { state: "unavailable" };
  const logBy = new Map<string, StewardLogRow[]>();
  for (const r of slog.v ?? []) logBy.set(r.room_id, [...(logBy.get(r.room_id) ?? []), r]);
  const actBy = new Map<string, StewardLogRow[]>();
  for (const r of sact.v ?? []) actBy.set(r.room_id, [...(actBy.get(r.room_id) ?? []), r]);

  const installBy = new Map<string, InstallRow>((ins.v ?? []).map((r) => [r.room_id, r]));
  // machine spellings per room, from the install hostname
  const keysByRoom = new Map<string, string[]>();
  for (const r of ins.v ?? []) if (r.hostname) keysByRoom.set(r.room_id, expandKeys(machineKeys(r.hostname)));
  const allKeys = [...new Set([...keysByRoom.values()].flat())];
  const roomOfKey = new Map<string, string>();
  for (const [room, keys] of keysByRoom) for (const k of keys) roomOfKey.set(matchKey(k), room);

  let hb: { v: HeartbeatRow[] | null; ok: boolean } = { v: [], ok: true };
  let ext: { v: ExtRow[] | null; ok: boolean } = { v: [], ok: true };
  let occ: { v: Awaited<ReturnType<typeof readOccupancy>> | null; ok: boolean } = { v: [], ok: true };
  let whc: { v: WarehouseConsultRow[] | null; ok: boolean } = { v: [], ok: true };
  if (allKeys.length > 0) {
    [hb, ext, occ, whc] = await Promise.all([
      safe("kiosk_health_heartbeat", () => readHeartbeats(deps.db, allKeys, asOf)),
      safe("pulse_presence_ext", () => readExt(deps.db, allKeys, asOf)),
      safe("occupancy", () => readOccupancy(deps.db, allKeys, asOf)),
      safe("eta_encounter_windows", () => readWarehouseConsults(deps.db, allKeys, asOf)),
    ]);
  }

  const lisBy = new Map<string, ListenerRow>((lis.v ?? []).map((r) => [r.room_id, r]));
  const sesBy = new Map<string, SessionRow>();
  for (const s of ses.v ?? []) if (!sesBy.has(s.room_id)) sesBy.set(s.room_id, s); // newest first
  const levBy = new Map<string, LevelRow[]>();
  for (const l of (lev.v ?? []) as LevelDbRow[]) {
    const list = levBy.get(l.room_id) ?? [];
    list.push({ t: Date.parse(l.sampled_at), rms: l.peak, zero: l.zero_ratio });
    levBy.set(l.room_id, list);
  }
  const steBy = new Map<string, StewardRow>((ste.v ?? []).map((r) => [r.room_id, r]));
  const hbBy = new Map<string, number>();
  for (const h of hb.v ?? []) {
    const room = roomOfKey.get(matchKey(h.machine));
    const t = Date.parse(h.received_at);
    if (room && (!hbBy.has(room) || t > hbBy.get(room)!)) hbBy.set(room, t);
  }
  const extBy = new Map<string, ExtRow>();
  for (const e of ext.v ?? []) {
    const room = roomOfKey.get(matchKey(e.machine));
    if (room && (!extBy.has(room) || Date.parse(e.ts) > Date.parse(extBy.get(room)!.ts))) extBy.set(room, e);
  }
  const occBy = new Map<string, { occupied: boolean; ambiguous: boolean; page_name: string | null; best_dn: string | null; best_uid: string | null; best_stale: boolean }>();
  for (const o of occ.v ?? []) {
    const room = roomOfKey.get(matchKey(o.machine));
    if (room) occBy.set(room, { occupied: o.occupied, ambiguous: o.ambiguous, page_name: o.page_name, best_dn: o.best_dn ?? null, best_uid: o.best_uid ?? null, best_stale: !!o.best_stale });
  }
  // v1.4: the newest warehouse consult per room; it counts only while OPEN (t_open <= now, and no t_close or one within the last 2 minutes)
  const openConsultBy = new Map<string, WarehouseConsultRow>();
  const lastConsultBy = new Map<string, WarehouseConsultRow>();
  for (const c of whc.v ?? []) {
    const room = roomOfKey.get(matchKey(c.machine));
    const tOpen = Date.parse(c.t_open);
    const tClose = c.t_close ? Date.parse(c.t_close) : null;
    if (!room || !Number.isFinite(tOpen) || tOpen > now) continue;
    if (tClose !== null && !(tClose >= now - CONSULT_CLOSE_GRACE_MS)) {
      // v1.5: closed, but recently enough that the doctor is still the room's doctor between patients
      if (tClose >= now - LAST_CONSULT_WINDOW_MS && tClose <= now) {
        const pl = lastConsultBy.get(room);
        if (!pl || Date.parse(pl.t_close!) < tClose) lastConsultBy.set(room, c);
      }
      continue;
    }
    const prev = openConsultBy.get(room);
    if (!prev || Date.parse(prev.t_open) < tOpen) openConsultBy.set(room, c);
  }

  const rooms: RoomRow[] = ROOMS.map((def) => {
    const l = lisBy.get(def.room_id) ?? null;
    const inst = installBy.get(def.room_id) ?? null;
    const s = sesBy.get(def.room_id) ?? null;
    const sdec = steBy.get(def.room_id) ?? null;
    const input: StateInput = {
      now,
      listener: l ? { last_poll_at: ms(l.last_poll_at), levels_at: ms(l.levels_at), rms: l.mic_peak, zero: l.mic_zero_ratio } : null,
      install: inst ? { flags: flagsOf(inst.state_flags), state_changed_at: ms(inst.state_changed_at), input_device_name: inst.input_device_name, input_devices: deviceNamesOf(inst.input_devices) } : null,
      session: { open: !!s, since: s ? ms(s.started_at) : null, chunk_age_s: s && s.last_chunk_at ? Math.round((now - Date.parse(s.last_chunk_at)) / 1000) : null },
      heartbeat_at: hbBy.get(def.room_id) ?? null,
      ext_at: extBy.has(def.room_id) ? Date.parse(extBy.get(def.room_id)!.ts) : null,
      levels: levBy.get(def.room_id) ?? [],
      steward: sdec ? { action: sdec.action, mode: sdec.mode, at: Date.parse(sdec.ts) } : null,
      known: { listener: lis.ok, install: ins.ok && !!inst, session: ses.ok, heartbeat: hb.ok && keysByRoom.has(def.room_id), ext: ext.ok && keysByRoom.has(def.room_id), levels: lev.ok },
    };
    // a room with a listener row but no enrolled install is not "unknown": the install is simply absent, rules read it as null
    if (ins.ok && !inst) input.known.install = true;
    const r = computeState(input);
    const o = occBy.get(def.room_id);
    const e = extBy.get(def.room_id);
    const present = !!o && o.occupied && !o.ambiguous;
    // F28: the name is the identity-checked occupant's (scopedOccupancy), never the newest extension event's display_name (that is the stale cookie identity)
    // v1.5: else a consult closed within 90 min names it ("Last consult HH:MM"). v1.4: an open warehouse consult names the doctor whatever occupancy says. Otherwise the occupancy rules stand: the occupant's non-stale full display name (v1.6),
    // then the page greeting, then the literal. A stale-cookie stream's dn is a greeting or a placeholder, never the cookie's name; its best_dn is not used.
    const wc = openConsultBy.get(def.room_id);
    // v1.6: the resolver's full display name comes before the page greeting (a first name only); a bare email or uid is not a name
    const rawBest = o && !o.best_stale ? o.best_dn?.trim() : "";
    const bestName = rawBest && !rawBest.includes("@") && rawBest !== o?.best_uid?.trim() ? rawBest : "";
    const lc = lastConsultBy.get(def.room_id);
    const doctor: RoomRow["doctor"] = wc?.doctor_name
      ? { display: wc.doctor_name.slice(0, 60), activity: "In consultation" }
      : lc?.doctor_name
        ? { display: lc.doctor_name.slice(0, 60), activity: `Last consult ${istHm(Date.parse(lc.t_close!))}` }
        : present
        ? { display: bestName.slice(0, 60) || o!.page_name?.trim().slice(0, 60) || "Doctor", activity: (e?.has_encounter && now - Date.parse(e.ts) <= 180_000 ? "In consultation" : "Signed in") as "In consultation" | "Signed in" }
        : null;
    return {
      room_id: def.room_id,
      label: def.label,
      doctor,
      doctor_known: occ.ok && whc.ok,
      state: r.state,
      state_since: r.state_since === null ? null : new Date(r.state_since).toISOString(),
      detail_code: r.detail_code,
      level: { rms: r5(r.level.rms), zero: r5(r.level.zero), at: r.level.at === null ? null : new Date(r.level.at).toISOString(), stale: r.level.stale },
      baseline_rms: r5(r.baseline_rms),
      device: r.device,
      session: { open: input.session.open, since: input.session.since === null ? null : new Date(input.session.since).toISOString(), chunk_age_s: input.session.chunk_age_s },
      steward: sdec ? { action: sdec.action, mode: sdec.mode, at: sdec.ts } : null,
      steward_line: cardLine(actBy.get(def.room_id) ?? [], now),
      steward_log: (logBy.get(def.room_id) ?? []).slice(0, 20).map(lineOf),
      claim: null,
      ages_s: { listener: r1(r.ages_s.listener), heartbeat: r1(r.ages_s.heartbeat), ext: r1(r.ages_s.ext) },
    };
  });
  // claims: attach the open ones; the ONLY write of GET /now is the auto-clear of a claim whose room no longer needs anyone (once per room per minute, claims.ts)
  for (const c of clm.v ?? []) {
    const row = rooms.find((r) => r.room_id === c.room_id);
    if (!row) continue;
    const resolved = claimResolved(row.state, !!row.doctor, row.doctor_known);
    // F27: one good poll is not enough; it takes two in a row
    const streak = resolvedStreak(row.room_id, resolved);
    if (resolved && deps.claims && streak >= CLEAR_AFTER_POLLS && autoClearDue(row.room_id, now)) {
      await safe("rooms_live_claim_clear", () => deps.claims!.clear(row.room_id));
      continue;
    }
    if (!resolved) row.claim = toView(c);
  }
  if (deps.claims && clm.ok) forgetStreaksExcept((clm.v ?? []).map((c) => c.room_id));
  const labelOf = new Map(rooms.map((r) => [r.room_id, r.label]));
  const changes_today: ChangeRow[] = (sact.v ?? [])
    .filter((r) => isChange(r) && labelOf.has(r.room_id) && Date.parse(r.ts) >= Date.parse(istDayStart))
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
    .slice(0, CHANGES_MAX)
    .map((r) => ({ ...lineOf(r), room_id: r.room_id, label: labelOf.get(r.room_id)!, tag: "Steward" as const }));
  return { generated_at: asOf, rooms, degraded, steward_status: stewardStatus, changes_today };
}

// ---------------------------------------------------------------------------
// the 2-second memo
// ---------------------------------------------------------------------------
let memo: { at: number; p: Promise<Snapshot> } | null = null;

export async function getSnapshot(deps: Deps): Promise<Snapshot> {
  const now = (deps.now ?? Date.now)();
  if (memo && now - memo.at < MEMO_MS && now >= memo.at) return memo.p;
  const p = buildSnapshot(deps).catch((e) => {
    if (memo && memo.p === p) memo = null;
    throw e;
  });
  memo = { at: now, p };
  return p;
}
export const resetMemoForTests = (): void => {
  memo = null;
  resetRosterForTests();
};
/** after a claim is written the next /now must show it at once */
export const resetSnapshotMemo = resetMemoForTests;
