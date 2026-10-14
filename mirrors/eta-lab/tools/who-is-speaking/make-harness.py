#!/usr/bin/env python3
"""Build a stand-alone test page for page.html: stubbed claude.ai runtime (in-memory db, signed in as an owner),
the invented turns in mock-turns/ and, if ffmpeg exists, a quiet 10 s test tone per turn (not speech).

  python3 make-harness.py <out.html>
The mock turns carry hidden fields (machine_label, doubtful, room, doctor, speaker_basis, margin) on purpose:
the page must never show them."""
import json, pathlib, shutil, subprocess, sys

here = pathlib.Path(__file__).parent
out = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else here / "harness.html"
turns = [json.loads(p.read_text()) for p in sorted((here / "mock-turns").glob("*.json"))]
for t in turns:
    if shutil.which("ffmpeg"):
        dst = out.parent / t["audio"]
        dst.parent.mkdir(parents=True, exist_ok=True)
        if not dst.exists():
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i",
                            "sine=frequency=%d:duration=%d" % (240 + 30 * (len(t["id"]) + ord(t["id"][0]) % 7), int(t["duration_s"])),
                            "-af", "volume=0.15", "-ac", "1", "-b:a", "32k", str(dst)], check=True)
stub = """<script>
(function(){
 const turns=%s;const labels={};const subs=[];
 const snap=c=>({docs:(c==="turns"?turns:Object.values(labels)).map(v=>({exists:true,data:()=>JSON.parse(JSON.stringify(v))}))});
 window.claude={use:async n=>n==="db"?{
   collection:c=>({onSnapshot:cb=>{subs.push([c,cb]);setTimeout(()=>cb(snap(c)),0)}}),
   doc:p=>{const id=p.split("/")[1];return{get:async()=>({exists:!!labels[id],data:()=>labels[id]}),
     set:async b=>{labels[id]=JSON.parse(JSON.stringify(b));window.__labels=labels;subs.forEach(([k,cb])=>k==="labels"&&cb(snap("labels")))}}}
 }:{me:async()=>({id:"u1",name:"Test Rater",isOwner:true}),profiles:async ids=>Object.fromEntries(ids.map(i=>[i,{name:"Test Rater"}]))}};
})();
</script>""" % json.dumps(turns)
page = (here / "page.html").read_text()
out.write_text('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0">' + stub + page + "</body></html>")
print("wrote", out, "with", len(turns), "mock turns")
