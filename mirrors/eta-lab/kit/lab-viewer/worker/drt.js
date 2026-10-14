// DRTPQMA: Doc / Room / Time / PQM / Audio. Read-only page over drt/<date>.json (eta-lab-ratings) + tape audio (tapes/ in eta-lab-results).
// The Worker only ever reads: the doc via RATINGS.get, tape chunks via RESULTS.head/get (tapes/ prefix only) for keys LISTED IN THAT DAY'S DOC.
import { parseRange } from "./index.js";

const HDRS = { "cache-control": "private, no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cross-origin-resource-policy": "same-origin", "x-frame-options": "DENY" };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...HDRS, "content-type": "application/json" } });
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_~-]{0,63}$/;   // PQM uids; a split encounter is "<uid>~<n>"
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

function gapTimes(g, date) {
  const s = istSeconds(g.start, date), e = istSeconds(g.end, date);
  return s !== null && e !== null && e > s ? { s, e } : { s: null, e: null };
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
    for (const a of Array.isArray(e.audio) ? e.audio.slice(0, 24) : []) {
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
  const gaps = [], label = Object.fromEntries(rooms.map((r) => [r.room_id, r.label]));
  for (const g of Array.isArray(d.gaps) ? d.gaps.slice(0, 3000) : []) {
    if (!g || typeof g.id !== "string" || !ID.test(g.id)) continue;
    const cand = [];
    const cr = Array.isArray(g.candidate_rooms) ? g.candidate_rooms : g.candidate_rooms && typeof g.candidate_rooms === "object" ? Object.keys(g.candidate_rooms) : [];
    for (const c of cr.slice(0, 12)) {
      const id = typeof c === "string" ? c : c && typeof c === "object" ? c.room_id : null;
      const t = (typeof c === "object" && c ? str(c.label, 40) : "") || (typeof id === "string" ? label[id] || str(id, 40) : "");
      if (t && !cand.includes(t)) cand.push(t);
    }
    gaps.push({
      id: g.id, reason: REASONS.has(g.reason) ? g.reason : "room_unknown", doctor: str(g.doctor, 80) || null,
      token_no: Number.isInteger(g.token_no) ? g.token_no : null, ...gapTimes(g, date), candidate_rooms: cand,
    });
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
    const days = await listDays(env), latest = days.length ? days[days.length - 1] : null;
    return new Response(null, { status: 302, headers: { ...HDRS, location: latest ? `/drt/${latest}` : `/drt/${new Date(Date.now() + IST_MS).toISOString().slice(0, 10)}` } });
  }
  if (!date) return api ? json(200, { days: await listDays(env) }) : json(404, { error: "not found" });
  if (!api) return pageShell(DRT_PAGE.replaceAll("__DATE__", date), "drt");
  const doc = await loadDoc(env, date);
  if (!doc) return json(404, { error: "no drt file for this date yet" });
  if (tape) return serveTape(request, env, doc, url.searchParams.get("k"));
  return json(200, doc);
}

async function listDays(env) {
  const days = [];
  try {
    let cursor;
    for (let i = 0; i < 5; i++) {
      const l = await env.RATINGS?.list({ prefix: "drt/", cursor });
      for (const o of l?.objects ?? []) { const d = /^drt\/(\d{4}-\d{2}-\d{2})\.json$/.exec(o.key)?.[1]; if (d) days.push(d); }
      if (!l?.truncated) break;
      cursor = l.cursor;
    }
  } catch { /* an unreadable listing is an empty one */ }
  return [...new Set(days)].sort();
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
.scrub[hidden]{display:none}.scrub{display:flex;gap:10px;align-items:center;margin-top:6px}.scrub input{flex:1;min-width:0}.scrub button{font:inherit;padding:3px 10px;min-width:64px}.clk{font-variant-numeric:tabular-nums;font-size:13px}.mut{color:var(--mut);font-size:13px}.err{color:#b3261e}
.days{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin:6px 0}.days a,.days .dis{padding:2px 9px;border:1px solid var(--line);border-radius:12px;font-size:13px;text-decoration:none;color:var(--acc);background:var(--card)}
.days a[aria-current]{background:var(--acc);color:var(--bg);border-color:var(--acc);font-weight:600}.days .dis{color:var(--mut);opacity:.5}
details{margin:2px 0}summary{cursor:pointer}.cand{color:var(--mut)}
h2{font-size:14px;margin:16px 0 4px}ul{margin:4px 0;padding-left:20px}
</style></head><body>
<header><h1>Doc / Room / Time</h1><nav><a href="/">Days</a><a href="/timeline">Timeline</a><a href="/drt">Doc-Room-Time</a></nav></header>
<div class="bar"><label>Day <input type="date" id="d" value="__DATE__"></label><span class="mut" id="meta"></span></div>
<div class="days" id="days"></div>
<div class="legend" id="legend"></div>
<div id="msg" class="mut"></div>
<svg id="grid" role="img" aria-label="Rooms by time, one block per PQM encounter" hidden></svg>
<div class="player" id="player" hidden><div id="ptitle"></div><div class="mut" id="pstat"></div><div class="scrub" id="scrubrow" hidden><button type="button" id="pp">Pause</button><span id="pclk" class="clk">--:--:--</span><input type="range" id="scrub" min="0" max="1" step="1" value="0" aria-label="Position in encounter"><span class="clk" id="pend">--:--:--</span></div><audio id="au" preload="none"></audio><audio id="au2" preload="none"></audio></div>
<h2 id="gh" hidden>Not yet placed (room unknown)</h2><div id="gaps"></div>
<h2 id="nh" hidden>Placed, but no tape covers the time</h2><div id="notape"></div>
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
  const hs=document.createElement("span"),hk=sv("svg",{width:14,height:14,viewBox:"0 0 14 14"});hk.appendChild(sv("rect",{width:14,height:14,rx:3,fill:"none",stroke:"#888","stroke-dasharray":"3 2"}));hk.appendChild(sv("path",{d:"M0 14L14 0M-2 4L4 -2M10 16L16 10",stroke:"#888","stroke-width":1.5}));hs.append(hk,document.createTextNode("hatched: room from schedule only · solid: voice evidence"));lg.appendChild(hs);
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
  const byId=Object.fromEntries(doc.encounters.map(e=>[e.id,e]));
  const rows=(reason)=>doc.gaps.filter(x=>x.reason===reason).map(x=>{const e=byId[x.id]||{};return{doc:x.doctor||e.doctor||"Unknown doctor",tok:x.token_no!==null?x.token_no:(e.token_no!==undefined?e.token_no:null),s:x.s!==null?x.s:(e.s!==undefined?e.s:null),e:x.e!==null?x.e:(e.e!==undefined?e.e:null),cand:x.candidate_rooms}});
  grouped($("gh"),$("gaps"),rows("room_unknown"));grouped($("nh"),$("notape"),rows("no_tape"));
  showDays();
}
function grouped(head,box,rs){
  if(!rs.length)return;head.hidden=false;const by={};for(const r of rs)(by[r.doc]=by[r.doc]||[]).push(r);
  for(const n of Object.keys(by).sort()){
    const g=by[n].sort((a,b)=>(a.s===null?1e9:a.s)-(b.s===null?1e9:b.s)),d=document.createElement("details"),sm=document.createElement("summary");
    sm.textContent=n+" — "+g.length+(g.length===1?" encounter":" encounters");d.appendChild(sm);
    const ul=document.createElement("ul");
    for(const r of g){const li=document.createElement("li");li.textContent=(r.tok!==null?"#"+r.tok+" ":"")+(r.s!==null&&r.e!==null?hm(r.s)+"–"+hm(r.e):"time unknown");
      if(r.cand.length){const c=document.createElement("span");c.className="cand";c.textContent=" · candidate rooms: "+r.cand.join(", ");li.appendChild(c)}ul.appendChild(li)}
    d.appendChild(ul);box.appendChild(d);
  }
}
function showDays(){
  fetch("/api/drt").then((r)=>r.ok?r.json():null).then((j)=>{
    const ds=j&&Array.isArray(j.days)?j.days.filter(x=>/^\\d{4}-\\d{2}-\\d{2}$/.test(x)):[];if(!ds.length)return;
    const box=$("days"),WD=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
    const prev=ds.filter(x=>x<DATE).pop(),nxt=ds.find(x=>x>DATE);
    const nav=(t,d)=>{const e=document.createElement(d?"a":"span");e.textContent=t;if(d)e.href="/drt/"+d;else e.className="dis";return e};
    box.appendChild(nav("← prev day",prev));box.appendChild(nav("next day →",nxt));
    for(const d of ds){const a=document.createElement("a");a.href="/drt/"+d;a.textContent=d.slice(5)+" "+WD[new Date(d+"T00:00:00Z").getUTCDay()];if(d===DATE)a.setAttribute("aria-current","date");box.appendChild(a)}
  }).catch(()=>{});
}
function url(k){return "/api/drt/"+DATE+"/tape?k="+encodeURIComponent(k)}
function locate(audio,pos){
  const n=audio.length;let acc=0;
  for(let i=0;i<n;i++){const d=audio[i].dur_s;if(pos<acc+d||i===n-1)return{i:i,off:audio[i].offset_s+Math.min(Math.max(pos-acc,0),d),base:acc};acc+=d}
  return null;
}
const hms=(s)=>{s=Math.max(0,Math.round(s));return String(Math.floor(s/3600)).padStart(2,"0")+":"+String(Math.floor(s%3600/60)).padStart(2,"0")+":"+String(s%60).padStart(2,"0")};
const A=[$("au"),$("au2")],rng=$("scrub"),pp=$("pp");
let cur=0,playing=false,dragging=false;
const bad=()=>{$("pstat").textContent="audio failed to load";$("pstat").className="err"};
for(const el of A){
  el.addEventListener("timeupdate",()=>{if(!play||el!==A[cur])return;const p=play.e.audio[play.i];if(el.currentTime>=p.offset_s+p.dur_s)advance();else tick()});
  el.addEventListener("ended",()=>{if(play&&el===A[cur])advance()});
  el.addEventListener("error",()=>{if(play&&el===A[cur])bad()});
}
function prep(el,i){const p=play.e.audio[i];el.dataset.i=String(i);el.onloadedmetadata=()=>{el.currentTime=p.offset_s};el.src=url(p.key);el.load()}
function startEl(el,off){
  const go=()=>{el.currentTime=off;if(playing&&el===A[cur])el.play().catch(()=>{playing=false;pp.textContent="Play";$("pstat").textContent="press play to start"})};
  if(el.readyState>=1)go();else el.onloadedmetadata=go;
}
function activate(i,off){
  const nx=A[cur^1],was=A[cur];
  was.pause();was.onloadedmetadata=null;
  if(nx.dataset.i===String(i)&&nx.getAttribute("src")){cur^=1}else{prep(was,i)}
  const el=A[cur];startEl(el,off);play.i=i;
  if(i+1<play.e.audio.length&&A[cur^1].dataset.i!==String(i+1))prep(A[cur^1],i+1);
  tick(off);
}
function advance(){
  if(play.i+1<play.e.audio.length){const q=play.e.audio[play.i+1];activate(play.i+1,q.offset_s)}
  else{A[cur].pause();playing=false;pp.textContent="Play";$("pstat").textContent="end of encounter"}
}
function posOf(off){const p=play.e.audio[play.i];return play.cum[play.i]+Math.min(Math.max(off-p.offset_s,0),p.dur_s)}
function tick(off){
  if(!play)return;const pos=posOf(off===undefined?A[cur].currentTime:off);
  if(!dragging)rng.value=String(pos);
  showAt(dragging?Number(rng.value):pos);
}
function showAt(pos){
  $("pclk").textContent=hms(play.e.s+pos);
  const l=locate(play.e.audio,pos);$("pstat").className="mut";
  $("pstat").textContent="piece "+((l?l.i:0)+1)+" of "+play.e.audio.length;
}
function start(e,tip){
  $("player").hidden=false;$("ptitle").textContent=tip;
  for(const el of A){el.pause();el.removeAttribute("src");el.dataset.i=""}
  if(!e.audio.length){play=null;playing=false;$("scrubrow").hidden=true;$("pstat").textContent="No audio for this encounter.";$("pstat").className="err";return}
  const cum=[];let t=0;for(const a of e.audio){cum.push(t);t+=a.dur_s}
  play={e:e,i:0,cum:cum,total:t};playing=true;pp.textContent="Pause";
  $("scrubrow").hidden=false;rng.max=String(t);rng.value="0";$("pend").textContent=hms(e.s+t);
  $("pstat").className="mut";activate(0,e.audio[0].offset_s);
}
pp.addEventListener("click",()=>{if(!play)return;playing=!playing;pp.textContent=playing?"Pause":"Play";if(playing)A[cur].play().catch(bad);else A[cur].pause()});
rng.addEventListener("input",()=>{if(!play)return;dragging=true;showAt(Number(rng.value))});
rng.addEventListener("change",()=>{
  if(!play)return;dragging=false;const l=locate(play.e.audio,Number(rng.value));if(!l)return;
  if(l.i===play.i&&A[cur].readyState>=1){A[cur].currentTime=l.off;tick(l.off)}else activate(l.i,l.off);
});
</script></body></html>`;
