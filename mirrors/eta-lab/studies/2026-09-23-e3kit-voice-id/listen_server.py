#!/usr/bin/env python3
"""E-3 Cardiology listening session server (LISTEN-E3-CARDIOLOGY.md). Stdlib only, tailnet-bound.
Serves clips already extracted to out/listen_clips/*.m4a — no live extraction during the session,
so nothing depends on the door or the Mini's diarize while V is listening. Every answer is written
to disk the instant it's clicked (answers.json + progress.json), so a refresh or a break loses
nothing. Shows the browser NOTHING but the audio player and the buttons: the JSON sent to the
client never carries score, cluster id, or window id — only clip_id, its index, and total count.
"""
import http.server
import json
import os
import socketserver
import sys
import time
import urllib.parse

OUT = os.path.expanduser("~/dev/_fable/e3kit/out")
CLIPS_DIR = os.path.join(OUT, "listen_clips")
MANIFEST_PATH = os.path.join(OUT, "clips_manifest.json")   # server-only: has score/window_id etc.
ANSWERS_PATH = os.path.join(OUT, "answers.json")           # latest answer per clip_id (state/resume/report)
ANSWERS_LOG_PATH = os.path.join(OUT, "answers_log.json")   # every click ever, in order — "the raw answers JSON with timestamps"
PROGRESS_PATH = os.path.join(OUT, "progress.json")
LABELS_CSV = os.path.join(OUT, "labels_cardiology.csv")
PORT = 8798
CANDIDATES = ["The Cardiology OPD clinician"]  # only sourced name; see report for the source; internal label key stays "dibyendu" for continuity with recorded answers

LABEL_KEYS = ["dibyendu", "other_doctor", "patient", "family", "nurse", "two_voices", "cant_tell"]
LABEL_TO_SCORE_LABEL = {  # normalized to score.py's doctor|patient|other (cant_tell excluded from the csv)
    "dibyendu": "doctor", "other_doctor": "doctor", "patient": "patient",
    "family": "other", "nurse": "other", "two_voices": "other",
}

PAGE = """<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>E-3 listen</title>
<style>
body{font-family:-apple-system,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;background:#111;color:#eee}
button{display:block;width:100%;padding:14px;margin:6px 0;font-size:17px;border-radius:8px;border:1px solid #444;background:#222;color:#eee;cursor:pointer}
button:hover{background:#333}
button.kbd::after{content:attr(data-k);float:right;opacity:.5}
#progress{font-size:14px;opacity:.7;margin-bottom:10px}
#nav{display:flex;gap:8px;margin-top:14px}
#nav button{flex:1;background:#1a1a1a}
#namebox{display:none;margin:8px 0}
#namebox input{width:70%;padding:10px;font-size:16px;border-radius:6px;border:1px solid #444;background:#222;color:#eee}
#namebox button{width:26%;display:inline-block}
#ctx{margin:10px 0}
audio{width:100%}
</style></head><body>
<div id="progress">-- / --</div>
<audio id="player" controls></audio>
<div id="ctx"><button id="replay">Replay</button><button id="context">+3s context</button></div>
<div id="buttons"></div>
<div id="namebox"><input id="nameinput" placeholder="clinician name"><button id="namesubmit">Use</button></div>
<div id="nav"><button id="back">Back</button><button id="skip">Skip</button></div>
<script>
let state=null, playing=null;
const labels=[["The Cardiology OPD clinician","dibyendu"],["Another doctor","other_doctor"],["Patient","patient"],
  ["Family/attendant","family"],["Nurse/staff","nurse"],["Two voices","two_voices"],["Can't tell","cant_tell"]];
function render(){
  document.getElementById('progress').textContent = (state.index+1)+" / "+state.total;
  const p=document.getElementById('player');
  p.src = "/clip/"+state.clip_id+".m4a";
  p.play().catch(()=>{});
  const bdiv=document.getElementById('buttons'); bdiv.innerHTML="";
  labels.forEach((l,i)=>{
    const b=document.createElement('button'); b.className='kbd'; b.dataset.k=(i+1);
    b.textContent=l[0]; b.onclick=()=>choose(l[1]); bdiv.appendChild(b);
  });
  document.getElementById('namebox').style.display='none';
}
async function load(){ state = await (await fetch('/api/state')).json(); render(); }
async function choose(key){
  if(key==='other_doctor'){ document.getElementById('namebox').style.display='block'; document.getElementById('nameinput').focus(); return; }
  await submit(key, null);
}
async function submit(key, name){
  const body={clip_id:state.clip_id, index:state.index, label_key:key, clinician_name:name};
  state = await (await fetch('/api/answer',{method:'POST',body:JSON.stringify(body)})).json();
  render();
}
document.getElementById('namesubmit').onclick=()=>{
  const n=document.getElementById('nameinput').value.trim(); if(n) submit('other_doctor', n);
};
document.getElementById('replay').onclick=()=>document.getElementById('player').play();
document.getElementById('context').onclick=async()=>{
  const p=document.getElementById('player');
  p.src = "/clip/"+state.clip_id+".ctx.m4a"; await p.play().catch(()=>{});
};
document.getElementById('back').onclick=async()=>{ state = await (await fetch('/api/back',{method:'POST'})).json(); render(); };
document.getElementById('skip').onclick=async()=>{ state = await (await fetch('/api/answer',{method:'POST',body:JSON.stringify({clip_id:state.clip_id,index:state.index,label_key:'__skip__',clinician_name:null})})).json(); render(); };
window.onkeydown=(e)=>{ if(e.key>='1'&&e.key<='7'){ choose(labels[+e.key-1][1]); } };
load();
</script></body></html>"""


def load_json(path, default):
    return json.load(open(path)) if os.path.exists(path) else default


def save_json(path, obj):
    tmp = path + ".tmp"
    json.dump(obj, open(tmp, "w"), indent=1)
    os.replace(tmp, path)


class Handler(http.server.BaseHTTPRequestHandler):
    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _client_state(self):
        manifest = load_json(MANIFEST_PATH, {"clips": []})
        clips = manifest["clips"]
        progress = load_json(PROGRESS_PATH, {"index": 0})
        idx = min(progress["index"], max(0, len(clips) - 1))
        return {"index": idx, "total": len(clips), "clip_id": clips[idx]["clip_id"] if clips else None}

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/":
            body = PAGE.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif parsed.path == "/api/state":
            self._json(self._client_state())
        elif parsed.path.startswith("/clip/"):
            fname = os.path.basename(parsed.path[len("/clip/"):])
            fpath = os.path.join(CLIPS_DIR, fname)
            if not os.path.exists(fpath):
                self.send_response(404); self.end_headers(); return
            data = open(fpath, "rb").read()
            self.send_response(200)
            self.send_header("Content-Type", "audio/mp4")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)
        else:
            self.send_response(404); self.end_headers()

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw)
        except Exception:
            body = {}
        parsed = urllib.parse.urlparse(self.path)
        manifest = load_json(MANIFEST_PATH, {"clips": []})
        clips = {c["clip_id"]: c for c in manifest["clips"]}
        progress = load_json(PROGRESS_PATH, {"index": 0})

        if parsed.path == "/api/answer":
            clip_id = body.get("clip_id")
            key = body.get("label_key")
            name = body.get("clinician_name")
            entry = {"clip_id": clip_id, "label_key": key, "clinician_name": name, "ts": time.time()}
            log = load_json(ANSWERS_LOG_PATH, [])
            log.append(entry)
            save_json(ANSWERS_LOG_PATH, log)
            answers = load_json(ANSWERS_PATH, {})
            answers[clip_id] = {"label_key": key, "clinician_name": name, "ts": entry["ts"]}
            save_json(ANSWERS_PATH, answers)
            rewrite_labels_csv(clips, answers)
            progress["index"] = min(progress.get("index", 0) + 1, len(clips) - 1) if clips else 0
            save_json(PROGRESS_PATH, progress)
            self._json(self._client_state())
        elif parsed.path == "/api/back":
            progress["index"] = max(0, progress.get("index", 0) - 1)
            save_json(PROGRESS_PATH, progress)
            self._json(self._client_state())
        else:
            self.send_response(404); self.end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def rewrite_labels_csv(clips, answers):
    """score.py format: window_id,time_ms,label,clinician_id. Rewritten IN FULL from the current
    (latest-per-clip_id) answers every time — never appended — so a Back-and-correct never leaves a
    stale row behind. cant_tell/two_voices/nurse/family map to 'other'; __skip__ and cant_tell carry
    no real doctor/patient signal but 'other' still lets score.py's centroid math use them as
    non-doctor negatives, except __skip__ which is dropped entirely (never a real observation)."""
    rows = []
    for clip_id, ans in answers.items():
        key = ans.get("label_key")
        if key == "__skip__" or clip_id not in clips:
            continue
        label = LABEL_TO_SCORE_LABEL.get(key, "other")
        clinician_id = ans.get("clinician_name") if key == "other_doctor" and ans.get("clinician_name") else ("dibyendu" if key == "dibyendu" else "n/a")
        c = clips[clip_id]
        rows.append((c["window_id"], c["start_ms"], label, clinician_id))
    tmp = LABELS_CSV + ".tmp"
    with open(tmp, "w") as f:
        f.write("window_id,time_ms,label,clinician_id\n")
        for r in rows:
            f.write("%s,%d,%s,%s\n" % r)
    os.replace(tmp, LABELS_CSV)


class Server(socketserver.TCPServer):
    allow_reuse_address = True  # a quick restart during V's session must not hit "address in use"


def main():
    manifest = load_json(MANIFEST_PATH, {"clips": []})
    print("clips loaded:", len(manifest["clips"]))
    with Server(("0.0.0.0", PORT), Handler) as httpd:
        print("listening on 0.0.0.0:%d" % PORT)
        httpd.serve_forever()


if __name__ == "__main__":
    main()
