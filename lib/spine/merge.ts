/**
 * Spine merge: pure mergeSignals (SPINE-PLAN §3, M1-M9). No clock, no randomness, no I/O: `now` is a parameter.
 * Rulings: D1 id = enc_ + 16 base32 with no 8-digit run, D7 72 h horizon, D8 overlap >= 50% of the shorter interval.
 *
 * Readings (R2), each interpreting a plan line:
 * - A2, M2 "Two signals with the same consult_uid, consult_key or pqm_uid are the same encounter ... A Pulse enc id on two
 *   machines gives two encounters, flagged multi_machine": consult_key and pqm_uid are merge keys. A consult_uid match
 *   merges only when the machine matches too (the same consult_key, or none on either side); the same consult_uid on two
 *   machines gives two encounters, both flagged multi_machine.
 * - F1, M4 + M8: a prior encounter anchored by a strong signal (pulse|pqm) is claimed ONLY by the group that holds that
 *   anchor signal (by its stale encounter_id or its identity key). A weak signal's stale encounter_id never pulls it in.
 *   Two priors anchored by the same strong kind are never survivor and loser. Output encounter_ids are unique (throws).
 * - I2, M4 "even when they overlap": any positive overlap between two same-kind strong anchors sets pulse_overlap (raw spans).
 * - I3 (safer reading, pending ruling): a weak or inferred boundary is clamped at the open/close of a neighbouring
 *   strong-anchored encounter in the same room, flag `clamped`. Explicit strong closes (M6 rank) are never clamped.
 * - I4, M8 "After ist_date+72 h only links change": a frozen prior keeps its links; nothing moves from or to it. A frozen prior
 *   never absorbs a live one (a live candidate survives instead), and a frozen loser's signals keep their assignment.
 * - X1 (R3): a prior claimed by any group is never also a loser; the uniqueness assert runs over every emitted row.
 * - X2 (R3, interim safer rule pending a ruling): a pulse group and a pqm group merge by TIME only when the overlap is >= 50%
 *   of BOTH spans; by shared key as before. In a pulse+pqm merge the pulse-anchored prior survives. A strong-anchored prior
 *   is never marked merged into a strong prior of the same kind.
 * - X3c (R3): when the clamp would leave an empty span the raw span is kept and the flag `clamp_failed` is set.
 * - X5 (R3): strongOwner prefers the identity link (consult_key | pqm_uid) over a stale encounter_id.
 * - X6c (R3): a weak signal with only a consult_uid that exists on more than one machine gets the flag `ambiguous` on its group.
 */
import { createHmac } from "node:crypto";
import type {
  KeyKind, LinkBasis, MergeResult, MergedEncounter, MergedLink, PriorEncounter, Proxy, SignalAssignment, SpinePrior, SpineSignal,
} from "./types";
import { DERIVED_PROXIES, STRONG_PROXIES, WEAK_PROXIES } from "./types";

export const OVERLAP_PCT = 50; // D8
export const CAP_MS = 90 * 60_000; // M1, compute.ts:44
export const MIN_WEAK_SPAN_MS = 120_000; // M5
export const NO_TAPE_RECHECK_MS = 24 * 3_600_000; // M5
export const HORIZON_MS = 72 * 3_600_000; // D7
const IST_OFFSET_MS = 19_800_000;
const ID_KEY = "eta-spine-encounter-id-v1"; // a domain separator, not a secret
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const EIGHT_DIGITS = /\d{8}/;
const MATCH_KINDS: KeyKind[] = ["consult_uid", "consult_key", "pqm_uid"];
const ANCHOR_ORDER: Proxy[] = ["pulse", "pqm", "timeline", "acoustic", "nemotron_window", "doctor_activity"];
const PULSE_EXPLICIT_CLOSE = new Set(["endConsult", "url_clear"]);
// M6 rank, lower wins. Close: pulse endConsult|url_clear > pqm > timeline > acoustic > pulse inferred > doctor_activity.
const OPEN_RANK: Record<string, number> = { pulse: 0, pqm: 1, timeline: 2, acoustic: 3, doctor_activity: 4, nemotron_window: 5 };

interface Norm {
  sig: SpineSignal;
  room: string;
  open: number;
  close: number;
  explicitClose: boolean;
  keys: [KeyKind, string][];
  via: LinkBasis;
}
interface Group {
  members: Norm[];
}
interface Span {
  open: number;
  close: number;
}

function attr(sig: SpineSignal, k: string): string | null {
  const v = sig.attrs?.[k];
  return typeof v === "string" && v !== "" ? v : null;
}
export function istDate(ms: number): string {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}
function horizonEnd(istDay: string): number {
  return Date.parse(`${istDay}T00:00:00Z`) - IST_OFFSET_MS + HORIZON_MS;
}
function keysOf(sig: SpineSignal): [KeyKind, string][] {
  const out: [KeyKind, string][] = [];
  for (const k of ["consult_uid", "consult_key", "pqm_uid", "caa_uid", "buddy_opaque"] as KeyKind[]) {
    const v = attr(sig, k);
    if (v) out.push([k, v]);
  }
  const w = attr(sig, "window_id") ?? (sig.proxy === "nemotron_window" ? sig.source_key : null);
  if (w) out.push(["window_id", w]);
  if (sig.proxy === "caa" && !out.some(([k]) => k === "caa_uid")) out.push(["caa_uid", sig.source_key]);
  return out;
}
const isStrong = (n: Norm) => STRONG_PROXIES.includes(n.sig.proxy);
const isDerived = (n: Norm) => DERIVED_PROXIES.includes(n.sig.proxy);
const isWeak = (n: Norm) => WEAK_PROXIES.includes(n.sig.proxy);
const cmp = (a: string | number, b: string | number) => (a < b ? -1 : a > b ? 1 : 0);

function normOrder(a: Norm, b: Norm): number {
  return cmp(a.open, b.open) || cmp(a.close, b.close) || cmp(a.sig.proxy, b.sig.proxy) || cmp(a.sig.source_key, b.sig.source_key) || cmp(a.room, b.room);
}

function overlapMs(a: Span, b: Span): number {
  return Math.max(0, Math.min(a.close, b.close) - Math.max(a.open, b.open));
}
function shorter(a: Span, b: Span): number {
  return Math.min(a.close - a.open, b.close - b.open);
}
/** D8: overlap >= 50% of the shorter interval. */
function meets(a: Span, b: Span): boolean {
  const sh = shorter(a, b);
  return sh > 0 && overlapMs(a, b) * 100 >= sh * OVERLAP_PCT;
}
/** X2: overlap >= 50% of BOTH spans. */
function mutual(a: Span, b: Span): boolean {
  const la = a.close - a.open, lb = b.close - b.open;
  const o = overlapMs(a, b);
  return la > 0 && lb > 0 && o * 100 >= la * OVERLAP_PCT && o * 100 >= lb * OVERLAP_PCT;
}
function ratio(a: Span, b: Span): number {
  const sh = shorter(a, b);
  return sh > 0 ? overlapMs(a, b) / sh : 0;
}

function closeRank(n: Norm): number {
  switch (n.sig.proxy) {
    case "pulse": return PULSE_EXPLICIT_CLOSE.has(attr(n.sig, "close_reason") ?? "") ? 0 : 4;
    case "pqm": return 1;
    case "timeline": return 2;
    case "acoustic": return 3;
    case "doctor_activity": return 5;
    default: return 6;
  }
}

/** M6. Highest-ranked explicit open and close; ties go to the earlier open and the later close. */
function spanDetail(g: Group): Span & { openStrong: boolean; closeStrong: boolean } {
  const core = g.members.filter((m) => !isDerived(m));
  const best = (xs: Norm[], rank: (n: Norm) => number, pick: (a: Norm, b: Norm) => boolean) =>
    xs.reduce((a, b) => (rank(b) < rank(a) || (rank(b) === rank(a) && pick(b, a)) ? b : a));
  const openN = best(core, (n) => OPEN_RANK[n.sig.proxy] ?? 9, (b, a) => b.open < a.open);
  const explicit = core.filter((m) => m.explicitClose);
  const closeN = explicit.length ? best(explicit, closeRank, (b, a) => b.close > a.close) : null;
  const close = closeN ? closeN.close : Math.max(...core.map((m) => m.close));
  if (close > openN.open) {
    return { open: openN.open, close, openStrong: isStrong(openN), closeStrong: !!closeN && isStrong(closeN) && closeRank(closeN) <= 1 };
  }
  return { open: Math.min(...core.map((m) => m.open)), close: Math.max(...core.map((m) => m.close)), openStrong: false, closeStrong: false };
}
function spanOf(g: Group): Span {
  const { open, close } = spanDetail(g);
  return { open, close };
}

function groupKeys(g: Group): Set<string> {
  const s = new Set<string>();
  for (const m of g.members) for (const [k, v] of m.keys) if (MATCH_KINDS.includes(k)) s.add(`${k}\u0000${v}`);
  return s;
}
const mkey = (n: Norm) => n.keys.find(([k]) => k === "consult_key")?.[1] ?? null;
/** A2: a consult_uid match also needs the machine to agree (same consult_key, or none on either side). */
const sharesKey = (n: Norm, g: Group) => {
  const ks = groupKeys(g);
  const nk = mkey(n);
  return n.keys.some(([k, v]) => {
    if (!MATCH_KINDS.includes(k) || !ks.has(`${k}\u0000${v}`)) return false;
    if (k !== "consult_uid") return true;
    return g.members.some((m) => m.keys.some(([mk, mv]) => mk === "consult_uid" && mv === v) && (nk === null || mkey(m) === null || mkey(m) === nk));
  });
};
const hasProxy = (g: Group, p: Proxy) => g.members.some((m) => m.sig.proxy === p);

/** M4: two strong anchors of the same kind never merge. */
function strongConflict(a: Group, b: Group): boolean {
  return STRONG_PROXIES.some((p) => hasProxy(a, p) && hasProxy(b, p));
}

function groupSortKey(g: Group): string {
  const a = anchorOf(g);
  return `${a.room}\u0000${String(Math.min(...g.members.map((m) => m.open))).padStart(16, "0")}\u0000${ANCHOR_ORDER.indexOf(a.sig.proxy)}\u0000${a.sig.source_key}`;
}
function anchorOf(g: Group): Norm {
  const core = g.members.filter((m) => !isDerived(m));
  return [...core].sort((a, b) => ANCHOR_ORDER.indexOf(a.sig.proxy) - ANCHOR_ORDER.indexOf(b.sig.proxy) || normOrder(a, b))[0];
}

function base32(buf: Buffer): string {
  let bits = 0, acc = 0, out = "";
  for (const byte of buf) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  return out;
}
/** D1: keyed hash of (anchor proxy, source_key, room_id, first t_open); `counter` is the rehash round. */
export function encounterIdCandidate(anchorProxy: string, sourceKey: string, roomId: string, firstOpen: number, counter: number): string {
  const msg = `${anchorProxy}|${sourceKey}|${roomId}|${firstOpen}` + (counter > 0 ? `|${counter}` : "");
  return "enc_" + base32(createHmac("sha256", ID_KEY).update(msg).digest().subarray(0, 10));
}
export function mintEncounterId(anchorProxy: string, sourceKey: string, roomId: string, firstOpen: number, taken: Set<string>): string {
  for (let c = 0; ; c++) {
    const id = encounterIdCandidate(anchorProxy, sourceKey, roomId, firstOpen, c);
    if (EIGHT_DIGITS.test(id) || taken.has(id)) continue;
    return id;
  }
}

/** F1 backstop: two output rows with one encounter_id would be a duplicate PK for the writer, and could swap two patients' consults. */
export function assertUniqueIds(encounters: { encounter_id: string }[]): void {
  const seen = new Set<string>();
  for (const e of encounters) {
    if (seen.has(e.encounter_id)) throw new Error(`spine merge: duplicate encounter_id ${e.encounter_id}`);
    seen.add(e.encounter_id);
  }
}

const BASIS_RANK: Record<LinkBasis, number> = { exact: 0, overlap: 1, merge: 2 };

export function mergeSignals(signals: SpineSignal[], merge_version: string, prior: SpinePrior, now: number): MergeResult {
  // ---- M1 normalise
  const latest = new Map<string, SpineSignal>();
  for (const s of signals) {
    const k = `${s.proxy}\u0000${s.source_key}`;
    const cur = latest.get(k);
    if (!cur || s.source_rev > cur.source_rev) latest.set(k, s);
  }
  let unplaced = 0, openDeferred = 0;
  const norms: Norm[] = [];
  for (const s of latest.values()) {
    if (!s.room_id) { unplaced++; continue; }
    if (s.t_close === null && now - s.t_open < CAP_MS) { openDeferred++; continue; }
    const capped = s.t_close === null;
    norms.push({
      sig: s, room: s.room_id, open: s.t_open, close: capped ? s.t_open + CAP_MS : s.t_close!,
      explicitClose: !capped, keys: keysOf(s), via: "exact",
    });
  }
  norms.sort(normOrder);

  // ---- strong groups: M2 identity (pulse = consult_key, pqm = pqm_uid), then M3/M4 pairing
  const groups: Group[] = [];
  const byIdentity = new Map<string, Group>();
  for (const n of norms.filter(isStrong)) {
    const ident = n.sig.proxy === "pulse" ? attr(n.sig, "consult_key") : attr(n.sig, "pqm_uid");
    const k = `${n.sig.proxy}\u0000${n.room}\u0000${ident ?? n.sig.source_key}`;
    let g = byIdentity.get(k);
    if (!g) { g = { members: [] }; byIdentity.set(k, g); groups.push(g); }
    g.members.push(n);
  }
  const pairs: { a: Group; b: Group; byKey: boolean; r: number }[] = [];
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      const a = groups[i], b = groups[j];
      if (a.members[0].room !== b.members[0].room) continue;
      const sa = spanOf(a), sb = spanOf(b);
      const byKey = b.members.some((m) => sharesKey(m, a));
      const cross = hasProxy(a, "pulse") !== hasProxy(b, "pulse") && (hasProxy(a, "pqm") || hasProxy(b, "pqm"));
      if (byKey || (cross ? mutual(sa, sb) : meets(sa, sb))) pairs.push({ a, b, byKey, r: ratio(sa, sb) });
    }
  }
  pairs.sort((x, y) => Number(y.byKey) - Number(x.byKey) || y.r - x.r || cmp(groupSortKey(x.a), groupSortKey(y.a)) || cmp(groupSortKey(x.b), groupSortKey(y.b)));
  const owner = new Map<Group, Group>();
  const root = (g: Group): Group => { let r = g; while (owner.has(r)) r = owner.get(r)!; return r; };
  for (const p of pairs) {
    const a = root(p.a), b = root(p.b);
    if (a === b || strongConflict(a, b)) continue;
    if (!p.byKey) for (const m of b.members) m.via = "overlap";
    a.members.push(...b.members);
    owner.set(b, a);
  }
  const live = (): Group[] => groups.filter((g) => !owner.has(g));

  // ---- weak signals: M2 key, M3 time, M7 ambiguity; leftovers seed weak groups
  const ambiguous = new Set<Group>();
  const uidMachines = new Map<string, Set<string>>();
  for (const n of norms) {
    const u = attr(n.sig, "consult_uid"), mk = mkey(n);
    if (u && mk) (uidMachines.get(u) ?? uidMachines.set(u, new Set()).get(u)!).add(mk);
  }
  for (const n of norms.filter(isWeak)) {
    const cands = live().filter((g) => g.members[0].room === n.room);
    const keyed = cands.filter((g) => sharesKey(n, g));
    const timed = cands.filter((g) => meets(spanOf(g), n));
    const pool = keyed.length ? keyed : timed;
    if (!pool.length) { groups.push({ members: [n] }); continue; }
    const order = [...pool].sort((a, b) => ratio(spanOf(b), n) - ratio(spanOf(a), n) || spanOf(a).open - spanOf(b).open || cmp(groupSortKey(a), groupSortKey(b)));
    const to = order[0];
    if (!keyed.length) {
      n.via = "overlap";
      if (pool.length > 1) ambiguous.add(to);
    }
    const nu = attr(n.sig, "consult_uid");
    if (nu && !mkey(n) && (uidMachines.get(nu)?.size ?? 0) > 1) ambiguous.add(to); // X6c
    to.members.push(n);
  }

  // ---- derived signals attach by key only
  const unattached: string[] = [];
  for (const n of norms.filter(isDerived)) {
    const pool = live().filter((g) => g.members[0].room === n.room && sharesKey(n, g));
    if (!pool.length) { unattached.push(`${n.sig.proxy}:${n.sig.source_key}`); continue; }
    pool.sort((a, b) => ratio(spanOf(b), n) - ratio(spanOf(a), n) || spanOf(a).open - spanOf(b).open || cmp(groupSortKey(a), groupSortKey(b)));
    pool[0].members.push(n);
  }
  unattached.sort();
  const finals = live().sort((a, b) => cmp(groupSortKey(a), groupSortKey(b)));

  // ---- flags (M2 multi_machine, M4 pulse_overlap)
  const flags = new Map<Group, Set<string>>(finals.map((g) => [g, new Set<string>()]));
  const rawSpan = new Map<Group, Span>(finals.map((g) => [g, spanOf(g)]));
  // I3: clamp weak or inferred boundaries at the open/close of a neighbouring strong-anchored encounter
  const spans = new Map<Group, Span>();
  for (const g of finals) {
    const d = spanDetail(g);
    let { open, close } = d;
    for (const n of finals) {
      if (n === g || n.members[0].room !== g.members[0].room || !(hasProxy(n, "pulse") || hasProxy(n, "pqm"))) continue;
      const ns = rawSpan.get(n)!;
      if (!d.closeStrong && ns.open > d.open && ns.open < d.close) close = Math.min(close, ns.open);
      if (!d.openStrong && ns.open <= d.open && ns.close > d.open && ns.close < d.close) open = Math.max(open, ns.close);
    }
    if (close > open && (open !== d.open || close !== d.close)) {
      flags.get(g)!.add("clamped");
      spans.set(g, { open, close });
    } else {
      if (open !== d.open || close !== d.close) flags.get(g)!.add("clamp_failed"); // X3c: empty span, raw span kept
      spans.set(g, { open: d.open, close: d.close });
    }
  }
  for (const g of ambiguous) flags.get(g)?.add("ambiguous");
  const pulseByUid = new Map<string, Set<Group>>();
  for (const g of finals) for (const m of g.members) {
    const u = m.sig.proxy === "pulse" ? attr(m.sig, "consult_uid") : null;
    if (u) (pulseByUid.get(u) ?? pulseByUid.set(u, new Set()).get(u)!).add(g);
  }
  for (const gs of pulseByUid.values()) if (gs.size > 1) for (const g of gs) flags.get(g)!.add("multi_machine");
  for (let i = 0; i < finals.length; i++) for (let j = i + 1; j < finals.length; j++) {
    const a = finals[i], b = finals[j];
    if (a.members[0].room === b.members[0].room && strongConflict(a, b) && overlapMs(rawSpan.get(a)!, rawSpan.get(b)!) > 0) {
      flags.get(a)!.add("pulse_overlap");
      flags.get(b)!.add("pulse_overlap");
    }
  }

  // ---- prior ids (M8/M9)
  const priorById = new Map(prior.encounters.map((e) => [e.encounter_id, e]));
  const resolve = (id: string): string => {
    let cur = id;
    for (let i = 0; i < 16; i++) {
      const e = priorById.get(cur);
      if (!e || e.status !== "merged" || !e.merged_into) break;
      cur = e.merged_into;
    }
    return cur;
  };
  const priorLinkId = new Map(prior.links.map((l) => [`${l.key_kind}\u0000${l.value}`, resolve(l.encounter_id)]));
  const taken = new Set<string>(prior.encounters.map((e) => e.encounter_id));
  const frozen = (e: PriorEncounter) => now >= horizonEnd(e.ist_date);
  const survives = (a: PriorEncounter, b: PriorEncounter) => {
    const sa = STRONG_PROXIES.includes(a.anchor_proxy), sb = STRONG_PROXIES.includes(b.anchor_proxy);
    if (sa && sb && a.anchor_proxy !== b.anchor_proxy) return a.anchor_proxy === "pulse"; // X2: the pulse-anchored prior survives
    return sa !== sb ? sa : a.created_at !== b.created_at ? a.created_at < b.created_at : a.encounter_id < b.encounter_id;
  };

  const encounters: MergedEncounter[] = [];
  const links: MergedLink[] = [];
  const assignments: SignalAssignment[] = [];
  const claimed = new Set<string>();
  const losers = new Map<string, string>(); // loser id -> survivor id
  const frozenKept = new Map<string, Group>(); // I4: frozen candidates that lost; their signals keep their assignment
  const groupIds: string[] = [];
  const idToGroup = new Map<string, Group>();

  // F1: a strong-anchored prior is claimed only by the group that holds its anchor signal.
  const strongOwner = new Map<string, Group>();
  for (const g of finals) {
    for (const m of g.members) {
      if (!isStrong(m)) continue;
      const ident = m.sig.proxy === "pulse" ? "consult_key" : "pqm_uid";
      const ids = new Set<string>();
      const iv = attr(m.sig, ident);
      const l = iv ? priorLinkId.get(`${ident}\u0000${iv}`) : undefined;
      if (l && priorById.get(l)?.anchor_proxy === m.sig.proxy) ids.add(l); // X5: the identity link beats a stale id
      else if (m.sig.encounter_id) ids.add(resolve(m.sig.encounter_id));
      for (const id of ids) {
        const pe = priorById.get(id);
        if (pe && pe.anchor_proxy === m.sig.proxy && !strongOwner.has(id)) strongOwner.set(id, g);
      }
    }
  }
  for (const g of finals) {
    const ids = new Set<string>();
    for (const m of g.members) {
      if (m.sig.encounter_id) ids.add(resolve(m.sig.encounter_id));
      for (const [k, v] of m.keys) { const l = priorLinkId.get(`${k}\u0000${v}`); if (l) ids.add(l); }
    }
    const cand = [...ids].map((id) => priorById.get(id)).filter((e): e is PriorEncounter =>
      !!e && !claimed.has(e.encounter_id) && e.room_id === g.members[0].room && e.status !== "merged" &&
      (!STRONG_PROXIES.includes(e.anchor_proxy) || strongOwner.get(e.encounter_id) === g));
    const liveCand = cand.filter((e) => !frozen(e));
    const pool = liveCand.length ? liveCand : cand; // I4: a frozen prior never absorbs a live one
    const survivor = pool.length ? pool.reduce((a, b) => (survives(b, a) ? b : a)) : null;
    const anchor = anchorOf(g);
    const span = spans.get(g)!;
    let id: string;
    if (survivor) {
      id = survivor.encounter_id;
      for (const e of cand) {
        if (e === survivor) continue;
        if (frozen(e)) { frozenKept.set(e.encounter_id, g); continue; }
        if (e.anchor_proxy === survivor.anchor_proxy && STRONG_PROXIES.includes(e.anchor_proxy)) continue; // M4 across reruns
        losers.set(e.encounter_id, id);
      }
    } else {
      id = mintEncounterId(anchor.sig.proxy, anchor.sig.source_key, anchor.room, Math.min(...g.members.map((m) => m.open)), taken);
    }
    taken.add(id);
    claimed.add(id);
    groupIds.push(id);
    idToGroup.set(id, g);

    const old = survivor;
    const fl = flags.get(g)!;
    if (old && frozen(old)) {
      fl.add("frozen");
      encounters.push({
        encounter_id: id, ist_date: old.ist_date, room_id: old.room_id, t_open: old.t_open, t_close: old.t_close, status: old.status,
        merged_into: old.merged_into, anchor_proxy: old.anchor_proxy, boundary_rev: old.boundary_rev, merge_version, reason: old.reason ?? "frozen",
        flags: [...fl].sort(), boundary_moved: false,
      });
    } else {
      // ---- M5 status
      const finalReasons = new Set(g.members.filter((m) => m.sig.proxy === "cutter").map((m) => attr(m.sig, "final_reason")));
      const weakAgree = new Set(g.members.filter((m) => isWeak(m) && meets(span, m)).map((m) => m.sig.proxy)).size;
      const strong = hasProxy(g, "pulse") ? "pulse" : hasProxy(g, "pqm") ? "pqm" : null;
      let status: MergedEncounter["status"], reason: string;
      if (finalReasons.has("blind_room_day")) { status = "rejected"; reason = "blind_room_day"; }
      else if (finalReasons.has("no_tape") && now >= span.close + NO_TAPE_RECHECK_MS) { status = "rejected"; reason = "no_tape"; }
      else if (finalReasons.has("silent_audio")) { status = "confirmed"; reason = "silent"; }
      else if (strong) { status = "confirmed"; reason = strong; }
      else if (weakAgree >= 2 && span.close - span.open >= MIN_WEAK_SPAN_MS) { status = "confirmed"; reason = "weak_agree"; }
      else { status = "candidate"; reason = weakAgree >= 2 ? "weak_short" : "weak_single"; }
      const moved = !!old && (old.t_open !== span.open || old.t_close !== span.close);
      encounters.push({
        encounter_id: id, ist_date: old?.ist_date ?? istDate(span.open), room_id: anchor.room, t_open: span.open, t_close: span.close,
        status, merged_into: null, anchor_proxy: anchor.sig.proxy, boundary_rev: old ? old.boundary_rev + (moved ? 1 : 0) : 0, merge_version,
        reason, flags: [...fl].sort(), boundary_moved: moved,
      });
    }
    for (const m of g.members) {
      const was = m.sig.encounter_id ? resolve(m.sig.encounter_id) : null;
      const keep = was && was !== id && frozenKept.get(was) === g ? was : id; // X4b
      assignments.push({ proxy: m.sig.proxy, source_key: m.sig.source_key, source_rev: m.sig.source_rev, encounter_id: keep });
    }
  }

  for (const c of claimed) losers.delete(c); // X1: a claimed prior is never also a loser
  // losers (M8): merged rows, links move by alias
  for (const [lid, sid] of [...losers].sort()) {
    const e = priorById.get(lid)!;
    encounters.push({
      encounter_id: lid, ist_date: e.ist_date, room_id: e.room_id, t_open: e.t_open, t_close: e.t_close, status: "merged", merged_into: sid,
      anchor_proxy: e.anchor_proxy, boundary_rev: e.boundary_rev, merge_version, reason: "merged", flags: [], boundary_moved: false,
    });
  }

  assertUniqueIds(encounters); // F1/X1: after the loser rows, so it sees every emitted row

  // ---- links: one active owner per (kind, value)
  const want = new Map<string, MergedLink[]>();
  const add = (l: MergedLink) => { const k = `${l.key_kind}\u0000${l.value}`; (want.get(k) ?? want.set(k, []).get(k)!).push(l); };
  finals.forEach((g, i) => {
    for (const m of g.members) for (const [k, v] of m.keys) add({ encounter_id: groupIds[i], key_kind: k, value: v, basis: m.via });
  });
  for (const l of prior.links) {
    const sid = losers.get(resolve(l.encounter_id)) ?? losers.get(l.encounter_id);
    if (sid) add({ encounter_id: sid, key_kind: l.key_kind, value: l.value, basis: "merge" });
  }
  const frozenIds = new Set(prior.encounters.filter((e) => e.status !== "merged" && frozen(e)).map((e) => e.encounter_id));
  const priorKind = new Map(prior.links.map((l) => [`${l.key_kind}\u0000${l.value}`, l.key_kind]));
  for (const [k, all] of want) {
    const keep = priorLinkId.get(k);
    // I4: a link owned by a frozen prior stays; nothing moves to a frozen encounter from another owner
    if (keep && frozenIds.has(keep)) {
      const own = all.find((o) => o.encounter_id === keep);
      links.push(own ?? { encounter_id: keep, key_kind: priorKind.get(k)!, value: k.split("\u0000")[1], basis: "exact" });
      continue;
    }
    const opts = keep ? all.filter((o) => !frozenIds.has(o.encounter_id)) : all;
    if (!opts.length) { links.push({ encounter_id: keep!, key_kind: priorKind.get(k)!, value: k.split("\u0000")[1], basis: "exact" }); continue; }
    opts.sort((a, b) => Number(b.encounter_id === keep) - Number(a.encounter_id === keep) || BASIS_RANK[a.basis] - BASIS_RANK[b.basis] || cmp(a.encounter_id, b.encounter_id));
    links.push(opts[0]);
  }
  links.sort((a, b) => cmp(a.key_kind, b.key_kind) || cmp(a.value, b.value));
  encounters.sort((a, b) => cmp(a.room_id, b.room_id) || cmp(a.t_open, b.t_open) || cmp(a.encounter_id, b.encounter_id));
  assignments.sort((a, b) => cmp(a.proxy, b.proxy) || cmp(a.source_key, b.source_key) || cmp(a.source_rev, b.source_rev));
  return { merge_version, encounters, links, assignments, unplaced, open_deferred: openDeferred, unattached };
}
