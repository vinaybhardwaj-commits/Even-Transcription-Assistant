"""Per-consult store: consult.flac (whole span), doctor.flac + others.flac (when identified), timeline.json, one index.jsonl row, private R2 mirror. Mono 16 kHz, -18 LUFS."""
import json, os, shutil, subprocess, tempfile, time
from . import config as C

def ensure_dir(path):
    """create path (and parents) 0700 and chmod 0700 the clips root and every dir between it and path, including the root itself (R6)."""
    os.makedirs(path, mode=0o700, exist_ok=True)
    cur = path
    while cur.startswith(C.CLIPS) and len(cur) >= len(C.CLIPS):
        os.chmod(cur, 0o700)
        if cur == C.CLIPS: break
        cur = os.path.dirname(cur)

def normalize(src_args, out):
    """two-pass loudnorm to -18 LUFS (linear) -> mono 16 kHz FLAC."""
    p1 = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", *src_args, "-af", "loudnorm=I=-18:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"], capture_output=True, text=True)
    m = json.loads(p1.stderr[p1.stderr.rindex("{"):p1.stderr.rindex("}") + 1])
    try: finite = float(m["input_i"]) > -200
    except ValueError: finite = False
    if not finite:                                                                    # digital silence (-inf LUFS): loudnorm's second pass would fail; keep the audio as it is
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *src_args, "-ac", "1", "-ar", "16000", "-c:a", "flac", out], check=True, capture_output=True); return False
    af = f"loudnorm=I=-18:TP=-1.5:LRA=11:measured_I={m['input_i']}:measured_TP={m['input_tp']}:measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *src_args, "-af", af, "-ac", "1", "-ar", "16000", "-c:a", "flac", out], check=True, capture_output=True); return True

def concat_pieces(pieces, wav16, out, workdir):
    tmp = tempfile.mkdtemp(prefix="cc_", dir=workdir); lst = []
    try:
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", f"{C.GAP_S}", f"{tmp}/gap.wav"], check=True, capture_output=True)
        for i, (a, b) in enumerate(pieces):
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{a:.3f}", "-t", f"{b - a:.3f}", "-i", wav16, "-ac", "1", "-ar", "16000", f"{tmp}/p{i:04d}.wav"], check=True, capture_output=True)
            lst += [f"{tmp}/p{i:04d}.wav"] + ([f"{tmp}/gap.wav"] if i < len(pieces) - 1 else [])
        open(f"{tmp}/c.txt", "w").write("".join(f"file '{p}'\n" for p in lst))
        return normalize(["-f", "concat", "-safe", "0", "-i", f"{tmp}/c.txt"], out)
    finally:
        for f in os.listdir(tmp): os.remove(f"{tmp}/{f}")
        os.rmdir(tmp)

def write_consult(final_dir, work_audio, end_rel, doctor_pieces, other_pieces, identified, timeline, workdir):
    """build in a temp dir next to final_dir, then swap in (a re-cut replaces the previous version). -> dict of file sizes."""
    ensure_dir(os.path.dirname(final_dir)); tmp = final_dir + ".tmp"
    restore_old(final_dir)
    if os.path.exists(tmp): shutil.rmtree(tmp)
    os.makedirs(tmp, mode=0o700)
    try: return _write_into(tmp, final_dir, work_audio, end_rel, doctor_pieces, other_pieces, identified, timeline, workdir)
    except BaseException:                                                              # m3-05(e): a failed build never leaves its .tmp dir behind
        shutil.rmtree(tmp, ignore_errors=True); raise

def _write_into(tmp, final_dir, work_audio, end_rel, doctor_pieces, other_pieces, identified, timeline, workdir):
    unnorm = []                                                                        # m3-06 (M4): outputs that measured -inf LUFS are kept as they are; say so in timeline.json
    if not normalize(["-t", f"{end_rel:.3f}", "-i", work_audio], f"{tmp}/consult.flac"): unnorm.append("consult.flac")
    if identified:
        wav16 = f"{workdir}/{timeline['consult_uid']}_16k.wav"
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", work_audio, "-ac", "1", "-ar", "16000", wav16], check=True, capture_output=True)
        try:
            if doctor_pieces and not concat_pieces(doctor_pieces, wav16, f"{tmp}/doctor.flac", workdir): unnorm.append("doctor.flac")
            if other_pieces and not concat_pieces(other_pieces, wav16, f"{tmp}/others.flac", workdir): unnorm.append("others.flac")
        finally:
            os.remove(wav16)
    timeline["unnormalized"] = unnorm
    from . import gating as G
    G.tag_timeline(timeline, f"{tmp}/consult.flac", work_audio, end_rel)                                    # m3-08: consult_zero_ratio / voice_isolated / gating_source for every clip
    fd = os.open(f"{tmp}/timeline.json", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh: json.dump(timeline, fh, indent=1)
    for f in os.listdir(tmp): os.chmod(f"{tmp}/{f}", 0o600)
    sizes = {f: os.path.getsize(f"{tmp}/{f}") for f in sorted(os.listdir(tmp))}
    old = final_dir + ".old"
    if os.path.exists(final_dir): os.rename(final_dir, old)
    os.rename(tmp, final_dir); os.chmod(final_dir, 0o700)
    if os.path.exists(old): shutil.rmtree(old)
    return sizes

def restore_old(final_dir):
    """m3-06 (M2): a kill between rename(final -> .old) and rename(.tmp -> final) leaves .old with no final: put the previous version back. -> True when restored."""
    old = final_dir + ".old"
    if os.path.isdir(old) and not os.path.exists(final_dir): os.rename(old, final_dir); return True
    return False

def read_index(path=None):
    """latest row per consult_uid (the index is append-only)."""
    p = path or C.INDEX; latest = {}
    if os.path.exists(p):
        for l in open(p):
            if l.strip():
                try: r = json.loads(l); latest[r["consult_uid"]] = r
                except Exception: pass
    return latest

def append_index(row, path=None):
    p = path or C.INDEX; ensure_dir(os.path.dirname(p))
    with open(p, "a") as f: f.write(json.dumps(row) + "\n")
    os.chmod(p, 0o600)

def _r2_client(cred_file=None, bucket=None):
    cf = cred_file or C.R2_WRITE_FILE
    if not os.path.exists(cf): return None, bucket or C.R2_BUCKET
    import boto3
    from botocore.config import Config
    L = [l.strip() for l in open(cf) if l.strip()]
    cfg = Config(connect_timeout=C.R2_CONNECT_TIMEOUT_S, read_timeout=C.R2_READ_TIMEOUT_S, retries={"total_max_attempts": C.R2_TOTAL_ATTEMPTS})          # m3-16c L5: explicit timeouts (a blackholed endpoint no longer costs ~47 s per row)
    return boto3.client("s3", aws_access_key_id=L[0], aws_secret_access_key=L[1], endpoint_url=L[2], region_name="auto", config=cfg), (L[3] if len(L) > 3 else (bucket or C.R2_BUCKET))

def mirror(final_dir, rel_path, client=None, cred_file=None, bucket=None, prefix=None):
    """upload every file of final_dir to <bucket>/<prefix>/<rel_path>/<file> (private). With no write credential: status pending_no_credential (not an error). client = boto3-like, injectable.
    m3-15: an upload failure does NOT raise: status "error" (with the exception type), so the row keeps the files' truth and mirror_pending retries it."""
    bucket, prefix = bucket or C.R2_BUCKET, prefix or C.R2_PREFIX
    try:
        if client is None:
            client, bucket = _r2_client(cred_file, bucket)
            if client is None: return dict(status="pending_no_credential", bucket=bucket, prefix=f"{prefix}/{rel_path}")
        n = 0
        for f in sorted(os.listdir(final_dir)):
            client.put_object(Bucket=bucket, Key=f"{prefix}/{rel_path}/{f}", Body=open(f"{final_dir}/{f}", "rb").read()); n += 1
        return dict(status="mirrored", bucket=bucket, prefix=f"{prefix}/{rel_path}", files=n, at=time.strftime("%Y-%m-%dT%H:%M:%S%z"))
    except Exception as e:
        return dict(status="error", error=f"{type(e).__name__}: {str(e)[:120]}", bucket=bucket, prefix=f"{prefix}/{rel_path}", at=time.strftime("%Y-%m-%dT%H:%M:%S%z"))

def delete_remote(rel_path, names, client=None, cred_file=None, bucket=None, prefix=None):
    """m3-15 (m3-14 F5): delete the R2 keys of files a re-cut no longer has (doctor.flac / others.flac). -> list of deleted names (empty without a credential); an error is returned in the list as 'error: ...' and logged, never raised."""
    bucket, prefix = bucket or C.R2_BUCKET, prefix or C.R2_PREFIX; out = []
    try:
        if client is None:
            client, bucket = _r2_client(cred_file, bucket)
            if client is None: return []
        for f in names:
            client.delete_object(Bucket=bucket, Key=f"{prefix}/{rel_path}/{f}"); out.append(f)
    except Exception as e: out.append(f"error: {type(e).__name__}: {str(e)[:100]}")
    return out

def read_state(path=None):
    p = path or C.RECHECK_STATE
    try: return json.load(open(p))
    except Exception: return {}

def write_state(state, path=None):
    p = path or C.RECHECK_STATE; ensure_dir(os.path.dirname(p)); tmp = p + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh: json.dump(state, fh)
    os.replace(tmp, p)

def sweep_tmp(root, now, older_than=3600.0, max_depth=4):
    """m3-05(e): remove directories named *.tmp under the clips root that were last modified more than an hour ago (leftovers of a killed run). -> number removed. Files are never touched."""
    n = 0
    if not os.path.isdir(root): return 0
    for dirpath, dirnames, _ in os.walk(root):
        if dirpath[len(root):].count(os.sep) >= max_depth: dirnames[:] = []; continue
        for d in list(dirnames):
            full = os.path.join(dirpath, d)
            if d.endswith(".old"):                                                                                  # m3-06 (M2)
                if restore_old(full[:-4]): dirnames.remove(d)
                elif now - os.stat(full).st_mtime > older_than: shutil.rmtree(full, ignore_errors=True); dirnames.remove(d); n += 1     # N3: an .old next to its final is a leftover
                continue
            if d.endswith(".tmp") and now - os.stat(full).st_mtime > older_than: shutil.rmtree(full, ignore_errors=True); dirnames.remove(d); n += 1
    return n
