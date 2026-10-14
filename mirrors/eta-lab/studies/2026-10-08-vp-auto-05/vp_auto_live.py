#!/usr/bin/env python3
"""vp-auto-05: the daily AUTO-route job (V ruling 08 Oct: a print that passes all five rev9 gates and routes AUTO goes live without his ear check). nemo venv python (librosa for the F0 gate):
  ~/eta-data/nemotron/venv-nemo-main/bin/python3 vp_auto_live.py [--dry-run] [--date YYYY-MM-DD]
Gates, thresholds and routing are vp_auto.py (rev9, frozen) UNCHANGED. What is new here: the input (cut clips of the cutter, not the export extraction), the add-only mint into the versioned live prints (prints_store.py), the schedule, the run file.
Rules (consult-lead, binding): R1 ADD ONLY (a doctor who already has a live print is reported, never changed); R2 the VP-ACC pinned prints file is never opened for writing; R3 provenance on every auto print; R4 rollback = prints_store.py rollback;
R5 no gpu.lock here (CPU-only gating; re-cuts of older clips are done by the cutter itself, tools/recut_queue.py); R6 run file ~/eta-data/vp-auto/runs/<date>.json + one summary line; R7 clips cut before a print existed keep their old tag.
Mint only when G_sex is PASS (a known name sex and a usable F0 that agree): INCONCLUSIVE routes to EAR here, rev9 itself is untouched. A doctor who already has ANY print (live, provisional or production) is reported, never minted.
Clips used: status cut, warehouse doctor uid (timeline doctor.source), not voice_isolated, quality not multi_doctor, with live embeddings (timeline clusters; no re-embedding: older clips are re-cut by the cutter). Every other clip is counted in 'skipped' with its reason."""
import argparse, base64, collections, csv, json, os, re, subprocess, sys, time
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "2026-10-06-vp-auto")); sys.path.insert(0, HERE)
import vp_auto as VA, prints_store as PS
vm = VA.vm
E = os.path.expanduser("~/eta-data"); CLIPS = f"{E}/consult/clips"; GPU_LOCK = os.path.expanduser("~/gpu.lock"); RUNS = f"{E}/vp-auto/runs"
WAREHOUSE = "warehouse_doctor_uid"
UID_RE = re.compile(r"[A-Za-z0-9]{20}")                      # warehouse doctor uids: exactly 20 ASCII letters / digits (05c N2); anything else (blanks, zero-width characters, other lengths) is refused per doctor
PRODUID = {"Ankit": "F092iDIAfwXKtLCqP8HS", "Poornima": "0q9pSZHR24ysquO6V4Xg", "Dibyendu": "bKr81BFLZSuiMa7MvhaA", "Animesh": "mGXTEDg9o9WNR9gpZ4sY", "Salanki": "MFTZnXMshE91P7fHnqgX",
            "Vinay": None, "Darshan": None}              # 05c L1: the two production prints whose warehouse uid is NOT known on the box stay None (explicitly unmapped) until consult-lead supplies the uids; while any production print is unmapped the job mints nothing     # as vp_auto.py main()

def code_commit():
    try: return subprocess.run(["git", "-C", HERE, "rev-parse", "--short", "HEAD"], capture_output=True, text=True).stdout.strip() or None
    except Exception: return None

BAD_UIDS = set()

def read_index(path):
    latest = {}
    for l in open(path):
        if l.strip():
            try: r = json.loads(l); latest[r["consult_uid"]] = r
            except Exception: pass
    return latest

def gather(index, clips=CLIPS):
    """cut clips -> (windows by doctor uid {uid: [window dict as vp_auto.analyze_doctor wants]}, skipped Counter, names {uid: name})."""
    W = collections.defaultdict(list); skipped = collections.Counter(); names = {}; BAD_UIDS.clear()
    for uid, r in sorted(index.items(), key=lambda kv: kv[1].get("span_start", "")):
        if r.get("status") != "cut": continue
        try: tl = json.load(open(f"{clips}/{r['path']}/timeline.json"))
        except Exception: skipped["timeline_unreadable"] += 1; continue
        d = tl.get("doctor") or {}
        if not d.get("uid"): skipped["no_doctor"] += 1; continue
        if not (isinstance(d["uid"], str) and UID_RE.fullmatch(d["uid"])): skipped["bad_uid"] += 1; BAD_UIDS.add(repr(d["uid"])); continue            # N2: that doctor's clips are skipped and reported, the run goes on
        if d.get("source") != WAREHOUSE: skipped["non_warehouse_doctor"] += 1; continue
        if r.get("voice_isolated") or tl.get("voice_isolated"): skipped["voice_isolated"] += 1; continue
        q = (tl.get("window") or {}).get("quality")
        if q == "multi_doctor": skipped["multi_doctor"] += 1; continue
        cl = tl.get("clusters") or {}
        if not any(c.get("emb_b64") for c in cl.values()): skipped["no_embeddings"] += 1; continue                    # live embeddings only; clips cut before m3-11 are re-cut by tools/recut_queue.py (cutter m3-14), never re-embedded
        cls = []
        for spk, c in cl.items():
            raw = np.frombuffer(base64.b64decode(c["emb_b64"]), dtype=np.float32).copy() if c.get("emb_b64") else None
            cls.append(dict(spk=spk, sec=c["sec"], emb=None if raw is None else vm.nrm(raw), raw=raw))
        turns = [dict(speaker_raw=t["cluster"], start_s=t["start_s"], end_s=t["end_s"]) for t in tl.get("turns") or [] if t.get("cluster") is not None]
        W[d["uid"]].append(dict(cid=uid, uid=d["uid"], room=r.get("room_slug"), quality=q, day=r["ist_date"], clusters=cls, turns=turns, path=f"{clips}/{r['path']}", span_start=r.get("span_start"), span_end=r.get("span_end")))
        names[d["uid"]] = d.get("name") or d["uid"]
    return dict(W), skipped, names

def clip_audio(windows):
    cache = {}; paths = {w["cid"]: w["path"] for ws in windows.values() for w in ws}
    def audio16(cid):
        if cid not in cache:
            p = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", f"{paths[cid]}/consult.flac", "-ac", "1", "-ar", "16000", "-f", "f32le", "-"], capture_output=True, check=True)
            if len(cache) > 6: cache.pop(next(iter(cache)))
            cache[cid] = np.frombuffer(p.stdout, dtype=np.float32)
        return cache[cid]
    return audio16

def analyze(windows, names, live_doc, prod, sx, f0_fn=None, provisional_uids=()):
    """-> (results {uid: route dict}, prints {uid: vec}). A doctor with ANY existing print (live file, provisional file, production prints) is analysed against his LIVE/provisional print when he has one (reported only); production-only doctors and the rest against a freshly built one.
    All existing prints, production included, stay in every comparison set (G-distinct). rev9 functions unchanged; the only addition to routing: AUTO needs G_sex.status == PASS, else EAR."""
    live = {p["doctor_uid"]: vm.nrm(np.array(p["centroid_192_l2"], dtype=np.float32)) for p in live_doc["prints"]}
    prod_uids = {next((x for k, x in PRODUID.items() if k.lower() in p["name"].lower()), None) for p in prod} - {None}
    sources = {}
    for u in set(live) | set(provisional_uids) | prod_uids: sources[u] = [n for n, ok in (("live", u in live), ("provisional", u in provisional_uids), ("production", u in prod_uids)) if ok]
    # 05c N1: fail CLOSED. A doctor whose NAME matches a production print (any shared name token of >= 4 letters) but whose uid is not exactly that print's mapped uid (unmapped print, different uid, or a uid equal only ignoring case) is treated as HAVING a print: reported, never minted.
    toks = lambda n: {t for t in re.split(r"[^a-z]+", (n or "").lower()) if t and t != "dr"}
    exact = set(live) | set(provisional_uids) | prod_uids; fold = {x.lower(): x for x in exact}
    for u in windows:
        why = []
        if u not in exact and u.lower() in fold: why.append(f"uid equals {fold[u.lower()]} only ignoring case")
        for pr in prod:
            if toks(names.get(u, "")) & {t for t in toks(pr["name"]) if len(t) >= 4}:
                pu = next((x for k, x in PRODUID.items() if k.lower() in pr["name"].lower()), None)
                if pu != u: why.append(f"name matches production print '{pr['name']}' ({'unmapped' if pu is None else 'mapped to a different uid'})")
        if why: sources.setdefault(u, []).append("unverified:" + "; ".join(why))
    prints = {u: (live[u] if u in live else VA.seed_and_print(ws)) for u, ws in windows.items()}; prints = {u: p for u, p in prints.items() if p is not None}
    results = {}
    for u, ws in windows.items():
        if u not in prints: results[u] = dict(route="WAIT", why="no embedded clusters", gates={}, name=names.get(u, u), has_print=u in sources, print_sources=sources.get(u, [])); continue
        others = {f"run:{names.get(v, v)}": p for v, p in prints.items() if v != u and v not in live}
        others.update({f"live:{v}": p for v, p in live.items() if v != u})
        others.update({f"production:{p['name']}": p["v"] for p in prod if next((x for k, x in PRODUID.items() if k.lower() in p["name"].lower()), None) != u})
        sxr = sx.get(u); ns = sxr["sex"] if sxr else None; unc = (sxr["uncertain"] == "Y") if sxr else True
        res = VA.analyze_doctor(ws, prints[u], others, ns, unc, f0_fn or (lambda items: vm.median_f0(items)))
        if res["route"] == "AUTO" and res["gates"]["G_sex"]["status"] != "PASS":                                    # vp-auto-05b F1: INCONCLUSIVE sex is not a pass for an unattended mint
            res["route"] = "EAR"; res["why"] = f"G-sex not PASS ({res['gates']['G_sex']['status']}: name sex known {not unc and ns in ('F', 'M')}, F0 class {res['gates']['G_sex']['f0_class']}): V's ear, not minted"
        res.update(name=names.get(u, u), has_print=u in sources, print_sources=sources.get(u, [])); results[u] = res
    new = [u for u in windows if u in prints and u not in sources]
    fold = collections.defaultdict(list)
    for u in new: fold[u.lower()].append(u)
    for k, us in fold.items():                                                                                       # 05c L2: two NEW doctors whose uids differ only in case -> both EAR, none minted
        if len(us) > 1:
            for u in us:
                if results[u]["route"] in ("AUTO", "EAR"):
                    results[u]["why"] = (results[u]["why"] + "; " if results[u]["route"] == "EAR" else "") + f"uid collides case-insensitively with another new doctor of this run ({', '.join(x for x in us if x != u)})"; results[u]["route"] = "EAR"
    VA.apply_distinct_pairs(results, prints, new)
    return results, prints

def make_print(u, ws, pr, res, name, commit, today):
    g = res["gates"]; m = [w for w in ws if VA.matching(w, pr)]
    return dict(doctor_uid=u, display_name=name, room=collections.Counter(w["room"] for w in ws).most_common(1)[0][0], centroid_192_l2=[round(float(x), 7) for x in pr], model="speechbrain/spkrec-ecapa-voxceleb (192-d, L2-normalised)",
                n_windows=len(m), n_days=g["G_thin"]["days"], total_speech_seconds=g["G_thin"]["seconds"], f0_median_hz=g["G_sex"]["f0_median_hz"], status="auto_live", source_days=sorted({w["day"] for w in m}),
                minted_by="vp-auto", route=res["route"], gates=g, window_ids=[w["cid"] for w in m], clip_spans=[dict(consult_uid=w["cid"], span_start=w["span_start"], span_end=w["span_end"]) for w in m], mint_date=today, code_commit=commit, prereg="VP-AUTO-PREREG-rev9.md (gates unchanged) + vp-auto-05 ruling")

def write_run(path, obj):
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True); fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh: json.dump(obj, fh, indent=1, default=str)

def run(dry=False, date=None, d=PS.D, clips=CLIPS, runs=RUNS, f0_fn=None, load_refs=None):
    today = date or time.strftime("%Y-%m-%d"); out = f"{runs}/{today}{'-dry' if dry else ''}.json"
    windows, skipped, names = gather(read_index(f"{clips}/index.jsonl"), clips)
    n, p, live_doc = PS.load(d); prod, sx = (load_refs or load_refs_default)()
    prov_path = f"{d}/{PS.PROVISIONAL}"; prov_uids = {x["doctor_uid"] for x in json.load(open(prov_path))["prints"]} if os.path.exists(prov_path) else set()
    vm.audio16 = clip_audio(windows)
    results, prints = analyze(windows, names, live_doc, prod, sx, f0_fn, prov_uids)
    commit = code_commit(); minted, reported_has_print = [], []
    for u, r in results.items():
        if r["route"] != "AUTO": continue
        if r["has_print"]: reported_has_print.append(dict(doctor_uid=u, print_sources=r["print_sources"])); continue
        minted.append(make_print(u, windows[u], prints[u], r, r["name"], commit, today))
    unmapped = sorted(p["name"] for p in prod if next((x for k, x in PRODUID.items() if k.lower() in p["name"].lower()), None) is None)
    blocked = []
    if unmapped and minted: blocked = [m["doctor_uid"] for m in minted]; minted = []                                   # 05c L1: no mint while any production print is unmapped
    version, refused = None, {}
    if minted and not dry:
        rep = PS.add_prints_report(minted, d, commit, known_uids=set(windows)); version = rep["version"]; refused = rep["refused"]
        written = set(rep["added"]); minted = [m for m in minted if m["doctor_uid"] in written]                   # 05c N6: the list is what was really written
    elif minted:                                                                                                  # dry run: apply the same refusal rules without writing
        refused = {m["doctor_uid"]: "refused" for m in minted if not UID_RE.fullmatch(m["doctor_uid"])}; minted = [m for m in minted if m["doctor_uid"] not in refused]
    refused.update({u: "uid refused: " + b for u, b in ((b, "not 20 ASCII alphanumerics") for b in sorted(BAD_UIDS))})
    c = collections.Counter(r["route"] for r in results.values()); used = sum(len(w) for w in windows.values())
    summary = (f"vp-auto-05 {today}{' DRY' if dry else ''}: clips used {used} of {used + sum(skipped.values())} cut, doctors {len(results)}, AUTO {c['AUTO']} (would mint/minted {len(minted)}, already has a print {len(reported_has_print)}, refused {len(refused)}), "
               f"EAR {c['EAR']}, WAIT {c['WAIT']}, REJECT {c['REJECT']}" + (f", MINT BLOCKED unmapped_production_print {len(unmapped)} (blocked {len(blocked)} AUTO)" if unmapped else "") + f", live version {'v%03d' % (version or n)}" + (" (unchanged, dry run)" if dry else ""))
    obj = dict(date=today, dry_run=dry, live_version_before=n, live_version_after=version or n, code_commit=commit, skipped_clips=dict(skipped), routes={u: dict(name=r["name"], route=r["route"], why=r["why"], has_print=r["has_print"], print_sources=r["print_sources"], gates=r["gates"]) for u, r in results.items()},
               minted=[dict(doctor_uid=x["doctor_uid"], name=x["display_name"], gates=x["gates"], window_ids=x["window_ids"]) for x in minted], already_has_print_reported_only=reported_has_print, refused=refused, **({"unmapped_production_print": unmapped, "mint_blocked_for": blocked} if unmapped else {}), summary=summary)
    write_run(out, obj); print(summary); return obj

def load_refs_default():
    prod = [dict(name=x["name"], v=vm.nrm(vm.b64(x["centroid_b64_float32_le"].replace("\\n", "")))) for x in json.load(open(f"{E}/consult/prod-prints.json"))]
    sx = {r["doctor_uid"]: r for r in csv.DictReader(open(f"{E}/centroid-mint/roomsub/SEXTABLE_rev7.FROZEN.csv"))}
    return prod, sx

ALERTS = os.path.expanduser("~/eta-data/consult/ALERTS.jsonl")
def alert(msg, source="vp-auto-daily"):
    """05c N5: one JSON line in the alert spool (the cutter's tools/alert_watch.py tails it; an agent session relays it to the bus). Never raises."""
    try:
        os.makedirs(os.path.dirname(ALERTS), mode=0o700, exist_ok=True); fd = os.open(ALERTS, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        with os.fdopen(fd, "a") as fh: fh.write(json.dumps(dict(at=time.strftime("%Y-%m-%dT%H:%M:%S%z"), source=source, alert=msg)) + "\n")
    except Exception as e: print(f"could not write the alert spool: {e}", file=sys.stderr)

def main(argv=None):
    ap = argparse.ArgumentParser(); ap.add_argument("--dry-run", action="store_true"); ap.add_argument("--date"); ap.add_argument("--alert", help="only append this text to the alert spool (used by the OnFailure unit)"); a = ap.parse_args(argv)
    if a.alert: alert(a.alert, "systemd"); return
    try: run(a.dry_run, a.date)
    except BaseException as e:
        if isinstance(e, SystemExit) and e.code in (0, None): raise
        alert(f"ALERT vp-auto daily job failed: {type(e).__name__}: {str(e)[:200]}"); raise
if __name__ == "__main__": main()
