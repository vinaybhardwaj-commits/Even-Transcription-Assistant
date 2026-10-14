#!/usr/bin/env python3
"""Build a stand-alone test page for page.html: stubbed claude.ai runtime (in-memory db, signed in as an owner), the
invented cards in mock-cards/ and, if ffmpeg exists, a quiet test tone per clip (not speech).

  python3 make-harness.py <out.html>
The mock cards carry hidden fields (tier, pqm_score, cluster_id, true_doctor, confidence) on purpose: the page must
never show them. mock-cards/_doctors.json becomes the config/doctors doc."""
import json, pathlib, shutil, subprocess, sys

here = pathlib.Path(__file__).parent
out = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else here / "harness.html"
cards, doctors = [], None
for p in sorted((here / "mock-cards").glob("*.json")):
    d = json.loads(p.read_text())
    if p.name == "_doctors.json":
        doctors = d
    else:
        cards.append(d)
clips = []
for c in cards:
    clips += ([c["a"], c["b"]] if c["kind"] == "pair" else c["clips"] + [c["contrast"]])
if shutil.which("ffmpeg"):
    for i, cl in enumerate(clips):
        dst = out.parent / cl["src"]
        dst.parent.mkdir(parents=True, exist_ok=True)
        if not dst.exists():
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i",
                            "sine=frequency=%d:duration=%d" % (220 + 25 * i, int(cl["duration_s"])),
                            "-af", "volume=0.15", "-ac", "1", "-b:a", "32k", str(dst)], check=True)
stub = """<script>
(function(){
 const links=%s,config={doctors:%s},verdicts={};const subs=[];
 const snap=c=>({docs:(c==="links"?links:Object.values(verdicts)).map(v=>({exists:true,data:()=>JSON.parse(JSON.stringify(v))}))});
 window.claude={use:async n=>n==="db"?{
   collection:c=>({onSnapshot:cb=>{subs.push([c,cb]);setTimeout(()=>cb(snap(c)),0)}}),
   doc:p=>{const [c,id]=p.split("/");return{
     get:async()=>c==="config"?{exists:!!config[id],data:()=>config[id]}:{exists:!!verdicts[id],data:()=>verdicts[id]},
     set:async b=>{verdicts[id]=JSON.parse(JSON.stringify(b));window.__verdicts=verdicts;subs.forEach(([k,cb])=>k==="verdicts"&&cb(snap("verdicts")))}}}
 }:{me:async()=>({id:"u1",name:"Test Rater",isOwner:true}),profiles:async ids=>Object.fromEntries(ids.map(i=>[i,{name:"Test Rater"}]))}};
})();
</script>""" % (json.dumps(cards), json.dumps(doctors))
page = (here / "page.html").read_text()
out.write_text('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0">' + stub + page + "</body></html>")
print("wrote", out, "with", len(cards), "mock cards")
