// DRTPQMA: Doc / Room / Time / PQM / Audio. Read-only page over drt/<date>.json (eta-lab-ratings) + tape audio (tapes/ in eta-lab-results).
// The Worker only ever reads: the doc via RATINGS.get, tape chunks via RESULTS.head/get (tapes/ prefix only) for keys LISTED IN THAT DAY'S DOC.
import { parseRange } from "./index.js";

const HDRS = { "cache-control": "private, no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cross-origin-resource-policy": "same-origin", "x-frame-options": "DENY" };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...HDRS, "content-type": "application/json" } });
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const KEY = /^tapes\/[A-Za-z0-9][A-Za-z0-9._\/-]{0,300}$/;
const SOURCES = new Set(["voice", "schedule", "schedule+voice"]);
const REASONS = new Set(["no_tape", "room_unknown"]);
const IST_MS = 19800000, DAY_MS = 86400000;
const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const okKey = (k) => typeof k === "string" && KEY.test(k) && !k.includes("..") && !k.includes("//");

// seconds since IST midnight of `date`, or null when the instant is not on that IST day
function istSeconds(iso, date) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const ist = ms + IST_MS;
  if (new Date(ist).toISOString().slice(0, 10) !== date) return null;
  return (ist % DAY_MS) / 1000;
}

// Whitelist parse of drt.json: only the fields the page needs (doctor, token no, times, room, audio pieces).
export function drtOf(text, date) {
  let d;
  try { d = JSON.parse(text); } catch { return null; }
  if (!d || typeof d !== "object" || d.date !== date || !Array.isArray(d.rooms) || !Array.isArray(d.encounters)) return null;
  const rooms = [], seenRoom = new Set();
  for (const r of d.rooms.slice(0, 60)) {
    if (!r || typeof r.room_id !== "string" || !ID.test(r.room_id) || seenRoom.has(r.room_id)) continue;
    seenRoom.add(r.room_id);
    rooms.push({ room_id: r.room_id, label: str(r.label, 40) || r.room_id });
  }
  const encounters = [];
  for (const e of d.encounters.slice(0, 3000)) {
    if (!e || typeof e.id !== "string" || !ID.test(e.id) || !seenRoom.has(e.room_id)) continue;
    const s = istSeconds(e.start, date), t = istSeconds(e.end, date);
    if (s === null || t === null || t <= s) continue;
    const audio = [];
    for (const a of Array.isArray(e.audio) ? e.audio.slice(0, 8) : []) {
      const off = num(a?.offset_s), dur = num(a?.dur_s);
      if (!okKey(a?.key) || off === null || dur === null || off < 0 || dur <= 0) continue;
      audio.push({ key: a.key, offset_s: off, dur_s: dur });
    }
    encounters.push({
      id: e.id, room_id: e.room_id, doctor: str(e.doctor, 80) || "Unknown", token_no: Number.isInteger(e.token_no) ? e.token_no : null,
      s, e: t, start: str(e.start, 40), end: str(e.end, 40),
      room_source: SOURCES.has(e.room_source) ? e.room_source : "schedule", audio,
    });
  }
  const gaps = [];
  for (const g of Array.isArray(d.gaps) ? d.gaps.slice(0, 3000) : []) {
    if (g && typeof g.id === "string" && ID.test(g.id)) gaps.push({ id: g.id, reason: REASONS.has(g.reason) ? g.reason : "room_unknown" });
  }
  const bf = d.built_from && typeof d.built_from === "object" ? d.built_from : {};
  return { date, rooms, doctors: [...new Set(encounters.map((e) => e.doctor))].sort(), encounters, gaps,
    built_from: { pqm: str(bf.pqm, 80), schedule_sha: str(bf.schedule_sha, 64), tapes_index_sha: str(bf.tapes_index_sha, 64) } };
}

async function loadDoc(env, date) {
  if (!env.RATINGS) return null;
  try { const o = await env.RATINGS.get(`drt/${date}.json`); return o ? drtOf(await o.text(), date) : null; } catch { return null; }
}

const TYPES = { m4a: "audio/mp4", mp4: "audio/mp4", webm: "audio/webm", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", opus: "audio/ogg" };

async function serveTape(request, env, doc, key) {
  if (!okKey(key) || !env.RESULTS || !doc.encounters.some((e) => e.audio.some((a) => a.key === key))) return json(404, { error: "not found" });
  const head = await env.RESULTS.head(key);
  if (!head) return json(404, { error: "audio not found" });
  const ct = head.httpMetadata?.contentType;
  const type = typeof ct === "string" && ct.startsWith("audio/") ? ct : TYPES[key.split(".").pop().toLowerCase()] || "application/octet-stream";
  const h = { ...HDRS, "content-type": type, "accept-ranges": "bytes" };
  const range = parseRange(request.headers.get("range"), head.size);
  if (range === "invalid") return new Response(null, { status: 416, headers: { ...h, "content-range": `bytes */${head.size}` } });
  if (range === null) { const o = await env.RESULTS.get(key); return new Response(request.method === "HEAD" ? null : o.body, { status: 200, headers: { ...h, "content-length": String(head.size) } }); }
  const o = await env.RESULTS.get(key, { range });
  return new Response(request.method === "HEAD" ? null : o.body, { status: 206, headers: { ...h, "content-range": `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`, "content-length": String(range.length) } });
}

export async function drtRoute(request, env, url, who, pageShell) {
  const m = /^\/(api\/)?drt(?:\/(\d{4}-\d{2}-\d{2}))?(?:\/(tape))?\/?$/.exec(url.pathname);
  if (!m) return null;
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("method not allowed", { status: 405, headers: { ...HDRS, allow: "GET, HEAD" } });
  const [, api, date, tape] = m;
  if (!api && !date) {
    let latest = null;
    try { const l = await env.RATINGS?.list({ prefix: "drt/" }); for (const o of l?.objects ?? []) { const d = /^drt\/(\d{4}-\d{2}-\d{2})\.json$/.exec(o.key)?.[1]; if (d && (!latest || d > latest)) latest = d; } } catch { latest = null; }
    return new Response(null, { status: 302, headers: { ...HDRS, location: latest ? `/drt/${latest}` : `/drt/${new Date(Date.now() + IST_MS).toISOString().slice(0, 10)}` } });
  }
  if (!date) return json(404, { error: "not found" });
  if (!api) return pageShell(DRT_PAGE.replaceAll("__DATE__", date), "drt");
  const doc = await loadDoc(env, date);
  if (!doc) return json(404, { error: "no drt file for this date yet" });
  if (tape) return serveTape(request, env, doc, url.searchParams.get("k"));
  return json(200, doc);
}

export const DRT_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Doc Room Time</title>
<style nonce="__NONCE__">
:root{--bg:#fbfbfa;--ink:#1c1c1c;--mut:#666;--line:#d9d9d4;--card:#fff;--acc:#1f5fbf}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#15171a;--ink:#e8e8e6;--mut:#9a9a96;--line:#333;--card:#1e2126;--acc:#7aa7ff}}
:root[data-theme="dark"]{--bg:#15171a;--ink:#e8e8e6;--mut:#9a9a96;--line:#333;--card:#1e2126;--acc:#7aa7ff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.4 system-ui,sans-serif;padding:12px 16px}
h1{font-size:17px;margin:0 0 8px}nav a{margin-right:14px;color:var(--acc);text-decoration:none;font-weight:600}
.bar{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:8px 0}input[type=date]{font:inherit;padding:3px 6px;background:var(--card);color:var(--ink);border:1px solid var(--line);border-radius:4px}
.legend{display:flex;gap:14px;flex-wrap:wrap;margin:6px 0;font-size:13px}.legend span{display:inline-flex;gap:6px;align-items:center}
#grid{display:block;width:100%;height:auto;background:var(--card);border:1px solid var(--line);border-radius:6px}
.blk{cursor:pointer}.blk:focus{outline:none}.blk:focus rect.main,.blk:hover rect.main{stroke:var(--ink);stroke-width:2}
.player{position:sticky;bottom:0;background:var(--card);border:1px solid var(--line);border-radius:6px;padding:8px 12px;margin-top:10px}
.player audio{width:100%;margin-top:6px}.mut{color:var(--mut);font-size:13px}.err{color:#b3261e}
h2{font-size:14px;margin:16px 0 4px}ul{margin:4px 0;padding-left:20px}
</style></head><body>
<header><h1>Doc / Room / Time</h1><nav><a href="/">Days</a><a href="/timeline">Timeline</a><a href="/drt">Doc-Room-Time</a></nav></header>
<div class="bar"><label>Day <input type="date" id="d" value="__DATE__"></label><span class="mut" id="meta"></span></div>
<div class="legend" id="legend"></div>
<div id="msg" class="mut"></div>
<svg id="grid" role="img" aria-label="Rooms by time, one block per PQM encounter" hidden></svg>
<div class="player" id="player" hidden><div id="ptitle"></div><div class="mut" id="pstat"></div><audio id="au" controls preload="none"></audio></div>
<h2 id="gh" hidden>Encounters we could not place or play</h2><ul id="gaps"></ul>
<script nonce="__NONCE__">
"use strict";
const DATE="__DATE__",NS="http://www.w3.org/2000/svg",PAL=["#1f77b4","#d95f02","#1b9e77","#7570b3","#e7298a","#66a61e","#a6761d","#e6ab02","#17becf","#8c564b","#bcbd22","#393b79"];
const T0=8*3600,T1=21*3600,LW=88,W=1200,AX=26,LH=22,PAD=6;
const $=(i)=>document.getElementById(i);
function sv(tag,a,txt){const e=document.createElementNS(NS,tag);for(const k in a)e.setAttribute(k,a[k]);if(txt!==undefined)e.textContent=txt;return e}
const hm=(s)=>String(Math.floor(s/3600)).padStart(2,"0")+":"+String(Math.floor(s%3600/60)).padStart(2,"0");
$("d").addEventListener("change",()=>{if(/^\\d{4}-\\d{2}-\\d{2}$/.test($("d").value))location.href="/drt/"+$("d").value});
let doc=null,play=null;
fetch("/api/drt/"+DATE).then(async(r)=>{if(!r.ok){$("msg").textContent=r.status===404?"No data for this day yet.":"Could not load this day.";return}doc=await r.json();draw()}).catch(()=>{$("msg").textContent="Could not load this day."});
function draw(){
  const col={};doc.doctors.forEach((n,i)=>{col[n]=PAL[i%PAL.length]});
  $("meta").textContent=doc.encounters.length+" encounters · "+doc.rooms.length+" rooms"+(doc.built_from.pqm?" · PQM "+doc.built_from.pqm:"");
  const lg=$("legend");
  for(const n of doc.doctors){const s=document.createElement("span"),k=sv("svg",{width:14,height:14,viewBox:"0 0 14 14"});k.appendChild(sv("rect",{width:14,height:14,rx:3,fill:col[n]}));s.append(k,document.createTextNode(n));lg.appendChild(s)}
  const hs=document.createElement("span"),hk=sv("svg",{width:14,height:14,viewBox:"0 0 14 14"});hk.appendChild(sv("rect",{width:14,height:14,rx:3,fill:"none",stroke:"#888","stroke-dasharray":"3 2"}));hk.appendChild(sv("path",{d:"M0 14L14 0M-2 4L4 -2M10 16L16 10",stroke:"#888","stroke-width":1.5}));hs.append(hk,document.createTextNode("room from schedule only (no voice evidence)"));lg.appendChild(hs);
  const lanesOf={};let H=AX;const rowY={};
  for(const r of doc.rooms){
    const es=doc.encounters.filter(e=>e.room_id===r.room_id).sort((a,b)=>a.s-b.s),ends=[];
    for(const e of es){let l=ends.findIndex(x=>x<=e.s);if(l<0){l=ends.length;ends.push(0)}ends[l]=e.e;e.lane=l}
    const n=Math.max(1,ends.length);lanesOf[r.room_id]=n;rowY[r.room_id]=H;H+=n*LH+PAD*2;
  }
  const g=$("grid");g.setAttribute("viewBox","0 0 "+W+" "+H);g.hidden=false;
  const defs=sv("defs",{});const pat=sv("pattern",{id:"hatch",width:6,height:6,patternUnits:"userSpaceOnUse",patternTransform:"rotate(45)"});pat.appendChild(sv("line",{x1:0,y1:0,x2:0,y2:6,stroke:"#fff","stroke-width":2.5,"stroke-opacity":.75}));defs.appendChild(pat);g.appendChild(defs);
  const X=(s)=>LW+(Math.min(T1,Math.max(T0,s))-T0)/(T1-T0)*(W-LW-8);
  for(let h=8;h<=21;h++){const x=X(h*3600);g.appendChild(sv("line",{x1:x,y1:AX-4,x2:x,y2:H,stroke:"#8886","stroke-width":1}));g.appendChild(sv("text",{x:x,y:14,"text-anchor":"middle","font-size":11,fill:"#888"},String(h).padStart(2,"0")+":00"))}
  for(const r of doc.rooms){
    const y=rowY[r.room_id],h=lanesOf[r.room_id]*LH+PAD*2;
    g.appendChild(sv("line",{x1:0,y1:y+h,x2:W,y2:y+h,stroke:"#8886","stroke-width":1}));
    g.appendChild(sv("text",{x:6,y:y+PAD+15,"font-size":12,"font-weight":600,fill:"currentColor"},r.label));
  }
  for(const e of doc.encounters){
    const x0=X(e.s),x1=X(e.e);if(x1<=x0&&(e.e<=T0||e.s>=T1))continue;
    const w=Math.max(4,x1-x0),y=rowY[e.room_id]+PAD+e.lane*LH,sched=e.room_source==="schedule";
    const tip=(e.token_no!==null?"#"+e.token_no+" ":"")+e.doctor+" · "+hm(e.s)+"–"+hm(e.e)+" · room via "+e.room_source+(e.audio.length?"":" · no audio");
    const b=sv("g",{class:"blk",tabindex:0,role:"button","aria-label":tip});
    b.appendChild(sv("title",{},tip));
    b.appendChild(sv("rect",{class:"main",x:x0,y:y,width:w,height:LH-3,rx:3,fill:col[e.doctor],"fill-opacity":e.audio.length?1:.45,stroke:sched?"#333":"none","stroke-dasharray":sched?"4 2":"0"}));
    if(sched)b.appendChild(sv("rect",{x:x0,y:y,width:w,height:LH-3,rx:3,fill:"url(#hatch)","pointer-events":"none"}));
    if(w>40&&e.token_no!==null)b.appendChild(sv("text",{x:x0+4,y:y+LH-8,"font-size":11,fill:"#fff","pointer-events":"none"},"#"+e.token_no));
    const go=()=>start(e,tip);b.addEventListener("click",go);b.addEventListener("keydown",(k)=>{if(k.key==="Enter"||k.key===" "){k.preventDefault();go()}});
    g.appendChild(b);
  }
  if(doc.gaps.length){$("gh").hidden=false;const byId=Object.fromEntries(doc.encounters.map(e=>[e.id,e]));for(const x of doc.gaps){const li=document.createElement("li"),e=byId[x.id];li.textContent=(e?(e.token_no!==null?"#"+e.token_no+" ":"")+e.doctor+" "+hm(e.s)+"–"+hm(e.e):"encounter "+x.id)+" — "+(x.reason==="no_tape"?"no tape covers this time":"room unknown (no schedule slot / voice evidence)");$("gaps").appendChild(li)}}
}
const au=$("au");
function url(k){return "/api/drt/"+DATE+"/tape?k="+encodeURIComponent(k)}
function start(e,tip){
  $("player").hidden=false;$("ptitle").textContent=tip;
  if(!e.audio.length){play=null;au.pause();au.removeAttribute("src");$("pstat").textContent="No audio for this encounter.";$("pstat").className="err";return}
  $("pstat").className="mut";play={e:e,i:0};load();
}
function load(){
  const p=play.e.audio[play.i];$("pstat").textContent="piece "+(play.i+1)+" of "+play.e.audio.length;
  au.onloadedmetadata=()=>{au.currentTime=p.offset_s;au.play().catch(()=>{$("pstat").textContent="press play to start"})};
  au.src=url(p.key);au.load();
}
function next(){if(!play)return;const p=play.e.audio[play.i];if(play.i+1<play.e.audio.length){play.i++;load()}else{au.pause();$("pstat").textContent="end of encounter"}}
au.addEventListener("timeupdate",()=>{if(!play)return;const p=play.e.audio[play.i];if(au.currentTime>=p.offset_s+p.dur_s)next()});
au.addEventListener("ended",next);
au.addEventListener("error",()=>{if(play){$("pstat").textContent="audio failed to load";$("pstat").className="err"}});
</script></body></html>`;
