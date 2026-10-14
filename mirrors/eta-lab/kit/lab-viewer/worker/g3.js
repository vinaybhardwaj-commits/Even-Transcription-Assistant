// FUSER v1 G3 blinded dose audit (lid-debug spec LABVIEWER-G3-BLIND-SPEC.md, rater V). Bucket eta-lab-ratings only.
//   READS   g3/<run>/items.json (A/B pre-randomised by lid-debug, no system names) and g3/<run>/audio/<item>.m4a
//   WRITES  g3/<run>/marks/<hash>.json and g3-history/<run>/<hash>/<ms>.json
// The A/B -> system key lives under the key-store prefix owned by lid-debug; NO code path in this Worker builds, lists or reads that prefix
// (test/viewer.test.js asserts the prefix string appears nowhere in worker/). Every key below is built from a validated run id, item id and rater hash only.
import { isRater, raterHash } from "./rate.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MARK = ["right", "wrong", "missing"];
const HDRS = { "cache-control": "private, no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cross-origin-resource-policy": "same-origin", "x-frame-options": "DENY" };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...HDRS, "content-type": "application/json" } });
const refuse = () => new Response("forbidden", { status: 403, headers: { ...HDRS, "content-type": "text/plain" } });
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

// items.json -> whitelisted rows; strings kept VERBATIM (no trim/case change); duplicate or invalid ids make the whole set unusable
export function itemsOf(text) {
  let d; try { d = JSON.parse(text); } catch { return null; }
  const list = Array.isArray(d) ? d : d?.items;
  if (!Array.isArray(list) || list.length === 0 || list.length > 500) return null;
  const rows = [];
  for (const x of list) {
    if (!x || typeof x !== "object" || typeof x.item_id !== "string" || !ID.test(x.item_id) || typeof x.A !== "string" || typeof x.B !== "string" || x.A.length > 200 || x.B.length > 200) return null;
    rows.push({ item_id: x.item_id, consult_id: typeof x.consult_id === "string" ? x.consult_id.slice(0, 64) : "", A: x.A, B: x.B });
  }
  return new Set(rows.map((r) => r.item_id)).size === rows.length ? rows : null;
}

export function markOf(v) {
  if (!v || typeof v !== "object" || Array.isArray(v) || !Object.keys(v).every((k) => ["A", "B", "cant_judge", "note", "ts"].includes(k))) return null;
  if (v.note !== undefined && (typeof v.note !== "string" || v.note.length > 1000)) return null;
  if (v.ts !== undefined && (typeof v.ts !== "string" || v.ts.length > 40)) return null;
  const note = v.note ?? "", ts = v.ts ?? "";
  if (v.cant_judge === true) return { cant_judge: true, note, ts };   // CAN'T JUDGE overrides any card marks
  if (v.cant_judge !== undefined && v.cant_judge !== false) return null;
  return MARK.includes(v.A) && MARK.includes(v.B) ? { A: v.A, B: v.B, cant_judge: false, note, ts } : null;
}

async function loadItems(env, run) {
  const o = await env.RATINGS.get(`g3/${run}/items.json`);
  if (!o) return null;
  const text = await o.text(), rows = itemsOf(text);
  return rows ? { rows, sha: hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))) } : null;
}

function rangeOf(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!m || (m[1] === "" && m[2] === "")) return "invalid";
  let a, b;
  if (m[1] === "") { const n = Number(m[2]); if (n <= 0) return "invalid"; a = Math.max(0, size - n); b = size - 1; } else { a = Number(m[1]); b = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1); }
  return a > b || a >= size ? "invalid" : { offset: a, length: b - a + 1 };
}

// /g3/<run> (page) and /api/g3/<run>/(items|mine|audio/<item>). Returns null for a path that is not ours.
export async function g3Route(request, env, url, who, pageShell) {
  const m = /^\/(api\/)?g3\/([^/]+)(?:\/(items|mine|audio)(?:\/([^/]+))?)?$/.exec(url.pathname);
  if (!m) return url.pathname === "/g3" || url.pathname.startsWith("/g3/") || url.pathname.startsWith("/api/g3/") ? json(404, { error: "not found" }) : null;
  if (!isRater(env, who.email)) return refuse();
  const [, api, run, part, item] = m;
  if (!ID.test(run) || (!api && part) || (api && !part) || (part !== "audio" && item !== undefined) || (part === "audio" && !(item && ID.test(item)))) return json(404, { error: "not found" });
  if (!api) {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("method not allowed", { status: 405, headers: { ...HDRS, allow: "GET, HEAD" } });
    return pageShell(G3_PAGE.replace("__RUN__", run), "g3");
  }
  if (part === "items") {
    if (request.method !== "GET") return new Response("method not allowed", { status: 405, headers: { ...HDRS, allow: "GET" } });
    const it = await loadItems(env, run);
    return it ? json(200, { run_id: run, items_sha: it.sha, items: it.rows }) : json(404, { error: "no items for this run" });
  }
  if (part === "audio") {
    if (request.method !== "GET") return new Response("method not allowed", { status: 405, headers: { ...HDRS, allow: "GET" } });
    const it = await loadItems(env, run);
    if (!it || !it.rows.some((r) => r.item_id === item)) return json(404, { error: "not found" });
    const key = `g3/${run}/audio/${item}.m4a`, head = await env.RATINGS.head(key);
    if (!head) return json(404, { error: "audio not found" });
    const h = { ...HDRS, "content-type": "audio/mp4", "accept-ranges": "bytes" }, r = rangeOf(request.headers.get("range"), head.size);
    if (r === "invalid") return new Response(null, { status: 416, headers: { ...h, "content-range": `bytes */${head.size}` } });
    if (r === null) { const o = await env.RATINGS.get(key); return new Response(o.body, { status: 200, headers: { ...h, "content-length": String(head.size) } }); }
    const o = await env.RATINGS.get(key, { range: r });
    return new Response(o.body, { status: 206, headers: { ...h, "content-range": `bytes ${r.offset}-${r.offset + r.length - 1}/${head.size}`, "content-length": String(r.length) } });
  }
  const h = await raterHash(who.email), key = `g3/${run}/marks/${h}.json`;
  const cur = await env.RATINGS.get(key);
  let doc = null;
  if (cur) { try { doc = JSON.parse(await cur.text()); } catch { return json(500, { error: "marks unreadable" }); } }
  if (request.method === "GET") return json(200, doc ?? { rater: who.email, run_id: run, items_sha: null, t: {}, closed: null });
  if (request.method !== "PUT") return new Response("method not allowed", { status: 405, headers: { ...HDRS, allow: "GET, PUT" } });
  if (!(request.headers.get("content-type") || "").toLowerCase().startsWith("application/json")) return json(415, { error: "application/json only" });
  const site = request.headers.get("sec-fetch-site"); if (site && site !== "same-origin") return refuse();
  const text = await request.text();
  if (text.length > 8000) return json(413, { error: "too large" });
  let body; try { body = JSON.parse(text); } catch { return json(400, { error: "not json" }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json(422, { error: "object expected" });
  const it = await loadItems(env, run);
  if (!it) return json(409, { error: "no items for this run" });
  if (doc?.closed) return json(409, { error: "run is closed" });
  const next = { rater: who.email, run_id: run, items_sha: it.sha, t: { ...(doc?.t ?? {}) }, closed: null };
  if (Object.keys(body).length === 2 && typeof body.item === "string" && "mark" in body) {
    if (!it.rows.some((r) => r.item_id === body.item)) return json(422, { error: "unknown item" });
    const mk = markOf(body.mark);
    if (!mk) return json(422, { error: "mark not allowed" });
    next.t[body.item] = mk;
  } else if (Object.keys(body).length === 1 && body.close === true) {
    if (!it.rows.every((r) => next.t[r.item_id])) return json(409, { error: "unrated items remain" });   // a run can't close with an unrated item
    next.closed = new Date().toISOString();
  } else return json(422, { error: "expected {item, mark} or {close: true}" });
  const now = new Date(), out = JSON.stringify(next);
  await env.RATINGS.put(`g3-history/${run}/${h}/${now.getTime()}.json`, out, { httpMetadata: { contentType: "application/json" } });   // every save kept
  await env.RATINGS.put(key, out, { httpMetadata: { contentType: "application/json" } });
  return json(200, { ok: true, rated: Object.keys(next.t).length, closed: next.closed });
}

// One item at a time. All text is set via textContent (verbatim); no system name, colour or ordering cue anywhere; no A/B totals.
export const G3_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dose audit</title>
<style nonce="__NONCE__">
:root{--bg:#fbfaf7;--ink:#1c1a17;--mut:#6b675f;--line:#e2ddd2;--acc:#0f6b6b;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#161513;--ink:#ecE8e0;--mut:#a39e94;--line:#3a3833;--acc:#5bb5b5;--card:#1f1e1b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 system-ui,sans-serif}
main{max-width:720px;margin:0 auto;padding:16px}
h1{font-size:18px;margin:0 0 4px}.mut{color:var(--mut);font-size:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;margin:12px 0}
.dose{font-size:22px;font-weight:600;margin:4px 0 10px;word-break:break-word}
.row{display:flex;gap:8px;flex-wrap:wrap}
button{font:inherit;padding:10px 14px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--ink);cursor:pointer;min-height:44px}
button.on{background:var(--acc);color:#fff;border-color:var(--acc)}button:disabled{opacity:.5;cursor:default}
audio{width:100%;margin:6px 0}textarea{width:100%;min-height:70px;font:inherit;padding:8px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--ink)}
.bar{height:6px;background:var(--line);border-radius:3px;margin:8px 0}.bar>i{display:block;height:6px;background:var(--acc);border-radius:3px}
#msg{min-height:1.4em;color:var(--mut)}
</style></head><body><main>
<h1>Dose audit</h1><div class="mut" id="prog">Loading</div>
<div class="bar"><svg width="100%" height="6" viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true"><rect id="barfill" x="0" y="0" width="0" height="6" fill="#0f6b6b"></rect></svg></div>
<div id="body"></div><div id="msg" role="status"></div>
<script nonce="__NONCE__">
const RUN="__RUN__";
const $=(t,a,...k)=>{const e=document.createElement(t);for(const[x,y]of Object.entries(a||{}))e.setAttribute(x,y);for(const c of k)e.append(c);return e};
let items=[],marks={},closed=null,idx=0,cur={};
const say=(s)=>{document.getElementById("msg").textContent=s};
const api=async(p,o)=>{const r=await fetch("/api/g3/"+RUN+"/"+p,o);if(!r.ok)throw new Error(r.status);return r.json()};
const isRated=(id)=>!!marks[id];
function progress(){const n=items.filter((i)=>isRated(i.item_id)).length;document.getElementById("prog").textContent=(idx+1)+" of "+items.length+" \\u00b7 "+n+" / "+items.length+" rated"+(closed?" \\u00b7 closed":"");document.getElementById("barfill").setAttribute("width",String(items.length?100*n/items.length:0))}
function render(){
  const it=items[idx],b=document.getElementById("body");b.textContent="";progress();
  cur=marks[it.item_id]?{...marks[it.item_id]}:{};
  const ro=!!closed;
  const au=$("audio",{controls:"",preload:"auto",src:"/api/g3/"+RUN+"/audio/"+encodeURIComponent(it.item_id)});
  const spd=[0.75,1,1.25].map((v)=>{const x=$("button",{type:"button"},v+"x");x.onclick=()=>{au.playbackRate=v};return x});
  const back=$("button",{type:"button"},"Back 5 s");back.onclick=()=>{au.currentTime=Math.max(0,au.currentTime-5)};
  const pp=$("button",{type:"button"},"Play / pause");pp.onclick=()=>{au.paused?au.play():au.pause()};
  b.append($("div",{class:"card"},$("div",{class:"mut"},"Consult "+(it.consult_id||it.item_id)),au,$("div",{class:"row"},pp,back,...spd)));
  const btns={};
  for(const [side,keys] of [["A",["1","2","3"]],["B",["7","8","9"]]]){
    const c=$("div",{class:"card"},$("div",{class:"mut"},side),$("div",{class:"dose"},it[side]));
    const r=$("div",{class:"row"});btns[side]={};
    ["right","wrong","missing"].forEach((m,i)=>{const x=$("button",{type:"button"},m.toUpperCase()+" ("+keys[i]+")");btns[side][m]=x;x.disabled=ro;x.onclick=()=>{cur.cant_judge=false;cur[side]=m;paint()};r.append(x)});
    c.append(r);b.append(c);
  }
  const cj=$("button",{type:"button"},"CAN'T JUDGE (0)");cj.disabled=ro;cj.onclick=()=>{cur={cant_judge:true};paint()};
  const note=$("textarea",{maxlength:"1000",placeholder:"Note (optional)"});note.value=cur.note||"";note.disabled=ro;
  const save=$("button",{type:"button"},"Save & next");save.disabled=ro;
  const prev=$("button",{type:"button"},"Back");prev.disabled=idx===0;prev.onclick=()=>{idx--;render()};
  const nxt=$("button",{type:"button"},"Next");nxt.disabled=idx>=items.length-1;nxt.onclick=()=>{idx++;render()};
  b.append($("div",{class:"card"},$("div",{class:"row"},cj),$("div",{class:"mut"},"Note"),note,$("div",{class:"row"},prev,save,nxt)));
  if(!ro){const all=items.every((i)=>isRated(i.item_id));const cl=$("button",{type:"button"},"Close run");cl.disabled=!all;cl.onclick=async()=>{if(!confirm("Close the run? Marks become read-only."))return;try{const r=await api("mine",{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({close:true})});closed=r.closed;render()}catch(e){say("Could not close ("+e.message+")")}};b.append($("div",{class:"card"},cl))}
  function paint(){for(const s of ["A","B"])for(const m of ["right","wrong","missing"])btns[s][m].className=(!cur.cant_judge&&cur[s]===m)?"on":"";cj.className=cur.cant_judge?"on":""}
  paint();
  save.onclick=async()=>{
    const mk=cur.cant_judge?{cant_judge:true}:{A:cur.A,B:cur.B,cant_judge:false};
    if(!cur.cant_judge&&(!cur.A||!cur.B)){say("Mark both A and B, or CAN'T JUDGE.");return}
    if(note.value)mk.note=note.value;mk.ts=new Date().toISOString();
    try{await api("mine",{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({item:it.item_id,mark:mk})});marks[it.item_id]=mk;say("Saved.");
      if(idx<items.length-1)idx++;render()}catch(e){say("Save failed ("+e.message+"). Nothing lost on screen; try again.")}
  };
  window.onkeydown=(e)=>{if(ro||e.target===note||e.ctrlKey||e.metaKey||e.altKey)return;const k={"1":["A","right"],"2":["A","wrong"],"3":["A","missing"],"7":["B","right"],"8":["B","wrong"],"9":["B","missing"]}[e.key];if(k){cur.cant_judge=false;cur[k[0]]=k[1];paint()}else if(e.key==="0"){cur={cant_judge:true};paint()}};
}
(async()=>{try{
  const [i,m]=await Promise.all([api("items"),api("mine")]);items=i.items;marks=m.t||{};closed=m.closed||null;
  idx=Math.max(0,items.findIndex((x)=>!isRated(x.item_id)));if(items.every((x)=>isRated(x.item_id)))idx=0;render();
}catch(e){document.getElementById("prog").textContent="No items loaded for this run yet ("+e.message+")."}})();
</script></main></body></html>`;
