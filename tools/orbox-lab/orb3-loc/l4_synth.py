"""L4: the full walk chain on synthetic audio: 120 s beacon block, 3 calibration rounds + 15 test rounds, 120 s beacon block.
usage: l4_synth.py OUT_DIR [--place-err 0.10] [--seed 1] [--ppm 3]
Render and room as l1_synth (RT60 0.5 s, 1/d level, noise). Relative clock drift: mic2 +ppm, pi -ppm, against mic1.
Calibration rounds 1-3 are the phone held at mic1, mic2, pi, but --place-err m off (random direction); locate gets the nominal spots.
True speakers: left (-0.3, 0.2), right (0.9, 0.2): 1.2 m apart."""
import argparse, json, os
import numpy as np, soundfile as sf
import beacon_gen as bg, locate as L, walk_sync as W, walk_track as WT, l1_synth as S

FS = bg.FS
TRUE_L, TRUE_R = np.array([-0.3, 0.2]), np.array([0.9, 0.2])
T_PRE0, WALK_LEAD, ROUND_S = 3.0, 10.0, 30.0
ROUNDS = 18                      # 3 calibration + 10 inside + 5 outside


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--geometry", default="geom.json")
    ap.add_argument("--place-err", type=float, default=0.10)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--ppm", type=float, default=3.0)
    ap.add_argument("--mc", type=int, default=100)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    names = ["mic1", "mic2", "pi"]
    g = L.Geo(a.geometry, names, calibrated=True)
    rng = np.random.default_rng(a.seed)
    S.CLK = {"mic1": (+7.300e-3, 0.0), "mic2": (-2.150e-3, +a.ppm * 1e-6), "pi": (-1.0814, -a.ppm * 1e-6)}
    ev = []

    def block(t0):
        for i in range(WT.N_EVENTS):
            tb = t0 + WT.LEAD_S + i * WT.PERIOD_S
            ev.append((S.beacon_u, tb, bg.SWEEP_S, TRUE_L)); ev.append((S.check_u, tb + WT.CHECK_DELAY_S, bg.SWEEP_S, TRUE_R))
    block(T_PRE0)
    t_walk = T_PRE0 + WT.BLOCK_S + 2.0 + WALK_LEAD
    truth = []
    cal = [g.mics[0], g.mics[1], g.mics[2]]
    for r in range(ROUNDS):
        if r < 3:
            ang = rng.uniform(0, 2 * np.pi)
            P = cal[r] + a.place_err * np.array([np.cos(ang), np.sin(ang)])
        else:
            P = np.array((S.INSIDE + S.OUTSIDE)[r - 3])
        truth.append(P)
        for dt in (1.0, 12.0):
            ev.append((S.probe_u, t_walk + ROUND_S * r + dt, L.PROBE_T, P))
    t_post = t_walk + ROUND_S * ROUNDS + 5.0
    block(t_post)
    dur = t_post + WT.BLOCK_S + 3.0
    n_out = int(dur * FS)
    paths = []
    for n, m in zip(names, g.mics):
        x = S.render(ev, m, n, g.c, rng, n_out)
        x += rng.standard_normal(n_out) * 0.002
        p = os.path.join(a.out, n + ".wav"); sf.write(p, np.clip(x, -1, 1), FS, subtype="PCM_16"); paths.append(p)
        del x
    sync = W.run(paths)
    json.dump(sync, open(os.path.join(a.out, "walk_sync.json"), "w"), indent=1)
    true_b = {"mic2": a.ppm, "pi": -a.ppm}
    print("walk_sync (truth drift vs mic1 in brackets): " + "; ".join(
        f"{n} {sync['drift_ppm'][n]:+.3f} ppm [{true_b[n]:+.3f}] resid rms {sync['resid_rms_us'][n]:.2f} us" for n in names[1:]) +
        f"; events {sync['n_left']}+{sync['n_right']}, dropped {len(sync['dropped'])}")
    res = L.run(paths, sync, a.geometry, "probe", mc=a.mc, calib="1:mic1,2:mic2,3:pi", place_sigma_m=0.10, seed=a.seed)
    json.dump(res, open(os.path.join(a.out, "events.json"), "w"), indent=1)
    c = res["calibration"]
    print(f"calibration 3-point residual rms {c['resid_rms_us']:.0f} us max {c['resid_max_us']:.0f} us (placement error {a.place_err} m)")
    errs = []
    for r in range(3, ROUNDS):
        es = [e for e in res["events"] if e["round"] == r + 1]
        if not es:
            errs.append(np.nan); continue
        xy = np.mean([[e["x"], e["y"]] for e in es], axis=0)
        errs.append(float(np.hypot(*(xy - truth[r]))))
    errs = np.array(errs)
    for name, sel in (("all", slice(0, 15)), ("inside", slice(0, 10)), ("outside", slice(10, 15))):
        print(f"walk-position error {name}: median {np.nanmedian(errs[sel]):.3f} m, max {np.nanmax(errs[sel]):.3f} m")
    print("per round:", np.round(errs, 2).tolist())
    sp = res["speakers"]
    print(f"speakers: left ({sp['left']['x']:+.2f},{sp['left']['y']:+.2f}) truth {TRUE_L.tolist()}, right ({sp['right']['x']:+.2f},{sp['right']['y']:+.2f}) truth {TRUE_R.tolist()}; "
          f"separation {sp['separation_m']:.2f} m (truth {np.hypot(*(TRUE_L - TRUE_R)):.2f}); ambiguous L/R {sp['left']['ambiguous']}/{sp['right']['ambiguous']}")


if __name__ == "__main__":
    main()
