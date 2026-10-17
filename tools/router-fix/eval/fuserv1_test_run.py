#!/usr/bin/env python3
"""FUSER v1 TEST runner (23 cw-* CAP consults, frozen fuserv1, V7 policy 8a). Never runs before its gates pass:
  - fuserv1/ clean and repo HEAD == --freeze-sha (the freeze record's sha)
  - the T-FUSER-2 list (eval-out/test-v0-tracks-list.json) names 2 fused.v0 tracks per window; each file exists,
    its sha256 matches the list, its mtime is earlier than this run's first log line, and fuserv1.eligibility
    accepts it (frozen v0 pin, not dirty, frozen reb pin, right ETR arm)
  - every window's SELECTED SraVaani track (what the prepass reads) is the pinned config hash, ok and non-empty
  - the window is a cw-* dev_clip, not on the excluded/held-out list, count == --expect-n
Any failure refuses before the first API call (nothing spent). The run log (first line written here, at
RUN_LOG) is what the v0-track writer refuses on, so v0 tracks are written before it and never after.
On a fallback slice the runner records the fused.v0 (ETR-on arm) text for that slice's time span next to the
untouched validator result (rec["v0_fallback"][slice_index]); v0 is NOT a model input (matches DEV).
usage: fuserv1_test_run.py --windows IDS.txt --v0-list LIST.json --sravaani-hash H --freeze-sha SHA --out OUT.jsonl"""
import argparse, glob, hashlib, json, os, random, subprocess, sys, time, traceback

sys.path.insert(0, "/tmp/wt-reb-a447dc36/kit")
import reb as reb_pkg
_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(_REPO, "fuserv1"))
import eligibility, gemini_call as gc, lexicon, number_parse as npm, runner  # noqa: E402

RUN_LOG = os.environ.get("TEST_V1_RUN_LOG", "/home/eta/oc/router-fix/eval-out/fuserv1-test-run.log")
RX_PATH = "/home/eta/eta-data/cap2/rx_history.jsonl"
EXCLUDED = {"cw-vafxdW8k1Nt4tpyOzHQb", "L041", "L057", "L139", "L182"}
FUSED_ENGINE = "fuser-v0-m6-etr"
SEED = 3
MIN_COSTED = 5


class Refuse(Exception):
    pass


def _git(*a):
    return subprocess.check_output(["git", "-C", _REPO, *a], text=True).strip()


def gate(ids, v0_list, sravaani_hash, freeze_sha, expect_n, root, run_start, code_head=None, fuserv1_dirty=None):
    """Returns {wid: (ist_date, room_id, {arm: fused_track_dict})} or raises Refuse with every problem."""
    bad = []
    head = code_head if code_head is not None else _git("rev-parse", "HEAD")
    dirty = fuserv1_dirty if fuserv1_dirty is not None else bool(_git("status", "--porcelain"))
    if head != freeze_sha:
        bad.append(f"repo HEAD {head} != freeze sha {freeze_sha}")
    if dirty:
        bad.append("repo has uncommitted changes (whole repo, incl. eval/ and this runner)")
    if len(ids) != expect_n or len(set(ids)) != len(ids):
        bad.append(f"window count {len(ids)} (unique {len(set(ids))}) != {expect_n}")
    by_win = {}
    for row in v0_list["tracks"]:
        by_win.setdefault(row["window_id"], {})[row["arm"]] = row
    out = {}
    for wid in ids:
        if wid in EXCLUDED or not wid.startswith("cw-"):
            bad.append(f"{wid}: excluded or not cw-*"); continue
        hits = glob.glob(os.path.join(root, "*", "*", wid, "manifest.json"))
        if len(hits) != 1:
            bad.append(f"{wid}: {len(hits)} manifests"); continue
        ist_date, room_id = hits[0].split(os.sep)[-4], hits[0].split(os.sep)[-3]
        w = reb_pkg.load_window(wid, ist_date=ist_date, room_id=room_id, root=root)
        if (w.manifest or {}).get("source_kind") != "dev_clip":
            bad.append(f"{wid}: source_kind != dev_clip"); continue
        sel = [t for t in w.tracks(layer="stt", engine="sravaani")]
        if not sel or sel[0].entry.get("config_hash") != sravaani_hash or not any(
                s.get("text") for s in sel[0].segments):
            bad.append(f"{wid}: selected SraVaani track is not the pinned non-empty {sravaani_hash}")
        arms = {}
        for arm, flag in (("etr_on", True), ("etr_off", False)):
            row = by_win.get(wid, {}).get(arm)
            if not row:
                bad.append(f"{wid}: no v0 {arm} track in the list"); continue
            p = row["path"]
            if not os.path.exists(p):
                bad.append(f"{wid} {arm}: track file missing"); continue
            with open(p, "rb") as fh:
                digest = hashlib.sha256(fh.read()).hexdigest()
            if digest != row["sha256"]:
                bad.append(f"{wid} {arm}: track sha256 differs from the list"); continue
            if os.path.getmtime(p) >= run_start:
                bad.append(f"{wid} {arm}: track mtime not earlier than the run start"); continue
            with open(p) as fh:
                tr = json.load(fh)
            if (tr.get("window_id") != wid or tr.get("layer") != "fused" or tr.get("engine") != FUSED_ENGINE
                    or tr.get("config_hash") != row.get("config_hash") or tr.get("status") != "ok"):
                bad.append(f"{wid} {arm}: track identity (window/layer/engine/config_hash/status) does not match the list row")
                continue
            ok, why = eligibility.eligibility(tr.get("config"), flag)
            if not ok:
                bad.append(f"{wid} {arm}: ineligible {why}"); continue
            arms[arm] = tr
        out[wid] = (ist_date, room_id, arms)
    if bad:
        raise Refuse("REFUSING, no API call made:\n  " + "\n  ".join(bad))
    return out


def v0_text_for_slice(fused_track, slice_bounds):
    t0, t1 = slice_bounds["t0_ms"], slice_bounds["t1_ms"]
    segs = sorted((s for s in fused_track["segments"] if s["t1_ms"] > t0 and s["t0_ms"] < t1),
                  key=lambda s: s["t0_ms"])
    return " ".join(s["text"] for s in segs if s.get("text"))


def attach_fallback(res, fused_on_track):
    fb = {}
    for i, sl in enumerate(res["slices"]):
        if sl["validated"]["outcome"] == "fallback":
            fb[str(i)] = {"text": v0_text_for_slice(fused_on_track, sl["slice"]),
                          "source": "fused.v0 etr_on", "config_hash": fused_on_track["config_hash"]}
    return fb


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--windows", required=True); ap.add_argument("--v0-list", required=True)
    ap.add_argument("--sravaani-hash", required=True); ap.add_argument("--freeze-sha", required=True)
    ap.add_argument("--out", required=True); ap.add_argument("--expect-n", type=int, default=23)
    ap.add_argument("--cost-cap", type=float, required=True)
    ap.add_argument("--root", default=reb_pkg.reb.DEFAULT_ROOT)
    a = ap.parse_args(argv)
    if os.path.exists(a.out) or os.path.exists(RUN_LOG):
        sys.exit(f"refusing: {a.out} or {RUN_LOG} already exists (one uninterrupted run, no resume)")
    ids = [l.strip() for l in open(a.windows) if l.strip() and not l.startswith("#")]
    run_start = time.time()
    try:
        plan = gate(ids, json.load(open(a.v0_list)), a.sravaani_hash, a.freeze_sha, a.expect_n, a.root, run_start)
    except Refuse as e:
        sys.exit(str(e))
    order = sorted(ids)
    random.Random(SEED).shuffle(order)
    with open(RUN_LOG, "x") as lg:
        lg.write(f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} TEST v1 start code {a.freeze_sha} "
                 f"sravaani {a.sravaani_hash} n={len(ids)} seed {SEED} cap ${a.cost_cap}\n")
    lex = lexicon.load_lexicon(RX_PATH); ridx = npm.build_reverse_index(2000)
    send = gc.http_transport(gc.get_key())
    spent, n_costed = 0.0, 0
    with open(a.out, "x") as out:
        for i, wid in enumerate(order):
            ist_date, room_id, arms = plan[wid]
            t0 = time.time()
            try:
                w = reb_pkg.load_window(wid, ist_date=ist_date, room_id=room_id, root=a.root)
                res = runner.run_window(w, lex, ridx, send)
                rec = {"window_id": wid, "room_id": room_id, "ist_date": ist_date, "ok": True, "result": res,
                       "v0_fallback": attach_fallback(res, arms["etr_on"])}
                spent += res.get("total_cost_usd") or 0.0
                n_costed += 1
            except Exception as e:
                rec = {"window_id": wid, "room_id": room_id, "ist_date": ist_date, "ok": False,
                       "error": str(e), "traceback": traceback.format_exc()}
            out.write(json.dumps(rec, ensure_ascii=False, default=str) + "\n"); out.flush()
            print(f"[{i+1}/{len(order)}] {wid} {'OK' if rec['ok'] else 'ERROR ' + rec.get('error', '')} "
                  f"{time.time()-t0:.1f}s cost=${spent:.4f}", flush=True)
            proj = spent + (len(order) - i - 1) * spent / n_costed if n_costed >= MIN_COSTED else None
            if not rec["ok"]:
                print("STOPPED_ON_ERROR: a failed window's cost is uncounted. HALT -- post first.", flush=True)
                sys.exit(3)
            if spent > a.cost_cap or (proj is not None and proj > a.cost_cap):
                print(f"STOPPED_COST_CAP: spent ${spent:.4f}, projected {proj}, cap ${a.cost_cap}. HALT -- post first.", flush=True)
                sys.exit(2)
    print(f"DONE cost=${spent:.4f}", flush=True)


if __name__ == "__main__":
    main()
