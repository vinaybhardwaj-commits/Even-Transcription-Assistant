#!/usr/bin/env python3
"""Build a stand-alone test page: v2-page.html with a stubbed claude.ai runtime (in-memory db,
signed in as an owner) and the mock consults in mock-consults/. No patient data.

  python3 make-harness.py [out.html]      # default: harness.html next to this script
  python3 -m http.server 8765 --bind 127.0.0.1   # then open http://127.0.0.1:8765/harness.html
"""
import json, pathlib, sys

here = pathlib.Path(__file__).parent
out = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else here / "harness.html"
import os
mocks = [json.loads(p.read_text()) for p in sorted(pathlib.Path(os.environ.get("MOCK_DIR", here / "mock-consults")).glob("*.json"))]
stub = """<script>
(function(){
 const consults=%s;const ratings={};const subs=[];
 const snap=c=>({docs:(c==="consults"?consults:Object.values(ratings)).map(v=>({exists:true,data:()=>JSON.parse(JSON.stringify(v))}))});
 window.claude={use:async n=>n==="db"?{
   collection:c=>({onSnapshot:cb=>{subs.push([c,cb]);setTimeout(()=>cb(snap(c)),0)}}),
   doc:p=>{const id=p.split("/")[1];return{get:async()=>({exists:!!ratings[id],data:()=>ratings[id]}),
     set:async b=>{ratings[id]=JSON.parse(JSON.stringify(b));window.__ratings=ratings;subs.forEach(([k,cb])=>k==="ratings"&&cb(snap("ratings")))}}}
 }:{me:async()=>({id:"u1",name:"Test Reviewer",isOwner:true}),profiles:async ids=>Object.fromEntries(ids.map(i=>[i,{name:"Test Reviewer"}]))}};
})();
</script>""" % json.dumps(mocks)
# A quiet test tone stands in for whole-consult audio (only if ffmpeg exists); it is not speech.
import shutil, subprocess
for m in mocks:
    af = m.get("audio_full")
    if af and shutil.which("ffmpeg"):
        dst = out.parent / af["src"].lstrip("/")
        dst.parent.mkdir(parents=True, exist_ok=True)
        if not dst.exists():
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i",
                            "sine=frequency=330:duration=%d" % int(af.get("duration_s", 60)), "-af", "volume=0.15",
                            "-ac", "1", "-b:a", "32k", str(dst)], check=True)
page = (here / "v2-page.html").read_text()
out.write_text('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0">' + stub + page + "</body></html>")
print("wrote", out, "with", len(mocks), "mock consults")
