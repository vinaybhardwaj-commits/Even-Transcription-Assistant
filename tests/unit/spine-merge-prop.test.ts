/** spine-s2 R2 refuter: seeded property test (throwaway; lives in .bc/oref-r2, copied in to run). Synthetic ids only. */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { mergeSignals } from "@/lib/spine/merge";
import type { MergeResult, PriorEncounter, Proxy, SpinePrior, SpineSignal } from "@/lib/spine/types";

const T0 = Date.parse("2026-10-19T04:00:00Z");
const MIN = 60_000, SEC = 1000;
const NOW = T0 + 12 * 3_600_000;
const N = Number(process.env.PROP_N ?? 3000);
function rng(seed: number) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
type R = () => number;
const ri = (r: R, a: number, b: number) => a + Math.floor(r() * (b - a + 1));
const pick = <T,>(r: R, xs: T[]) => xs[Math.floor(r() * xs.length)];
function shuffle<T>(xs: T[], r: R): T[] { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
const sha = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex");
const REASONS = ["endConsult", "url_clear", "idle_timeout", "next_open", "logout"];

interface Consult { kind: "pulse" | "pqm"; key: string; o: number; c: number; }
function genDay(r: R, mixed: boolean) {
  const n = ri(r, 2, 6);
  const cs: Consult[] = [];
  let t = ri(r, 0, 30) * MIN;
  for (let i = 0; i < n; i++) {
    const d = ri(r, 3, 15) * MIN + ri(r, 0, 59) * SEC;
    cs.push({ kind: mixed && r() < 0.4 ? "pqm" : "pulse", key: `c${i}`, o: t, c: t + d });
    t = t + d + ri(r, -90, 120) * SEC; // pads overlap up to 90 s or a gap up to 2 min
  }
  const sigs: SpineSignal[] = [];
  let rev = 1;
  for (const c of cs) {
    if (c.kind === "pulse") sigs.push({ proxy: "pulse", source_key: `p_${c.key}`, source_rev: rev++, room_id: "room_a", t_open: T0 + c.o, t_close: T0 + c.c,
      attrs: { consult_uid: `u_${c.key}`, consult_key: `u_${c.key}@m1`, close_reason: pick(r, REASONS) } });
    else sigs.push({ proxy: "pqm", source_key: `q_${c.key}`, source_rev: rev++, room_id: "room_a", t_open: T0 + c.o, t_close: T0 + c.c, attrs: { pqm_uid: `pq_${c.key}` } });
  }
  const nw = ri(r, 1, 8);
  for (let i = 0; i < nw; i++) sigs.push(weak(r, cs, `w${i}`, rev++));
  if (r() < 0.5) { const c = pick(r, cs); sigs.push({ proxy: "cutter", source_key: `k_${c.key}`, source_rev: rev++, room_id: "room_a", t_open: T0 + c.o, t_close: T0 + c.c, attrs: c.kind === "pulse" ? { consult_uid: `u_${c.key}` } : { pqm_uid: `pq_${c.key}` } }); }
  return { cs, sigs };
}
function weak(r: R, cs: Consult[], key: string, rev: number, proxy?: Proxy): SpineSignal {
  const c = pick(r, cs);
  const span = cs[cs.length - 1].c;
  let o: number, cl: number;
  const mode = r();
  if (mode < 0.4) { o = c.o + ri(r, -60, 120) * SEC; cl = c.c + ri(r, -120, 60) * SEC; }
  else if (mode < 0.7) { const b = c.c; o = b - ri(r, 30, 400) * SEC; cl = b + ri(r, 30, 400) * SEC; } // straddles a boundary
  else if (mode < 0.85) { o = c.o - ri(r, 0, 5) * MIN; cl = c.c + ri(r, 1, 20) * MIN; } // long blob over neighbours
  else { o = ri(r, 0, Math.max(1, Math.floor(span / SEC))) * SEC; cl = o + ri(r, 20, 900) * SEC; }
  if (cl <= o) cl = o + 30 * SEC;
  const attrs: Record<string, unknown> = {};
  const kr = r();
  if (kr < 0.15) attrs[c.kind === "pulse" ? "consult_uid" : "pqm_uid"] = c.kind === "pulse" ? `u_${c.key}` : `pq_${c.key}`;
  else if (kr < 0.2) { const w = pick(r, cs); attrs[w.kind === "pulse" ? "consult_uid" : "pqm_uid"] = w.kind === "pulse" ? `u_${w.key}` : `pq_${w.key}`; } // wrong key
  return { proxy: proxy ?? pick(r, ["acoustic", "timeline", "doctor_activity", "acoustic"] as Proxy[]), source_key: key, source_rev: rev, room_id: "room_a", t_open: T0 + o, t_close: T0 + cl, attrs };
}
const toPrior = (res: MergeResult, created: Map<string, number>, runNo: number): SpinePrior => ({
  encounters: res.encounters.map((e) => { if (!created.has(e.encounter_id)) created.set(e.encounter_id, runNo * 1000 + created.size); return { ...e, created_at: created.get(e.encounter_id)! } as PriorEncounter; }),
  links: res.links.map((l) => ({ encounter_id: l.encounter_id, key_kind: l.key_kind, value: l.value })),
});
const withIds = (s: SpineSignal[], res: MergeResult) => s.map((x) => ({ ...x, encounter_id: res.assignments.find((a) => a.proxy === x.proxy && a.source_key === x.source_key)?.encounter_id ?? null }));
function lateRevs(r: R, s: SpineSignal[], cs: Consult[]): SpineSignal[] {
  let maxRev = Math.max(...s.map((x) => x.source_rev));
  const out = s.map((x) => {
    if (x.proxy === "pulse" || x.proxy === "pqm") {
      if (r() < 0.25) return { ...x, source_rev: ++maxRev, t_close: x.t_close! + ri(r, -60, 90) * SEC, attrs: x.proxy === "pulse" ? { ...x.attrs, close_reason: pick(r, REASONS) } : x.attrs };
      return x;
    }
    if (x.proxy === "cutter") return x;
    if (r() < 0.5) { const w = weak(r, cs, x.source_key, ++maxRev, x.proxy); return { ...w, encounter_id: x.encounter_id }; } // the weak signal hops, keeps its stale id
    return x;
  });
  if (r() < 0.5) out.push(weak(r, cs, `wn${maxRev}`, ++maxRev));
  return out;
}

interface Bad { seed: number; mixed: boolean; run: number; what: string; }
function check(seed: number, mixed: boolean, bad: Bad[], stats: Record<string, number>) {
  const r = rng(seed * 7919 + (mixed ? 1 : 0));
  const { cs, sigs } = genDay(r, mixed);
  const created = new Map<string, number>();
  let s = sigs, prior: SpinePrior = { encounters: [], links: [] };
  const anchorIds: Map<string, string>[] = [];
  const linkOwner: Map<string, string>[] = [];
  const anchorOfEnc: Map<string, string>[] = [];
  for (let run = 0; run < 4; run++) {
    let res: MergeResult;
    try { res = mergeSignals(s, "mv1", prior, NOW); }
    catch (e) { bad.push({ seed, mixed, run, what: `throw ${(e as Error).message.slice(0, 60)}` }); return; }
    const fail = (what: string) => { bad.push({ seed, mixed, run, what });  };
    // output ids unique
    const ids = res.encounters.map((e) => e.encounter_id);
    if (new Set(ids).size !== ids.length) fail("duplicate encounter_id");
    const live = new Set(res.encounters.filter((e) => e.status !== "merged").map((e) => e.encounter_id));
    // no two same-kind strong anchors share an id
    const strongBy = new Map<string, string>();
    const ai = new Map<string, string>();
    for (const a of res.assignments) {
      if (a.proxy !== "pulse" && a.proxy !== "pqm") continue;
      ai.set(a.source_key, a.encounter_id);
      const k = `${a.proxy}|${a.encounter_id}`;
      if (strongBy.has(k) && strongBy.get(k) !== a.source_key) fail(`two ${a.proxy} anchors share ${a.encounter_id.slice(0, 8)}`);
      strongBy.set(k, a.source_key);
      if (!live.has(a.encounter_id)) fail(`strong anchor assigned to non-live encounter`);
    }
    anchorIds.push(ai);
    const encAnchor = new Map<string, string>();
    for (const [k, id] of ai) if (k.startsWith("p_")) encAnchor.set(id, k);
    anchorOfEnc.push(encAnchor);
    const lo = new Map(res.links.map((l) => [`${l.key_kind}|${l.value}`, l.encounter_id]));
    linkOwner.push(lo);
    if (run > 0) {
      for (const [k, id] of ai) {
        const was = anchorIds[run - 1].get(k);
        if (was && was !== id) {
          // allowed only as an M8 merge: the old id is now merged into the new one
          const m = res.encounters.find((e) => e.encounter_id === was);
          if (k.startsWith("p_") && !mixed) fail(`pulse ${k} changed id`);
          else if (!(m && m.status === "merged" && m.merged_into === id)) fail(`${k} changed id without a merged row`);
          else { stats[`m8_${k[0]}_idchange`] = (stats[`m8_${k[0]}_idchange`] ?? 0) + 1;  }
        }
      }
      for (const [k, id] of lo) {
        const was = linkOwner[run - 1].get(k);
        if (!was || was === id) continue;
        const pa = anchorOfEnc[run - 1].get(was), pb = anchorOfEnc[run].get(id);
        if (pa && pb && pa !== pb) {
          const kind = k.split("|")[0];
          stats[`link_move_pulse_to_pulse_${kind}`] = (stats[`link_move_pulse_to_pulse_${kind}`] ?? 0) + 1;
          if (kind === "consult_key" || (kind === "consult_uid" && k.split("|")[1].startsWith("u_"))) {
            // a pulse's own key may never move to another pulse's encounter
            const owner = k.split("|")[1].replace(/^u_/, "").replace(/@m1$/, "");
            if (pb !== `p_${owner}` ) fail(`${kind} link of ${owner} moved to ${pb}`);
          }
        }
      }
      // a pulse's own consult_key link always sits with that pulse's encounter
    }
    for (const c of cs) if (c.kind === "pulse") {
      const own = lo.get(`consult_key|u_${c.key}@m1`);
      if (own && own !== ai.get(`p_${c.key}`)) fail(`consult_key link of ${c.key} not on its pulse`);
    }
    // determinism: shuffled input and prior give a byte-identical result
    if (seed % 5 === 0) {
      const sr = rng(seed + run);
      const res2 = mergeSignals(shuffle(s, sr), "mv1", { encounters: shuffle(prior.encounters, sr), links: shuffle(prior.links, sr) }, NOW);
      if (sha(res2) !== sha(res)) fail("shuffle changes the result");
    }
    const nextPrior = toPrior(res, created, run + 1);
    // fixed point: same signals with their ids, output as prior
    if (seed % 7 === 0) {
      const fp = mergeSignals(withIds(s, res), "mv1", nextPrior, NOW);
      const strip = (x: MergeResult) => ({ e: x.encounters.filter((e) => e.status !== "merged").map((e) => [e.encounter_id, e.t_open, e.t_close, e.status, e.boundary_rev]), l: x.links.map((l) => [l.key_kind, l.value, l.encounter_id]), a: x.assignments });
      if (sha(strip(fp)) !== sha(strip(res))) fail("output-as-prior is not a fixed point");
      if (fp.encounters.some((e) => e.boundary_moved)) fail("fixed point moved a boundary");
    }
    prior = nextPrior;
    s = lateRevs(r, withIds(s, res), cs);
  }
}

describe("R2 refuter property: back-to-back consults across reruns", () => {
  for (const mixed of [false, true]) it(`${N} random room-days, ${mixed ? "pulse+pqm" : "pulse only"}, 3 reruns each`, () => {
    const bad: Bad[] = [];
    const stats: Record<string, number> = {};
    for (let seed = Number(process.env.SEED0 ?? 1); seed <= N; seed++) check(seed, mixed, bad, stats);
    expect(bad).toEqual([]);
    void stats;
  }, 300_000);
});
