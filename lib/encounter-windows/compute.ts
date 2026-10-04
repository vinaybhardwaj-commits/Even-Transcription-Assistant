/**
 * lib/encounter-windows/compute.ts — pure computation of encounter windows from presence events.
 *
 * Port of ~/pulse-watch/gate-p1/consults.mjs (consult pairing, closes, attribution) on top of the occupancy
 * port in ./occupancy.ts. NO database access here.
 *
 * PAIRING. The extension emits an encounter_open carrying the consult uid (`encounter_id`) and, separately, an
 * encounter_open carrying only a `prescription_ref` (the Pulse URL ref). A consult is keyed on encounter_id; its
 * encounter_id open is paired with the NEAREST unused prescription_ref-only open within 60 s on the same machine,
 * and the consult opens at the EARLIER of the pair. A ref-only open with no partner is NOT a consult (counted in
 * the summary as unpaired_refs). Re-opens of the same encounter_id merge (reopen_count).
 *
 * CLOSE, in order: the first encounter_close for that encounter_id after the last open (bounded by the next
 * different consult's open) -> endConsult; else the LATEST close of one of its prescription_refs -> url_clear;
 * else the next different encounter_id open on the machine -> next_open; else the first logout/idle/locked event
 * after it -> logout / idle_timeout; else 90 minutes after the open -> cap_90m (or `open`, t_close null, while the
 * 90 minutes have not yet elapsed at asOf). A fallback close later than 90 minutes is also capped.
 *
 * ATTRIBUTION. doctor_uid = the most frequent uid on the consult's own rows (open pair + its closes) -> 'rows';
 * else the occupant at open time (occupancy resolver) -> 'occupant'; else 'none'.
 */
import {
  byTimeThenId,
  normalizeEvent,
  occupancyAt,
  type NEvent,
  type OccAt,
  type OccOptions,
} from "./occupancy";
import {
  normalizeHostname,
  RESOLVER_VERSION,
  type Attribution,
  type CloseReason,
  type ComputeOptions,
  type ComputeResult,
  type EncounterWindowRow,
  type PresenceEvent,
  type Quality,
  type RoomRef,
} from "./types";

const CAP_MS = 90 * 60_000;
const PAIR_MS = 60_000;

const toMs = (x: string | number | Date | undefined): number | undefined =>
  x === undefined ? undefined : x instanceof Date ? x.getTime() : typeof x === "number" ? x : new Date(x).getTime();

type Consult = {
  machine: string;
  enc: string;
  opens: number[];
  openIds: number[];
  refs: Set<string>;
  uids: Array<{ uid: string; dn: string | null }>;
  unpaired: number;
  // filled by closes
  open: number;
  close: number | null;
  closeReason: CloseReason;
  closeIds: number[];
};

function lookupRoom(cw: ComputeOptions["crosswalk"], machine: string): RoomRef | null {
  if (!cw) return null;
  const key = normalizeHostname(machine);
  if (cw instanceof Map) {
    return cw.get(machine) ?? cw.get(key) ?? null;
  }
  for (const k of Object.keys(cw)) if (k === machine || normalizeHostname(k) === key) return cw[k] ?? null;
  return null;
}

type MachineResult = { consults: Consult[]; unpairedRefs: number[]; all: NEvent[] };

function pairMachine(machine: string, all: NEvent[], asOf: number): MachineResult {
  const es = all.filter((e) => e.source === "ext"); // already (t, id) sorted
  const eo = es.filter((e) => e.event === "encounter_open" && e.enc);
  const ro = es.filter((e) => e.event === "encounter_open" && !e.enc && e.rx);
  const eclose = es.filter((e) => e.event === "encounter_close");
  const used = new Set<number>();
  const byEnc = new Map<string, Consult>();
  const consults: Consult[] = [];

  for (const e of eo) {
    let best: NEvent | null = null;
    let bd = Number.POSITIVE_INFINITY;
    for (const r of ro) {
      if (used.has(r.id)) continue;
      const d = Math.abs(r.t - e.t);
      if (d <= PAIR_MS && d < bd) {
        best = r;
        bd = d;
      }
    }
    if (best) used.add(best.id);
    let c = byEnc.get(e.enc!);
    if (!c) {
      c = { machine, enc: e.enc!, opens: [], openIds: [], refs: new Set(), uids: [], unpaired: 0, open: 0, close: null, closeReason: "open", closeIds: [] };
      byEnc.set(e.enc!, c);
      consults.push(c);
    }
    c.opens.push(best ? Math.min(e.t, best.t) : e.t);
    c.openIds.push(e.id);
    if (best) {
      if (best.rx) c.refs.add(best.rx);
      c.openIds.push(best.id);
    } else c.unpaired++;
    for (const r of [e, best]) if (r && r.uid) c.uids.push({ uid: r.uid, dn: r.dn });
  }
  const unpairedRefs = ro.filter((r) => !used.has(r.id)).map((r) => r.t);

  for (const c of consults) {
    c.opens.sort((a, b) => a - b);
    c.open = c.opens[0]!;
    const last = c.opens[c.opens.length - 1]!;
    let nxt: number | null = null;
    for (const x of eo) if (x.enc !== c.enc && x.t > last && (nxt === null || x.t < nxt)) nxt = x.t;
    const bound = nxt ?? Number.POSITIVE_INFINITY;
    const after = eclose.filter((e) => e.t >= last && e.t <= bound);
    const ec = after.find((e) => e.enc === c.enc) ?? null;
    let rc: NEvent | null = null;
    for (const e of after) if (e.rx && c.refs.has(e.rx) && (rc === null || e.t > rc.t)) rc = e;
    for (const e of after) if ((e === ec || (e.rx && c.refs.has(e.rx))) && e.uid) c.uids.push({ uid: e.uid, dn: e.dn });

    if (ec) {
      c.close = ec.t;
      c.closeReason = "endConsult";
      c.closeIds = [ec.id];
    } else if (rc) {
      c.close = rc.t;
      c.closeReason = "url_clear";
      c.closeIds = [rc.id];
    } else {
      let fb: number | null = null;
      let reason: CloseReason = "cap_90m";
      let evId: number | null = null;
      if (nxt !== null) {
        fb = nxt;
        reason = "next_open";
        evId = eo.find((x) => x.enc !== c.enc && x.t === nxt)?.id ?? null;
      } else {
        const st = es.find((e) => e.t > last && (e.event === "logout" || e.event === "idle" || e.event === "locked"));
        if (st) {
          fb = st.t;
          reason = st.event === "logout" ? "logout" : "idle_timeout";
          evId = st.id;
        }
      }
      if (fb === null) {
        if (c.open + CAP_MS > asOf) {
          c.close = null;
          c.closeReason = "open";
        } else {
          c.close = c.open + CAP_MS;
          c.closeReason = "cap_90m";
        }
      } else if (fb - c.open > CAP_MS) {
        c.close = c.open + CAP_MS;
        c.closeReason = "cap_90m";
      } else {
        c.close = fb;
        c.closeReason = reason;
        if (evId !== null) c.closeIds = [evId];
      }
    }
  }
  return { consults, unpairedRefs, all };
}

function topUid(uids: Consult["uids"]): { uid: string; dn: string | null } | null {
  const counts = new Map<string, { n: number; uid: string; dn: string | null }>();
  for (const u of uids) {
    const k = `${u.uid}\u0000${u.dn ?? ""}`;
    const x = counts.get(k);
    if (x) x.n++;
    else counts.set(k, { n: 1, uid: u.uid, dn: u.dn });
  }
  let top: { n: number; uid: string; dn: string | null } | null = null;
  for (const x of counts.values()) if (!top || x.n > top.n) top = x; // first inserted wins ties
  return top ? { uid: top.uid, dn: top.dn } : null;
}

const emptyQuality = (): Record<Quality, number> => ({ clean: 0, ambiguous: 0, multi_doctor: 0, unclosed: 0, unattributed: 0 });
const emptyAttr = (): Record<Attribution, number> => ({ rows: 0, occupant: 0, none: 0 });

/** close reasons that are an explicit close event; everything else is inferred and flagged 'unclosed'. */
const EXPLICIT_CLOSE: ReadonlySet<CloseReason> = new Set(["endConsult", "url_clear"]);

/** Compute windows and a run summary. Pure: events in, rows out. */
export function computeWindowsDetailed(events: PresenceEvent[], opts: ComputeOptions = {}): ComputeResult {
  const occOpts: OccOptions = {};
  if (opts.genuineMin !== undefined) occOpts.genuineMin = opts.genuineMin;
  if (opts.nightlyCutoff !== undefined) occOpts.nightlyCutoff = opts.nightlyCutoff;
  if (opts.lookbackH !== undefined) occOpts.lookbackH = opts.lookbackH;
  if (opts.focusMin !== undefined) occOpts.focusMin = opts.focusMin;

  const byMachine = new Map<string, NEvent[]>();
  let maxT = Number.NEGATIVE_INFINITY;
  for (const raw of events) {
    const e = normalizeEvent(raw);
    if (!e) continue;
    if (e.t > maxT) maxT = e.t;
    let a = byMachine.get(e.machine);
    if (!a) byMachine.set(e.machine, (a = []));
    a.push(e);
  }
  const asOf = toMs(opts.asOf) ?? (Number.isFinite(maxT) ? maxT : Date.now());
  const from = toMs(opts.from) ?? Number.NEGATIVE_INFINITY;
  const to = toMs(opts.to) ?? Number.POSITIVE_INFINITY;
  const inRange = (t: number) => t >= from && t < to;

  const rows: EncounterWindowRow[] = [];
  const summary = { consults: 0, unpaired_refs: 0, by_quality: emptyQuality(), by_attribution: emptyAttr(), by_close_reason: {} as Record<string, number> };
  const seenKeys = new Set<string>();

  for (const machine of [...byMachine.keys()].sort()) {
    const all = byMachine.get(machine)!;
    all.sort(byTimeThenId);
    const { consults, unpairedRefs } = pairMachine(machine, all, asOf);
    summary.unpaired_refs += unpairedRefs.filter(inRange).length;
    const room = lookupRoom(opts.crosswalk, machine);

    for (const c of consults) {
      if (!inRange(c.open)) continue;
      const midT = c.close !== null ? Math.round((c.open + c.close) / 2) : Math.round((c.open + asOf) / 2);
      const occOpen: OccAt = occupancyAt(all, c.open, occOpts);
      const occMid: OccAt = occupancyAt(all, midT, occOpts);

      const top = topUid(c.uids);
      let attribution: Attribution;
      let doctorUid: string | null = null;
      let displayName: string | null = null;
      if (top) {
        attribution = "rows";
        doctorUid = top.uid;
        displayName = top.dn;
      } else if (occOpen.best) {
        attribution = "occupant";
        doctorUid = occOpen.best.uid;
        displayName = occOpen.best.dn;
      } else attribution = "none";

      const multi = occOpen.n_present >= 2 || occMid.n_present >= 2;
      let quality: Quality;
      if (attribution === "none" && occOpen.ambiguous) quality = "ambiguous";
      else if (multi) quality = "multi_doctor";
      else if (!EXPLICIT_CLOSE.has(c.closeReason)) quality = "unclosed";
      else if (attribution === "none") quality = "unattributed";
      else quality = "clean";

      let key = c.enc;
      if (seenKeys.has(key)) key = `${c.enc}@${machine}`;
      seenKeys.add(key);

      const ids = [...new Set([...c.openIds, ...c.closeIds])].sort((a, b) => a - b);
      rows.push({
        consult_key: key,
        consult_uid: c.enc,
        prescription_ref: c.refs.size ? [...c.refs][0]! : null,
        machine,
        room_id: room?.room_id ?? null,
        room_slug: room?.slug ?? null,
        doctor_uid: doctorUid,
        display_name: displayName,
        attribution,
        t_open: new Date(c.open).toISOString(),
        t_close: c.close === null ? null : new Date(c.close).toISOString(),
        close_reason: c.closeReason,
        quality,
        reopen_count: c.opens.length - 1,
        source_event_ids: ids,
        resolver_version: RESOLVER_VERSION,
      });
      summary.consults++;
      summary.by_quality[quality]++;
      summary.by_attribution[attribution]++;
      summary.by_close_reason[c.closeReason] = (summary.by_close_reason[c.closeReason] ?? 0) + 1;
    }
  }
  rows.sort((a, b) => a.t_open.localeCompare(b.t_open) || a.machine.localeCompare(b.machine));
  return { rows, summary };
}

/** computeWindows(events, {from,to}) -> rows. See the file header for the rules. */
export function computeWindows(events: PresenceEvent[], opts: ComputeOptions = {}): EncounterWindowRow[] {
  return computeWindowsDetailed(events, opts).rows;
}
