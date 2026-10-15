#!/usr/bin/env python3
"""indic_server.py (v2) — IndicConformer-600M STT service on :8082.

v2 changes (Workstream A — fix long-audio crash + fail gracefully):
  - Internal chunking: audio is normalized to 16 kHz mono WAV, and anything
    longer than MAXWIN (~35 s) is sliced into WIN (30 s) + OVERLAP (0.5 s)
    windows. Each window is run through ONNX independently and the texts are
    concatenated. This avoids the ONNXRuntime "Non-zero status code running Add
    node" crash that happens on long sequences.
  - Each per-window ONNX call is wrapped in try/except — a failing window is
    skipped (empty), never crashes the request.
  - The endpoint NEVER returns a raw HTTP 500. On any inference error it returns
    200 with {"ok":false,"error":"...","text":"","segments":[]}.
  - Returns segments + timings: {"ok":true,"text":"…","language":"kn",
    "decoding":"rnnt","segments":[{"start_s":0,"end_s":30,"text":"…"}],"sec":…}.
  - Backward compatible: old keys (text/language/decoding/sec) are preserved, so
    the whisper shim / app that read `.text` keep working. Empty text with
    ok:true means "model produced nothing for this language" (a signal, not an
    error — IndicConformer is monolingual per call).

API: POST /inference (multipart: file, language IN-22, decoding ctc|rnnt) ; GET /healthz.
Inference is serialized with a lock (one ONNX call at a time = the §4 concurrency guard).
"""
import os, sys, json, time, tempfile, subprocess, threading
import http.server
from email.parser import BytesParser
from email.policy import default as POLICY
import torch, soundfile as sf
from transformers import AutoModel

PORT   = int(os.environ.get("INDIC_PORT", "8082"))
MODEL  = os.environ.get("INDIC_MODEL", "ai4bharat/indic-conformer-600m-multilingual")
DEFDEC = os.environ.get("INDIC_DECODING", "rnnt")
SR     = 16000
WIN    = float(os.environ.get("INDIC_WIN_S", "30"))      # window length (s)
OVERLAP = float(os.environ.get("INDIC_OVERLAP_S", "0.5")) # overlap added to each window
MAXWIN = float(os.environ.get("INDIC_MAXWIN_S", "35"))    # run whole-file if <= this
IN22 = {"as","bn","brx","doi","gu","hi","kn","kok","ks","mai","ml","mni",
        "mr","ne","or","pa","sa","sat","sd","ta","te","ur","en"}
_LOCK = threading.Lock()

print(f"[indic] loading {MODEL} ...", flush=True); _t=time.time()
MODELOBJ = AutoModel.from_pretrained(MODEL, trust_remote_code=True); MODELOBJ.eval()
print(f"[indic] model ready in {time.time()-_t:.1f}s, serving :{PORT}", flush=True)


def to_wav(b, suffix):
    """Write upload bytes to temp, transcode to 16 kHz mono WAV, return path."""
    fi=tempfile.NamedTemporaryFile(delete=False, suffix=suffix); fi.write(b); fi.close()
    fo=fi.name+".wav"
    r=subprocess.run(["ffmpeg","-y","-loglevel","error","-i",fi.name,"-ac","1","-ar",str(SR),"-f","wav",fo],
                     capture_output=True, timeout=300)
    os.unlink(fi.name)
    if r.returncode!=0: raise RuntimeError("ffmpeg: "+r.stderr.decode("utf-8","replace")[:300])
    return fo


def ffprobe_duration(p):
    try:
        o=subprocess.check_output(["ffprobe","-v","error","-show_entries","format=duration","-of","csv=p=0",p],
                                  timeout=30)
        return float(o.strip())
    except Exception:
        return 0.0


def slice_wav(p, start, length):
    g=tempfile.NamedTemporaryFile(suffix=".wav", delete=False); g.close()
    subprocess.run(["ffmpeg","-y","-loglevel","error","-ss",str(start),"-t",str(length),"-i",p,
                    "-ac","1","-ar",str(SR),g.name], capture_output=True, timeout=120)
    return g.name


def run_onnx(wav_path, lang, dec):
    """Single ONNX inference over one (<= ~35 s) WAV. Serialized by _LOCK."""
    data,sr=sf.read(wav_path, dtype="float32")
    if data.ndim>1: data=data.mean(axis=1)
    wav=torch.from_numpy(data).unsqueeze(0)
    if sr!=SR:
        import torchaudio; wav=torchaudio.functional.resample(wav, sr, SR)
    with _LOCK, torch.no_grad():
        out=MODELOBJ(wav, lang, dec)
    return out if isinstance(out,str) else (out[0] if out else "")


def infer_long(wav_path, language, decoding):
    """Chunk long audio into <=30 s windows; run each; concatenate. Returns
    {"text":..., "segments":[...]}. A failing window is skipped, not fatal."""
    dur=ffprobe_duration(wav_path)
    if dur<=0 or dur<=MAXWIN:
        t=run_onnx(wav_path, language, decoding)
        segs=[{"start_s":0,"end_s":round(dur,2),"text":t}] if t.strip() else []
        return {"text":t.strip(), "segments":segs}
    segs=[]; texts=[]; start=0.0
    while start<dur:
        c=slice_wav(wav_path, start, WIN+OVERLAP)
        try:
            t=run_onnx(c, language, decoding)
        except Exception as e:
            sys.stderr.write(f"[indic] window {start:.0f}s failed: {e!r}\n"); t=""
        finally:
            try: os.unlink(c)
            except Exception: pass
        if t.strip():
            segs.append({"start_s":round(start,2),"end_s":round(min(dur,start+WIN),2),"text":t.strip()})
            texts.append(t.strip())
        start+=WIN
    return {"text":" ".join(texts).strip(), "segments":segs}


def parse_multipart(body, ctype):
    framed=b"MIME-Version: 1.0\r\nContent-Type: "+ctype.encode()+b"\r\n\r\n"+body
    msg=BytesParser(policy=POLICY).parsebytes(framed)
    fp=None; fields={}
    if not msg.is_multipart(): return fp, fields
    for part in msg.iter_parts():
        name=part.get_param("name", header="Content-Disposition")
        fn=part.get_param("filename", header="Content-Disposition")
        if name=="file" and fn is not None:
            fp=(fn, part.get_payload(decode=True) or b"")
        elif name:
            pl=part.get_payload(decode=True) or b""
            fields[name]=pl.decode("utf-8","replace") if isinstance(pl,bytes) else str(pl)
    return fp, fields


class H(http.server.BaseHTTPRequestHandler):
    def log_message(self,*a): sys.stderr.write("[indic] "+(a[0]%a[1:])+"\n")
    def _j(self,code,obj):
        b=json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code); self.send_header("Content-Type","application/json; charset=utf-8")
        self.send_header("Content-Length",str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        if self.path=="/healthz": return self._j(200,{"ok":True})
        self.send_error(404)
    def do_POST(self):
        if not self.path.startswith("/inference"): return self.send_error(404)
        ct=self.headers.get("Content-Type","")
        if not ct.startswith("multipart/form-data"): return self._j(415,{"ok":False,"error":"multipart only","text":""})
        n=int(self.headers.get("Content-Length","0") or 0); body=self.rfile.read(n)
        try: fp,fields=parse_multipart(body,ct)
        except Exception as e: return self._j(400,{"ok":False,"error":f"parse: {e}","text":""})
        if not fp: return self._j(400,{"ok":False,"error":"missing file","text":""})
        lang=(fields.get("language") or "").strip().lower()
        if lang not in IN22: lang="hi"
        dec=(fields.get("decoding") or DEFDEC).strip().lower()
        if dec not in ("ctc","rnnt"): dec=DEFDEC
        fn,data=fp; suffix=os.path.splitext(fn)[1] or ".webm"
        t0=time.time(); wav=None
        try:
            wav=to_wav(data, suffix)
            res=infer_long(wav, lang, dec)
            return self._j(200,{"ok":True,"text":res["text"],"language":lang,"decoding":dec,
                                "segments":res["segments"],"sec":round(time.time()-t0,2)})
        except Exception as e:
            sys.stderr.write(f"[indic] inference error: {e!r}\n")
            return self._j(200,{"ok":False,"error":repr(e)[:300],"text":"","language":lang,
                                "decoding":dec,"segments":[],"sec":round(time.time()-t0,2)})
        finally:
            if wav:
                try: os.unlink(wav)
                except Exception: pass


if __name__=="__main__":
    http.server.ThreadingHTTPServer(("0.0.0.0",PORT),H).serve_forever()
