// The single-page UI (ruling 328): the TRANSCRIPT first, technical data collapsed at the bottom.
// No third-party scripts, no analytics, no external requests. All record text is inserted with textContent, never innerHTML. Phone-first.
const CSS = `
:root{--bg:#fbfaf7;--fg:#1d1d1b;--mut:#6b6a63;--line:#dcd9cf;--acc:#0b5cab;--hi:#fff3bf;--card:#fff;--warn:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecebe6;--mut:#a09f96;--line:#33332f;--acc:#7db4f0;--hi:#4a3f12;--card:#1e1e1c;--warn:#f2b8b5}}
*{box-sizing:border-box;min-width:0}body{overflow-wrap:anywhere;margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
header{position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--line);padding:8px 16px;z-index:5}
header h1{font-size:17px;margin:0 0 6px}nav a{margin-right:14px;color:var(--acc);text-decoration:none;font-weight:600}nav a.on{border-bottom:2px solid var(--acc)}
main{padding:12px 16px 90px;max-width:900px;margin:0 auto}
label{font-size:13px;color:var(--mut)}input,select,button{font:inherit;color:inherit;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px;min-height:40px}
.wide{width:100%}.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:8px 0}
.cov{font-size:13px;color:var(--mut);background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin:8px 0}.cov b{color:var(--fg)}
.date{margin:14px 0 4px;font-weight:700;font-size:17px}.dcov{font-size:12px;color:var(--mut);margin:0 0 4px}
.room{margin:10px 0 2px;font-weight:600;color:var(--acc)}
a.win{display:block;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--card);margin:4px 0;text-decoration:none;color:var(--fg)}
a.win .t{font-weight:600}a.win .m{color:var(--mut);font-size:13px}a.win .fw{margin-top:2px;overflow-wrap:anywhere}
.chip{display:inline-block;border:1px solid var(--line);border-radius:99px;padding:0 8px;font-size:12px;margin-left:6px;color:var(--mut)}.chip.warn{color:var(--warn);border-color:var(--warn)}
h2{margin:6px 0 2px;font-size:22px}.sub{color:var(--mut);margin:0 0 10px}
.seg{padding:6px 0;border-bottom:1px solid var(--line);overflow-wrap:anywhere}.seg .ts{color:var(--mut);font-variant-numeric:tabular-nums;margin-right:6px}.seg .lg{color:var(--mut);margin-right:6px}
.seg.ref{color:var(--mut);font-style:italic}.seg .why{font-size:12px;color:var(--warn);margin-left:6px;font-style:normal}.seg .en{color:var(--mut);margin-top:2px}.seg.now{background:var(--hi)}
.seg .play{min-width:36px;min-height:32px;padding:2px 6px;margin-right:8px}
.cline{padding:3px 0;overflow-wrap:anywhere}.cline .ts{color:var(--mut);font-variant-numeric:tabular-nums;margin-right:6px}.cline .lg{color:var(--mut);margin-right:6px}
.cline .en{margin:1px 0 4px 22px;color:var(--fg);opacity:.85}.cline .en:before{content:"↳ ";color:var(--mut)}.cline .orig{margin-left:22px;color:var(--mut);font-size:13px}
.cline.unc{color:var(--mut);font-style:italic}.cline.hit{background:var(--hi)}mark{background:var(--hi);color:inherit;padding:0 1px}
.cnote{padding:6px 10px;margin:8px 0;border-left:3px solid var(--line);color:var(--mut);font-size:14px}.cnote.warn{border-color:var(--warn)}
.uncgroup{margin:2px 0}.uncgroup button{font-size:12px;min-height:0;padding:0 8px;border-style:dashed;color:var(--mut);background:transparent;border-radius:99px}
.cstat{font-size:13px;color:var(--mut);margin:4px 0 8px}.roomrow{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;margin:10px 0 2px}.roomrow a.read{font-weight:600}
.notext{padding:12px;border:1px dashed var(--line);border-radius:8px;color:var(--mut);margin:10px 0}
.noaudio{color:var(--mut);font-size:14px;margin:8px 0}
details.tech{margin-top:26px;border-top:1px solid var(--line);padding-top:10px}details.tech summary{cursor:pointer;font-weight:600;color:var(--mut)}
.tech pre{white-space:pre-wrap;word-break:break-word;font-size:12px;max-height:60vh;overflow:auto}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin:8px 0}.mut{color:var(--mut);font-size:13px}.warn{color:var(--warn)}
.bar{position:fixed;bottom:0;left:0;right:0;background:var(--bg);border-top:1px solid var(--line);padding:8px 16px;display:flex;gap:10px;align-items:center}.bar audio{flex:1;min-width:0;height:40px}
`;

const JS = String.raw`
"use strict";
const $=(s,r=document)=>r.querySelector(s);
const el=(t,a={},...k)=>{const e=document.createElement(t);for(const [x,v] of Object.entries(a)){if(v==null)continue;if(x==="class")e.className=v;else if(x.startsWith("on"))e.addEventListener(x.slice(2),v);else e.setAttribute(x,v)}for(const c of k.flat(Infinity)){if(c==null||c===false)continue;e.append(c instanceof Node?c:document.createTextNode(String(c)))}return e};
const main=$("main");
// replaceChildren does not flatten arrays (it would stringify them); every page goes through this
const show=(...k)=>main.replaceChildren(...k.flat(Infinity).filter(x=>x!=null&&x!==false));
const state={rows:null,viewKey:null,counts:null,search:null,chunkIdx:null,onlyText:true,room:"",lang:"",open:{},q:""};
const j=async u=>{const r=await fetch(u,{credentials:"same-origin"});if(!r.ok)throw new Error(u+" "+r.status);return r};
const MON=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"],DOW=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const fmtDate=d=>{const t=new Date(d+"T00:00:00Z");return isNaN(t)?d:DOW[t.getUTCDay()]+" "+t.getUTCDate()+" "+MON[t.getUTCMonth()]+" "+t.getUTCFullYear()};
const mmss=s=>Math.floor(s/60)+":"+String(Math.floor(s%60)).padStart(2,"0");
const wkey=r=>r.key.replace(/^runs\//,"").replace(/\.json$/,"");
const STATUS={text:"",refused:"transcript discarded as unreliable",no_text:"no speech detected",no_signal:"no sound recorded (microphone silent)",untested:"not transcribed: silence unconfirmed",failed:"transcription failed"};
const SCORE={text:5,refused:4,no_text:3,no_signal:2,untested:2,failed:1};

async function loadRows(){
  if(state.rows)return state.rows;
  try{const r=await j("/api/view-index");state.viewKey=r.headers.get("x-vault-key")||"";
   const all=(await r.text()).split("\n").filter(Boolean).map(l=>JSON.parse(l));
   // the same window can appear in several runs (retries, backfill): keep the best record of each
   const best=new Map();for(const x of all){const k=x.start?x.room_id+"|"+x.start:x.key;const b=best.get(k);
    if(!b||(SCORE[x.status]||0)>(SCORE[b.status]||0)||((SCORE[x.status]||0)===(SCORE[b.status]||0)&&((x.complete?1:0)>(b.complete?1:0)||((x.complete?1:0)===(b.complete?1:0)&&x.run_id>b.run_id))))best.set(k,x)}
   state.rows=[...best.values()];state.byKey=new Map(all.map(x=>[x.key,x]));state.total=all.length;state.idxIds=new Set(all.map(x=>x.key.split("/")[2]+"/"+x.key.split("/").pop().replace(/\.json$/,"").replace(/\.attempt\d+$/,""))).size}catch(e){state.rows=[];state.byKey=new Map();state.total=0}
  return state.rows}
async function loadManifests(){if(!state.mf){try{state.mf=(await (await j("/api/manifests")).json()).runs}catch(e){state.mf=[]}}return state.mf}
async function loadCounts(){if(!state.counts){try{state.counts=await (await j("/api/vault-counts")).json()}catch(e){state.counts={by_date:{},run_files:0,hist_24sep_windows:0}}}return state.counts}
function setNav(p){document.querySelectorAll("nav a").forEach(a=>a.classList.toggle("on",a.dataset.p===p))}
const builtAt=()=>{const m=/view-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(state.viewKey||"");return m?(+m[3])+" "+MON[+m[2]-1]+" "+m[4]+":"+m[5]+" IST":"unknown"};

/* ---------------------------------------------------------------- Days */
function statusChip(x){return x.status==="text"?null:el("span",{class:"chip warn"},x.status==="untested"&&x.untested_kind==="transcribed_unconfirmed"?"transcribed, empty: exact-zero unconfirmed":(STATUS[x.status]||x.status))}
function winRow(x){
  const t=(x.t0?x.t0+"–"+(x.t1||"?"):"clip");
  return el("a",{class:"win",href:"#/win/"+wkey(x)},
    el("div",{},el("span",{class:"t"},t),el("span",{class:"m"}," · "+(x.lang||"language ?")+(x.status==="text"?" · "+x.n_words+" words":"")),statusChip(x),x.complete===false?el("span",{class:"chip"},"partial provenance"):null),
    x.first_words?el("div",{class:"fw"},x.first_words+(x.n_words>12?" …":"")):null)}
async function days(){
  setNav("days");show(el("p",{class:"mut"},"Loading…"));
  const rows=await loadRows(),counts=await loadCounts();
  const f=rows.filter(r=>(!state.room||r.room_name===state.room)&&(!state.lang||r.lang===state.lang));
  const hasText=d=>f.some(r=>r.ist_date===d&&r.status==="text");
  let dates=[...new Set(f.map(r=>r.ist_date))].sort().reverse();
  if(state.onlyText)dates=dates.filter(hasText); // only days with speech by default
  if(!state.autoOpened&&dates.length){state.autoOpened=true;state.open[dates[0]]=true} // land on the newest day with speech
  const rooms=[...new Set(rows.map(r=>r.room_name))].sort(),langs=[...new Set(rows.map(r=>r.lang).filter(Boolean))].sort();
  const nIdx=rows.length,nTxt=rows.filter(r=>r.status==="text").length,K=counts.run_files||0,nFiles=state.idxIds||0;
  const hist=counts.hist_24sep_windows||0;
  const cov=el("div",{class:"cov"},
    el("b",{},"Coverage. "),"Index built "+builtAt()+": ",el("b",{},String(nIdx))," windows indexed, ",el("b",{},String(nTxt))," with text. Windows with a run file in the vault: ",el("b",{},String(K)),
    K>nFiles?" ("+(K-nFiles)+" newer than the index, they appear after the next hourly refresh)":"",". ",
    hist<4507?"Last night's HIST mining (24 Sep, 4,507 windows): only "+hist+" are in the vault so far.":"Last night's HIST mining (24 Sep): all 4,507 windows are in the vault.");
  const box=el("div",{},dates.length?null:el("p",{class:"mut"},rows.length?"No days with speech match these filters.":"No index has been published yet."));
  for(const d of dates){
    const dr=f.filter(r=>r.ist_date===d),dt=dr.filter(r=>r.status==="text"),dk=(counts.by_date||{})[d]||0,open=state.open[d];
    const words=dt.reduce((n,r)=>n+(r.n_words||0),0);
    box.append(el("div",{class:"date"},el("a",{href:"#/days",onclick:e=>{e.preventDefault();state.open[d]=!open;days()}},(open?"▾ ":"▸ ")+fmtDate(d)),el("span",{class:"m"}," · "+words.toLocaleString()+" words")),
      el("div",{class:"dcov"},dr.length+" indexed · "+dt.length+" with text · "+dk+" run files in the vault"+(dk>dr.length?" · "+(dk-dr.length)+" not indexed yet":"")));
    if(!open)continue;
    const list=state.onlyText?dt:dr;
    const byRoom=new Map();for(const r of list){(byRoom.get(r.room_id)||byRoom.set(r.room_id,{name:r.room_name,ws:[]}).get(r.room_id)).ws.push(r)}
    for(const [rid,g] of [...byRoom].sort((a,b)=>a[1].name<b[1].name?-1:1)){
      const tw=g.ws.filter(r=>r.status==="text"),rw=tw.reduce((n,r)=>n+(r.n_words||0),0),lg=[...new Set(tw.map(r=>r.lang).filter(Boolean))].join(", "),rk=d+"|"+rid,ro=state.open[rk];
      box.append(el("div",{class:"roomrow"},el("span",{class:"room"},g.name),el("span",{class:"m"},rw.toLocaleString()+" words · "+tw.length+" windows"+(lg?" · "+lg:"")),
        el("a",{class:"read",href:"#/consult/"+rid+"/"+d},"Read the consult →"),
        el("a",{href:"#/days",class:"m",onclick:e=>{e.preventDefault();state.open[rk]=!ro;days()}},ro?"hide windows":"windows")));
      if(ro){g.ws.sort((a,b)=>(a.start||a.key)<(b.start||b.key)?-1:1);box.append(...g.ws.map(winRow))}
    }
  }
  show(el("div",{class:"row"},
     el("label",{},el("input",{type:"checkbox",...(state.onlyText?{checked:""}:{}),onchange:e=>{state.onlyText=e.target.checked;days()}})," only days and windows with speech"),
     el("select",{"aria-label":"room",onchange:e=>{state.room=e.target.value;days()}},el("option",{value:""},"all rooms"),rooms.map(x=>el("option",{value:x,...(x===state.room?{selected:""}:{})},x))),
     el("select",{"aria-label":"language",onchange:e=>{state.lang=e.target.value;days()}},el("option",{value:""},"all languages"),langs.map(x=>el("option",{value:x,...(x===state.lang?{selected:""}:{})},x)))),
   el("form",{onsubmit:e=>{e.preventDefault();state.q=$("#q").value;search()}},el("input",{id:"q",type:"search",class:"wide",placeholder:"search all the text (English or original)",value:state.q})),
   cov,box)}

/* ---------------------------------------------------------------- Window */
let audio,chunks=[],segs=[],winStart=0,curChunk=-1,stopAt=null,base="",playingAll=false;
const absMs=t=>winStart+t*1000;
function chunkFor(ms){return chunks.findIndex(c=>ms>=c.s&&ms<c.e)}
function playAt(rel,end,all){const ms=absMs(rel);let i=chunkFor(ms);if(i<0){i=chunks.findIndex(c=>c.s>ms);if(i<0){note("No audio at this time.");return}}
 stopAt=end==null?null:absMs(end);playingAll=!!all;const off=Math.max(0,(Math.max(ms,chunks[i].s)-chunks[i].s)/1000);
 if(curChunk!==i){curChunk=i;audio.src=base+"/"+i;audio.addEventListener("loadedmetadata",()=>{audio.currentTime=off;audio.play().catch(()=>{})},{once:true});audio.load()}else{audio.currentTime=off;audio.play().catch(()=>{})}}
function note(t){const n=$("#note");if(n)n.textContent=t}
function onTime(){if(!audio||curChunk<0)return;const ms=chunks[curChunk].s+audio.currentTime*1000;const rel=(ms-winStart)/1000;
 document.querySelectorAll(".seg").forEach((n,i)=>n.classList.toggle("now",!!segs[i]&&rel>=segs[i].start_s&&rel<segs[i].end_s));
 if(stopAt!=null&&ms>=stopAt){audio.pause();stopAt=null}}
function onEnded(){if(!audio||!playingAll||curChunk<0)return;const nx=curChunk+1;if(nx<chunks.length)playAt((chunks[nx].s-winStart)/1000,null,true)}

const ACR=new Set(["opd","ipd","ot","icu","er","ct","mri","nicu","ed","gh"]);
const prettyRoom=slug=>slug.replace(/-[a-z0-9]{4}$/,"").split("-").filter(Boolean).map(t=>ACR.has(t)?t.toUpperCase():t.charAt(0).toUpperCase()+t.slice(1)).join(" ");
// for a window the hourly index does not list yet: the room name comes from the audio keys in the record itself, the times from start/end
function roomFromRecord(d){const p=d.provenance||{};const keys=[...((p.source_chunks||[]).map(c=>c&&c.r2_key)),...((d.cut&&d.cut.chunk_keys)||[]),...(p.source_audio_keys||[])];
 for(const k of keys){const m=/^bench\/([^/]+)\//.exec(k||"");if(m)return prettyRoom(m[1])}return null}
const istHM=iso=>{const t=new Date(iso);return isNaN(t)?null:t.toLocaleTimeString("en-GB",{timeZone:"Asia/Kolkata",hour:"2-digit",minute:"2-digit",hour12:false})};
// the segments of a record: hist writers keep them at the top level, the parity writer under payload
const segmentsOf=d=>Array.isArray(d.segments)?d.segments:(d.payload&&Array.isArray(d.payload.segments)?d.payload.segments:[]);
const isObj=x=>x&&typeof x==="object"&&!Array.isArray(x);
const UNTESTED={near_silence:"Not transcribed. This window was skipped as \"no signal\", but its recording is near-silent, not digital zero: it holds low-level signal, and only a transcription can tell whether there is speech in it. The skip was on the wrong signature and the window has not been transcribed yet.",
  transcribed_unconfirmed:"Transcribed, and the transcription came back empty. This window is on the exact-zero (no-signal) list, but that mark is unconfirmed (its short chunks cannot be judged by size alone), so it is not shown as a recording fault.",
  undetermined:"Not transcribed. This window was skipped as exact-zero by chunk size, but that is unconfirmed (short chunks cannot be judged by size alone). It has not been transcribed."};
function whyEmpty(d,row,all,addNoSignal,untested){
  if(untested)return UNTESTED[untested]||UNTESTED.undetermined;
  const st=d.state||(d.payload&&d.payload.state),err=d.error||(d.payload&&d.payload.error);
  if((row&&row.no_signal)||st==="no_signal"||addNoSignal)return "No sound recorded (microphone silent). Every chunk of this window's recording is exact zero, so there was nothing to transcribe.";
  if(d.ok===false||st==="failed")return "No transcript: the transcription failed"+(err?" ("+String(err).slice(0,120)+")":"")+".";
  if(all.length&&all.every(s=>s.refused)){ // ruling 333: said plainly, in one line
    const reasons=[...new Set(all.map(s=>s.refused_reason).filter(Boolean))].join(", ")||"text guard";
    const kept=all.some(s=>typeof s.text==="string"&&s.text.trim());
    return "Transcript discarded as unreliable (guard: "+reasons+")."+(kept?" The discarded text is shown above in grey.":" The discarded text was not kept.")}
  return row?"No transcript: this record has no segments, so no speech was detected in this window.":"Not yet indexed. This window is newer than the hourly index, so it has not been checked for silence: it has no transcript, but that does not mean there was no sound. It will be classified after the next hourly refresh."}
async function win(key){
  setNav("days");show(el("p",{class:"mut"},"Loading…"));
  let d;try{d=await (await j("/api/window/"+key)).json()}catch(e){show(el("p",{class:"warn"},"Window not found."));return}
  await loadRows();const vkey="runs/"+key+".json";const row=(state.byKey&&state.byKey.get(vkey))||null;
  const p=d.provenance||{},parts=key.split("/"),payload=isObj(d.payload)?d.payload:{};
  segs=segmentsOf(d).filter(isObj);winStart=Date.parse(d.start);base="/audio/"+key;
  // audio: the record's own chunks, else the chunks the cut used (timed by the chunk index), else a single stored clip
  let sc;
  if(p.source_chunks&&p.source_chunks.length)sc=p.source_chunks;
  else{const keys=(d.cut&&d.cut.chunk_keys&&d.cut.chunk_keys.length)?d.cut.chunk_keys:(p.source_audio_keys||[]);
   if(keys.length>1||(keys.length===1&&!isNaN(winStart))){if(!state.chunkIdx){try{state.chunkIdx=new Map((await (await j("/api/chunks-index")).text()).split("\n").filter(Boolean).map(l=>{const r=JSON.parse(l);return [r.r2_key,r]}))}catch(e){state.chunkIdx=new Map()}}}
   sc=keys.map(k=>(state.chunkIdx&&state.chunkIdx.get(k))||{r2_key:k})}
  if(sc.length===1&&isNaN(Date.parse(sc[0].started_at))){winStart=0;sc=[{r2_key:sc[0].r2_key,started_at:new Date(0).toISOString(),ended_at:new Date(1e13).toISOString()}]} // one stored clip: transcript times are seconds from its start
  chunks=sc.map(c=>({s:Date.parse(c.started_at),e:c.ended_at?Date.parse(c.ended_at):Date.parse(c.started_at)+(c.duration_ms||0)}));
  const hasAudio=sc.length>0,canPlay=hasAudio&&chunks.every(c=>!isNaN(c.s));curChunk=-1;
  const lang=d.dominant_language||payload.dominant_language||(row&&row.lang)||"?";
  const engines=[...new Set(segs.map(s=>s.engine).filter(Boolean))];
  const goodN=segs.filter(s=>!s.refused&&typeof s.text==="string"&&s.text.trim()).length;
  let untested=row&&row.untested_kind||null;
  if(!untested&&goodN===0&&!segs.length){ // owners' corrections of the exact-zero mark live in addenda (any run's), keyed by window id
    try{const wid=d.window_id||parts[parts.length-1];
      try{const cw=(await (await j("/api/corrections/"+encodeURIComponent(parts[1])+"/"+encodeURIComponent(parts[2]))).json()).windows||{};if(cw[wid])untested=cw[wid]}catch(e){} // kind=correction files (r341) override the older addendum carriers
      if(!untested)for(const m of await loadManifests()){const a=m.addendum;if(!a)continue;
      if(Array.isArray(a.near_silence_full_chunk_window_ids)&&a.near_silence_full_chunk_window_ids.includes(wid)){untested="near_silence";break}
      if(Array.isArray(a.transcribed_unconfirmed_window_ids)&&a.transcribed_unconfirmed_window_ids.includes(wid)){untested="transcribed_unconfirmed";break}
      if(Array.isArray(a.short_chunk_off_band_window_ids)&&a.short_chunk_off_band_window_ids.includes(wid))untested="undetermined"}}catch(e){}}
  let addNoSignal=false;
  if(!untested&&goodN===0&&!segs.length&&!(row&&row.no_signal)){ // not depending on the hourly index: the run's own addendum lists its NO_SIGNAL windows (either shape)
    try{const runs=await loadManifests(),m=runs.find(x=>x.run_id===p.run_id),a=m&&m.addendum;
     const ids=a?(Array.isArray(a.no_signal_window_ids)?a.no_signal_window_ids:(a.no_signal&&Array.isArray(a.no_signal.window_ids)?a.no_signal.window_ids:[])):[];
     addNoSignal=ids.includes(d.window_id||parts[parts.length-1])}catch(e){}}
  const rid=d.room_id||parts[1];
  const room=row?row.room_name:(roomFromRecord(d)||(/^bs_/.test(rid)?"Parity clip (room not recorded)":rid));
  const t0=row?row.t0:istHM(d.start),t1=row?row.t1:istHM(d.end);
  const lines=segs.map((s,i)=>{
    const ref=!!s.refused,txt=typeof s.text==="string"?s.text:"";
    return el("div",{class:"seg"+(ref?" ref":"")},
      canPlay?el("button",{class:"play",title:"play this line","aria-label":"play line "+(i+1),onclick:()=>playAt(s.start_s,s.end_s,false)},"▶"):null,
      el("span",{class:"ts"},"["+mmss(s.start_s||0)+"–"+mmss(s.end_s||0)+"]"),el("span",{class:"lg"},"("+(s.lang||"?")+")"),txt||(ref?"(no text)":""),
      ref?el("span",{class:"why"},"refused"+(s.refused_reason?": "+s.refused_reason:"")):null,
      s.text_en?el("div",{class:"en"},s.text_en):null)});
  const wholeEn=(d.transcript_english||d.transcript_en||payload.transcript_english||"");
  const noLineEn=!segs.some(s=>s.text_en);
  const dl=()=>{const u=URL.createObjectURL(new Blob([JSON.stringify(d,null,1)],{type:"application/json"}));const a=el("a",{href:u,download:parts[parts.length-1]+".json"});document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),2000)};
  const tech=Object.assign({},d);for(const k of ["segments","transcript_native","transcript_native_collapsed","transcript_english","transcript_en","language_timeline"])delete tech[k];
  if(tech.payload){tech.payload=Object.assign({},tech.payload);for(const k of ["segments","transcript_native","transcript_english","language_timeline"])delete tech.payload[k]}
  audio=el("audio",{controls:"",preload:"none"});audio.addEventListener("timeupdate",onTime);audio.addEventListener("ended",onEnded);
  show(el("p",{},el("a",{href:"#/days"},"← all days")),
   el("h2",{},room),
   el("p",{class:"sub"},(row?fmtDate(row.ist_date):parts[2])+(t0?" · "+t0+"–"+(t1||"?")+" IST":" · time not recorded")+" · language "+lang+(engines.length?" · engine "+engines.join(", "):"")+((!untested&&((row&&row.no_signal)||addNoSignal))?" · no sound recorded (microphone silent)":"")+(untested?(untested==="transcribed_unconfirmed"?" · transcribed, empty":" · not transcribed"):"")),
   lines,
   goodN===0?el("div",{class:"notext"},whyEmpty(d,row,segs,addNoSignal,untested)):null,
   wholeEn&&noLineEn?el("div",{class:"seg"},el("div",{class:"mut"},"English (whole window)"),el("div",{},wholeEn)):null,
   hasAudio?(canPlay?null:el("p",{class:"noaudio"},"Audio is stored, but its timing is not available for this window.")):el("p",{class:"noaudio"},"No audio stored for this window."),
   el("details",{class:"tech"},el("summary",{},"Technical details"),
     el("p",{class:"mut"},"Vault key: "+vkey+(p.run_id?" · run "+p.run_id:"")+(p.producer?" · "+p.producer:"")+(p.provenance_complete===false?" · partial provenance"+(p.incomplete_reason?": "+p.incomplete_reason:""):"")),
     el("button",{onclick:dl},"download full JSON"),el("pre",{},JSON.stringify(tech,null,1))));
  if(hasAudio&&canPlay)document.body.append(el("div",{class:"bar",id:"bar"},el("button",{onclick:()=>playAt(0,null,true)},"▶ window"),audio,el("span",{id:"note",class:"mut"})))}

/* ---------------------------------------------------------------- Consult (ruling 337a) */
const INDIC=new Set(["kn","hi","ta","te","ml","bn","gu","mr","pa","or","as","ur"]);
const latinShare=t=>{let l=0,n=0;for(const c of t){if(/\p{L}/u.test(c)){n++;if(/[A-Za-z]/.test(c))l++}}return n?l/n:0};
const repeatLoop=t=>{const w=t.toLowerCase().split(/\s+/).filter(Boolean);let run=1;for(let i=1;i<w.length;i++){run=w[i]===w[i-1]?run+1:1;if(run>=5)return true}return false};
// provisional readability rule; a measured per-segment flag (337c) from the vault replaces it whenever there is one
function isUnclear(s){
  if(s.flag&&typeof s.flag.ok==="boolean")return s.flag.ok===false&&s.flag.collapse===true; // measured flag: a line collapses only where its owner says the precision floor passed; otherwise it is just marked
  if(s.refused)return true;const t=(s.text||"").trim();if(!t)return true;
  if(s.lang==="und")return true;
  if(INDIC.has(s.lang)&&latinShare(t)>0.6)return true; // romanised "Indic": garble
  if(repeatLoop(t))return true;
  return false}
const hms=ms=>new Date(ms).toLocaleTimeString("en-GB",{timeZone:"Asia/Kolkata",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false});
const WINNOTE={refused:"Transcript discarded as unreliable.",no_text:"no speech detected.",no_signal:"No sound recorded (microphone silent).",untested:"not transcribed: silence unconfirmed.",failed:"transcription failed."};
const hl=(t,q)=>{if(!q)return t;const out=[];const lo=t.toLowerCase();let i=0,k;while((k=lo.indexOf(q,i))>=0){if(k>i)out.push(t.slice(i,k));out.push(el("mark",{},t.slice(k,k+q.length)));i=k+q.length}if(i<t.length)out.push(t.slice(i));return out};
async function consult(room,date,at){
  setNav("days");show(el("p",{class:"mut"},"Loading the consult…"));
  let c;state.cc=state.cc||{};const cck=room+"|"+date;try{const hit=state.cc[cck];if(hit&&Date.now()-hit.at<60000)c=hit.c;else{c=await (await j("/api/consult/"+encodeURIComponent(room)+"/"+encodeURIComponent(date))).json();state.cc[cck]={at:Date.now(),c}}}catch(e){show(el("p",{},el("a",{href:"#/days"},"← all days")),el("p",{class:"warn"},"This room and day could not be loaded."));return}
  const segs=c.segments,cs=state.cs=state.cs||{};const ck=room+"|"+date;const st=cs[ck]||(cs[ck]={open:{},q:""});
  const nonEn=x=>x.lang&&x.lang!=="en"&&!x.refused&&x.text.trim();
  // build the ordered stream: text segments (unclear ones grouped) and one plain line for every window that has no speech
  const items=[];
  // one stream, strictly in time order: the lines (kept windows, and the uncovered minutes of a partly hidden one) and one plain note per window that has no speech or is hidden
  const bySeg=new Map();for(const x of segs){(bySeg.get(x.w)||bySeg.set(x.w,[]).get(x.w)).push(x)}
  const short=r=>String(r||"another run").replace(/^hist-(bulk|miner)-/,"");
  c.windows.forEach((w,wi)=>{
    const ws=bySeg.get(wi)||[];
    if(w.partial){items.push({t:w.s,note:w.t0+"–"+w.t1+" · also transcribed by "+short(w.run_id)+" ("+w.n_words+" words); it overlaps windows shown elsewhere, so only its minutes not shown there are listed. Open it",warn:false,k:w.k});}
    else if(!ws.length){items.push({t:w.s,note:w.t0+"–"+w.t1+" · "+(WINNOTE[w.status]||"no text."),warn:w.status!=="no_text",k:w.k});return}
    else if(!ws.some(x=>!x.refused&&x.text.trim())){items.push({t:w.s,note:w.t0+"–"+w.t1+" · "+WINNOTE.refused,warn:true,k:w.k});return}
    for(const x of ws){if(!x.refused&&!x.text.trim())continue;items.push({t:x.t,s:x,u:isUnclear(x)})}
  });
  for(const w of (c.hidden||[]))items.push({t:w.s,note:w.t0+"–"+w.t1+" · also transcribed by "+short(w.run_id)+" ("+(w.status==="text"?w.n_words+" words":(WINNOTE[w.status]||"no text").replace(/\.$/,""))+"); hidden here because it overlaps a window shown. Open it",warn:false,k:w.k});
  items.sort((a,b)=>a.t-b.t); // stable: notes and lines of the same instant keep their order
  const q=(st.q||"").toLowerCase();
  const matches=[];const out=[];let i=0,gid=0;
  const renderSeg=(x,dim)=>{
    const shown=x.re&&x.re.better&&x.re.text2?x.re.text2:x.text,lang=(x.re&&x.re.better&&x.re.lang2)||x.lang||"?";
    const hit=q&&((shown+" "+(x.en||"")+" "+x.text).toLowerCase().includes(q));
    const line=el("div",{class:"cline"+(dim?" unc":"")+(hit?" hit":""),"data-t":String(x.t)},
      el("span",{class:"ts"},"["+hms(x.t)+"]"),el("span",{class:"lg"},"("+lang+")"),...(q?hl(shown||"(no text)",q):[shown||"(no text)"]),
      dim&&x.refused?el("span",{class:"why"},"refused"+(x.why?": "+x.why:"")):null,
      x.flag&&x.flag.ok===false&&!dim?el("span",{class:"why"}," [unclear]"):null,
      nonEn(x)&&x.en?el("div",{class:"en"},...(q?hl(x.en,q):[x.en]),x.enq?el("span",{class:"why"}," (machine translation flagged: "+(typeof x.enq==="string"?x.enq:"unreliable")+")"):null):null,
      nonEn(x)&&!x.en&&x.enerr?el("div",{class:"orig"},"(English translation failed: "+x.enerr+")"):null,
      x.re&&x.re.better&&x.re.text2?el("div",{class:"orig"},"original: "+x.text):null);
    if(hit)matches.push(line);return line};
  while(i<items.length){
    const it=items[i];
    if(it.note){out.push(el("div",{class:"cnote"+(it.warn?" warn":"")},el("a",{href:"#/win/"+it.k},it.note)));i++;continue}
    if(!it.u){out.push(renderSeg(it.s,false));i++;continue}
    const grp=[];while(i<items.length&&items[i].s&&items[i].u){grp.push(items[i].s);i++}
    const g="g"+(gid++),anyHit=q&&grp.some(x=>((x.text||"")+" "+(x.en||"")).toLowerCase().includes(q)),open=st.open[g]||anyHit||st.all;
    out.push(el("div",{class:"uncgroup"},el("button",{onclick:()=>{st.open[g]=!open;consultRender()}},(open?"hide unclear lines (":"show unclear lines (")+grp.length+")"),...(open?grp.map(x=>renderSeg(x,true)):[])));
  }
  function consultRender(){consult(room,date,null)}
  const nUn=items.filter(x=>x.s&&x.u).length,firstT=segs.length?hms(segs[0].t):null,lastT=segs.length?hms(segs[segs.length-1].t):null;
  const langs=[...new Set(segs.filter(x=>!x.refused&&x.text.trim()).map(x=>x.lang).filter(Boolean))].join(", ");
  show(el("p",{},el("a",{href:"#/days"},"← all days")),
   el("h2",{},c.room_name),
   el("p",{class:"sub"},fmtDate(date)+(firstT?" · "+firstT.slice(0,5)+"–"+lastT.slice(0,5)+" IST":"")+" · "+c.counts.windows+" windows"+(c.counts.hidden_windows?" (+"+c.counts.hidden_windows+" overlapping, hidden)":"")+" · "+c.counts.words.toLocaleString()+" words"+(langs?" · "+langs:"")),
   c.counts.non_english?el("div",{class:"cstat"},"English is available for "+c.counts.with_english+" of "+c.counts.non_english+" non-English lines"+(c.counts.with_english<c.counts.non_english?" (the rest are still being translated).":".")):null,
   el("form",{onsubmit:e=>{e.preventDefault();st.q=$("#cq").value;consultRender()}},el("div",{class:"row"},el("input",{id:"cq",type:"search",class:"wide",placeholder:"search this consult",value:st.q||"",style:null}),el("button",{type:"submit"},"search"))),
   q?el("div",{class:"cstat"},matches.length+" lines match “"+st.q+"”"+(matches.length?" (first match scrolled into view)":"")):null,
   nUn?el("div",{class:"cstat"},nUn+" unclear lines are collapsed. ",el("a",{href:"#/consult/"+room+"/"+date,onclick:e=>{e.preventDefault();st.all=!st.all;consultRender()}},st.all?"collapse them again":"show all unclear lines")):null,
   out.length?out:el("div",{class:"notext"},"There is no speech recorded for this room on this day."),
   el("p",{class:"mut"},c.counts.segments+" lines · index "+(c.view_key||"").replace("index/","")));
  const target=matches[0]||(at?[...document.querySelectorAll(".cline")].find(n=>{const t=hms(+n.dataset.t);return t>=at}):null);
  if(target)target.scrollIntoView({block:"center"})}

/* ---------------------------------------------------------------- Runs (technical) */
async function runs(){setNav("runs");show(el("p",{class:"mut"},"Loading…"));const rows=await loadRows();const ms=await loadManifests();
 const by=new Map();for(const r of [...state.byKey.values()]){const x=by.get(r.run_id)||by.set(r.run_id,{n:0,text:0}).get(r.run_id);x.n++;if(r.status==="text")x.text++}
 const man=new Map(ms.map(m=>[m.run_id,m]));const ids=[...new Set([...by.keys(),...man.keys()])].filter(Boolean).sort().reverse();
 show(el("h2",{},"Runs"),el("p",{class:"mut"},"Technical view: every run of the speech-to-text stack."),
  ids.map(id=>{const x=by.get(id),m=man.get(id),s=m&&m.stack;
   return el("div",{class:"card"},el("b",{},id),el("div",{class:"mut"},(x?x.n+" windows · "+x.text+" with text":"not in the index yet")+(m?" · "+m.status:"")),
    s?el("div",{class:"mut"},"whisper "+String(s.whisper&&s.whisper.model).slice(0,40)+" · router "+String(s.router&&s.router.commit).slice(0,40)):el("div",{class:"mut"},"no stack recorded"),
    m&&m.addendum?el("div",{class:"mut warn"},"note: "+(m.addendum.temperature_fallback?"temperature_fallback = "+m.addendum.temperature_fallback+" · ":"")+m.addendum.reason):null)}))}

/* ---------------------------------------------------------------- Search */
async function search(){setNav("days");const q=state.q.trim().toLowerCase();if(!q){days();return}
 show(el("p",{},el("a",{href:"#/days"},"← all days")),el("p",{class:"mut"},"Searching…"));
 await loadRows();
 if(!state.search){try{state.search=(await (await j("/api/search-index")).text()).split("\n").filter(Boolean).map(l=>JSON.parse(l))}catch(e){state.search=null;show(el("p",{},el("a",{href:"#/days"},"← all days")),el("p",{class:"warn"},"The search index has not been built yet."));return}}
 const hits=[];for(const r of state.search){const t=(r.text||"").toLowerCase(),e=(r.text_en||"").toLowerCase();const i=t.indexOf(q),k=e.indexOf(q);if(i>=0||k>=0){const src=k>=0?r.text_en:r.text,at=k>=0?k:i;hits.push({r,snip:src.slice(Math.max(0,at-50),at+q.length+80)});if(hits.length>=200)break}}
 show(el("p",{},el("a",{href:"#/days"},"← all days")),el("h2",{},"“"+state.q+"”: "+hits.length+(hits.length>=200?"+":"")+" windows"),
  hits.map(h=>{const v=state.byKey.get(h.r.key);return el("a",{class:"win",href:"#/win/"+h.r.key.replace(/^runs\//,"").replace(/\.json$/,"")},
   el("div",{},el("span",{class:"t"},(v?v.room_name:h.r.room_id)),el("span",{class:"m"}," · "+fmtDate(h.r.ist_date)+(v&&v.t0?" · "+v.t0:""))),el("div",{class:"fw"},"…"+h.snip+"…"),v&&v.room_id&&v.t0?el("div",{class:"m"},el("a",{href:"#/consult/"+v.room_id+"/"+h.r.ist_date+"/"+v.t0+":00"},"read in the consult →")):null)}))}

function router(){document.getElementById("bar")?.remove();if(audio){audio.pause();audio=null}const h=location.hash.replace(/^#\//,"").split("/");
 const go={days:()=>days(),runs:()=>runs(),consult:()=>consult(h[1],h[2],h[3]),win:()=>win(h.slice(1).join("/"))}[h[0]||"days"]||days;go().catch(e=>show(el("p",{class:"warn"},"Something went wrong.")))}
addEventListener("hashchange",router);router();
fetch("/api/me").then(r=>r.json()).then(m=>{if(m&&m.rater){const n=document.querySelector("nav");for(const [t,u] of [["Label lines","/rate/label200"],["Rate excerpts","/rate/rate20"]])n.append(el("a",{href:u},t))}}).catch(()=>{}); // the two raters (r349) get links to the rating pages
`;

export function shell(nonce) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>ETA Lab Transcripts</title><style nonce="${nonce}">${CSS}</style></head><body><header><h1>ETA Lab Transcripts</h1><nav><a href="#/days" data-p="days">Days</a><a href="#/runs" data-p="runs">Runs</a></nav></header><main></main><script nonce="${nonce}">${JS}</script></body></html>`;
}
