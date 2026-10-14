#!/usr/bin/env python3
"""VP-ACC-01: voiceprint accuracy of the provisional prints on holdout days, scored exactly as VP-ACC-PREREG-rev3.md (rev2 + the long-window exclusion; rev1 was failed by the refuter, rev2 stays unchanged in git). CPU only.
  vp_acc.py prepare   LISTS the holdout clips that have no embeddings and asks for a RE-CUT (cutter m3-14: tools/recut_queue.py runs `cutter.run --once --only UID --recut`; the live pipeline writes the embeddings). Re-embedding from consult.flac is RETIRED (parity with the live embeddings failed, 08 Oct). NOT scoring.
  vp_acc.py count     holdout size after ALL exclusions (rev3), per exclusion reason; computes no score, needs no pin
  vp_acc.py score     write ~/eta-data/consult/vp-acc/score-<stamp>.json + a table. Run by the REFUTER, not by diar-lab.
Nothing here changes a print, the 0.55 threshold or any cutter file."""
import argparse, base64, collections, hashlib, json, math, os, statistics, sys, time
import numpy as np
H = os.path.expanduser("~"); CLIPS = f"{H}/eta-data/consult/clips"; PRINTS = f"{H}/eta-data/consult/prints-provisional-06oct.json"; OUT = f"{H}/eta-data/consult/vp-acc"
CUTTER = os.environ.get("CUTTER_DIR", f"{H}/oc/consult/cutter-deploy")
HOLDOUT_FROM = "2026-10-07"; COS = 0.55; MIN_CLUSTER_S = 20.0; MIN_NONVI_CLIPS = 40; MAX_EMBED_ATTEMPTS = 2; MAX_MINUTES = 45.0                       # rev3: same cut-off as the cutter's deferred_long (m3-12)
PRINTS_SHA256 = "68a719eac7aad1aaf281df2187f0e9f9404c7dc03110bd9107386ec61a744ad4"          # rev2 F4: the pinned prints file; a re-mint is a new pre-registration revision
WAREHOUSE = "warehouse_doctor_uid"
BARS = dict(R1_pooled=0.95, R1_doctor=0.85, R1_doctor_min_clips=5, R2_max=0.02, R3_min=0.98)

def nrm(v): v = np.asarray(v, dtype=np.float64); return v / np.linalg.norm(v)
def unb64(s): return nrm(np.frombuffer(base64.b64decode(s), dtype="<f4").astype(np.float64))

def load_prints(path=PRINTS):
    return {p["doctor_uid"]: dict(name=p["display_name"], vec=nrm(p["centroid_192_l2"]), source_gated=bool(p.get("source_gated"))) for p in json.load(open(path))["prints"]}

def check_prints_pin(path=PRINTS):
    """rev2 F4: `score` refuses to run on a prints file other than the pinned one, or when a print lists source days on/after the holdout start."""
    import hashlib
    h = hashlib.sha256(open(path, "rb").read()).hexdigest()
    if h != PRINTS_SHA256: raise SystemExit(f"REFUSED: prints file sha256 {h} != pinned {PRINTS_SHA256} (a re-mint needs a new pre-registration revision)")
    for p in json.load(open(path))["prints"]:
        for d in p.get("source_days") or []:
            if d >= HOLDOUT_FROM: raise SystemExit(f"REFUSED: print {p['display_name']} lists source day {d} >= {HOLDOUT_FROM}")

def read_index(path=None):
    latest = {}
    for l in open(path or f"{CLIPS}/index.jsonl"):
        if l.strip():
            r = json.loads(l); latest[r["consult_uid"]] = r
    return latest

def is_vi(row):
    """voice_isolated from the row (m3-08 tagging); a row without the field is judged by the m3-08 date rule: OPD 4/5 (slug opd-4 / opd-5) and clip start inside 2026-10-01 00:00 .. 2026-10-07 21:30 IST."""
    import datetime as dt, re
    if row.get("voice_isolated") is not None: return bool(row["voice_isolated"])
    IST = dt.timezone(dt.timedelta(hours=5, minutes=30)); d = dt.datetime.fromisoformat(row["span_start"]); d = d if d.tzinfo else d.replace(tzinfo=IST)
    return bool(re.match(r"opd-[45](-|$)", row.get("room_slug") or "")) and dt.datetime(2026, 10, 1, tzinfo=IST) <= d <= dt.datetime(2026, 10, 7, 21, 30, tzinfo=IST)

def holdout(index, timeline_of):
    """-> (clips, need, excluded): clips = dict(uid, gt, vi, room, day, clusters [(sec, vec)], re_embedded) for cut clips of the holdout days; need = uids still without embeddings; excluded = counts: embed_failed (prepare failed on it), no_minutes, long_gt45 (rev3: index minutes missing / > 45.0), multi_doctor, non_warehouse (doctor from another source), no_doctor."""
    out, need, ex = [], [], collections.Counter()
    for uid, r in sorted(index.items(), key=lambda kv: kv[1].get("span_start", "")):
        if r.get("status") != "cut" or r.get("ist_date", "") < HOLDOUT_FROM: continue
        m = r.get("minutes")                                                                      # rev3: long windows (not single consults) are out of the test, before every bar
        if isinstance(m, bool) or not isinstance(m, (int, float)) or not math.isfinite(m) or m <= 0:       # rev3 m3-13b: missing, non-numeric, non-finite or <= 0 minutes are no_minutes
            ex["no_minutes"] += 1; continue
        if m > MAX_MINUTES: ex["long_gt45"] += 1; continue
        tl = timeline_of(r); d = tl.get("doctor") or {}
        if tl["window"].get("quality") == "multi_doctor": ex["multi_doctor"] += 1; continue
        if not d.get("uid"): ex["no_doctor"] += 1; continue                                     # F2
        if d.get("source") != WAREHOUSE: ex["non_warehouse"] += 1; continue                        # F1
        cl = tl.get("clusters") or {}; re = False
        if not any(c.get("emb_b64") for c in cl.values()):
            if marker_state(uid)[0] == "ok" and marker_state(uid)[1] >= MAX_EMBED_ATTEMPTS: ex["embed_failed"] += 1; continue          # the re-cut driver failed on it twice: an explicit, counted exclusion
            else: need.append(uid); continue
        out.append(dict(uid=uid, gt=d["uid"], vi=is_vi(r), room=r["room_slug"], day=r["ist_date"], re_embedded=re,
                        clusters=[(c["sec"], unb64(c["emb_b64"])) for c in cl.values() if c.get("emb_b64") and c["sec"] >= MIN_CLUSTER_S]))
    return out, need, dict(ex)

def pct(x, q): x = sorted(x); return x[min(len(x) - 1, int(q * len(x)))] if x else None
def dist(x): return dict(n=len(x), min=min(x) if x else None, p5=pct(x, 0.05), median=statistics.median(x) if x else None)

def score(clips, prints, excluded=None):
    """exactly the pre-registered quantities on the NON-VI clips (bars); VI clips get the same numbers separately with no bars."""
    def run(cs):
        S = {c["uid"]: {u: max([float(np.dot(v, p["vec"])) for sec, v in c["clusters"] if sec >= MIN_CLUSTER_S], default=None) for u, p in prints.items()} for c in cs}
        gen, imp, r2_pairs, r2_hits, r2_fail, r3_hit, r3_n, r3_fail = [], [], 0, 0, [], 0, 0, []
        scorable = lambda c: any(sec >= MIN_CLUSTER_S for sec, _ in c["clusters"]); r2_pairs_all = 0; unscorable = sum(not scorable(c) for c in cs)          # rev2 F3
        per = collections.defaultdict(lambda: dict(clips=0, hits=0, genuine=[]))
        for c in cs:
            s = S[c["uid"]]
            if c["gt"] in prints:
                d = per[c["gt"]]; d["clips"] += 1
                if s[c["gt"]] is not None: gen.append(s[c["gt"]]); d["genuine"].append(s[c["gt"]]); d["hits"] += s[c["gt"]] >= COS
            for u in prints:
                if u == c["gt"]: continue
                r2_pairs_all += 1
                if scorable(c): r2_pairs += 1
                if s[u] is not None:
                    imp.append(s[u])
                    if s[u] >= COS: r2_hits += 1; r2_fail.append((c["uid"], prints[u]["name"], round(s[u], 3)))
            sc = {u: v for u, v in s.items() if v is not None}
            if sc and max(sc.values()) >= COS:
                r3_n += 1; top = max(sc, key=sc.get)
                if top == c["gt"]: r3_hit += 1
                else: r3_fail.append((c["uid"], prints[top]["name"], round(sc[top], 3), "gt " + (prints[c["gt"]]["name"] if c["gt"] in prints else "unprinted")))
        printed = [c for c in cs if c["gt"] in prints]; hits = sum(d["hits"] for d in per.values()); n = sum(d["clips"] for d in per.values())
        eer = None
        if gen and imp:
            best = None
            for t in sorted(set(gen + imp)):
                far = sum(x >= t for x in imp) / len(imp); frr = sum(x < t for x in gen) / len(gen)
                if best is None or abs(far - frr) < best[0]: best = (abs(far - frr), t, far, frr)
            eer = dict(threshold=round(best[1], 3), far=round(best[2], 4), frr=round(best[3], 4))
        return dict(clips=len(cs), printed_doctor_clips=len(printed),
                    R1=dict(pooled=(hits / n if n else None), hits=hits, n=n, per_doctor={prints[u]["name"]: dict(clips=d["clips"], recall=(d["hits"] / d["clips"] if d["clips"] else None), genuine=dist(d["genuine"]), source_gated=prints[u]["source_gated"]) for u, d in per.items()}),
                    R2=dict(rate=(r2_hits / r2_pairs if r2_pairs else None), hits=r2_hits, pairs=r2_pairs, rate_all_clips_no_bar=(r2_hits / r2_pairs_all if r2_pairs_all else None), pairs_all_clips=r2_pairs_all, unscorable_clips=unscorable, failures=r2_fail),
                    R3=dict(rate=(r3_hit / r3_n if r3_n else None), hits=r3_hit, n=r3_n, failures=r3_fail),
                    genuine=dist(gen), impostor=dist(imp), equal_error=eer)
    non, vi = [c for c in clips if not c["vi"]], [c for c in clips if c["vi"]]
    brief = lambda x: dict(clips=x["clips"], R1_pooled=x["R1"]["pooled"], R1_n=x["R1"]["n"], R2=x["R2"]["rate"], R2_pairs=x["R2"]["pairs"], R3=x["R3"]["rate"], R3_n=x["R3"]["n"])
    res = dict(prereg="VP-ACC-PREREG-rev3.md", prints_sha256=PRINTS_SHA256, excluded=excluded or {}, by_embedding_no_bars={k: brief(run([c for c in non if c["re_embedded"] == v])) for k, v in (("live", False), ("re_embedded", True))}, holdout_from=HOLDOUT_FROM, cos=COS, min_cluster_s=MIN_CLUSTER_S, bars=BARS, non_vi=run(non), vi_no_bars=run(vi), re_embedded_clips=sum(c["re_embedded"] for c in clips),
               by_doctor_non_vi=dict(collections.Counter(prints[c["gt"]]["name"] if c["gt"] in prints else "unprinted" for c in non)))
    a = res["non_vi"]
    if a["printed_doctor_clips"] < MIN_NONVI_CLIPS: res["verdict"] = f"INCONCLUSIVE: {a['printed_doctor_clips']} non-VI clips of printed doctors (< {MIN_NONVI_CLIPS})"; return res
    ok1 = a["R1"]["pooled"] >= BARS["R1_pooled"] and all(d["recall"] >= BARS["R1_doctor"] for d in a["R1"]["per_doctor"].values() if d["clips"] >= BARS["R1_doctor_min_clips"])
    ok2 = a["R2"]["rate"] is not None and a["R2"]["rate"] <= BARS["R2_max"]; ok3 = a["R3"]["rate"] is None or a["R3"]["rate"] >= BARS["R3_min"]
    res["verdict"] = ("PASS" if ok1 and ok2 and ok3 else "FAIL") + f" (R1 {'ok' if ok1 else 'fail'}, R2 {'ok' if ok2 else 'fail'}, R3 {'ok' if ok3 else 'fail'})"; return res

def table(res):
    a = res["non_vi"]; f = lambda x: "n/a" if x is None else f"{100 * x:.1f}%"
    L = [f"VP-ACC-01 {res['verdict']}", f"holdout >= {res['holdout_from']}: non-VI {a['clips']} clips ({a['printed_doctor_clips']} of printed doctors), VI {res['vi_no_bars']['clips']}, re-embedded {res['re_embedded_clips']}",
         f"R1 recall pooled {f(a['R1']['pooled'])} ({a['R1']['hits']}/{a['R1']['n']})  bar >= 95%, each doctor >= 85% when >= 5 clips", f"R2 false accept {f(a['R2']['rate'])} ({a['R2']['hits']}/{a['R2']['pairs']} pairs, scorable clips)  bar <= 2%; over all clips {f(a['R2']['rate_all_clips_no_bar'])} ({a['R2']['pairs_all_clips']} pairs), unscorable clips {a['R2']['unscorable_clips']}", f"R3 top-1 {f(a['R3']['rate'])} ({a['R3']['hits']}/{a['R3']['n']})  bar >= 98%",
         f"excluded {res['excluded']}", f"by embedding (no bars) {res['by_embedding_no_bars']}", f"genuine cos {a['genuine']}", f"impostor cos {a['impostor']}", f"equal-error {a['equal_error']}"]
    for n, d in a["R1"]["per_doctor"].items(): L.append(f"  {n}: {d['clips']} clips, recall {f(d['recall'])}, genuine {d['genuine']}" + ("  [source_gated]" if d["source_gated"] else ""))
    L += [f"R2 failures: {a['R2']['failures']}", f"R3 failures: {a['R3']['failures']}"]; return "\n".join(L)

def count(clips, need, ex, prints):
    """rev3 `count`: the holdout after ALL exclusions, no score. non_vi_printed_doctor_clips is what the INCONCLUSIVE floor (40) is checked on."""
    non = [c for c in clips if not c["vi"]]; printed = [c for c in non if c["gt"] in prints]
    reasons = {k: ex.get(k, 0) for k in ("embed_failed", "no_minutes", "long_gt45", "multi_doctor", "no_doctor", "non_warehouse")}; reasons["vi"] = len(clips) - len(non)
    bad = sum(1 for u in need if marker_state(u)[0] == "bad")
    return dict(holdout_from=HOLDOUT_FROM, clips_after_exclusions=len(clips), bad_marker=bad, non_vi=len(non), non_vi_printed_doctor_clips=len(printed), vi=reasons["vi"], without_embeddings_yet=len(need), excluded=reasons,
                floor=MIN_NONVI_CLIPS, status="INCONCLUSIVE (below the floor)" if len(printed) < MIN_NONVI_CLIPS else "floor reached")

def timeline_of(row): return json.load(open(f"{CLIPS}/{row['path']}/timeline.json"))

def marker_state(uid):
    """-> ("none", 0) | ("ok", attempts) | ("bad", 0). A marker is valid only if it is a JSON object with this consult_uid, an integer attempts >= 1 and a reasons list with len(reasons) >= attempts (m3-13d F3); anything unreadable, empty, truncated or hand-made is "bad"."""
    try: m = json.load(open(f"{OUT}/reembed/{uid}.failed.json"))
    except FileNotFoundError: return "none", 0
    except Exception: return "bad", 0
    a = m.get("attempts") if isinstance(m, dict) else None
    if not (isinstance(a, int) and not isinstance(a, bool) and a >= 1 and m.get("consult_uid") == uid and isinstance(m.get("reasons"), list) and len(m["reasons"]) >= a): return "bad", 0
    return "ok", a

def failed_attempts(uid): return marker_state(uid)[1]

def mark_failed(uid, why):
    """(kept for tests and tools; the re-cut driver writes the same marker) a re-cut of this clip failed (a worker exception JSON, or an exit code that is neither 0 nor a deferral): <uid>.failed.json (0600), written atomically (temp file in the same directory + rename), with attempts and reasons. The first failure leaves the clip in `need` (retried by the next prepare, score keeps refusing); the second makes it the counted exclusion embed_failed. A bad marker is ignored (the clip stays needed) and replaced by a fresh one with attempts 1."""
    d = f"{OUT}/reembed"; os.makedirs(d, mode=0o700, exist_ok=True); st, a = marker_state(uid); prev = []
    if st == "ok": prev = json.load(open(f"{d}/{uid}.failed.json"))["reasons"]
    tmp = f"{d}/.{uid}.failed.{os.getpid()}.tmp"; fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh: json.dump(dict(consult_uid=uid, attempts=a + 1, reasons=prev + [why], at=time.strftime("%Y-%m-%dT%H:%M:%S%z")), fh); fh.flush(); os.fsync(fh.fileno())
    os.replace(tmp, f"{d}/{uid}.failed.json"); return a + 1

def check_embeddings(clips):
    """m3-14 (REFUTE-m3-13e note): every embedding used must be a finite 192-d vector; otherwise `score` REFUSES (a wrong-dimension or NaN vector must never be scored silently)."""
    bad = [c["uid"] for c in clips for _, v in c["clusters"] if np.asarray(v).shape != (192,) or not np.all(np.isfinite(v))]
    if bad: raise SystemExit(f"REFUSED: {len(bad)} clip(s) carry an embedding that is not a finite 192-d vector: {sorted(set(bad))[:5]}")

def prereg_sidecar_check(here=None):
    """m3-13b: the rev3 file must match its committed sidecar VP-ACC-PREREG-rev3.sha256; -> the sha."""
    here = here or os.path.dirname(os.path.abspath(__file__)); h = hashlib.sha256(open(f"{here}/VP-ACC-PREREG-rev3.md", "rb").read()).hexdigest()
    want = open(f"{here}/VP-ACC-PREREG-rev3.sha256").read().split()[0]
    if h != want: raise SystemExit(f"REFUSED: VP-ACC-PREREG-rev3.md sha256 {h} != sidecar {want}")
    return h


def prepare():
    """RE-CUT REQUEST (rev3 amendment m3-14): lists the holdout clips that still have no embeddings. The deployed cutter re-cuts them (tools/recut_queue.py, holdout first); nothing is re-embedded here and no GPU is used."""
    _, need, ex = holdout(read_index(), timeline_of)
    print(json.dumps(dict(holdout_clips_needing_a_recut=len(need), already_embed_failed=ex.get("embed_failed", 0), recut_with="python3 tools/recut_queue.py (cutter-deploy, cutter m3-14)", uids=need)))

def main(argv=None):
    ap = argparse.ArgumentParser(); ap.add_argument("cmd", choices=["prepare", "score", "count"]); a = ap.parse_args(argv)
    if a.cmd == "prepare": return prepare()
    if a.cmd == "count": print(json.dumps(count(*holdout(read_index(), timeline_of), load_prints()), indent=1)); return
    check_prints_pin(); psha = prereg_sidecar_check(); prints = load_prints(); clips, need, ex = holdout(read_index(), timeline_of)
    if need: raise SystemExit(f"REFUSED: {len(need)} holdout clips that pass the exclusions still have no embedding (`prepare` lists them; the re-cut driver cuts them again with the live pipeline; a clip it fails on twice becomes the counted exclusion embed_failed): {need[:5]}...")
    check_embeddings(clips); res = score(clips, prints, ex); res["prereg_sha256"] = psha
    os.makedirs(OUT, mode=0o700, exist_ok=True); p = f"{OUT}/score-{time.strftime('%Y%m%d-%H%M%S')}.json"; fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh: json.dump(res, fh, indent=1, default=str)
    print(table(res)); print("written", p)

if __name__ == "__main__": main()
