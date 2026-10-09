"""Speakers: label the diarizer output against the doctor print (or S1..Sn without one), turns with cos, overlap-free pieces for doctor / others. Pure numpy; the diarizer is a callable."""
import base64, collections, json, os, re, subprocess
import numpy as np
from . import config as C

def unb64(s): return None if s is None else np.frombuffer(base64.b64decode(s), dtype=np.float32)
def nrm(v): return v / np.linalg.norm(v)

class PrintsError(Exception): pass
PRINT_DIM = 192

def load_prints(path=None, strict=False):
    """{doctor_uid: unit vector}. strict=True (the run's own loading, vp-auto-05b F2) FAILS LOUD with PrintsError and never falls back: a missing file or dangling pointer, unreadable JSON, an empty prints list, a vector that is not 192-d / finite / non-zero, or (for the live file) a provisional doctor that is missing.
    strict=False keeps the old lenient reading (a missing file = {}) for tools and tests."""
    p = path or C.PRINTS
    if not strict:
        if not os.path.exists(p): return {}
        return {x["doctor_uid"]: nrm(np.array(x["centroid_192_l2"], dtype=np.float32)) for x in json.load(open(p))["prints"]}
    if os.path.islink(p) and not os.path.exists(p): raise PrintsError(f"prints pointer {p} is dangling (target {os.readlink(p)} missing)")
    if not os.path.exists(p): raise PrintsError(f"prints file {p} does not exist")
    try: doc = json.load(open(p))
    except Exception as e: raise PrintsError(f"prints file {p} unreadable: {type(e).__name__}")
    rows = doc.get("prints") if isinstance(doc, dict) else None
    if not isinstance(rows, list) or not rows: raise PrintsError(f"prints file {p} has no prints")
    out = {}; uids = [x.get("doctor_uid") for x in rows if isinstance(x, dict)]
    canon = lambda u: re.sub("[\u200b-\u200f\u2060\ufeff\u00ad]", "", u.strip()).casefold()
    seen = collections.Counter(canon(u) for u in uids if isinstance(u, str)); dup = sorted(k for k, n in seen.items() if n > 1)
    if dup: raise PrintsError(f"prints file {p} lists a doctor_uid twice (equal after strip / casefold / removing zero-width characters): {dup[:3]}")        # 05c N4 + L3: last-wins would be silent
    for x in rows:
        uid = x.get("doctor_uid") if isinstance(x, dict) else None
        if not isinstance(uid, str) or not uid.strip(): raise PrintsError(f"prints file {p}: a print without a doctor_uid")
        try: v = np.array(x["centroid_192_l2"], dtype=np.float64)
        except Exception: raise PrintsError(f"print {uid}: centroid unreadable")
        if v.shape != (PRINT_DIM,) or not np.all(np.isfinite(v)): raise PrintsError(f"print {uid}: centroid is not a finite {PRINT_DIM}-d vector")
        n = float(np.linalg.norm(v))
        if n < 1e-6: raise PrintsError(f"print {uid}: zero vector")
        out[uid] = (v / n).astype(np.float32)
    if os.path.realpath(p) != os.path.realpath(C.PROVISIONAL_PRINTS) and os.path.exists(C.PROVISIONAL_PRINTS):
        try: prov = {x["doctor_uid"] for x in json.load(open(C.PROVISIONAL_PRINTS))["prints"]}
        except Exception as e: raise PrintsError(f"provisional prints unreadable: {type(e).__name__}")
        missing = sorted(prov - set(out))
        if missing: raise PrintsError(f"live prints lack {len(missing)} provisional doctor(s): {missing[:3]}")
    return out

CONFIG_ERROR = 78                                                               # worker exit code (EX_CONFIG): the diarize package env vars are unset; an error + ALERT, never 'deferred'
DEFERRED = 75                                                                   # worker exit code: the clock passed the latest start after the lock was acquired

def run_job(job, gate, runner=None, lock=None, worker_cmd=None, wait_scale=1.0):
    """ONE diarization job in its own worker process under the GPU lock, released afterwards (E1 can take it between jobs). gate = cutter.gpu.gate(...) result (ok).
    flock waits at most gate['wait_s'] (never past the latest start); the worker re-checks --not-after after the lock is acquired. -> 0 ok | 'deferred' | other rc.
    runner(cmd, stdin_text) -> rc injectable (tests); worker_cmd / wait_scale let tests run a real flock against a fake worker."""
    cmd = ["flock", "-w", f"{gate['wait_s'] * wait_scale:.2f}", lock or C.GPU_LOCK, "timeout", f"{int(gate['timeout_s'])}"] + (worker_cmd or
           [C.DIAR_PY, os.path.join(os.path.dirname(os.path.abspath(__file__)), "diar_worker.py")]
           + ([] if gate.get("not_after") is None else ["--not-after", f"{gate['not_after']:.0f}"]) + ([] if gate.get("hard_stop") is None else ["--hard-stop", f"{gate['hard_stop']:.0f}"]))       # no deadlines when the night gate is off
    stdin = json.dumps({"jobs": [job]})
    if runner: rc = runner(cmd, stdin) or 0
    else:
        env = dict(os.environ, DIAR_DEVICE="cuda", PYANNOTE_CACHE=f"{C.H}/.cache/torch/pyannote", HF_HUB_OFFLINE="1")
        rc = subprocess.run(["nice", "-n", "5"] + cmd, input=stdin, capture_output=True, text=True, env=env).returncode
    if rc in (1, DEFERRED): return "deferred"                                  # flock could not get the lock in time (rc 1) or the start deadline passed (75)
    if rc == 124: return "gpu_timeout"
    return rc

def label(result, print_vec):
    """result = one worker output. -> dict(labels {spk: name}, clusters {spk: {sec, cos}}, doctor_clusters set). With a print: clusters with cos >= 0.55 are 'doctor'; the rest S1..Sn by speech seconds. Without: S1..Sn only."""
    cl = {}
    for spk, c in result["clusters"].items():
        emb = unb64(c["emb_b64"]); cl[spk] = dict(sec=c["sec"], embedded=emb is not None, emb_b64=c["emb_b64"], cos=None if (emb is None or print_vec is None) else round(float(np.dot(nrm(emb), print_vec)), 3))
    doc = {s for s, c in cl.items() if print_vec is not None and c["cos"] is not None and c["cos"] >= C.COS}
    rest = sorted((s for s in cl if s not in doc), key=lambda s: -cl[s]["sec"])
    labels = {s: "doctor" for s in doc}; labels.update({s: f"S{i + 1}" for i, s in enumerate(rest)})
    return dict(labels=labels, clusters=cl, doctor_clusters=doc)

def unembedded_s(lab):
    """m3-06b: seconds of speech in speaker groups that have no embedding (they go to consult.flac only)."""
    return round(sum(c["sec"] for c in lab["clusters"].values() if not c.get("embedded", c["cos"] is not None)), 2)

def split_failed(lab, identified):
    """m3-06b: -> reason string when the doctor is known but NO speaker group matched his print (at any size): the cutter cannot tell his speech from the others', so it writes no doctor.flac / others.flac. Else None."""
    if not identified or lab["doctor_clusters"]: return None
    cos = [c["cos"] for c in lab["clusters"].values() if c["cos"] is not None]
    return "no speaker group matched the doctor print" + (f" (best cos {max(cos):.2f})" if cos else " (no group has an embedding)")

def doctor_like(lab):
    """m3-07: embedded groups that are NOT labelled doctor but score >= 0.35 to his print (a diarizer split can leave part of his voice in a second group): FLAGGED only (doctor_like_s), they stay in others.flac. -> set of cluster ids."""
    return {s for s, c in lab["clusters"].items() if s not in lab["doctor_clusters"] and c["cos"] is not None and c["cos"] >= C.DOCTOR_LIKE_COS}

def doctor_like_s(lab):
    return round(sum(lab["clusters"][s]["sec"] for s in doctor_like(lab)), 2)

def borderline(lab, lo=0.45):
    """m3-06b (N2): groups not labelled doctor whose cos to his print is in [0.45, 0.55): consumers may want to drop their others.flac. -> list of cluster ids."""
    return sorted(s for s, c in lab["clusters"].items() if s not in lab["doctor_clusters"] and c["cos"] is not None and lo <= c["cos"] < C.COS)

def last_doctor_turn_end(result, doctor_clusters):
    ends = [s["end"] for s in result["segments"] if s["speaker"] in doctor_clusters]
    return max(ends) if ends else None

def turns(result, lab, print_vec, end_rel, start_abs, iso):
    """per-turn records up to end_rel (clip-relative seconds): speaker, cos to the print (None when under 0.5 s or no print)."""
    out = []
    for s, te in sorted(zip(result["segments"], result["turn_embs"]), key=lambda t: t[0]["start"]):
        if s["start"] >= end_rel: continue
        e = min(s["end"], end_rel); emb = unb64(te)
        out.append(dict(start_s=round(s["start"], 3), end_s=round(e, 3), start_ist=iso(start_abs + s["start"]), end_ist=iso(start_abs + e), speaker=lab["labels"][s["speaker"]], cluster=s["speaker"],
                        cos=None if (emb is None or print_vec is None) else round(float(np.dot(nrm(emb), print_vec)), 3), short_lt_0p5s=emb is None))
    return out

def subtract(turns_a, turns_b, min_len=0.3):
    """pieces of turns_a not overlapped by any turn of turns_b (overlap goes in consult only), pieces >= 0.3 s."""
    out = []
    for a, b in turns_a:
        cur = [(a, b)]
        for oa, ob in turns_b:
            nxt = []
            for x, y in cur:
                if ob <= x or oa >= y: nxt.append((x, y)); continue
                if oa > x: nxt.append((x, oa))
                if ob < y: nxt.append((ob, y))
            cur = nxt
        out += [(x, y) for x, y in cur if y - x >= min_len]
    return sorted(out)

def split_pieces(result, lab, end_rel, identified):
    """-> (doctor_pieces, other_pieces) overlap-free, clipped at end_rel. A speaker group with no embedding (m3-06b) is in NEITHER file (consult.flac only); it still counts as overlap for the doctor's pieces.
    m3-07 (consult-lead 04:38): a doctor-like group (cos >= 0.35 to his print) is only FLAGGED (doctor_like_s), it stays in others.flac: removing it would drop about half of the patient/relative audio."""
    if not identified: return [], []
    emb = lambda sp: lab["clusters"][sp].get("embedded", lab["clusters"][sp]["cos"] is not None)
    seg = lambda s: (s["start"], min(s["end"], end_rel))
    live = [s for s in result["segments"] if s["start"] < end_rel]
    d = [seg(s) for s in live if s["speaker"] in lab["doctor_clusters"]]
    o = [seg(s) for s in live if s["speaker"] not in lab["doctor_clusters"] and emb(s["speaker"])]
    u = [seg(s) for s in live if s["speaker"] not in lab["doctor_clusters"] and not emb(s["speaker"])]
    return subtract(d, o + u), subtract(o, d + u)
