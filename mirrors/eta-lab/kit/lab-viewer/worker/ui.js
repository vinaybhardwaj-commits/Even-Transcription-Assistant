// The single-page UI. No third-party scripts, no analytics, no external requests. All transcript text is
// inserted with textContent, never innerHTML. Phone-first.
const CSS = `
:root{--bg:#fbfaf7;--fg:#1d1d1b;--mut:#6b6a63;--line:#dcd9cf;--acc:#0b5cab;--hi:#fff3bf;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecebe6;--mut:#a09f96;--line:#33332f;--acc:#7db4f0;--hi:#4a3f12;--card:#1e1e1c}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.45 system-ui,sans-serif}
header{position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--line);padding:8px 16px;z-index:5}
header h1{font-size:17px;margin:0 0 6px}nav a{margin-right:14px;color:var(--acc);text-decoration:none;font-weight:600}nav a.on{border-bottom:2px solid var(--acc)}
main{padding:12px 16px 90px;max-width:1100px;margin:0 auto}
label{display:block;font-size:13px;color:var(--mut)}input,select,button{font:inherit;color:inherit;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px;min-height:40px}
.filters{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;margin:8px 0}
.grid{overflow-x:auto}table{border-collapse:collapse;width:100%}th,td{border:1px solid var(--line);padding:6px 8px;font-size:14px;text-align:center;white-space:nowrap}
td.n a{display:block;color:var(--acc);font-weight:700;text-decoration:none}th:first-child,td:first-child{text-align:left;position:sticky;left:0;background:var(--bg)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin:8px 0}
.mut{color:var(--mut);font-size:13px}.chip{display:inline-block;border:1px solid var(--line);border-radius:99px;padding:0 8px;font-size:12px;margin-right:4px}
.warn{color:#b3261e}.turn{display:grid;grid-template-columns:auto 1fr;gap:4px 10px;border-bottom:1px solid var(--line);padding:8px 0}
.turn.now{background:var(--hi)}.turn .meta{font-size:12px;color:var(--mut)}.turn .txt{grid-column:1/3}.turn .en{color:var(--mut)}
.play{min-width:44px}.bar{position:fixed;bottom:0;left:0;right:0;background:var(--bg);border-top:1px solid var(--line);padding:8px 16px;display:flex;gap:10px;align-items:center}
.bar audio{flex:1;min-width:0;height:40px}pre{white-space:pre-wrap;word-break:break-word;font-size:12px}
@media(min-width:720px){.turn{grid-template-columns:auto 1fr 1fr}.turn .txt{grid-column:auto}}
`;

const JS = String.raw`
"use strict";
const $=(s,r=document)=>r.querySelector(s);
const el=(t,a={},...k)=>{const e=document.createElement(t);for(const [x,v] of Object.entries(a)){if(v==null)continue;if(x==="class")e.className=v;else if(x.startsWith("on"))e.addEventListener(x.slice(2),v);else e.setAttribute(x,v)}for(const c of k.flat())e.append(c instanceof Node?c:document.createTextNode(c??""));return e};
const main=$("main");
const state={rows:null,manifests:null,search:null,f:{from:"",to:"",room:"",lang:"",run:"",surg:"",doc:"",q:""}};
const j=async u=>{const r=await fetch(u,{credentials:"same-origin"});if(!r.ok)throw new Error(u+" "+r.status);return r};
async function loadIndex(){if(state.rows)return state.rows;try{const t=await (await j("/api/index")).text();state.rows=t.split("\n").filter(Boolean).map(l=>JSON.parse(l))}catch(e){state.rows=[]}return state.rows}
const ist=d=>isNaN(new Date(d))?"(no time)":new Date(d).toLocaleString("en-GB",{timeZone:"Asia/Kolkata",hour12:false,day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit",second:"2-digit"});
const mmss=s=>Math.floor(s/60)+":"+String(Math.floor(s%60)).padStart(2,"0");
const wkey=r=>r.key.replace(/^runs\//,"").replace(/\.json$/,"");

function setNav(p){document.querySelectorAll("nav a").forEach(a=>a.classList.toggle("on",a.dataset.p===p))}

function filtered(rows){const f=state.f;return rows.filter(r=>(!f.from||r.ist_date>=f.from)&&(!f.to||r.ist_date<=f.to)&&(!f.room||r.room_id===f.room)&&(!f.lang||(r.languages||[]).includes(f.lang))&&(!f.run||r.run_id===f.run)&&(!f.doc||(r.doctor||"").toLowerCase().includes(f.doc.toLowerCase()))&&(!f.surg||(f.surg==="yes"?r.has_surgery_candidate===true:f.surg==="no"?r.has_surgery_candidate===false:r.has_surgery_candidate===null)))}
const uniq=(rows,k)=>[...new Set(rows.map(r=>r[k]).filter(Boolean))].sort();
function sel(id,label,opts,val){return el("label",{},label,el("select",{id,onchange:e=>{state.f[id]=e.target.value;days()}},el("option",{value:""},"all"),opts.map(o=>el("option",{value:o,...(o===val?{selected:""}:{})},o))))}

async function days(){setNav("days");const rows=await loadIndex();const f=state.f;main.replaceChildren(el("p",{class:"mut"},"Loading…"));
 const fr=filtered(rows);const rooms=[...new Set(fr.map(r=>r.room_id))].sort();const dates=[...new Set(fr.map(r=>r.ist_date))].sort().reverse().slice(0,60);
 const cnt=new Map();for(const r of fr){const k=r.room_id+"|"+r.ist_date;(cnt.get(k)||cnt.set(k,new Set()).get(k)).add(r.window_id)}
 const tbl=el("table",{},el("tr",{},el("th",{},"room"),dates.map(d=>el("th",{},d.slice(5)))),rooms.map(rm=>el("tr",{},el("td",{},rm.replace("room_","")),dates.map(d=>{const n=cnt.get(rm+"|"+d);return n?el("td",{class:"n"},el("a",{href:"#/day/"+rm+"/"+d},String(n.size))):el("td",{},"")}))));
 main.replaceChildren(
  el("div",{class:"filters"},
   el("label",{},"from",el("input",{type:"date",value:f.from,onchange:e=>{f.from=e.target.value;days()}})),
   el("label",{},"to",el("input",{type:"date",value:f.to,onchange:e=>{f.to=e.target.value;days()}})),
   sel("room","room",uniq(rows,"room_id"),f.room),
   sel("lang","language",[...new Set(rows.flatMap(r=>r.languages||[]))].sort(),f.lang),
   sel("run","run",uniq(rows,"run_id"),f.run),
   el("label",{},"surgery candidate",el("select",{onchange:e=>{f.surg=e.target.value;days()}},["","yes","no","unknown"].map(v=>el("option",{value:v,...(v===f.surg?{selected:""}:{})},v||"any")))),
   el("label",{},"doctor",el("input",{value:f.doc,placeholder:"name",onchange:e=>{f.doc=e.target.value;days()}}))),
  el("form",{onsubmit:e=>{e.preventDefault();state.f.q=$("#q").value;search()}},el("label",{},"search (English or original text)",el("input",{id:"q",type:"search",value:f.q,style:"width:100%"}))),
  el("p",{class:"mut"},fr.length+" transcript files, "+new Set(fr.map(r=>r.window_id)).size+" windows"+(dates.length===60?" (newest 60 days shown)":"")+(rows.length?"":". No index has been published yet.")),
  el("div",{class:"grid"},tbl))}

async function dayList(room,date){setNav("days");const rows=(await loadIndex()).filter(r=>r.room_id===room&&r.ist_date===date);
 const by=new Map();for(const r of rows)(by.get(r.window_id)||by.set(r.window_id,[]).get(r.window_id)).push(r);
 main.replaceChildren(el("p",{},el("a",{href:"#/days"},"← days")),el("h2",{},room+" · "+date),
  [...by].sort().map(([w,rs])=>{rs.sort((a,b)=>(b.provenance_complete-a.provenance_complete)||(b.run_id>a.run_id?1:-1));const r=rs[0];
   return el("div",{class:"card"},el("a",{href:"#/win/"+wkey(r)},ist(r.start)+" → "+ist(r.end).slice(-8)),el("div",{class:"mut"},r.n_turns+" turns · "+r.n_words+" words · "+(r.languages||[]).join(", ")+(r.doctor?" · "+r.doctor:"")),
    el("div",{},rs.map(x=>el("a",{class:"chip",href:"#/win/"+wkey(x)},x.run_id+(x.provenance_complete?"":" (partial provenance)")))))}))}

let audio,chunks=[],segs=[],winStart=0,curChunk=-1,stopAt=null,base="",playingAll=false;
const absMs=t=>winStart+t*1000;
function chunkFor(ms){return chunks.findIndex(c=>ms>=c.s&&ms<c.e)}
function playAt(rel,end,all){const ms=absMs(rel);let i=chunkFor(ms);if(i<0){i=chunks.findIndex(c=>c.s>ms);if(i<0){note("No audio at this time.");return}}
 stopAt=end==null?null:absMs(end);playingAll=!!all;const off=Math.max(0,(Math.max(ms,chunks[i].s)-chunks[i].s)/1000);
 if(curChunk!==i){curChunk=i;audio.src=base+"/"+i;audio.addEventListener("loadedmetadata",()=>{audio.currentTime=off;audio.play()},{once:true});audio.load()}else{audio.currentTime=off;audio.play()}}
function note(t){$("#note").textContent=t}
function onTime(){if(curChunk<0)return;const ms=chunks[curChunk].s+audio.currentTime*1000;const rel=(ms-winStart)/1000;
 document.querySelectorAll(".turn").forEach((n,i)=>n.classList.toggle("now",segs[i]&&rel>=segs[i].start_s&&rel<segs[i].end_s));
 if(stopAt!=null&&ms>=stopAt){audio.pause();stopAt=null}}
function onEnded(){if(!playingAll||curChunk<0)return;const nx=curChunk+1;if(nx<chunks.length){playAt((chunks[nx].s-winStart)/1000,null,true)}}

async function win(key){setNav("days");main.replaceChildren(el("p",{class:"mut"},"Loading…"));
 let d;try{d=await (await j("/api/window/"+key)).json()}catch(e){main.replaceChildren(el("p",{class:"warn"},"Window not found."));return}
 const p=d.provenance||{};const parts=key.split("/");base="/audio/"+key;segs=d.segments||[];winStart=Date.parse(d.start);
 const sc=(p.source_chunks&&p.source_chunks.length?p.source_chunks:(p.source_audio_keys||[]).map(k=>({r2_key:k})));
 chunks=sc.map(c=>({s:Date.parse(c.started_at),e:c.ended_at?Date.parse(c.ended_at):Date.parse(c.started_at)+(c.duration_ms||0)}));const canPlay=chunks.length&&chunks.every(c=>!isNaN(c.s));
 curChunk=-1;
 const rows=segs.map((s,i)=>el("div",{class:"turn"},
   el("button",{class:"play",disabled:canPlay?null:"",title:"play this line",onclick:()=>playAt(s.start_s,s.end_s,false)},"▶"),
   el("div",{class:"meta"},mmss(s.start_s)+" – "+mmss(s.end_s)+" · "+ist(winStart+s.start_s*1000).slice(-8)+" · "+(d.doctor||s.doctor?"Dr "+(s.doctor||d.doctor)+" · ":"")+(s.speaker!=null?"speaker "+s.speaker:"speaker —")+" · "+(s.lang||"")),
   el("div",{class:"txt"},s.text||""),el("div",{class:"txt en"},s.text_en||(s.text_en===""?"":"— no English for this run"))));
 const dl=()=>{const u=URL.createObjectURL(new Blob([JSON.stringify(d,null,1)],{type:"application/json"}));const a=el("a",{href:u,download:parts[parts.length-1]+".json"});document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),2000)};
 audio=el("audio",{controls:"",preload:"none"});audio.addEventListener("timeupdate",onTime);audio.addEventListener("ended",onEnded);
 main.replaceChildren(el("p",{},el("a",{href:"#/day/"+parts[1]+"/"+parts[2]},"← "+parts[1]+" · "+parts[2])),el("h2",{},ist(d.start)+" → "+ist(d.end).slice(-8)),
  el("div",{class:"card"},el("div",{},el("span",{class:"chip"},p.run_id||""),el("span",{class:"chip"},p.producer||""),p.provenance_complete?"":el("span",{class:"chip warn"},"partial provenance")),
   el("div",{class:"mut"},"created "+(p.created_at||"?")+" · served by "+(d.served_by||d.router||"?")+" · "+(d.dominant_language||"")),
   el("details",{},el("summary",{},"provenance / stack"),el("pre",{},JSON.stringify(p,null,1))),el("button",{onclick:dl},"download JSON")),
  rows.length?rows:el("p",{class:"mut"},"No turns in this file."));
 document.body.append(el("div",{class:"bar",id:"bar"},el("button",{disabled:canPlay?null:"",onclick:()=>playAt(0,null,true)},"▶ window"),audio,el("span",{id:"note",class:"mut"},canPlay?"":"no audio source recorded")))}

async function runs(){setNav("runs");main.replaceChildren(el("p",{class:"mut"},"Loading…"));const rows=await loadIndex();let ms=[];try{ms=(await (await j("/api/manifests")).json()).runs}catch(e){}
 const by=new Map();for(const r of rows)(by.get(r.run_id)||by.set(r.run_id,{n:0,w:0,words:0,partial:0}).get(r.run_id));for(const r of rows){const x=by.get(r.run_id);x.n++;x.words+=r.n_words||0;if(!r.provenance_complete)x.partial++}
 const man=new Map(ms.map(m=>[m.run_id,m]));const ids=[...new Set([...by.keys(),...man.keys()])].sort().reverse();
 main.replaceChildren(el("h2",{},"Runs"),ids.map(id=>{const x=by.get(id),m=man.get(id);const s=m&&m.stack;
  return el("div",{class:"card"},el("b",{},id),el("div",{class:"mut"},(x?x.n+" files · "+x.words+" words":"not in index yet")+(m?" · "+m.status:"")+(x&&x.partial?" · "+x.partial+" with partial provenance":"")),
   s?el("div",{class:"mut"},"whisper "+String(s.whisper&&s.whisper.model).slice(0,40)+" · router "+String(s.router&&s.router.commit).slice(0,40)+" · stack sha "+String(m.stack_versions_sha256||"").slice(0,12)):el("div",{class:"mut"},"no stack recorded"),
   m&&m.addendum?el("div",{class:"mut warn"},"note: "+(m.addendum.temperature_fallback?"temperature_fallback = "+m.addendum.temperature_fallback+" · ":"")+m.addendum.reason):null,el("button",{onclick:()=>{state.f.run=id;location.hash="#/days"}},"show days for this run"))}))}

async function search(){setNav("days");const q=state.f.q.trim().toLowerCase();if(!q){days();return}
 main.replaceChildren(el("p",{},el("a",{href:"#/days"},"← days")),el("p",{class:"mut"},"Searching…"));
 if(!state.search){try{state.search=(await (await j("/api/search-index")).text()).split("\n").filter(Boolean).map(l=>JSON.parse(l))}catch(e){state.search=null;main.replaceChildren(el("p",{},el("a",{href:"#/days"},"← days")),el("p",{class:"warn"},"The search index has not been built yet (it is published nightly)."));return}}
 const hits=[];for(const r of state.search){const t=(r.text||"").toLowerCase(),e=(r.text_en||"").toLowerCase();const i=t.indexOf(q),k=e.indexOf(q);if(i>=0||k>=0){const src=k>=0?r.text_en:r.text,at=k>=0?k:i;hits.push({r,snip:src.slice(Math.max(0,at-50),at+q.length+80)});if(hits.length>=200)break}}
 main.replaceChildren(el("p",{},el("a",{href:"#/days"},"← days")),el("h2",{},"“"+state.f.q+"” — "+hits.length+(hits.length>=200?"+":"")+" windows"),hits.map(h=>el("div",{class:"card"},el("a",{href:"#/win/"+h.r.key.replace(/^runs\//,"").replace(/\.json$/,"")},h.r.room_id+" · "+h.r.ist_date+" · "+h.r.window_id),el("div",{class:"mut"},"…"+h.snip+"…"))))}

function router(){document.getElementById("bar")?.remove();if(audio){audio.pause();audio=null}const h=location.hash.replace(/^#\//,"").split("/");
 const go={days:()=>days(),runs:()=>runs(),day:()=>dayList(h[1],h[2]),win:()=>win(h.slice(1).join("/"))}[h[0]||"days"]||days;go().catch(e=>main.replaceChildren(el("p",{class:"warn"},"Something went wrong.")))}
addEventListener("hashchange",router);router();
`;

export function shell(nonce) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>ETA Lab Transcripts</title><style nonce="${nonce}">${CSS}</style></head><body><header><h1>ETA Lab Transcripts</h1><nav><a href="#/days" data-p="days">Days</a><a href="#/runs" data-p="runs">Runs</a></nav></header><main></main><script nonce="${nonce}">${JS}</script></body></html>`;
}
