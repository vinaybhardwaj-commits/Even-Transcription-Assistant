"use strict";
/* Rating page (ruling 349): the 200-line label set and the 20-excerpt readability set. Talks only to same-origin /api/rate/*.
   Every doc is read through a whitelist; all text goes in with textContent (no innerHTML, no style attributes, no external requests).
   The rater is the Access identity, decided by the server; the client sends {label} or the rate20 answers, nothing else. */
const $=(s,r=document)=>r.querySelector(s);
const el=(t,a={},...k)=>{const e=document.createElement(t);for(const [x,v] of Object.entries(a)){if(v==null||v===false)continue;if(x==="class")e.className=v;else if(x.startsWith("on"))e.addEventListener(x.slice(2),v);else e.setAttribute(x,v===true?"":v)}for(const c of k.flat(Infinity)){if(c==null||c===false)continue;e.append(c instanceof Node?c:document.createTextNode(String(c)))}return e};
const main=$("main");
const INDIC=new Set(["kn","hi","ta","ml","bn","gu","te","mr","pa","or","as","ur"]);
const LANG={en:"English",hi:"Hindi",kn:"Kannada",ta:"Tamil",ml:"Malayalam",te:"Telugu",bn:"Bengali",gu:"Gujarati",mr:"Marathi",pa:"Punjabi",und:"Undetermined"};
/* label200 */
const LABELS=[["readable","Readable","Real speech in the claimed language"],["romanised_readable","Romanised readable","Indic in Latin letters, followable"],["garbled","Garbled","Nonsense, repeats, invented"],["wrong_language","Wrong language","Not the claimed language or script"],["unsure","Unsure","Cannot tell"]];
/* rate20: key, legend, hint, options [value,label] */
const RQ=[
 ["readable","Readable?","Could you follow what was said?",[["yes","Yes"],["partly","Partly"],["no","No"]]],
 ["useful","Useful?","Would this text help you understand the consult if you had not been there?",[["yes","Yes"],["little","A little"],["no","No"]]],
 ["wrong_lang","Wrong language?","Are any lines in a language or script that is not what was spoken?",[["no","No"],["some","Some lines"],["most","Most lines"]]],
 ["garbled","Garbled?","Words that make no sense, endless repeats, made-up sounding text.",[["none","None"],["some","Some"],["much","Much of it"]]]];
const REN=["english_right","English right?","Is the English underneath the lines a fair rendering of the line above it?",[["yes","Yes"],["no","No"]]];
const state={sets:[],set:null,items:[],mine:{},cur:0,follow:false,dirty:{},timers:{}};
try{state.follow=localStorage.getItem("rate-auto")==="1"}catch(e){}
const S=v=>typeof v==="string"?v:"";
const num=v=>Number.isFinite(+v)?+v:0;
const j=async(u,o)=>{const r=await fetch(u,Object.assign({credentials:"same-origin"},o||{}));if(!r.ok){const e=new Error(u+" "+r.status);e.status=r.status;throw e}return r};
const hasEn=it=>(it.lines||[]).some(l=>l.en);
const questions=it=>it.kind==="rate20"?RQ.concat(hasEn(it)?[REN]:[]):null;
function whitelist(set,d){
  d=d||{};
  if(set==="rate20")return{kind:"rate20",id:S(d.id),lines:(Array.isArray(d.lines)?d.lines:[]).map(l=>({t:S(l&&l.t),lang:S(l&&l.lang)||"und",text:S(l&&l.text),en:S(l&&l.en)})).filter(l=>l.text)};
  return{kind:"label200",id:S(d.id),n:num(d.n),lang:S(d.lang)||"und",dur_s:num(d.dur_s),text:S(d.text)};
}
function complete(it,a){
  if(!a)return false;
  if(it.kind==="rate20")return questions(it).every(q=>q[3].some(o=>o[0]===a[q[0]]));
  return LABELS.some(l=>l[0]===a.label);
}
const done=()=>state.items.filter(it=>complete(it,state.mine[it.id])).length;
const cur=()=>state.items[state.cur];

/* ---- header and progress ---- */
function head(){
  const nav=$("#sets");nav.replaceChildren(...state.sets.map(s=>el("a",{href:"#"+s.set,class:s.set===(state.set||"")?"on":null},s.set==="rate20"?"Rate 20 excerpts":s.set==="label200"?"Label "+s.n+" lines":s.set)));
}
function progress(){
  const n=state.items.length,d=done();
  $("#prog").textContent=d+" / "+n+(state.set==="rate20"?" rated":" labelled");
  $("#pfill").style.transform="scaleX("+(n?d/n:0)+")";
  const jmp=$("#jump");
  if(jmp){const want=state.items.map((it,i)=>(i+1)+(complete(it,state.mine[it.id])?" · done":"")).join("|");
    if(jmp.dataset.k!==want){jmp.replaceChildren(...state.items.map((it,i)=>el("option",{value:i},(i+1)+(complete(it,state.mine[it.id])?" · done":""))));jmp.dataset.k=want}
    jmp.value=String(state.cur)}
}

/* ---- one item ---- */
function radio(name,value,checked,label,extra){
  const inp=el("input",{type:"radio",name:name,value:value,id:"r-"+name+"-"+value});inp.checked=!!checked;
  return el("label",{class:"opt"},inp,el("span",{class:"b"},label,extra||null));
}
function linesBox(it){
  return el("div",{class:"tx",tabindex:"0",role:"region","aria-label":"Transcript excerpt"},it.lines.map(l=>el("div",{class:"ln"},
    el("span",{class:"ts"},"["+l.t+"]"),el("span",{class:"tt"},el("span",{class:"lg"},l.lang),l.text),
    INDIC.has(l.lang)?(l.en?el("span",{class:"en"},el("b",{},"English"),l.en):el("span",{class:"noen"},"No English for this line yet.")):null)));
}
function itemView(it){
  const a=state.mine[it.id]||{},i=state.cur,n=state.items.length;
  const note=el("textarea",{id:"note",placeholder:it.kind==="rate20"?"Anything specific: a line that is wrong, a language mix-up…":""});note.value=S(a.note);
  const card=el("div",{class:"card"},el("h2",{},(it.kind==="rate20"?"Excerpt ":"Line ")+(i+1)+" of "+n));
  if(it.kind==="rate20"){
    card.append(linesBox(it));
    questions(it).forEach(q=>card.append(el("fieldset",{},el("legend",{},q[1]),el("p",{class:"hint"},q[2]),
      el("div",{class:"opts"},q[3].map((o,k)=>radio(q[0],o[0],a[q[0]]===o[0],o[1]))))));
  }else{
    card.append(el("div",{class:"chips"},el("span",{},"Claimed language: ",el("b",{},LANG[it.lang]||it.lang)),it.dur_s?el("span",{},"Length: ",el("b",{},Math.round(it.dur_s)+" s")):null),
      el("blockquote",{class:"seg",tabindex:"0"},it.text),
      el("fieldset",{},el("legend",{},"What kind of text is this?"),el("div",{class:"opts five"},LABELS.map((l,k)=>radio("label",l[0],a.label===l[0],[l[1],el("kbd",{},String(k+1)),el("small",{},l[2])])))));
  }
  card.append(el("div",{},el("label",{class:"l",for:"note"},"Note (optional)"),note));
  return card;
}
function render(){
  progress();
  const it=cur(),p=$("#panel");
  if(!it){p.replaceChildren(el("p",{class:"empty"},state.loading?"Loading…":"Nothing to rate here yet."));$("#prev").disabled=true;$("#next").disabled=true;$("#nextopen").disabled=true;return}
  p.replaceChildren(itemView(it));
  $("#prev").disabled=state.cur<=0;$("#next").disabled=false;$("#next").textContent=state.cur>=state.items.length-1?"Done":"Next";
  $("#nextopen").disabled=false;$("#auto").checked=state.follow;progress();
}
function go(i){$("#status").textContent="";$("#status").className="status";$("#done").textContent="";state.cur=Math.max(0,Math.min(i,state.items.length-1));render();window.scrollTo(0,0)}
function goOpen(){const n=state.items.length;for(let k=1;k<=n;k++){const i=(state.cur+k)%n;if(!complete(state.items[i],state.mine[state.items[i].id])){go(i);return}}$("#done").textContent="Every item is done."}
function finish(){
  flush();
  const open=state.items.map((it,i)=>({it,i})).filter(x=>!complete(x.it,state.mine[x.it.id]));
  const box=$("#done");box.replaceChildren();
  if(!open.length){box.textContent="All items are done. Your answers are saved as you go; there is nothing to submit. Thank you.";return}
  box.append("Not finished yet. Still open: ");
  open.slice(0,40).forEach((x,k)=>{if(k)box.append(", ");box.append(el("button",{class:"link",onclick:()=>go(x.i)},String(x.i+1)))});
  if(open.length>40)box.append(" and "+(open.length-40)+" more");
  box.append(".");
}

/* ---- saving: PUT /api/rate/<set>/<id>, whole current answer of that item; the server stamps the rater and time ---- */
function payload(it){
  const a=state.mine[it.id]||{},o={};
  if(it.kind==="rate20"){questions(it).forEach(q=>{if(q[3].some(x=>x[0]===a[q[0]]))o[q[0]]=a[q[0]]})}
  else if(LABELS.some(l=>l[0]===a.label))o.label=a.label;
  if(a.note)o.note=a.note;
  return o;
}
function queueSave(it){
  state.dirty[it.id]=true;$("#status").textContent="Saving…";$("#status").className="status";
  clearTimeout(state.timers[it.id]);state.timers[it.id]=setTimeout(()=>flushOne(it),600);
}
async function flushOne(it){
  if(!state.dirty[it.id])return;delete state.dirty[it.id];
  const body=payload(it);if(!Object.keys(body).length)return;
  try{await j("/api/rate/"+state.set+"/"+encodeURIComponent(it.id),{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
    if(!Object.keys(state.dirty).length){$("#status").textContent="Saved";$("#status").className="status"}}
  catch(e){state.dirty[it.id]=true;$("#status").textContent=e.status===403?"You are not on the list of raters, so nothing can be saved.":"Couldn't save just now. Your answer is still on screen; change it to retry.";$("#status").className="status err"}
}
function flush(){for(const it of state.items){clearTimeout(state.timers[it.id]);flushOne(it)}}
function choose(name,value){
  const it=cur();if(!it)return;
  const a=state.mine[it.id]||(state.mine[it.id]={});
  if(it.kind==="rate20"){const q=questions(it).find(x=>x[0]===name);if(!q||!q[3].some(o=>o[0]===value))return;a[name]=value}
  else{if(name!=="label"||!LABELS.some(l=>l[0]===value))return;a.label=value}
  const r=$("#r-"+name+"-"+value);if(r)r.checked=true;
  progress();queueSave(it);
  if(state.follow&&complete(it,a))setTimeout(()=>{if(cur()&&cur().id===it.id){state.cur<state.items.length-1?go(state.cur+1):finish()}},350);
}

/* ---- loading a set ---- */
async function openSet(set){
  state.set=set;state.items=[];state.mine={};state.cur=0;state.loading=true;head();render();
  try{
    const docs=await (await j("/api/rate/"+set)).json();
    state.items=(Array.isArray(docs)?docs:[]).map(d=>whitelist(set,d)).filter(it=>it.id&&(it.kind==="rate20"?it.lines.length:it.text.trim()));
    if(set==="label200")state.items.sort((a,b)=>a.n-b.n||a.id.localeCompare(b.id));
    else state.items.sort((a,b)=>a.id.localeCompare(b.id));
    const mine=await (await j("/api/rate/"+set+"/mine")).json();
    const m=Array.isArray(mine)?Object.fromEntries(mine.filter(x=>x&&x.id).map(x=>[x.id,x])):(mine&&typeof mine==="object"?mine:{});
    for(const it of state.items){const x=m[it.id];if(!x)continue;const o={};
      if(it.kind==="rate20"){RQ.concat([REN]).forEach(q=>{if(typeof x[q[0]]==="string")o[q[0]]=x[q[0]]})}else if(typeof x.label==="string")o.label=x.label;
      if(typeof x.note==="string")o.note=x.note;state.mine[it.id]=o}
    state.loading=false;
    intro();
    const first=state.items.findIndex(it=>!complete(it,state.mine[it.id]));state.cur=first>=0?first:0;render();
  }catch(e){state.loading=false;$("#panel").replaceChildren(el("p",{class:"empty"},e.status===403?"You are not on the list of raters for this page.":"The items could not be loaded."))}
}
function intro(){
  const box=$("#intro");
  box.replaceChildren(state.set==="rate20"
   ?el("p",{class:"intro"},"Each item is a short stretch of a clinic conversation, as the transcript reader shows it: one line per spoken segment with its time, language and, where there is one, the English underneath. Read it, then answer the questions about the text itself. You are judging the transcript, not the doctor.")
   :el("p",{class:"intro"},"Each item is one line of a transcript, as a reader would see it, with the language the system claims for it. Decide what kind of text it is. You are judging the text, not the doctor; no audio is needed."),
   state.set==="rate20"
   ?el("details",{class:"how"},el("summary",{},"How to rate"),el("p",{},"Readable: could you follow what was said? Useful: would this help you understand the consult if you had not been there? Wrong language: lines shown in a language or script that is not what was spoken. Garbled: words that make no sense, endless repeats, or invented-sounding text. Your answers save as you go. On a computer, keys 1 to 3 answer the first open question, N or the right arrow moves on, P or the left arrow goes back."))
   :el("details",{class:"how"},el("summary",{},"What the five labels mean"),el("p",{},"Readable: real speech in the claimed language. Romanised readable: an Indic language written in Latin letters that a fluent reader can follow. Garbled: words that make no sense, endless repeats or invented text. Wrong language: text in a different language or script from the claimed one. Unsure: you cannot tell. Your labels save as you go, and you can change one until you finish. On a computer, keys 1 to 5 choose the label, N or the right arrow moves on, P or the left arrow goes back."))
  );
}

/* ---- events ---- */
main.addEventListener("change",e=>{const t=e.target;if(t.type==="radio")choose(t.name,t.value)});
main.addEventListener("input",e=>{const t=e.target,it=cur();if(it&&t.id==="note"){(state.mine[it.id]||(state.mine[it.id]={})).note=t.value;queueSave(it)}});
$("#prev").addEventListener("click",()=>{if(state.cur>0)go(state.cur-1)});
$("#next").addEventListener("click",()=>{if(state.cur<state.items.length-1)go(state.cur+1);else finish()});
$("#nextopen").addEventListener("click",goOpen);
$("#jump").addEventListener("change",e=>go(+e.target.value));
$("#auto").addEventListener("change",e=>{state.follow=e.target.checked;try{localStorage.setItem("rate-auto",state.follow?"1":"0")}catch(err){}});
document.addEventListener("keydown",e=>{
  const t=e.target,tag=t.tagName,type=t.type||"";
  if(tag==="TEXTAREA"||tag==="SELECT"||(tag==="INPUT"&&(type==="text"||type==="range"))||e.metaKey||e.ctrlKey||e.altKey)return;
  const k=e.key,it=cur();
  if(/^[1-5]$/.test(k)&&it){
    if(it.kind==="rate20"){if(+k>3)return;const a=state.mine[it.id]||{},q=questions(it).find(x=>!x[3].some(o=>o[0]===a[x[0]]));if(q&&q[3][+k-1]){choose(q[0],q[3][+k-1][0]);e.preventDefault()}}
    else{choose("label",LABELS[+k-1][0]);e.preventDefault()}
  }else if(k==="n"||(k==="ArrowRight"&&!(tag==="INPUT"&&type==="radio"))){if(state.cur<state.items.length-1)go(state.cur+1);e.preventDefault()}
  else if(k==="p"||(k==="ArrowLeft"&&!(tag==="INPUT"&&type==="radio"))){if(state.cur>0)go(state.cur-1);e.preventDefault()}
});
addEventListener("pagehide",flush);
addEventListener("hashchange",()=>{flush();const s=location.hash.replace(/^#/,"");if(state.sets.some(x=>x.set===s))openSet(s)});
(async()=>{
  try{state.sets=await (await j("/api/rate/sets")).json()}catch(e){main.replaceChildren(el("p",{class:"empty"},e.status===403?"You are not on the list of raters for this page.":"The rating sets could not be loaded."));return}
  state.sets=(Array.isArray(state.sets)?state.sets:[]).filter(s=>s&&typeof s.set==="string");
  const want=location.hash.replace(/^#/,"");
  const first=state.sets.some(x=>x.set===want)?want:(state.sets[0]&&state.sets[0].set);
  if(!first){head();main.replaceChildren(el("p",{class:"empty"},"No rating sets have been loaded yet."));return}
  openSet(first);
})();
