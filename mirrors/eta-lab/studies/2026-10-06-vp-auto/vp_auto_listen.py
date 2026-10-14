#!/usr/bin/env python3
"""VP-AUTO rev9 acceptance test: the listening set for V's ear = every AUTO and EAR doctor of a routes file.
Per doctor: 5 mint clips of 8-12 s (highest ECAPA purity to the doctor's print, <= 1 per window first, >= 2 days where possible, <= 3 per day) + 2 decoys
(another doctor's print from the SAME room: clips of that doctor's windows scored against his print; else a non-mint recurring voice of the doctor's own windows, flagged WEAK in the key).
Rev9 amendment A1 (consult-lead, listening only, gates unchanged): decoys are the SAME sex as the doctor (by name; a dead-zone F0 doctor uses the name). Preference: (1) another same-sex
doctor's mint from the same room; (2) a same-sex non-mint recurring voice of the doctor's own windows (sex by the P2 F0 rule, a dead-zone or unmeasurable voice does NOT qualify);
(3) a same-sex doctor's mint from another room; only if none exists an opposite-sex decoy, recorded as decoy_sex_mismatch in the KEY (never in the manifest).
Amendment A3 (consult-lead, 06 Oct 22:30, listening only, gates unchanged): the own-windows non-mint decoy tier is REMOVED (a doctor's own-window voices are unreliable decoys: the diarizer splits one doctor
into several clusters). Decoys come ONLY from OTHER doctors' mint / provisional / production prints, same sex by name (A1): first the same room, then any room. A2 code (a2_ok) stays but is now
UNREACHABLE (no own-windows non-mint candidate is ever built). Any clip V has already answered (V-ANSWERS-*.csv, mapped to the KEY files of the sets they answered) is excluded from every new set,
mint clips included: a new candidate may not overlap in time an answered clip of the same window. manifest.json carries no duration_s.
Amendment A2 (consult-lead, listening only; superseded by A3, kept for the record): an own-windows non-mint decoy is allowed only if its cos to the doctor's mint is < 0.45; otherwise that tier/group is skipped. Implemented on every measure:
the group centroid, EACH member cluster, and the 8-12 s clip's own ECAPA embedding must all be < 0.45 (a2_ok).
F1 (Refuter): clips are cut and written in k order 1..7 and every clip mtime/atime is set to one common value, so file times reveal nothing.
Same clip format and hidden key as vp-fast-01: mono 16 kHz WAV, two-pass loudnorm -18 LUFS, <slug>_<k>.wav with k = 1..7 SHUFFLED per doctor, manifest.json without any mint/decoy flag,
KEY-DO-NOT-SHIP.json (0600) kept on the box, directory 0700. CONFIRMED (vp_fast_score.py) = yes to >= 4 of 5 mint clips and no to both decoys.
Run with the eta-diarize venv (speechbrain ECAPA, CPU):  ~/services/eta-diarize/venv/bin/python3 vp_auto_listen.py --routes ~/eta-data/vp-auto/routes_<set>.json --out <dir>
NOT to be run on the test set before consult-lead's GO. --smoke runs one doctor into a scratch dir for code testing."""
import argparse, collections, glob, hashlib, json, os, random, subprocess, sys
import numpy as np
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "2026-10-06-vp-fast"))
import vp_fast_mint as vm
import vp_fast_listen as vl
import vp_auto as va
sys.path.insert(0, f"{vm.E}/manoj-package-work")
import manoj_diarize as md
E = vm.E

def window_audio(w): return f"{w['dir']}/audio/{w['cid']}.m4a"

EXCLUDED = {}                                    # A3: {window cid: [(start, end), ...]} of clips V has already answered
def load_answered(pairs):
    """pairs: ['V-ANSWERS-x.csv=keydir1,keydir2', ...]. Every clip named in an answers file is looked up in the KEY of the set(s) it answered -> (window, start, end)."""
    import csv
    EXCLUDED.clear(); n = 0
    for spec in pairs or []:
        csvp, dirs = spec.split("=", 1); ans = [r["clip"] for r in csv.DictReader(open(csvp))]
        keys = [json.load(open(os.path.join(d, "KEY-DO-NOT-SHIP.json")))["key"] for d in dirs.split(",")]
        for clip in ans:
            slug, k = clip.rsplit("_", 1)
            for key in keys:
                v = key.get(slug, {}).get(k)
                if v: EXCLUDED.setdefault(v["window"], []).append((v["start"], v["end"])); n += 1; break
    return n
def overlaps_answered(cid, s, e): return any(not (e <= a or s >= b) for a, b in EXCLUDED.get(cid, []))
def manifest_entry(name, sl, k): return dict(doctor_name=name, slug=sl, k=k, file=f"clips/{sl}_{k}.wav")        # A3: no duration_s

def candidates(windows_spks, centroid, step=2.0):
    out = []
    for w, spks in windows_spks:
        wav = None
        for a, b in vl.runs(w, spks):
            if wav is None: wav, sr = md.load_audio(window_audio(w))
            L = min(vl.CLIP_MAX, b - a); s = a; best = None
            while s + vl.CLIP_MIN <= b + 1e-6:
                e = min(s + L, b)
                if e - s >= vl.CLIP_MIN and not overlaps_answered(w["cid"], s, e):
                    emb = md.embedding_for_window(wav, sr, s, e)
                    if emb is not None:
                        c = float(np.dot(vm.nrm(emb), centroid))
                        if best is None or c > best["purity"]: best = dict(window=w, start=round(s, 2), end=round(e, 2), purity=round(c, 4), emb=vm.nrm(emb))
                s += step
            if best: out.append(best)
    return out

def cut_clip(w, s, e, out):
    src = ["-ss", f"{s:.2f}", "-t", f"{e - s:.2f}", "-i", window_audio(w)]
    p1 = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", *src, "-af", "loudnorm=I=-18:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"], capture_output=True, text=True)
    m = json.loads(p1.stderr[p1.stderr.rindex("{"):p1.stderr.rindex("}") + 1])
    af = f"loudnorm=I=-18:TP=-1.5:LRA=11:measured_I={m['input_i']}:measured_TP={m['input_tp']}:measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *src, "-af", af, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", out], check=True, capture_output=True)

NEMO_PY = os.path.expanduser("~/eta-data/nemotron/venv-nemo-main/bin/python3")
def median_f0_sub(items, cap_s=300.0):
    """Same selection as vp_fast_mint.median_f0 (round-robin over windows, longest non-overlapped piece first, up to cap_s), pyin run in the nemo venv (this venv has no librosa)."""
    per = [(w, vm.pieces(w, s)) for w, s in items]; per = [(w, p) for w, p in per if p]
    chosen, tot, i = [], 0.0, 0
    while tot < cap_s and any(i < len(p) for _, p in per):
        for w, p in per:
            if i < len(p) and tot < cap_s: chosen.append((window_audio(w), p[i][0], p[i][1])); tot += p[i][1] - p[i][0]
        i += 1
    if not chosen: return None, 0.0
    r = json.loads(subprocess.run([NEMO_PY, os.path.join(os.path.dirname(os.path.abspath(__file__)), "f0_child.py")], input=json.dumps(chosen), capture_output=True, text=True, check=True).stdout)
    return r["median"], r["voiced_s"]

A2_THR = 0.45
def a2_ok(group_cos, member_cos, clip_cos=None, thr=A2_THR):
    """A2: every cos to the doctor's mint must be strictly below 0.45 (group centroid, each member cluster, and - when known - the clip embedding)."""
    vals = [group_cos] + list(member_cos) + ([] if clip_cos is None else [clip_cos])
    return all(v < thr for v in vals)

def sex_table():
    import csv
    return {r["doctor_uid"]: (r["sex"], r["uncertain"] == "Y") for r in csv.DictReader(open(f"{E}/centroid-mint/roomsub/SEXTABLE_rev7.FROZEN.csv"))}

def write_clips(root, plan, cut_fn, mtime=None):
    """F1: plan = [(k, fn, c)]; the clips are cut in k order 1..N and then every clip gets the SAME mtime/atime. cut_fn(c, path) writes one clip."""
    mtime = mtime if mtime is not None else 1790000000.0
    for k, fn, c in sorted(plan, key=lambda t: t[0]): cut_fn(c, f"{root}/clips/{fn}")
    for k, fn, c in sorted(plan, key=lambda t: t[0]):                  # k order again: the ctime (set by utime itself) must not follow mint-then-decoy order either
        os.chmod(f"{root}/clips/{fn}", 0o600); os.utime(f"{root}/clips/{fn}", (mtime, mtime))

def pick_decoys(doc_uid, doc_sex, doc_sex_known, rooms, sources, nonmint, sexes):
    """A1 preference order. sources: {uid: (room_set_of_windows, clips_fn)} of other doctors' mints (clips_fn() -> up to 2 candidate clips); nonmint: [(sex_class, clips_fn, label)];
    sexes: {uid: (sex, uncertain)}. -> [(label, clip, sex_mismatch: bool)] (<= 2). Pure selection logic, unit-tested."""
    out = []
    same = lambda u: sexes.get(u, (None, True))[0] == doc_sex and not sexes.get(u, (None, True))[1] and doc_sex_known
    def take(label, fn, mismatch):
        for c in fn():
            if len(out) < 2: out.append((label, c, mismatch))
    for u2, (rms, fn) in sources.items():                                     # (1) same sex, same room
        if u2 != doc_uid and same(u2) and rms & set(rooms) and len(out) < 2: take(f"other_doctor_print:{u2}", fn, False)
    if len(out) < 2 and doc_sex_known:                                        # (2) same-sex non-mint recurring voice of the doctor's own windows
        for cls, fn, label in nonmint:
            if cls == doc_sex and len(out) < 2: take(label, fn, False)
    for u2, (rms, fn) in sources.items():                                     # (3) same sex, another room
        if u2 != doc_uid and same(u2) and not (rms & set(rooms)) and len(out) < 2: take(f"other_doctor_print:{u2}", fn, False)
    for u2, (rms, fn) in sources.items():                                     # (4) opposite / unknown sex: recorded as a mismatch
        if u2 != doc_uid and len(out) < 2 and not any(l == f"other_doctor_print:{u2}" for l, _, _ in out): take(f"other_doctor_print:{u2}", fn, True)
    return out

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--routes", required=True); ap.add_argument("--out", required=True); ap.add_argument("--smoke", action="store_true"); ap.add_argument("--answered", action="append", default=[], help="V-ANSWERS.csv=keydir[,keydir] (repeatable)"); a = ap.parse_args()
    print("answered clips excluded:", load_answered(a.answered), flush=True)
    R = json.load(open(a.routes)); docs = {u: d for u, d in R["doctors"].items() if d["route"] in ("AUTO", "EAR")}
    if a.smoke: docs = dict(list(docs.items())[:1])
    vm.audio16 = va.audio_from_dirs(); sexes = sex_table()
    W = {**va.load_windows(f"{E}/vp-fast"), **va.load_windows(f"{E}/vp-auto")}
    prints = {u: vm.nrm(np.array(d["print"], dtype=np.float32)) for u, d in R["doctors"].items() if d.get("print") and d["route"] in ("AUTO", "EAR")}      # run mints = AUTO/EAR only
    prov = {p["doctor_uid"]: (p["display_name"], vm.nrm(np.array(p["centroid_192_l2"], dtype=np.float32))) for p in json.load(open(f"{E}/consult/prints-provisional-06oct.json"))["prints"]}
    names = {u: d["name"] for u, d in R["doctors"].items()}
    allp = {**{u: (names[u], p) for u, p in prints.items()}, **{u: v for u, v in prov.items() if u not in prints}}
    PRODUID = {"Ankit": "F092iDIAfwXKtLCqP8HS", "Poornima": "0q9pSZHR24ysquO6V4Xg", "Dibyendu": "bKr81BFLZSuiMa7MvhaA", "Animesh": "mGXTEDg9o9WNR9gpZ4sY", "Salanki": "MFTZnXMshE91P7fHnqgX"}
    for x in json.load(open(f"{E}/consult/prod-prints.json")):                                      # production prints of doctors that have windows but no mint/provisional print (lowest priority)
        pu = next((u for k_, u in PRODUID.items() if k_.lower() in x["name"].lower()), None)
        if pu and pu not in allp: allp[pu] = (x["name"], vm.nrm(vm.b64(x["centroid_b64_float32_le"].replace("\\n", ""))))
    root = a.out; os.makedirs(f"{root}/clips", mode=0o700, exist_ok=True); os.chmod(root, 0o700)
    rnd = random.Random(int.from_bytes(os.urandom(8), "big")); manifest, key, notes = [], {}, {}
    spk = lambda w, p: {c["spk"] for c in w["clusters"] if c["emb"] is not None and float(np.dot(c["emb"], p)) >= va.COS}
    for u, d in docs.items():
        pr = prints[u]; ws = [w for w in W.values() if w["uid"] == u]
        rooms = [r for r, _ in collections.Counter(w["room"] for w in ws).most_common()]
        dsex, dunc = sexes.get(u, (None, True)); dknown = dsex in ("F", "M") and not dunc
        mc_ = vl.pick(candidates([(w, spk(w, pr)) for w in ws], pr), 5); notes[u] = dict(route=d["route"], mint_clips=len(mc_), days=len({c["window"]["day"] for c in mc_}), doctor_sex=dsex, sex_uncertain=dunc)
        sources = {}
        for u2, (n2, p2) in allp.items():
            if u2 == u or float(np.dot(p2, pr)) >= 0.45: continue
            w2 = [w for w in W.values() if w["uid"] == u2]
            if not w2: continue
            sources[u2] = ({w["room"] for w in w2}, (lambda w2=w2, p2=p2: vl.pick(candidates([(w, spk(w, p2)) for w in w2], p2), 2)))
        nonmint = []                                                         # A3: the own-windows non-mint tier is removed; tier 2 of pick_decoys is unreachable
        dec = pick_decoys(u, dsex, dknown, rooms, sources, nonmint, sexes)
        notes[u]["decoys"] = [(x, m) for x, _, m in dec]
        sl = vl.slug(names[u]); clips = [("mint", c, None, False) for c in mc_] + [("decoy", c, src, mm) for src, c, mm in dec]
        order = list(range(1, len(clips) + 1)); rnd.shuffle(order)
        plan = [(k, f"{sl}_{k}.wav", c) for (kind, c, src, mm), k in zip(clips, order)]
        write_clips(root, plan, lambda c, path: cut_clip(c["window"], c["start"], c["end"], path))
        for (kind, c, src, mm), k in zip(clips, order):
            fn = f"{sl}_{k}.wav"
            manifest.append(manifest_entry(names[u], sl, k))
            kd = dict(kind=kind, decoy_source=src, window=c["window"]["cid"], day=c["window"]["day"], start=c["start"], end=c["end"], purity=c["purity"])
            if kind == "decoy": kd["decoy_sex_mismatch"] = bool(mm)
            key.setdefault(sl, {})[str(k)] = kd
    manifest.sort(key=lambda m: (m["slug"], m["k"]))
    for fn, obj in (("manifest.json", manifest), ("KEY-DO-NOT-SHIP.json", dict(rule="CONFIRMED = yes to >= 4 of the 5 mint clips AND no to both decoys; else REJECTED", prereg_sha256=va.PREREG_SHA, amendment="A1 same-sex decoys", key=key, notes=notes))):
        fd = os.open(f"{root}/{fn}", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as fh: json.dump(obj, fh, indent=1)
    print("listening set", root, "clips", len(manifest), "notes", notes, "manifest sha16", hashlib.sha256(open(f"{root}/manifest.json", "rb").read()).hexdigest()[:16], flush=True)

if __name__ == "__main__": main()
