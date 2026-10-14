"""Clock drift and per-speaker offsets from the two beacon blocks around a phone walk (O17 ruling 5).

usage: walk_sync.py mic1.wav mic2.wav pi.wav [--out walk_sync.json]
beacon_sync v3 assumes one unbroken 30 s schedule, so it cannot take two blocks with a walk between them. This fits
  arrival_k - arrival_1 = b_k * arrival_1 + c0_left_k   (left sweeps)      = b_k * arrival_1 + c0_right_k (check chirps)
by least squares: one drift b_k shared by both speakers, one offset per speaker, linear across the whole span.
The first wav is the reference clock. Detection is the beacon_sync arrival rule with plain templates (no drift stretch).
"""
import argparse, itertools, json, os, sys
import numpy as np
import beacon_gen as bg, beacon_sync as bs, locate as L

FS = bg.FS
OUTLIER_US = 50.0
AGREE_TOL_S = 0.5                 # block offsets of one mic must agree within this (drift over a walk is far smaller)
MAX_J = 2                         # periods tried either side of the first-beacon anchor
MAX_RESID_RMS_US = 50.0           # after outlier drops; above this the pairing or the clock model is wrong (O18 ruling)
MIN_PER_BLOCK = 4                 # usable beacons a block must keep, per mic (O18 item 2)
PAIR_TOL_S = 1.5                  # pairing window around the expected arrival on a mic's own clock
BLOCK_GAP_S = 60.0                # mic1 beacons further apart than this start a new block


def arrivals(x, ref):
    out = []
    for t in L.candidates(x, ref):
        r = L.direct_arrival(x, ref, t - 0.1, t + 0.1)          # O18: locator rule (30 % within 30 ms)
        if r is not None:
            out.append(r)
    return out


def blocks_of(times):
    """Block index per time: a gap over BLOCK_GAP_S starts a new block."""
    b, out = 0, []
    for i, t in enumerate(times):
        if i and t - times[i - 1] > BLOCK_GAP_S:
            b += 1
        out.append(b)
    return out


def pair_by_schedule(ref_ev, ev, blk, dropped, mic, kind, shifts):
    """Pair each mic1 detection with the detection on `mic` within PAIR_TOL_S of (mic1 time + that block's shift). Returns rows."""
    rows, tn = [], np.array([a[0] / FS for a in ev])
    for i, a1 in enumerate(ref_ev):
        t1 = a1[0] / FS
        if len(tn) == 0:
            hit = None
        else:
            q = int(np.argmin(np.abs(tn - (t1 + shifts[blk[i]]))))
            hit = q if abs(tn[q] - (t1 + shifts[blk[i]])) <= PAIR_TOL_S else None
        if hit is None:
            dropped.append({"mic": mic, "kind": kind, "i": i, "block": blk[i], "reason": f"no detection on {mic} within {PAIR_TOL_S} s of the expected arrival"})
        else:
            rows.append((t1, tn[hit] - t1, blk[i], i))
    return rows


def run(paths, force_j=None):   # force_j: test only, {mic: periods} added to the chosen shift of block 0 to force a mispairing
    names = [os.path.splitext(os.path.basename(p))[0] for p in paths]
    xs = {n: bs.load(p) for n, p in zip(names, paths)}
    sw = bg.make_sweep()
    kinds = {"left": sw, "right": sw[::-1].copy()}
    ev = {k: {n: arrivals(xs[n], ref) for n in names} for k, ref in kinds.items()}
    ref = names[0]
    if len(ev["left"][ref]) < MIN_PER_BLOCK:
        raise SystemExit(f"{ref}: only {len(ev['left'][ref])} left beacons found")
    lt = [a[0] / FS for a in ev["left"][ref]]
    blk_l = blocks_of(lt)
    blk_r = [blk_l[int(np.argmin(np.abs(np.array(lt) - a[0] / FS)))] for a in ev["right"][ref]]   # a check belongs to the nearest beacon's block
    nb = max(blk_l) + 1
    period = float(np.median([d for d, same in zip(np.diff(lt), np.diff(blk_l) == 0) if same]))   # beacon spacing as played (15 s in a walk block, 30 s in sat1)
    out = {"version": "walk_sync-2", "mics": names, "ref": ref, "drift_ppm": {}, "c0_left_ms": {}, "c0_right_ms": {},
           "c0_ms": {}, "resid_rms_us": {}, "resid_max_us": {}, "n_left": len(ev["left"][ref]), "n_right": len(ev["right"][ref]),
           "blocks": nb, "offset_s": {}, "usable_left_per_block": {}, "dropped": [], "pair_dropped": []}
    for n in names[1:]:
        tn_left = np.array([a[0] / FS for a in ev["left"][n]])
        bn = blocks_of(list(tn_left))
        if not len(tn_left) or max(bn) + 1 != nb:
            raise SystemExit(f"{n}: left beacons form {max(bn) + 1 if len(tn_left) else 0} blocks, {ref} has {nb}")
        cand = []                                     # per block: [(shift, matches)] for the anchor shift plus up to +-MAX_J periods
        t_refs = [[t for t, bb in zip(lt, blk_l) if bb == b] for b in range(nb)]
        for b in range(nb):
            first_n = min(t for t, bb in zip(tn_left, bn) if bb == b)
            c_b = []
            for j in range(-MAX_J, MAX_J + 1):       # j != 0: a first beacon was missed on one of the two mics, or a mic started late
                sh = first_n - t_refs[b][0] + j * period
                c_b.append((sh, sum(1 for t in t_refs[b] if np.min(np.abs(tn_left - (t + sh))) <= PAIR_TOL_S)))
            cand.append(c_b)
        best = None                                   # the combination whose block shifts agree (same offset, drift aside): most matches, then smallest shift
        for combo in itertools.product(*cand):
            sh_c = [c[0] for c in combo]
            if max(sh_c) - min(sh_c) > AGREE_TOL_S:
                continue
            key = (sum(c[1] for c in combo), -abs(float(np.mean(sh_c))))
            if best is None or key > best[0]:
                best = (key, sh_c)
        if best is None:
            raise SystemExit(f"{n}: block offsets against {ref} disagree for every pairing within +-{MAX_J} periods "
                             f"(anchor shifts {[round(c[len(c) // 2][0], 3) for c in cand]} s): clock jump or wrong beacons; no sync written")
        shifts = [sh + (force_j or {}).get(n, 0) * period * (i == 0) for i, sh in enumerate(best[1])]
        out["offset_s"][n] = [float(sh) for sh in best[1]]
        print(f"walk_sync: {n} offset against {ref} per block (s): " + ", ".join(f"{sh:+.4f}" for sh in best[1]), file=sys.stderr)
        rows = []
        pd = out["pair_dropped"]
        rows_l = pair_by_schedule(ev["left"][ref], ev["left"][n], blk_l, pd, n, "left", shifts)
        rows_r = pair_by_schedule(ev["right"][ref], ev["right"][n], blk_r, pd, n, "right", shifts)
        use = {b: sum(1 for r in rows_l if r[2] == b) for b in range(nb)}
        out["usable_left_per_block"][n] = use
        short = {b: u for b, u in use.items() if u < MIN_PER_BLOCK}
        if short or len(rows_r) < MIN_PER_BLOCK:
            raise SystemExit(f"{n}: too few usable beacons: left per block {use}, checks {len(rows_r)} (need {MIN_PER_BLOCK}); dropped: {pd}")
        rows = [(t, d, 0, i) for t, d, _, i in rows_l] + [(t, d, 1, i) for t, d, _, i in rows_r]
        while True:
            t = np.array([r[0] for r in rows]); y = np.array([r[1] for r in rows]); isr = np.array([r[2] for r in rows], float)
            A = np.stack([t, 1 - isr, isr], axis=1)
            (b, cl, cr), *_ = np.linalg.lstsq(A, y, rcond=None)
            res = y - A @ np.array([b, cl, cr])
            w = int(np.argmax(np.abs(res)))
            if abs(res[w]) * 1e6 <= OUTLIER_US or len(rows) <= 2 * MIN_PER_BLOCK:
                break
            out["dropped"].append({"mic": n, "kind": list(kinds)[rows[w][2]], "i": rows[w][3], "resid_us": float(res[w] * 1e6)})
            rows.pop(w)
        rms = float(np.sqrt(np.mean(res ** 2)) * 1e6)
        if rms > MAX_RESID_RMS_US:
            raise SystemExit(f"{n}: drift fit residual rms {rms:.1f} us after outlier drops exceeds {MAX_RESID_RMS_US:.0f} us: wrong pairing or a bent clock; no sync written")
        out["drift_ppm"][n] = float(b * 1e6)
        out["c0_left_ms"][n], out["c0_right_ms"][n], out["c0_ms"][n] = cl * 1e3, cr * 1e3, cl * 1e3
        out["resid_rms_us"][n] = float(np.sqrt(np.mean(res ** 2)) * 1e6)
        out["resid_max_us"][n] = float(np.abs(res).max() * 1e6)
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("wavs", nargs="+")
    ap.add_argument("--out", default="walk_sync.json")
    a = ap.parse_args()
    r = run(a.wavs)
    json.dump(r, open(a.out, "w"), indent=1)
    for n in r["mics"][1:]:
        print(f"{n}: drift {r['drift_ppm'][n]:+.3f} ppm  c0 left {r['c0_left_ms'][n]:+.4f} ms  right {r['c0_right_ms'][n]:+.4f} ms  "
              f"resid rms {r['resid_rms_us'][n]:.2f} us max {r['resid_max_us'][n]:.2f} us")
    print(f"events left {r['n_left']} right {r['n_right']}  outliers {len(r['dropped'])}  unpaired {len(r['pair_dropped'])}")
    for d in r["pair_dropped"]:
        print("  pair dropped:", d)
