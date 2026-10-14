#!/usr/bin/env python3
"""vp-fast step 2: mint per doctor from the extracted windows and run the proxy gates of the rev8 draft (sex vs name with the 145-185 Hz dead zone, presence >= 80% and
largest share >= 60%, AMBIGUOUS if a same-sex second group is present in >= 50% or absorption >= 20%, room share < 20% where the room has other doctors' windows).
CPU only. Run with the nemo venv (sklearn, librosa 1.0.0): ~/eta-data/nemotron/venv-nemo-main/bin/python3 vp_fast_mint.py
Mint = the meta-cluster (merge 0.45 average linkage, frozen mine_centroid_multi 463042a0 cluster_pool/analyze) covering the most distinct CLEAN windows of the doctor.
A doctor failing or not testable on any gate is REPORTED, NOT minted. Output (box only, 0600): ~/eta-data/vp-fast/mint_report.json, mints.npz.
Deviations from the rev8 text (stated, because there is no held-out half here: V's ear is the identity check): the gates run on ALL the doctor's clean windows with a >= 15 s embedded cluster;
the >= 20-window minimum is reported, not a gate; the room voices (RV) used to exclude groups from P4 = recurring voices (>= 3 sessions on >= 2 days) of OTHER doctors' Sep clips and
extracted windows in the same room (not built per absent day); P5 is gated only when >= 10 other-doctor windows exist (thinner = reported)."""
import base64, collections, glob, hashlib, importlib.util, json, os, subprocess, sys, csv
import numpy as np
E = os.path.expanduser("~/eta-data"); OUT = f"{E}/vp-fast"; RES = f"{E}/voiceprint-rollout-hf/results/proposal"
COS, MIN15, DEAD_LO, DEAD_HI = 0.55, 15.0, 145.0, 185.0
LAB = {"room_yh3etjpf": "OPD1", "room_87frpus9": "OPD3", "room_ux92qpws": "OPD4", "room_4ggnkg5x": "OPD5", "room_pnyc9u49": "OPD6", "room_qyzghzaf": "OPD7", "room_bh6jtq4t": "Cardiology"}
NAMES = {}
def f16(p): return hashlib.sha256(open(p, "rb").read()).hexdigest()[:16]
def b64(s): return np.frombuffer(base64.b64decode(s), dtype=np.float32)
def nrm(v): return v / np.linalg.norm(v)
def load_mod(path, name):
    s = importlib.util.spec_from_file_location(name, path); m = importlib.util.module_from_spec(s); s.loader.exec_module(m); return m
mc = load_mod(f"{E}/centroid-mint/mine_centroid_multi.py", "mcm"); assert f16(f"{E}/centroid-mint/mine_centroid_multi.py") == "463042a05f1aeae3"

def load_windows():
    W = {}; selected = {x["consult_uid"] for x in json.load(open(f"{OUT}/windows_selected.json"))["windows"]}     # ADDENDUM 1: only the selected windows (Srinivas capped at his 25 most recent)
    for f in glob.glob(f"{OUT}/emb/*.json"):
        if os.path.basename(f)[:-5] not in selected: continue
        d = json.load(open(f)); cl = []
        for c in d["clusters"]:
            if c.get("embedding_b64") is not None: cl.append(dict(spk=c["speaker_raw"], sec=c["total_speech_sec"], emb=nrm(b64(c["embedding_b64"])), raw=b64(c["embedding_b64"])))
            else: cl.append(dict(spk=c["speaker_raw"], sec=c["total_speech_sec"], emb=None, raw=None))
        W[d["consult_uid"]] = dict(cid=d["consult_uid"], uid=d["uid"], room=d["room_id"], quality=d["quality"], day=d["day"], t_open=d["t_open"], clusters=cl, turns=d["turns"])
    return W

def pool_of(wins):
    return [dict(clip_id=w["cid"], date=w["day"], room=w["room"], speaker_raw=c["spk"], total_speech_sec=c["sec"], n_segments_scored=1, embedding=c["raw"]) for w in wins for c in w["clusters"] if c["emb"] is not None]

def groups_at(pool, md=0.45):
    if len(pool) < 2: return []
    lab = mc.cluster_pool(pool, md); g = collections.defaultdict(list)
    for p, l in zip(pool, lab): g[int(l)].append(p)
    out = []
    for ms in g.values():
        cen = nrm(np.stack([m["embedding"] for m in ms]).mean(axis=0))
        out.append(dict(members=ms, centroid=cen, n_sessions=len({m["clip_id"] for m in ms}), n_days=len({m["date"] for m in ms})))
    return out

def sep_room_pool(room, exclude_uid):
    out = []
    for u in os.listdir(RES):
        if u == exclude_uid or not os.path.isdir(f"{RES}/{u}"): continue
        for f in glob.glob(f"{RES}/{u}/embeddings/*_{room}_*.json"):
            d = json.load(open(f)); date = d["clip_id"].split("_")[0]
            for c in d["clusters"]:
                if c.get("embedding_b64") is not None: out.append(dict(clip_id=d["clip_id"], date=date, room=room, speaker_raw=c["speaker_raw"], total_speech_sec=c["total_speech_sec"], n_segments_scored=1, embedding=b64(c["embedding_b64"])))
    return out

# ---------------------------------------------------------------- F0 sex rule (P2)
_audio = {}
def audio16(cid):
    if cid not in _audio:
        p = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", f"{OUT}/audio/{cid}.m4a", "-ac", "1", "-ar", "16000", "-f", "f32le", "-"], capture_output=True, check=True)
        if len(_audio) > 6: _audio.pop(next(iter(_audio)))
        _audio[cid] = np.frombuffer(p.stdout, dtype=np.float32)
    return _audio[cid]
def pieces(w, spks):
    """turns of the speakers `spks` in window w with every interval overlapping a turn of another speaker removed; pieces >= 0.5 s."""
    mine = [(t["start_s"], t["end_s"]) for t in w["turns"] if t["speaker_raw"] in spks]; other = [(t["start_s"], t["end_s"]) for t in w["turns"] if t["speaker_raw"] not in spks]
    res = []
    for a, b in mine:
        cur = [(a, b)]
        for oa, ob in other:
            nxt = []
            for x, y in cur:
                if ob <= x or oa >= y: nxt.append((x, y)); continue
                if oa > x: nxt.append((x, oa))
                if ob < y: nxt.append((ob, y))
            cur = nxt
        res += [(x, y) for x, y in cur if y - x >= 0.5]
    return sorted(res, key=lambda p: -(p[1] - p[0]))
def median_f0(items, cap_s=300.0):
    """items: list of (window, speaker set). Round-robin across windows (longest non-overlapped piece first) up to cap_s of audio. -> (median Hz or None, voiced seconds)."""
    import librosa
    per = [(w, pieces(w, s)) for w, s in items]; per = [(w, p) for w, p in per if p]
    chosen, tot, i = [], 0.0, 0
    while tot < cap_s and any(i < len(p) for _, p in per):
        for w, p in per:
            if i < len(p) and tot < cap_s: chosen.append((w, p[i])); tot += p[i][1] - p[i][0]
        i += 1
    f0s = []
    for w, (a, b) in chosen:
        y = audio16(w["cid"])[int(a * 16000):int(b * 16000)]
        if len(y) < 2048: continue
        f0, vf, _ = librosa.pyin(y, fmin=65, fmax=400, sr=16000); f0s += list(f0[vf & ~np.isnan(f0)])
    if not f0s: return None, 0.0
    return float(np.median(f0s)), len(f0s) * 512 / 16000
def sex_of(med, vsec):
    if med is None or vsec < 2.0: return "NOT TESTABLE"
    return "F" if med > DEAD_HI else ("M" if med < DEAD_LO else "NOT TESTABLE")

def main():
    sx = {r["doctor_uid"]: r for r in csv.DictReader(open(f"{OUT}/SEXTABLE_rev7.FROZEN.csv"))}
    assert f16(f"{OUT}/SEXTABLE_rev7.FROZEN.csv") == "836b0095e0bf6c6c"
    PP = [dict(name=x["name"], doc=x["doctor_id"], v=nrm(b64(x["centroid_b64_float32_le"].replace("\\n", "")))) for x in json.load(open(f"{E}/consult/prod-prints.json"))]   # model UNVERIFIED (same 192-d); caveat in the report
    W = load_windows(); sel = json.load(open(f"{OUT}/windows_selected.json")); print("windows extracted", len(W), "of", len(sel["windows"]), flush=True)
    uids = []; [uids.append(w["uid"]) for w in sel["windows"] if w["uid"] not in uids]
    names = {}
    for l in open(sys.argv[1]):
        r = json.loads(l); names[r["consulting_doctor_uid"]] = r["consulting_doctor_name"]
    report, mints, mints2 = {}, {}, {}
    sepcache = {}
    for u in uids:
        ws = [w for w in W.values() if w["uid"] == u]
        if not ws: report[u] = dict(name=names.get(u), uid=u, status="NOT MINTED: no extracted windows (no tape or not extracted yet)"); continue
        clean = [w for w in ws if w["quality"] == "clean"]
        rec = dict(name=names.get(u), uid=u, windows_extracted=len(ws), windows_clean=len(clean), quality_counts=dict(collections.Counter(w["quality"] for w in ws)),
                   rooms=dict(collections.Counter(LAB.get(w["room"], w["room"]) for w in clean)), sex_table=dict(sex=sx.get(u, {}).get("sex"), uncertain=sx.get(u, {}).get("uncertain")))
        report[u] = rec
        use = clean if len(clean) >= 3 else ws                  # ADDENDUM 1: every doctor with >= 3 windows; Animesh has only multi_doctor windows (identity less certain, flagged)
        rec["windows_used"] = "clean" if len(clean) >= 3 else "ALL qualities (fewer than 3 clean; identity less certain)"
        if len(use) < 3: rec["status"] = "NOT MINTED: fewer than 3 windows"; continue
        room = collections.Counter(w["room"] for w in use).most_common(1)[0][0]; cw = [w for w in use if w["room"] == room]; rec["room"] = LAB.get(room, room); rec["n_days"] = len({w["day"] for w in cw})
        a = mc.analyze(pool_of(cw), mc.cluster_pool(pool_of(cw), 0.45)); top = a["top"][0] if a["top"] else None
        if not top: rec["status"] = "NOT MINTED: no cluster"; continue
        mint = nrm(top["centroid"]); rec["mint_meta_cluster"] = dict(n_windows=top["n_sessions"], n_days=top["n_days"], of_windows=len(cw))
        test = [w for w in cw if any(c["emb"] is not None and c["sec"] >= MIN15 for c in w["clusters"])]; rec["test_windows"] = len(test); rec["test_days"] = len({w["day"] for w in test})
        if len(test) < 3: rec["status"] = "NOT MINTED: fewer than 3 windows with an embedded cluster >= 15 s"; continue
        match = lambda c: c["emb"] is not None and float(np.dot(c["emb"], mint)) >= COS
        pres, largest, absorb = 0, 0, 0
        for w in test:
            mm = [c for c in w["clusters"] if match(c)]; msum = sum(c["sec"] for c in mm); nm = [c for c in w["clusters"] if not match(c)]
            if msum >= MIN15: pres += 1
            if msum > max([c["sec"] for c in nm], default=0): largest += 1
            if sum(1 for c in mm if c["sec"] >= MIN15) >= 2: absorb += 1
        n = len(test); g = {}
        g["P3_presence"] = round(pres / n, 3); g["P3_largest_share"] = round(largest / n, 3); g["P4b_absorption"] = round(absorb / n, 3)
        # P2: sex of the mint
        med, vs = median_f0([(w, {c["spk"] for c in w["clusters"] if match(c)}) for w in test])
        g["P2_f0_median_hz"] = None if med is None else round(med, 1); g["P2_voiced_s"] = round(vs, 1); g["P2_sex"] = sex_of(med, vs)
        dsex = sx.get(u, {}).get("sex"); dunc = sx.get(u, {}).get("uncertain", "Y") == "Y"
        # P4: second same-sex group >= 50%
        rv_pool = sepcache.setdefault((room, u), sep_room_pool(room, u)) + pool_of([w for w in W.values() if w["room"] == room and w["uid"] != u])
        rv = [x["centroid"] for x in groups_at(rv_pool) if x["n_sessions"] >= 3 and x["n_days"] >= 2]
        rest = [dict(clip_id=w["cid"], date=w["day"], room=room, speaker_raw=c["spk"], total_speech_sec=c["sec"], n_segments_scored=1, embedding=c["raw"], _c=c, _w=w) for w in test for c in w["clusters"] if c["emb"] is not None and c["sec"] >= MIN15 and not match(c)]
        second = []
        for gr in groups_at(rest):
            if float(np.dot(gr["centroid"], mint)) >= 0.45: continue
            if any(float(np.dot(gr["centroid"], r)) >= COS for r in rv): continue
            pr = len({m["clip_id"] for m in gr["members"]}) / n
            second.append(dict(presence=round(pr, 3), n_windows=len({m["clip_id"] for m in gr["members"]}), members=gr["members"]))
        second.sort(key=lambda s: -s["presence"]); g["P4_top_second_group_presence"] = second[0]["presence"] if second else 0.0; ambiguous = False; g["P4_second_group_sex"] = None
        if second and second[0]["presence"] >= 0.5:
            sm = second[0]; byw = collections.defaultdict(set)
            for m in sm["members"]: byw[m["clip_id"]].add(m["speaker_raw"])
            med2, vs2 = median_f0([(W[cid], s) for cid, s in byw.items()]); g["P4_second_group_f0_hz"] = None if med2 is None else round(med2, 1)
            opp = (dsex == "F" and med2 is not None and vs2 >= 2 and med2 < DEAD_LO) or (dsex == "M" and med2 is not None and vs2 >= 2 and med2 > DEAD_HI)
            g["P4_second_group_sex"] = "OPPOSITE" if opp else "SAME"; ambiguous = not opp
        # P5: room share
        oth = [w for w in W.values() if w["room"] == room and w["uid"] != u and w["quality"] == "clean" and any(c["emb"] is not None and c["sec"] >= MIN15 for c in w["clusters"])]
        g["P5_other_windows"] = len(oth)
        if oth: g["P5_mint_in_other_windows"] = round(sum(1 for w in oth if any(match(c) and c["sec"] >= MIN15 for c in w["clusters"])) / len(oth), 3)
        cosall = sorted(((round(float(np.dot(mint, x["v"])), 3), x["name"]) for x in PP), reverse=True)
        own = [c for c, nm in cosall if any(t and t in nm.lower() for t in [t for t in names.get(u, "").lower().replace(".", " ").split() if len(t) >= 5 and t != "nayar"][-2:])]
        rec["prod_print_cos"] = dict(caveat="production print model UNVERIFIED (192-d, same dimension as ECAPA); a low cos is not evidence against the mint", own_print=(own[0] if own else None), top3=cosall[:3])
        rec["gates"] = g; fails, nts = [], []
        if dunc or dsex is None: nts.append("sex table uncertain")
        elif g["P2_sex"] == "NOT TESTABLE": nts.append("P2 dead zone or < 2 s voiced")
        elif g["P2_sex"] != dsex: fails.append("P2 sex mismatch")
        if g["P3_presence"] < 0.8: fails.append("P3 presence < 80%")
        if g["P3_largest_share"] < 0.6: fails.append("P3 largest share < 60%")
        if ambiguous: nts.append("P4 AMBIGUOUS (same-sex second group >= 50%)")
        if g["P4b_absorption"] >= 0.2: nts.append("P4b AMBIGUOUS (absorption >= 20%)")
        if len(oth) >= 10 and g["P5_mint_in_other_windows"] >= 0.2: fails.append("P5 room share >= 20%")
        rec["gate_fails"], rec["gate_not_testable"] = fails, nts
        rec["p5_note"] = "gated (>= 10 other windows)" if len(oth) >= 10 else ("thin, reported only" if oth else "no other doctor's windows in the room, n/a")
        rec["thin_below_20_windows"] = n < 20
        # ADDENDUM 1 (V's ear decides): all gates are REPORTED; only a clear sex mismatch or an ambiguity blocks the mint. P3, P5 and the <20-window note are reported, not blocking.
        block = [f for f in fails if f.startswith("P2")] + [n_ for n_ in nts if n_.startswith("P4")]
        report_only = [f for f in fails if not f.startswith("P2")] + [n_ for n_ in nts if not n_.startswith("P4")]
        rec["blocking"], rec["reported_not_blocking"] = block, report_only
        if block and all(b.startswith("P4b") for b in block):
            rec["status"] = "NOT MINTED (absorption only): " + "; ".join(block) + " -- listening clips offered as a separate TIER-2 set, decision for consult-lead"; mints2[u] = mint
        elif block: rec["status"] = "NOT MINTED: " + "; ".join(block)
        else: rec["status"] = "MINTED" + (" (with reported flags: " + "; ".join(report_only) + ")" if report_only else ""); mints[u] = mint
        print(names.get(u), rec["status"], g, flush=True)
    out = f"{OUT}/mint_report.json"; fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh: json.dump(dict(embed_model="speechbrain/spkrec-ecapa-voxceleb", dim=192, doctors=report), fh, indent=1, default=str)
    np.savez(f"{OUT}/mints.npz", **{u: m for u, m in mints.items()}); os.chmod(f"{OUT}/mints.npz", 0o600)
    np.savez(f"{OUT}/mints_tier2.npz", **{u: m for u, m in mints2.items()}); os.chmod(f"{OUT}/mints_tier2.npz", 0o600)
    print("mint_report", out, f16(out))

if __name__ == "__main__": main()
