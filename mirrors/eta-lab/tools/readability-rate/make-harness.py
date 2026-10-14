#!/usr/bin/env python3
"""Build a stand-alone test page for page.html: stubbed claude.ai runtime (in-memory db, signed in as an owner)
and the invented excerpts in mock-excerpts/ (or $MOCK_DIR).

  python3 make-harness.py <out.html>
The mock excerpts carry hidden fields (room, window_id, engine, kind_hidden) on purpose: the page must never show them."""
import json, os, pathlib, sys

here = pathlib.Path(__file__).parent
out = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else here / "harness.html"
docs = [json.loads(p.read_text()) for p in sorted(pathlib.Path(os.environ.get("MOCK_DIR", here / "mock-excerpts")).glob("*.json"))]
stub = """<script>
(function(){
 const excerpts=%s;const ratings={};const subs=[];
 const snap=c=>({docs:(c==="excerpts"?excerpts:Object.values(ratings)).map(v=>({exists:true,data:()=>JSON.parse(JSON.stringify(v))}))});
 window.claude={use:async n=>n==="db"?{
   collection:c=>({onSnapshot:cb=>{subs.push([c,cb]);setTimeout(()=>cb(snap(c)),0)}}),
   doc:p=>{const id=p.split("/")[1];return{get:async()=>({exists:!!ratings[id],data:()=>ratings[id]}),
     set:async b=>{ratings[id]=JSON.parse(JSON.stringify(b));window.__ratings=ratings;subs.forEach(([k,cb])=>k==="ratings"&&cb(snap("ratings")))}}}
 }:{me:async()=>({id:"u1",name:"Test Rater",isOwner:true}),profiles:async ids=>Object.fromEntries(ids.map(i=>[i,{name:"Test Rater"}]))}};
})();
</script>""" % json.dumps(docs)
page = (here / "page.html").read_text()
out.write_text('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0">' + stub + page + "</body></html>")
print("wrote", out, "with", len(docs), "mock excerpts")
