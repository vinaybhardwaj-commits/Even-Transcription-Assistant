#!/usr/bin/env python3
"""Build a stand-alone test page for page.html: a stubbed claude.ai runtime (in-memory db, signed in as an owner)
plus the invented windows in mock-windows/ and, if ffmpeg exists, a quiet test tone for each (not speech).

  python3 make-harness.py <out.html>
Serve the folder with ../surgery-review/serve-harness.py to test. Mock windows carry the hidden fields
(teacher_count, engine counts) on purpose: the page must never show them."""
import json, os, pathlib, shutil, subprocess, sys

here = pathlib.Path(__file__).parent
out = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else here / "harness.html"
wins = [json.loads(p.read_text()) for p in sorted((here / "mock-windows").glob("*.json"))]
for w in wins:
    if shutil.which("ffmpeg"):
        dst = out.parent / w["audio"]
        dst.parent.mkdir(parents=True, exist_ok=True)
        if not dst.exists():
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i",
                            "sine=frequency=%d:duration=%d" % (260 + 40 * len(w["id"]), int(w["duration_s"])),
                            "-af", "volume=0.15", "-ac", "1", "-b:a", "32k", str(dst)], check=True)
stub = """<script>
(function(){
 const windows=%s;const counts={};const subs=[];
 const snap=c=>({docs:(c==="windows"?windows:Object.values(counts)).map(v=>({exists:true,data:()=>JSON.parse(JSON.stringify(v))}))});
 window.claude={use:async n=>n==="db"?{
   collection:c=>({onSnapshot:cb=>{subs.push([c,cb]);setTimeout(()=>cb(snap(c)),0)}}),
   doc:p=>{const id=p.split("/")[1];return{get:async()=>({exists:!!counts[id],data:()=>counts[id]}),
     set:async b=>{counts[id]=JSON.parse(JSON.stringify(b));window.__counts=counts;subs.forEach(([k,cb])=>k==="counts"&&cb(snap("counts")))}}}
 }:{me:async()=>({id:"u1",name:"Test Rater",isOwner:true}),profiles:async ids=>Object.fromEntries(ids.map(i=>[i,{name:"Test Rater"}]))}};
})();
</script>""" % json.dumps(wins)
page = (here / "page.html").read_text()
out.write_text('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0">' + stub + page + "</body></html>")
print("wrote", out, "with", len(wins), "mock windows")
