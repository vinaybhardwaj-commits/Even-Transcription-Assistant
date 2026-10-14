#!/usr/bin/env python3
"""Assemble page.html for the chain check from the surgery page's tested blocks (CSS, transcript, audio, player) plus the
chain-specific code below. Run:  python3 build_page.py [surgery-page.html]  (default: ../surgery-review/v2-page.html).
The output page.html is what gets published; this script only exists so the reused blocks stay byte-identical to the
surgery page's. Reused blocks are cut by the marker comments/line starts below and the script fails loudly if one moves."""
import re, sys, pathlib

here = pathlib.Path(__file__).parent
src = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else here.parent / "surgery-review" / "v2-page.html"
L = src.read_text().split("\n")

def find(prefix, start=0):
    for i in range(start, len(L)):
        if L[i].startswith(prefix):
            return i
    raise SystemExit("marker not found: " + prefix)

def block(start_prefix, end_prefix, include_end=False):
    a = find(start_prefix)
    b = find(end_prefix, a + 1)
    return "\n".join(L[a:b + (1 if include_end else 0)])

head_end = find('<div class="wrap">')
head = "\n".join(L[:head_end]).replace("<title>Surgery Advice Labels</title>", "<title>Chain Check</title>")
extra_css = """
.rx{margin:0;padding:12px 14px;border-left:4px solid var(--acc);background:var(--soft);border-radius:0 8px 8px 0;white-space:pre-wrap;overflow-wrap:anywhere;font-family:var(--sans)}
.rxmeta{font-size:.8rem;color:var(--mut);margin:6px 0 0}
dl.facts{margin:0;display:grid;grid-template-columns:minmax(0,max-content) minmax(0,1fr);gap:6px 14px}
dl.facts dt{font-weight:600;color:var(--mut);font-size:.85rem}
dl.facts dd{margin:0;overflow-wrap:anywhere}
.cardh{font-size:1rem;margin:0 0 6px}
.opt span{min-height:48px;display:inline-flex;align-items:center}
.qrow{border-top:1px solid var(--line);padding-top:12px;margin-top:12px}
.qrow:first-child{border-top:0;padding-top:0;margin-top:0}
@media (max-width:560px){dl.facts{grid-template-columns:1fr}dl.facts dt{margin-top:6px}}
</style>"""
head = head.replace("</style>", extra_css, 1)

reuse = [
    block("const SPK=", "const CUT="),
    block("const LANG=", "let db=null"),
    'const $=id=>document.getElementById(id);',
    block("const esc=s=>", "const cap=") ,
    block("const cap=", "const lab="),
    block("const noMotion=", "\n") if False else [l for l in L if l.startswith("const noMotion=")][0],
    block("const mmss=", "function stText") if False else "\n".join(L[find("const mmss="):find("const hasTurn=") + 1]),
    "\n".join(L[find("/* Audio hosting."):find("function playTurn(")]),
    "\n".join(L[find("// Language attribute for the original text"):find("/* Whole-consult audio:") ]),
    "\n".join(L[find("/* Whole-consult audio:"):find("const qsHtml=")]),
]
reused = "\n".join(r for r in reuse if r)

new_body = r'''<div class="wrap">
  <header class="bar" id="hdr">
    <div class="bar-row">
      <h1>Chain Check</h1>
      <span class="prog" id="prog">0 / 0 checked</span>
      <span class="meta" id="who"></span>
    </div>
    <div class="tabs" role="tablist" id="tabs" hidden>
      <button class="tab" role="tab" id="tab-check" aria-selected="true">My checks</button>
      <button class="tab" role="tab" id="tab-res" aria-selected="false">Results</button>
    </div>
    <nav class="chips" id="chips" aria-label="Chains"></nav>
  </header>

  <section id="view-check">
    <p class="intro">Each screen is one prescription, what happened to the patient afterwards, and the recording of one visit. Read the prescription, listen to or read the visit, then answer three short questions about it.</p>
    <details class="howto"><summary>How to check</summary>
      <p>First question: is this recording the visit that produced this prescription? Say Not sure if you cannot tell. If yes or not sure, the second question asks whether the operation that was later done is discussed in the conversation. If it is, the third asks whether it was proposed in this visit or earlier. Tap a time stamp in the transcript to hear from there. Greyed turns are outside the consult. Your answers save as you go and only you see them here.</p></details>
    <div class="panel" id="panel"><p class="empty">Loading the chains…</p></div>
    <div class="nav">
      <button class="btn ghost" id="prev">Previous</button>
      <button class="btn" id="next">Next</button>
    </div>
    <div class="status" id="status" aria-live="polite"></div>
    <div class="status" id="done" aria-live="polite"></div>
  </section>

  <section id="view-res" hidden>
    <p class="intro">Every rater's answers, side by side. Only you (the page owner) see this tab.</p>
    <div class="card" id="res"><p class="empty">No answers yet.</p></div>
  </section>
</div>

<script>
/* Chain check (P2). Chain docs (collection "chains") are read through a whitelist: id, date, rx{text,created_at,author}, facts[{label,value}],
   encounter{start_s,end_s}, audio_full{src,t0_s,duration_s}, turns[] (i,start_s,end_s,speaker,lang,orig,en,outside,earlier,phase,window,speaker_basis).
   Nothing else in a doc (a linker verdict, a link score, the class) is ever kept or shown, whatever the doc holds.
   Answers are saved to checks/<rater id> = {rater, schema, c:{<chainId>:{same, disc, when, note, ts}}}. */
let db=null,user=null,meId=null,owner=false,claudeOk=false,loaded=false;
let chains=[],sigs={},cur=null,mine={c:{}},all=[];
let saveTimer=null,saving=Promise.resolve(),dirty=false;
let allOrig=false;const origOpen=new Set();
const fnv=s=>{let h=2166136261;for(const ch of String(s)){h^=ch.charCodeAt(0);h=Math.imul(h,16777619)}return h>>>0};
const QS=[
  {f:"same",q:"Is this recording the visit that produced this prescription?",o:["yes","no","unsure"],L:{yes:"Yes",no:"No",unsure:"Not sure"}},
  {f:"disc",q:"Is the operation that was later done discussed in the conversation?",o:["yes","no"],L:{yes:"Yes",no:"No"}},
  {f:"when",q:"Was it proposed in this visit, or earlier?",o:["this_visit","earlier","not_proposed"],L:{this_visit:"In this visit",earlier:"Earlier, not in this visit",not_proposed:"Not proposed at all"}}
];
const visible=a=>{const v=[QS[0]];if(a.same==="yes"||a.same==="unsure"){v.push(QS[1]);if(a.disc==="yes")v.push(QS[2])}return v};
const A=id=>mine.c[id]||(mine.c[id]={});
const isDone=c=>{const a=mine.c[c.id]||{};return visible(a).every(q=>!!a[q.f])};
const started=c=>{const a=mine.c[c.id]||{};return QS.some(q=>a[q.f])};
const curC=()=>chains.find(x=>x.id===cur);
const idx=c=>chains.indexOf(c)+1;
function progress(){$("prog").textContent=chains.filter(isDone).length+" / "+chains.length+" checked"}
function chips(){
  $("chips").innerHTML=chains.map((c,i)=>{const s=isDone(c)?" done":started(c)?" part":"";
    return `<button class="chip${s}" data-go="${esc(c.id)}" aria-current="${c.id===cur}" title="${isDone(c)?"Checked":started(c)?"Started":"Not started"}">${i+1}</button>`}).join("");
}
'''
new_body += "\n" + reused + "\n" + r'''
function qsHtml(c){
  const a=mine.c[c.id]||{};
  return visible(a).map(q=>`<fieldset class="qrow"><legend>${esc(q.q)}</legend><div class="opts">${q.o.map(v=>
    `<label class="opt"><input type="radio" id="${q.f}-${v}" name="${q.f}" value="${v}"${a[q.f]===v?" checked":""}><span>${esc(q.L[v])}</span></label>`).join("")}</div></fieldset>`).join("");
}
function chainHtml(c){
  const a=mine.c[c.id]||{};
  const rx=c.rx||{};
  const meta=[rx.created_at&&("Written "+rx.created_at),rx.author&&("by "+rx.author)].filter(Boolean).join(" ");
  const turns=c.turns||[];
  const last=turns.reduce((x,t)=>Math.max(x,+t.end_s||0),0);
  return `<div class="chead"><h2>Chain ${idx(c)} of ${chains.length} <span class="tok">${esc(fmtDate(c.date))}</span></h2></div>
  <section class="card" aria-label="Prescription"><h3 class="cardh">Prescription</h3>
    <pre class="rx">${esc(rx.text||"")}</pre>${meta?`<p class="rxmeta">${esc(meta)}</p>`:""}</section>
  ${(c.facts||[]).length?`<section class="card" aria-label="What happened later"><h3 class="cardh">What happened later</h3><dl class="facts">${c.facts.map(f=>`<dt>${esc(f.label)}</dt><dd>${esc(f.value)}</dd>`).join("")}</dl></section>`:""}
  <section class="card" aria-label="Your answers"><h3 class="cardh">Your answers</h3><div id="qs" data-keys="${visible(a).map(q=>q.f).join()}">${qsHtml(c)}</div>
    <div class="foot"><label for="note" style="display:block;font-size:.85rem;font-weight:600;margin-bottom:4px">Note (optional)</label>
    <textarea id="note" data-k="${esc(c.id)}" data-f="note">${esc(a.note||"")}</textarea></div></section>
  ${playerHtml(c)}
  <section aria-label="Transcript"><div class="ts-head"><h3>Visit transcript</h3><div class="ts-tools">
    <label for="all-orig"><input type="checkbox" id="all-orig"${allOrig?" checked":""}> Show all originals</label></div></div>
    <div class="turns">${turns.length?turnsHtml(c,turns):`<p class="empty">This chain has no transcript.</p>`}</div>
    <div class="meta" style="margin-top:6px">${turns.length} turns${last?" · "+mmss(last)+" long":""}</div></section>`;
}
function render(){
  stopAudio();resetFull();chips();progress();
  const c=curC();
  if(!c){
    $("panel").innerHTML=`<p class="empty">${!claudeOk?"Open this page while signed in to claude.ai to check chains.":loaded?"No chains have been added yet.":"Loading the chains…"}</p>`;
    $("prev").disabled=true;$("next").disabled=true;return;
  }
  $("panel").innerHTML=chainHtml(c);plUi();syncStick();
  const ps=(fullOf(c)||{}).src;if(ps&&rangeOK===null)probeRange(ps).then(()=>plUi());
  const i=chains.indexOf(c);
  $("prev").disabled=i<=0;$("next").disabled=false;$("next").textContent=i>=chains.length-1?"Done":"Next";
}
function go(id){stopAudio();cur=id;$("status").textContent="";$("done").textContent="";render();window.scrollTo({top:0,behavior:"instant"})}
function queueSave(){dirty=true;$("status").textContent="Saving…";clearTimeout(saveTimer);saveTimer=setTimeout(flush,700)}
function flush(){
  if(!db||!meId||!dirty||!loaded)return;dirty=false;
  const body=JSON.parse(JSON.stringify({rater:meId,schema:1,c:mine.c,updated:new Date().toISOString()}));
  saving=saving.then(()=>db.doc("checks/"+meId).set(body)).then(()=>{$("status").textContent="Saved"}).catch(e=>{
    $("status").textContent=e&&e.code==="invalid_argument"?"You have view-only access, so your answers can't be saved. Ask the page owner for access.":"Couldn't save just now. Your answers are still on screen; change any answer to retry.";dirty=true;
  });
}
function setAnswer(f,v){
  const c=curC();if(!c)return;
  const a=A(c.id);a[f]=v;a.ts=new Date().toISOString();
  if(f==="same"&&v==="no"){delete a.disc;delete a.when}      // a chain that is not the right visit has nothing more to ask
  if(f==="disc"&&v==="no")delete a.when;
  const ae=document.activeElement,fid=ae&&ae.id;
  $("qs").innerHTML=qsHtml(c);$("qs").dataset.keys=visible(a).map(q=>q.f).join();
  const n=fid&&$(fid);if(n)n.focus();
  chips();progress();queueSave();
}
document.addEventListener("click",e=>{
  const t=e.target,g=t.closest("[data-go]");if(g){go(g.dataset.go);return}
  const c=curC();if(!c)return;
  const ob2=t.closest("[data-oblock]");
  if(ob2){setFold(ob2,ob2.getAttribute("aria-expanded")!=="true");return}
  const sk=t.closest("[data-seek]");
  if(sk){playFull(c,+sk.dataset.seek);return}
  if(t.closest("#pl-play")){if(full.playing)pauseFull();else playFull(c,full.audio?null:full.pos);return}
  if(t.closest("#pl-back")){setPos(c,getPos()-10);return}
  if(t.closest("#pl-fwd")){setPos(c,getPos()+10);return}
  if(t.closest("#pl-rate")){full.rate=RATES[(RATES.indexOf(full.rate)+1)%RATES.length];if(full.audio)full.audio.playbackRate=full.rate;plUi();return}
  const ob=t.closest("[data-orig]");
  if(ob){
    const k=ob.dataset.orig,p=ob.nextElementSibling,open=p.hidden;
    p.hidden=!open;open?origOpen.add(k):origOpen.delete(k);
    ob.setAttribute("aria-expanded",open);ob.textContent=open?"Hide original":"Show original";
  }
});
$("prev").onclick=()=>{const i=chains.findIndex(c=>c.id===cur);if(i>0)go(chains[i-1].id)};
$("next").onclick=()=>{
  const i=chains.findIndex(c=>c.id===cur);
  if(i<chains.length-1)go(chains[i+1].id);
  else{flush();
    const open=chains.map((c,k)=>({c,k})).filter(x=>!isDone(x.c));
    $("done").innerHTML=open.length
      ?"Not finished yet. Your answers save as you go, so there is nothing to submit. Still open: "+open.map(x=>`<button class="link" data-go="${esc(x.c.id)}">${x.k+1}</button>`).join(", ")+"."
      :"All chains are checked. Your answers are saved automatically; there is nothing to submit. Thank you.";}
};
document.addEventListener("change",e=>{
  const t=e.target;
  if(t.id==="pl-follow"){follow=t.checked;return}
  if(t.id==="all-orig"){
    allOrig=t.checked;
    document.querySelectorAll("[data-orig]").forEach(b=>{const p=b.nextElementSibling,open=allOrig||origOpen.has(b.dataset.orig);
      p.hidden=!open;b.setAttribute("aria-expanded",open);b.textContent=open?"Hide original":"Show original"});return;
  }
  if(t.type==="radio"&&QS.some(q=>q.f===t.name))setAnswer(t.name,t.value);
});
document.addEventListener("input",e=>{
  const t=e.target,c=curC();
  if(t.id==="pl-seek"){if(c)setPos(c,+t.value);return}
  if(c&&t.id==="note"){A(c.id).note=t.value;queueSave()}
});

/* ---- owner: results ---- */
async function renderRes(){
  const ids=all.map(r=>r.rater);let names={};
  try{names=user&&user.profiles?await user.profiles(ids):{}}catch(e){}
  const nm=id=>(names[id]&&names[id].name)||"Rater";
  if(!all.length){$("res").innerHTML=`<p class="empty">No answers yet.</p>`;return}
  const T={same:{},disc:{},when:{}};
  const cell=a=>!a?"—":visible(a).map(q=>a[q.f]?esc(q.L[a[q.f]]):"…").join(" · ");
  let compared=0,agreed=0;
  const rows=chains.map((c,i)=>{
    const ans=all.map(r=>((r.c||{})[c.id])).filter(a=>a&&QS.some(q=>a[q.f]));
    if(!ans.length)return"";
    ans.forEach(a=>QS.forEach(q=>{if(a[q.f])T[q.f][a[q.f]]=(T[q.f][a[q.f]]||0)+1}));
    let cmp="—";
    if(ans.length>=2){compared++;const same=new Set(ans.map(a=>a.same)).size===1;if(same)agreed++;cmp=`<span class="pill ${same?"ok":"warn"}">${same?"same visit verdict":"differ"}</span>`}
    return `<tr><td class="tok">${i+1} · ${esc(c.id)}</td>${all.map(r=>`<td>${cell((r.c||{})[c.id])}${((r.c||{})[c.id]||{}).note?` <span class="meta">(note)</span>`:""}</td>`).join("")}<td>${cmp}</td></tr>`;
  }).join("");
  const tally=q=>QS.find(x=>x.f===q).o.map(v=>QS.find(x=>x.f===q).L[v]+" "+(T[q][v]||0)).join(", ");
  $("res").innerHTML=`<h3 style="margin:0">Raters: ${all.length}</h3><p class="meta">${all.map(r=>esc(nm(r.rater))).join(", ")}</p>
    <p class="meta"><b>Same visit?</b> ${tally("same")}. <b>Operation discussed?</b> ${tally("disc")}. <b>Proposed when?</b> ${tally("when")}. Chains with two or more raters: ${compared}, same visit verdict on ${agreed}.</p>
    <details open><summary>Every checked chain</summary><div class="table-wrap"><table><thead><tr><th>Chain</th>${all.map(r=>`<th>${esc(nm(r.rater))}</th>`).join("")}<th>Compare</th></tr></thead><tbody>${rows}</tbody></table></div></details>`;
}
function tab(which){
  $("tab-check").setAttribute("aria-selected",which==="check");$("tab-res").setAttribute("aria-selected",which==="res");
  $("view-check").hidden=which!=="check";$("view-res").hidden=which!=="res";$("chips").hidden=which!=="check";
  if(which==="res")renderRes();
}
$("tab-check").onclick=()=>tab("check");$("tab-res").onclick=()=>tab("res");
render();
(async()=>{
  if(!window.claude||!window.claude.use)return;
  claudeOk=true;render();
  [db,user]=await Promise.all([claude.use("db"),claude.use("user")]);
  if(user){try{const me=await user.me();meId=me.id;owner=me.isOwner;$("who").textContent=me.name?("Checking as "+me.name):"";}catch(e){}}
  if(!db){render();return}
  if(!meId)$("status").textContent="Sign in to claude.ai to save your answers.";
  const num=v=>Number.isFinite(+v)?+v:0;
  db.collection("chains").onSnapshot(s=>{
    // whitelist: nothing but these fields is ever kept
    const next=s.docs.filter(d=>d.exists!==false).map(d=>{const x=d.data()||{};
      const af=x.audio_full,src=af&&(typeof af==="string"?af:af.src);
      return{id:String(x.id??d.id??""),date:String(x.date??""),
        rx:{text:String((x.rx&&x.rx.text)??""),created_at:String((x.rx&&x.rx.created_at)??""),author:String((x.rx&&x.rx.author)??"")},
        facts:(Array.isArray(x.facts)?x.facts:[]).filter(f=>f&&f.label!=null).map(f=>({label:String(f.label),value:String(f.value??"")})),
        audio_full:src?{src:String(src),t0_s:num(af.t0_s),duration_s:num(af.duration_s)}:null,
        turns:(Array.isArray(x.turns)?x.turns:[]).map(t=>({i:num(t.i),start_s:num(t.start_s),end_s:num(t.end_s),speaker:String(t.speaker??""),lang:String(t.lang??"en"),
          orig:String(t.orig??""),en:String(t.en??""),outside:t.outside===true,earlier:t.earlier===true,phase:t.phase,window:t.window,speaker_basis:t.speaker_basis}))}})
      .filter(x=>x.id).sort((a,b)=>fnv(a.id)-fnv(b.id)||a.id.localeCompare(b.id)); // one fixed scrambled order for every rater
    const ns={};next.forEach(x=>ns[x.id]=JSON.stringify(x));
    const listChanged=Object.keys(ns).join()!==Object.keys(sigs).join(),curChanged=!!cur&&sigs[cur]!==ns[cur];
    chains=next;sigs=ns;
    if(!chains.some(c=>c.id===cur)){cur=chains[0]?chains[0].id:null;render()}
    else if(listChanged||curChanged)render();else{chips();progress()}
  },()=>{});
  if(meId){try{const d=await db.doc("checks/"+meId).get();if(d.exists){const c=(d.data()||{}).c||{};
    Object.keys(c).forEach(k=>{mine.c[k]=Object.assign({},c[k],mine.c[k]||{})});render()}}catch(e){}}
  loaded=true;render();if(dirty)flush();
  if(owner){$("tabs").hidden=false;
    db.collection("checks").onSnapshot(s=>{all=s.docs.filter(d=>d.exists!==false).map(d=>d.data());if(!$("view-res").hidden)renderRes()},()=>{});
  }
})();
window.addEventListener("pagehide",flush);
window.addEventListener("resize",syncStick);
document.addEventListener("pointerdown",e=>{if(e.target.id==="pl-seek")scrubbing=true});
["pointerup","pointercancel"].forEach(n=>document.addEventListener(n,()=>{scrubbing=false}));
if(window.ResizeObserver&&$("hdr"))new ResizeObserver(syncStick).observe($("hdr"));
</script>
'''
out = head + "\n" + new_body
out = out.replace("<script>\n", "<script>\n", 1)
(here / "page.html").write_text(out)
print("wrote page.html", len(out), "bytes")
