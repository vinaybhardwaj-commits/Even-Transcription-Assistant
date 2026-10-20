/** spine-s2 R3 refuter: fresh seeded property test with ground-truth consult labels (throwaway; .bc/oref-r3). Synthetic ids only.
 * MERGE_IMPL=<abs path> swaps the implementation (scratch variants). OUT=<file> writes the stats. */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import type { MergeResult, PriorEncounter, Proxy, SpinePrior, SpineSignal } from "@/lib/spine/types";

const T0 = Date.parse("2026-10-19T04:00:00Z");
const MIN = 60_000, SEC = 1000;
const NOW = T0 + 12 * 3_600_000;
const FROZEN_NOW = Date.parse("2026-10-22T00:00:00Z");
const N = Number(process.env.PROP_N ?? 5000);
const CORRUPT = Number(process.env.CORRUPT ?? 0.03);
const SEED0 = Number(process.env.SEED0 ?? 500_001);
type R = () => number;
function mulberry(seed: number): R { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const ri = (r: R, a: number, b: number) => a + Math.floor(r() * (b - a + 1));
const pick = <T,>(r: R, xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
function shuffle<T>(xs: T[], r: R): T[] { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
const sha = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex");
const EXPLICIT = ["endConsult", "url_clear"], INFERRED = ["idle_timeout", "logout", "next_open"];

type Kind = "pulse" | "pqm" | "dual";
interface Consult { id: string; room: string; kind: Kind; o: number; c: number; pq?: { o: number; c: number; mode: string; keyed: boolean } }
function genRoom(r: R, room: string, mixed: boolean): Consult[] {
  const cs: Consult[] = [];
  let t = ri(r, 0, 20) * MIN;
  const n = ri(r, 2, 7);
  for (let i = 0; i < n; i++) {
    const d = (r() < 0.2 ? ri(r, 2, 5) : ri(r, 6, 25)) * MIN + ri(r, 0, 59) * SEC;
    const u = r();
    const kind: Kind = !mixed ? "pulse" : u < 0.4 ? "pulse" : u < 0.65 ? "pqm" : "dual";
    const c: Consult = { id: `${room}_${i}`, room, kind, o: t, c: t + d };
    if (kind === "dual") {
      const m = r();
      let po: number, pc: number, mode: string;
      if (m < 0.55) { const l = Math.min(d, ri(r, 2, 8) * MIN); po = t + Math.floor(r() * Math.max(1, d - l)); pc = po + l + (r() < 0.2 ? ri(r, 0, 60) * SEC : 0); mode = "inside"; }
      else if (m < 0.85) { po = t + ri(r, -60, 60) * SEC; pc = t + d + ri(r, -120, 120) * SEC; mode = "aligned"; }
      else { po = t + Math.floor(d * 0.6); pc = t + d + ri(r, 1, 6) * MIN; mode = "late"; }
      if (pc <= po) pc = po + 60 * SEC;
      c.pq = { o: po, c: pc, mode, keyed: r() < 0.3 };
    }
    cs.push(c);
    t = t + d + ri(r, -120, 180) * SEC;
  }
  return cs;
}
interface Day { cs: Consult[]; sigs: SpineSignal[] }
function genDay(r: R, mixed: boolean): Day {
  const cs = [...genRoom(r, "room_a", mixed), ...(r() < 0.5 ? genRoom(r, "room_b", mixed) : [])];
  const sigs: SpineSignal[] = [];
  let rev = 1;
  for (const c of cs) {
    if (c.kind !== "pqm") {
      const explicit = r() < 0.6;
      let close: number | null = c.c;
      if (!explicit && r() < 0.35) close = c.c + ri(r, 1, 12) * MIN; // inferred close overruns into the next consult
      if (r() < 0.02) close = null; // never closed: capped at 90 min
      const mk = r() < 0.1 ? "m2" : "m1";
      sigs.push({ proxy: "pulse", source_key: `p_${c.id}`, source_rev: rev++, room_id: c.room, t_open: T0 + c.o, t_close: close === null ? null : T0 + close,
        attrs: { consult_uid: `u_${c.id}`, consult_key: `u_${c.id}@${mk}`, close_reason: pick(r, explicit ? EXPLICIT : INFERRED) } });
    }
    if (c.kind === "pqm") sigs.push({ proxy: "pqm", source_key: `q_${c.id}`, source_rev: rev++, room_id: c.room, t_open: T0 + c.o, t_close: T0 + c.c, attrs: { pqm_uid: `pq_${c.id}` } });
    if (c.kind === "dual") sigs.push({ proxy: "pqm", source_key: `q_${c.id}`, source_rev: rev++, room_id: c.room, t_open: T0 + c.pq!.o, t_close: T0 + c.pq!.c,
      attrs: c.pq!.keyed ? { pqm_uid: `pq_${c.id}`, consult_uid: `u_${c.id}` } : { pqm_uid: `pq_${c.id}` } });
  }
  const nw = ri(r, 0, 10);
  for (let i = 0; i < nw; i++) sigs.push(weak(r, cs, `w${i}`, rev++));
  for (const c of cs) if (r() < 0.25) sigs.push({ proxy: "cutter", source_key: `k_${c.id}`, source_rev: rev++, room_id: c.room, t_open: T0 + c.o, t_close: T0 + c.c,
    attrs: c.kind === "pqm" ? { pqm_uid: `pq_${c.id}` } : { consult_uid: `u_${c.id}` } });
  return { cs, sigs };
}
function keyAttr(c: Consult): Record<string, unknown> { return c.kind === "pqm" ? { pqm_uid: `pq_${c.id}` } : { consult_uid: `u_${c.id}` }; }
function weak(r: R, cs: Consult[], key: string, rev: number, proxy?: Proxy): SpineSignal {
  const c = pick(r, cs);
  const roomCs = cs.filter((x) => x.room === c.room);
  const end = Math.max(...roomCs.map((x) => x.c));
  const d = c.c - c.o;
  let o: number, cl: number;
  const m = r();
  if (m < 0.3) { o = c.o + ri(r, -90, 90) * SEC; cl = c.c + ri(r, -90, 90) * SEC; }
  else if (m < 0.5) { o = c.o + Math.floor(r() * d); cl = o + ri(r, 20, 240) * SEC; } // fragment
  else if (m < 0.7) { o = c.c - ri(r, 20, 300) * SEC; cl = c.c + ri(r, 20, 300) * SEC; } // straddles the close
  else if (m < 0.85) { o = c.o - ri(r, 0, 8) * MIN; cl = c.c + ri(r, 0, 25) * MIN; } // blob
  else { o = ri(r, 0, Math.floor(end / SEC)) * SEC; cl = o + ri(r, 10, 1200) * SEC; } // noise
  if (cl <= o) cl = o + 15 * SEC;
  const kr = r();
  const attrs = kr < 0.15 ? keyAttr(c) : kr < 0.2 ? keyAttr(pick(r, cs)) : {};
  return { proxy: proxy ?? pick(r, ["acoustic", "timeline", "doctor_activity", "acoustic", "timeline"] as Proxy[]), source_key: key, source_rev: rev, room_id: c.room, t_open: T0 + o, t_close: T0 + cl, attrs };
}

// The writer upserts: a prior row the merge does not re-emit (a frozen loser) stays in the table.
const toPrior = (res: MergeResult, created: Map<string, number>, runNo: number, old: SpinePrior): SpinePrior => {
  const rows = new Map(old.encounters.map((e) => [e.encounter_id, e]));
  for (const e of res.encounters) { if (!created.has(e.encounter_id)) created.set(e.encounter_id, runNo * 1000 + created.size); rows.set(e.encounter_id, { ...e, created_at: created.get(e.encounter_id)! } as PriorEncounter); }
  return { encounters: [...rows.values()], links: res.links.map((l) => ({ encounter_id: l.encounter_id, key_kind: l.key_kind, value: l.value })) };
};
const withIds = (s: SpineSignal[], res: MergeResult) => s.map((x) => ({ ...x, encounter_id: res.assignments.find((a) => a.proxy === x.proxy && a.source_key === x.source_key)?.encounter_id ?? null }));
function rerun(r: R, s: SpineSignal[], cs: Consult[], allIds: string[]): SpineSignal[] {
  let maxRev = Math.max(...s.map((x) => x.source_rev));
  const out = s.map((x): SpineSignal => {
    if (x.proxy === "pulse" || x.proxy === "pqm") {
      let y = x;
      if (r() < 0.3 && x.t_close !== null) y = { ...x, source_rev: ++maxRev, t_close: Math.max(x.t_open + 30 * SEC, x.t_close + ri(r, -180, 180) * SEC),
        attrs: x.proxy === "pulse" ? { ...x.attrs, close_reason: pick(r, [...EXPLICIT, ...INFERRED]) } : x.attrs };
      if (r() < CORRUPT && allIds.length) y = { ...y, encounter_id: pick(r, allIds) }; // corrupt stale id (X5 class)
      return y;
    }
    if (x.proxy === "cutter") return x;
    if (r() < 0.4) return { ...weak(r, cs, x.source_key, ++maxRev, x.proxy), encounter_id: r() < CORRUPT * 3 && allIds.length ? pick(r, allIds) : x.encounter_id };
    return x;
  });
  for (let i = ri(r, 0, 2); i > 0; i--) out.push(weak(r, cs, `wn${maxRev}`, ++maxRev));
  return out;
}

interface Bad { seed: number; mixed: boolean; run: number; what: string }
const consultOf = (sk: string) => sk.slice(2);
function check(seed: number, mixed: boolean, merge: typeof import("@/lib/spine/merge").mergeSignals, bad: Bad[], st: Record<string, number>) {
  const r = mulberry(seed * 2654435761 + (mixed ? 7 : 3));
  const { cs, sigs } = genDay(r, mixed);
  const frozenDay = r() < 0.12;
  const created = new Map<string, number>();
  let s = sigs, prior: SpinePrior = { encounters: [], links: [] };
  let prevAi: Map<string, string> | null = null;
  let prevIdConsult = new Map<string, string>();
  let prevLinks = new Map<string, string>();
  const dayFlags = new Set<string>();
  for (let run = 0; run < 4; run++) {
    const now = frozenDay && run === 3 ? FROZEN_NOW : NOW;
    let res: MergeResult;
    try { res = merge(s, "mv1", prior, now); } catch (e) { bad.push({ seed, mixed, run, what: `throw ${(e as Error).message.slice(0, 50)}` }); return; }
    const fail = (what: string) => { bad.push({ seed, mixed, run, what }); if (process.env.DUMP_SEED === String(seed)) writeFileSync(`/tmp/spine-s2-r3-oref-dump-${seed}-${run}-${what.slice(0, 2)}.json`, JSON.stringify({ what, s, prior, res, cs }, null, 1)); };
    const ids = res.encounters.map((e) => e.encounter_id);
    if (new Set(ids).size !== ids.length) fail("V1 duplicate encounter_id");
    const enc = new Map(res.encounters.map((e) => [e.encounter_id, e]));
    const ai = new Map<string, string>();
    for (const a of res.assignments) if (a.proxy === "pulse" || a.proxy === "pqm") ai.set(a.source_key, a.encounter_id);
    // per id: which consults' strong signals sit on it
    const idConsults = new Map<string, Set<string>>();
    const kindOn = new Map<string, string>();
    for (const [sk, id] of ai) {
      (idConsults.get(id) ?? idConsults.set(id, new Set()).get(id)!).add(consultOf(sk));
      const kk = `${sk[0]}|${id}`;
      if (kindOn.has(kk) && kindOn.get(kk) !== sk) fail("V10 two same-kind strong anchors share an id");
      kindOn.set(kk, sk);
      const e = enc.get(id);
      const pe = prior.encounters.find((x) => x.encounter_id === id);
      if (e ? e.status === "merged" : !(pe && pe.status !== "merged" && now >= Date.parse("2026-10-21T18:30:00Z"))) fail(`V7 strong signal on a non-live encounter (${e ? "merged" : pe ? "prior " + pe.status : "absent"})`);
    }
    for (const [, cset] of idConsults) if (cset.size > 1) { st.cross_consult_merge = (st.cross_consult_merge ?? 0) + 1; dayFlags.add("cross"); }
    const idConsult = new Map<string, string>();
    for (const e of res.encounters) if (e.status !== "merged" && (e.anchor_proxy === "pulse" || e.anchor_proxy === "pqm")) {
      const sk = [...ai].find(([k, id]) => id === e.encounter_id && (e.anchor_proxy === "pulse" ? k.startsWith("p_") : k.startsWith("q_")));
      if (sk) idConsult.set(e.encounter_id, consultOf(sk[0]));
    }
    // a strong-anchored prior is never merged into an encounter of another consult
    for (const e of res.encounters) if (e.status === "merged" && prevIdConsult.has(e.encounter_id)) {
      const to = idConsult.get(e.merged_into ?? "");
      const from = prevIdConsult.get(e.encounter_id)!;
      if (to && to !== from) fail(`V3 strong prior of ${from} merged into ${to}`);
      if (to === from) st.same_consult_merged_row = (st.same_consult_merged_row ?? 0) + 1;
    }
    if (prevAi) for (const [sk, id] of ai) {
      const was = prevAi.get(sk);
      if (!was || was === id) continue;
      if (now === FROZEN_NOW) { fail(`V9 ${sk[0]} id changed in a frozen rerun`); continue; }
      if (sk.startsWith("p_")) { fail("V4 pulse id changed"); continue; }
      const m = enc.get(was);
      const mergedSame = m && m.status === "merged" && m.merged_into === id && idConsult.get(id) === consultOf(sk);
      const splitSame = [...ai].some(([k, v]) => v === was && k !== sk && consultOf(k) === consultOf(sk));
      if (mergedSame) st.pqm_merged_into_own_pulse = (st.pqm_merged_into_own_pulse ?? 0) + 1;
      else if (splitSame) st.pqm_split_from_own_pulse = (st.pqm_split_from_own_pulse ?? 0) + 1;
      else if (m && m.status !== "merged" && [...ai].some(([k, v]) => v === was && k.startsWith("p_"))) st.pqm_split_from_other_consult_pulse = (st.pqm_split_from_other_consult_pulse ?? 0) + 1; // knock-on of a cross-consult merge
      else fail(`V5 pqm id change not explained (${m?.status ?? "gone"})`);
    }
    const lo = new Map(res.links.map((l) => [`${l.key_kind}|${l.value}`, l.encounter_id]));
    for (const c of cs) {
      if (c.kind !== "pqm") { const k = [...lo].find(([kk]) => kk.startsWith("consult_key|u_" + c.id + "@")); if (k && k[1] !== ai.get(`p_${c.id}`)) fail("V6 consult_key link off its pulse"); }
      if (c.kind !== "pulse") { const l = lo.get(`pqm_uid|pq_${c.id}`); if (l && l !== ai.get(`q_${c.id}`)) fail("V6 pqm_uid link off its pqm"); }
    }
    if (now === FROZEN_NOW) for (const [k, v] of prevLinks) if ((k.startsWith("consult_key|") || k.startsWith("pqm_uid|")) && lo.get(k) !== v) fail("V9 identity link moved in a frozen rerun");
    // duplicates: a dual consult whose pulse and pqm end in two live CONFIRMED encounters
    if (run === 3 || run === 0) for (const c of cs) if (c.kind === "dual") {
      const a = ai.get(`p_${c.id}`), b = ai.get(`q_${c.id}`);
      const tag = `${run === 0 ? "r0" : "r3"}_${c.pq!.keyed ? "keyed" : c.pq!.mode}`;
      st[`dual_${tag}`] = (st[`dual_${tag}`] ?? 0) + 1;
      if (a && b && a !== b && enc.get(a)?.status === "confirmed" && enc.get(b)?.status === "confirmed") {
        st[`dup_${tag}`] = (st[`dup_${tag}`] ?? 0) + 1;
        if (run === 3) dayFlags.add("dup");
      }
    }
    // determinism
    const sr = mulberry(seed + run * 31);
    if (sha(merge(shuffle(s, sr), "mv1", { encounters: shuffle(prior.encounters, sr), links: shuffle(prior.links, sr) }, now)) !== sha(res)) fail("V8 shuffle changes the result");
    const nextPrior = toPrior(res, created, run + 1, prior);
    const fp = merge(withIds(s, res), "mv1", nextPrior, now);
    const strip = (x: MergeResult) => ({ e: x.encounters.filter((e) => e.status !== "merged").map((e) => [e.encounter_id, e.t_open, e.t_close, e.status, e.boundary_rev, e.flags.filter((f) => f !== "frozen")]), l: x.links.map((l) => [l.key_kind, l.value, l.encounter_id]), a: x.assignments });
    if (fp.encounters.some((e) => e.flags.includes("frozen") && !res.encounters.find((x) => x.encounter_id === e.encounter_id)?.flags.includes("frozen"))) st.frozen_flag_only_next_run = (st.frozen_flag_only_next_run ?? 0) + 1;
    if (sha(strip(fp)) !== sha(strip(res))) { fail("V8 output-as-prior is not a fixed point"); if (process.env.DUMP_SEED === String(seed)) writeFileSync(`/tmp/spine-s2-r3-oref-dump-${seed}-${run}.json`, JSON.stringify({ s: withIds(s, res), prior: nextPrior, res: strip(res), fp: strip(fp), resFull: res, fpFull: fp }, null, 1)); }
    if (fp.encounters.some((e) => e.boundary_moved)) fail("V8 fixed point moved a boundary");
    prevAi = ai; prevIdConsult = idConsult; prevLinks = lo;
    prior = nextPrior;
    s = rerun(r, withIds(s, res), cs, ids);
  }
  for (const f of dayFlags) st[`days_${f}`] = (st[`days_${f}`] ?? 0) + 1;
}

describe("R3 refuter property (fresh generator, ground-truth consults)", () => {
  for (const mixed of [false, true]) it(`${N} room-days, ${mixed ? "mixed" : "pulse only"}, 3 reruns`, async () => {
    const mod = (await import(process.env.MERGE_IMPL ?? "@/lib/spine/merge")) as typeof import("@/lib/spine/merge");
    const bad: Bad[] = [];
    const st: Record<string, number> = {};
    for (let seed = SEED0; seed < SEED0 + N; seed++) check(seed, mixed, mod.mergeSignals, bad, st);
    const byWhat: Record<string, number> = {};
    for (const b of bad) byWhat[b.what.replace(/ of .*/, "")] = (byWhat[b.what.replace(/ of .*/, "")] ?? 0) + 1;
    const out = process.env.OUT ? `${process.env.OUT}-${mixed ? "mixed" : "pulse"}.json` : null;
    if (out) writeFileSync(out, JSON.stringify({ n: N, seed0: SEED0, nbad: bad.length, daysBad: new Set(bad.map((b) => b.seed)).size, byWhat, st, first: bad.slice(0, 10), byKind: Object.fromEntries([...new Set(bad.map((b) => b.what.replace(/ of .*/, "")))].map((w) => [w, bad.filter((b) => b.what.replace(/ of .*/, "") === w).slice(0, 3).map((b) => [b.seed, b.run])])) }, null, 1));
    if (!process.env.NO_ASSERT) expect(bad.slice(0, 5)).toEqual([]);
  }, 600_000);
});
