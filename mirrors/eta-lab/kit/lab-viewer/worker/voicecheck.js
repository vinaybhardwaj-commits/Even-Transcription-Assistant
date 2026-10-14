// HUMAN VOICE CHECK (Fable #6248 / V's page spec #6261): V listens to the clips of each mined VOICE (one card per voice, headed by a proposed
// doctor name) and says who it is. Bucket eta-lab-ratings only.
//   READS   voicecheck/<run>/items.json and voicecheck/<run>/audio/<clip>.m4a
//   WRITES  voicecheck-rec/<run>/<annotator-hash>/<card|_submit>/<ms>-<rand>.json, APPEND-ONLY: one new object per save, nothing is ever overwritten or deleted.
// Any Access-authenticated user may annotate; the annotator is the verified Access email (never a form field), stored only in the records and the export.
// Each annotator's own view is derived from their own records (latest per card). The export (raters only) pages through everyone's records.
// Blinding: items.json is reduced to {card_id, proposed, clips[clip_id]} + the doctor-name list; nothing says which cards are decoys, or which
// session/day/consult/cluster a clip is from. The answer key stays box-only (0600) and this Worker has no code path that names or reads it.
// Card and clip ids must be opaque.
import { isRater, raterHash } from "./rate.js";
import { rangeOf } from "./g3.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ANS = ["agree", "disagree", "other_doctor", "unknown", "patient", "multiple", "not_judgeable"];
const HDRS = { "cache-control": "private, no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cross-origin-resource-policy": "same-origin", "x-frame-options": "DENY" };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...HDRS, "content-type": "application/json" } });
const refuse = () => new Response("forbidden", { status: 403, headers: { ...HDRS, "content-type": "text/plain" } });
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const name = (v, n) => typeof v === "string" && v.trim().length > 0 && v.length <= n;

// {cards:[{card_id, proposed, clips:[clip_id|{clip_id}]}], doctors:[name]}; every other field is dropped. Any invalid or duplicate id makes the set unusable.
export function itemsOf(text) {
  let d; try { d = JSON.parse(text); } catch { return null; }
  if (!d || typeof d !== "object" || !Array.isArray(d.cards) || d.cards.length === 0 || d.cards.length > 60) return null;
  const cards = [], seenClip = new Set();
  for (const c of d.cards) {
    if (!c || typeof c !== "object" || typeof c.card_id !== "string" || !ID.test(c.card_id) || !name(c.proposed, 60) || !Array.isArray(c.clips) || c.clips.length === 0 || c.clips.length > 8) return null;
    const clips = [];
    for (const x of c.clips) {
      const id = typeof x === "string" ? x : x?.clip_id;
      if (typeof id !== "string" || !ID.test(id) || seenClip.has(id)) return null;
      seenClip.add(id); clips.push(id);
    }
    cards.push({ card_id: c.card_id, proposed: c.proposed, clips });
  }
  if (new Set(cards.map((c) => c.card_id)).size !== cards.length) return null;
  let doctors = [];
  if (d.doctors !== undefined) {
    if (!Array.isArray(d.doctors) || d.doctors.length > 400 || !d.doctors.every((x) => name(x, 60))) return null;
    doctors = [...new Set(d.doctors)];
  }
  return { cards, doctors };
}

// one card's answer. ans and conf may each still be missing (a saved draft); a card counts as done only with both plus know (Y/N: does the annotator know this doctor's voice; asked on every card). flags and audible = clip ids of THIS card (audible: a name or role can be heard in that clip; A4 4.8 drop rule).
export function markOf(v, clipIds) {
  const keys = ["ans", "conf", "know", "other", "note", "second", "flags", "audible", "ts"];
  if (!v || typeof v !== "object" || Array.isArray(v) || !Object.keys(v).every((k) => keys.includes(k))) return null;
  if (v.ans !== undefined && !ANS.includes(v.ans)) return null;
  if (v.conf !== undefined && !(Number.isInteger(v.conf) && v.conf >= 1 && v.conf <= 5)) return null;
  if (v.know !== undefined && v.know !== "y" && v.know !== "n") return null;
  if (v.other !== undefined && !name(v.other, 80)) return null;
  if (v.other !== undefined && v.ans !== "other_doctor") return null;
  if (v.note !== undefined && (typeof v.note !== "string" || v.note.length > 1000)) return null;
  if (v.second !== undefined && (typeof v.second !== "string" || v.second.length > 500)) return null;
  if (v.ts !== undefined && (typeof v.ts !== "string" || v.ts.length > 40)) return null;
  for (const k of ["flags", "audible"]) if (v[k] !== undefined && (!Array.isArray(v[k]) || v[k].length > clipIds.length || new Set(v[k]).size !== v[k].length || !v[k].every((f) => clipIds.includes(f)))) return null;
  return { ans: v.ans ?? null, conf: v.conf ?? null, know: v.know ?? null, other: v.other ?? "", note: v.note ?? "", second: v.second ?? "", flags: v.flags ?? [], audible: v.audible ?? [], ts: v.ts ?? "" };
}
const done = (m) => !!m && m.ans !== null && m.conf !== null && (m.know === "y" || m.know === "n") && (m.ans !== "other_doctor" || !!m.other);

async function loadItems(env, run) {
  const o = await env.RATINGS.get(`voicecheck/${run}/items.json`);
  if (!o) return null;
  const text = await o.text(), it = itemsOf(text);
  return it ? { ...it, sha: hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))) } : null;
}

const dlOn = (env) => env.VOICECHECK_DOWNLOAD === "1";   // download/share stay off until a Fable/V ruling turns this var on
const append = (env, prefix, seg, rec, now) => {   // the only write: a new object per record, never overwrites
  const uniq = `${String(now.getTime()).padStart(13, "0")}-${Math.random().toString(36).slice(2, 8)}`;
  return env.RATINGS.put(`${prefix}${seg}/${uniq}.json`, JSON.stringify(rec), { httpMetadata: { contentType: "application/json" } });
};

// /voicecheck/<run> (page) and /api/voicecheck/<run>/(items|mine|audio/<item>). Returns null for a path that is not ours.
export async function voicecheckRoute(request, env, url, who, pageShell) {
  const m = /^\/(api\/)?voicecheck\/([^/]+)(?:\/(items|mine|audio|export)(?:\/([^/]+))?)?$/.exec(url.pathname);
  if (!m) return url.pathname === "/voicecheck" || url.pathname.startsWith("/voicecheck/") || url.pathname.startsWith("/api/voicecheck/") ? json(404, { error: "not found" }) : null;
  if (typeof who?.email !== "string" || !who.email) return refuse();
  const [, api, run, part, item] = m;
  if (!ID.test(run) || (!api && part) || (api && !part) || (part !== "audio" && item !== undefined) || (part === "audio" && !(item && ID.test(item)))) return json(404, { error: "not found" });
  if (part !== "export" && String(env.VOID_RUNS || "").split(",").map((x) => x.trim()).includes(run)) return json(404, { error: "not found" });
  if (!api) {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("method not allowed", { status: 405, headers: { ...HDRS, allow: "GET, HEAD" } });
    return pageShell(VOICECHECK_PAGE.replace("__RUN__", run), "voicecheck");
  }
  if (part === "items") {
    if (request.method !== "GET") return new Response("method not allowed", { status: 405, headers: { ...HDRS, allow: "GET" } });
    const it = await loadItems(env, run);
    return it ? json(200, { run_id: run, items_sha: it.sha, download: dlOn(env), doctors: it.doctors, cards: it.cards }) : json(404, { error: "no items for this run" });
  }
  if (part === "audio") {
    if (request.method !== "GET") return new Response("method not allowed", { status: 405, headers: { ...HDRS, allow: "GET" } });
    const it = await loadItems(env, run);
    if (!it || !it.cards.some((c) => c.clips.includes(item))) return json(404, { error: "not found" });
    const key = `voicecheck/${run}/audio/${item}.m4a`, head = await env.RATINGS.head(key);
    if (!head) return json(404, { error: "audio not found" });
    const dq = url.searchParams.get("download");
    if (dq !== null && (dq !== "1" || !dlOn(env))) return json(404, { error: "not found" });
    if (dq === "1") {   // the whole clip as a file named by its opaque clip id only; the id already passed ID
      const o = await env.RATINGS.get(key), via = url.searchParams.get("via") === "share" ? "share" : "download";
      await append(env, `voicecheck-rec/${run}/${await raterHash(who.email)}/`, "_dl", { run_id: run, items_sha: it.sha, annotator: who.email, saved_at: new Date().toISOString(), kind: via, clip: item }, new Date());   // audit: audio leaves the box
      return new Response(o.body, { status: 200, headers: { ...HDRS, "content-type": "audio/mp4", "content-disposition": `attachment; filename="${item}.m4a"`, "content-length": String(head.size) } });
    }
    const h = { ...HDRS, "content-type": "audio/mp4", "accept-ranges": "bytes" }, r = rangeOf(request.headers.get("range"), head.size);
    if (r === "invalid") return new Response(null, { status: 416, headers: { ...h, "content-range": `bytes */${head.size}` } });
    if (r === null) { const o = await env.RATINGS.get(key); return new Response(o.body, { status: 200, headers: { ...h, "content-length": String(head.size) } }); }
    const o = await env.RATINGS.get(key, { range: r });
    return new Response(o.body, { status: 206, headers: { ...h, "content-range": `bytes ${r.offset}-${r.offset + r.length - 1}/${head.size}`, "content-length": String(r.length) } });
  }
  if (part === "export") {
    if (request.method !== "GET") return new Response("method not allowed", { status: 405, headers: { ...HDRS, allow: "GET" } });
    if (!isRater(env, who.email)) return refuse();
    const cursor = url.searchParams.get("cursor") || undefined;
    if (cursor !== undefined && !/^[A-Za-z0-9_=.~+/-]{1,2000}$/.test(cursor)) return json(422, { error: "bad cursor" });
    const l = await env.RATINGS.list({ prefix: `voicecheck-rec/${run}/`, cursor, limit: 200 });
    const records = [];
    for (const o of [...l.objects].sort((x, y) => (x.key < y.key ? -1 : 1)).slice(0, 200)) {
      const g = await env.RATINGS.get(o.key);
      try { const r = g && JSON.parse(await g.text()); if (r && typeof r === "object") records.push({ key: o.key, ...r }); } catch { /* skip an unreadable object */ }
    }
    return json(200, { run_id: run, records, next: l.truncated ? l.cursor : null });
  }
  const h = await raterHash(who.email), prefix = `voicecheck-rec/${run}/${h}/`;
  const mineOf = async () => {   // latest record per card (keys sort by ms), plus the submit record
    const latest = new Map();
    let cursor;
    for (let page = 0; page < 10; page++) {
      const l = await env.RATINGS.list({ prefix, cursor });
      for (const o of l.objects) { const seg = o.key.slice(prefix.length).split("/"); if (seg.length === 2 && seg[0] !== "_dl" && (!latest.has(seg[0]) || o.key > latest.get(seg[0]))) latest.set(seg[0], o.key); }
      if (!l.truncated) break; cursor = l.cursor;
    }
    const t = {}, shas = new Set(); let submitted = null;
    for (const [seg, k] of latest) {
      let r; try { const g = await env.RATINGS.get(k); r = g && JSON.parse(await g.text()); } catch { r = null; }
      if (!r || typeof r !== "object") continue;
      if (seg === "_submit") submitted = typeof r.saved_at === "string" ? r.saved_at : null;
      else { t[seg] = { ans: r.ans ?? null, conf: r.conf ?? null, know: r.know ?? null, other: r.other ?? "", note: r.note ?? "", second: r.second ?? "", flags: Array.isArray(r.flags) ? r.flags : [], audible: Array.isArray(r.audible) ? r.audible : [], saved_at: r.saved_at ?? "" }; shas.add(r.items_sha ?? ""); }
    }
    return { t, submitted, shas };
  };
  if (request.method === "GET") {   // answers saved against a different items.json are never shown against these cards
    const m2 = await mineOf(), now = await loadItems(env, run), stale = !!now && [...m2.shas].some((x) => x !== now.sha);
    return json(200, { run_id: run, items_sha: now?.sha ?? null, t: stale ? {} : m2.t, submitted: stale ? null : m2.submitted, stale });
  }
  if (request.method !== "PUT") return new Response("method not allowed", { status: 405, headers: { ...HDRS, allow: "GET, PUT" } });
  if (!(request.headers.get("content-type") || "").toLowerCase().startsWith("application/json")) return json(415, { error: "application/json only" });
  const site = request.headers.get("sec-fetch-site"); if (site && site !== "same-origin") return refuse();
  const text = await request.text();
  if (text.length > 6000) return json(413, { error: "too large" });
  let body; try { body = JSON.parse(text); } catch { return json(400, { error: "not json" }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json(422, { error: "object expected" });
  const it = await loadItems(env, run);
  if (!it) return json(409, { error: "no items for this run" });
  const cur = await mineOf();
  if ([...cur.shas].some((x) => x !== it.sha)) return json(409, { error: "the clip set changed since your answers were saved" });
  if (cur.submitted) return json(409, { error: "batch already submitted" });
  const now = new Date(), rec = { run_id: run, items_sha: it.sha, annotator: who.email, saved_at: now.toISOString() };
  let seg;
  if (Object.keys(body).length === 2 && typeof body.card === "string" && "mark" in body) {
    const card = it.cards.find((c) => c.card_id === body.card);
    if (!card) return json(422, { error: "unknown card" });
    const mk = markOf(body.mark, card.clips);
    if (!mk) return json(422, { error: "mark not allowed" });
    seg = card.card_id; Object.assign(rec, { kind: "answer", card: card.card_id, ans: mk.ans, conf: mk.conf, know: mk.know, other: mk.other, note: mk.note, second: mk.second, flags: mk.flags, audible: mk.audible });
    cur.t[seg] = mk;
  } else if (Object.keys(body).length === 1 && body.submit === true) {
    if (!it.cards.every((c) => done(cur.t[c.card_id]))) return json(409, { error: "cards without an answer and confidence remain" });
    seg = "_submit"; rec.kind = "submit";
  } else return json(422, { error: "expected {card, mark} or {submit: true}" });
  await append(env, prefix, seg, rec, now);
  return json(200, { ok: true, done: it.cards.filter((c) => done(cur.t[c.card_id])).length, submitted: rec.kind === "submit" ? rec.saved_at : null });
}

// One card per voice, clips in the file's order. Text via textContent only; no ids, dates, session or cluster cue, no scores.
export const VOICECHECK_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Voice check</title>
<style nonce="__NONCE__">
:root{--bg:#fbfaf7;--ink:#1c1a17;--mut:#6b675f;--line:#e2ddd2;--acc:#0f6b6b;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#161513;--ink:#ece8e0;--mut:#a39e94;--line:#3a3833;--acc:#5bb5b5;--card:#1f1e1b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 system-ui,sans-serif}
main{max-width:720px;margin:0 auto;padding:16px}
h1{font-size:18px;margin:0 0 4px}h2{font-size:18px;margin:0 0 8px}.mut{color:var(--mut);font-size:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;margin:12px 0}
.clip{border-top:1px solid var(--line);padding:8px 0}.clip:first-of-type{border-top:0}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:8px 0}
button{font:inherit;padding:10px 14px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--ink);cursor:pointer;min-height:44px}
button.on{background:var(--acc);color:#fff;border-color:var(--acc)}button:disabled,select:disabled,input:disabled{opacity:.55;cursor:default}
audio{width:100%;margin:4px 0}select,input[type=text]{font:inherit;padding:8px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--ink);max-width:100%}
input.wide{width:100%}label.flag{font-size:14px;color:var(--mut)}
a.btn{font:inherit;padding:10px 14px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--ink);min-height:44px;display:inline-flex;align-items:center;text-decoration:none;font-size:14px}
.cl{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.bar{height:6px;background:var(--line);border-radius:3px;margin:8px 0}
.st{min-height:1.2em;color:var(--mut);font-size:14px}
</style></head><body><main>
<h1>Voice check</h1><div class="mut" id="prog">Loading</div>
<div class="bar"><svg width="100%" height="6" viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true"><rect id="barfill" x="0" y="0" width="0" height="6" fill="#0f6b6b"></rect></svg></div>
<div class="mut">Each card is one voice. Listen to its clips, then say who it is and how sure you are (5 = certain). Some cards are not the proposed doctor. You can change answers until you submit the batch.</div>
<div id="body"></div><div id="msg" class="st" role="status"></div>
<script nonce="__NONCE__">
const RUN="__RUN__";
const $=(t,a,...k)=>{const e=document.createElement(t);for(const[x,y]of Object.entries(a||{}))e.setAttribute(x,y);for(const c of k)e.append(c);return e};
const OPTS=[["agree","Agree"],["disagree","Disagree"],["other_doctor","Another doctor"],["unknown","Unknown voice"],["patient","Patient"],["multiple","Multiple voices in the clips"],["not_judgeable","Not judgeable"]];
let cards=[],canDl=false,doctors=[],marks={},submitted=null,q=Promise.resolve();
const say=(s)=>{document.getElementById("msg").textContent=s};
const api=async(p,o)=>{const r=await fetch("/api/voicecheck/"+RUN+"/"+p,o);if(!r.ok)throw new Error(r.status);return r.json()};
const clipUrl=(id)=>"/api/voicecheck/"+RUN+"/audio/"+encodeURIComponent(id);
const canShare=(()=>{try{return !!(navigator.share&&navigator.canShare&&navigator.canShare({files:[new File([new Uint8Array(1)],"a.m4a",{type:"audio/mp4"})]}))}catch(e){return false}})();
const isDone=(m)=>!!m&&!!m.ans&&!!m.conf&&(m.know==="y"||m.know==="n")&&(m.ans!=="other_doctor"||!!m.other);
function progress(){const n=cards.filter((c)=>isDone(marks[c.card_id])).length;document.getElementById("prog").textContent=n+" of "+cards.length+" voices done (answer and confidence)"+(submitted?" \u00b7 submitted":"");document.getElementById("barfill").setAttribute("width",String(cards.length?100*n/cards.length:0));return n}
function render(){
  const b=document.getElementById("body");b.textContent="";const ro=!!submitted;
  for(const c of cards){
    const cur=marks[c.card_id]?{...marks[c.card_id],flags:[...(marks[c.card_id].flags||[])],audible:[...(marks[c.card_id].audible||[])]}:{flags:[],audible:[]};
    const st=$("div",{class:"st"},isDone(cur)?"Saved.":"");
    const card=$("div",{class:"card"},$("h2",{},"Proposed: "+c.proposed));
    const clipFlags=[];
    c.clips.forEach((id,k)=>{
      const au=$("audio",{controls:"",preload:"none",src:clipUrl(id)});
      const cl=$("div",{class:"cl"});
      if(canDl){cl.append($("a",{class:"btn",href:clipUrl(id)+"?download=1",download:id+".m4a"},"Download"))}
      if(canDl&&canShare){const sh=$("button",{type:"button"},"Share");sh.onclick=async()=>{try{const r=await fetch(clipUrl(id)+"?download=1&via=share");if(!r.ok)throw new Error(r.status);const f=new File([await r.blob()],id+".m4a",{type:"audio/mp4"});await navigator.share({files:[f]})}catch(e){if(e&&e.name!=="AbortError")say("Could not share ("+e.message+")")}};cl.append(sh)}
      const fl=$("input",{type:"checkbox"});fl.checked=cur.flags.includes(id);fl.disabled=ro;
      fl.onchange=()=>{cur.flags=fl.checked?[...cur.flags,id]:cur.flags.filter((x)=>x!==id);persist()};
      const ad=$("input",{type:"checkbox"});ad.checked=cur.audible.includes(id);ad.disabled=ro;
      ad.onchange=()=>{cur.audible=ad.checked?[...cur.audible,id]:cur.audible.filter((x)=>x!==id);persist()};
      card.append($("div",{class:"clip"},$("div",{class:"mut"},"Clip "+(k+1)),au,$("label",{class:"flag"},fl," this clip is different from the others"),$("label",{class:"flag"},ad," a name or role is audible in this clip"),cl));
    });
    const ansB={},confB={},knowB={};
    const ar=$("div",{class:"row"}),cr=$("div",{class:"row"},$("span",{class:"mut"},"Confidence")),kr=$("div",{class:"row"},$("span",{class:"mut"},"I know this doctor's voice"));
    const sel=$("select",{"aria-label":"Which doctor"});sel.append($("option",{value:""},"Pick a doctor"));for(const d of doctors)sel.append($("option",{value:d},d));
    const free=$("input",{type:"text",maxlength:"80",placeholder:"or type a name",class:"wide"});
    const otherBox=$("div",{class:"row"},sel,free);
    const note=$("input",{type:"text",maxlength:"1000",placeholder:"Note (optional)",class:"wide"});note.value=cur.note||"";
    const second=$("input",{type:"text",maxlength:"500",placeholder:"Second opinion (optional): who, and what they said",class:"wide"});second.value=cur.second||"";
    sel.disabled=free.disabled=note.disabled=second.disabled=ro;
    const other=()=>(free.value.trim()||sel.value||"");
    if(cur.other){if(doctors.includes(cur.other))sel.value=cur.other;else free.value=cur.other}
    const paint=()=>{for(const [k,x] of Object.entries(ansB))x.className=cur.ans===k?"on":"";for(const [k,x] of Object.entries(confB))x.className=cur.conf===Number(k)?"on":"";for(const [k,x] of Object.entries(knowB))x.className=cur.know===k?"on":"";otherBox.hidden=cur.ans!=="other_doctor"};
    const persist=()=>{
      if(!cur.ans&&!cur.conf&&!cur.know&&!cur.flags.length&&!cur.audible.length&&!note.value&&!second.value)return;
      const mk={ts:new Date().toISOString(),flags:cur.flags,audible:cur.audible};if(cur.ans)mk.ans=cur.ans;if(cur.conf)mk.conf=cur.conf;if(cur.know)mk.know=cur.know;
      if(cur.ans==="other_doctor"&&other())mk.other=other();
      if(note.value)mk.note=note.value;if(second.value)mk.second=second.value;
      q=q.then(async()=>{try{await api("mine",{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({card:c.card_id,mark:mk})});marks[c.card_id]={ans:mk.ans||null,conf:mk.conf||null,know:mk.know||null,other:mk.other||"",note:mk.note||"",second:mk.second||"",flags:mk.flags,audible:mk.audible,ts:mk.ts};cur.other=mk.other||"";st.textContent=isDone(marks[c.card_id])?"Saved.":"Saved. Still needs "+(!mk.ans?"an answer":!mk.conf?"a confidence":"the voice-known Yes/No")+(mk.ans==="other_doctor"&&!mk.other?" and a doctor name":"")+".";updateSubmit()}catch(e){st.textContent="Save failed ("+e.message+"). Try again."}})};
    for(const [k,l] of OPTS){const x=$("button",{type:"button"},l);ansB[k]=x;x.disabled=ro;x.onclick=()=>{cur.ans=k;paint();persist()};ar.append(x)}
    for(const n of [1,2,3,4,5]){const x=$("button",{type:"button"},String(n));confB[n]=x;x.disabled=ro;x.onclick=()=>{cur.conf=n;paint();persist()};cr.append(x)}
    for(const [k,l] of [["y","Yes"],["n","No"]]){const x=$("button",{type:"button"},l);knowB[k]=x;x.disabled=ro;x.onclick=()=>{cur.know=k;paint();persist()};kr.append(x)}
    sel.onchange=()=>{if(sel.value)free.value="";cur.other=other();persist()};free.onchange=()=>{if(free.value.trim())sel.value="";cur.other=other();persist()};note.onchange=persist;second.onchange=persist;
    card.append(ar,otherBox,cr,kr,note,second,st);paint();b.append(card);
  }
  const sb=$("button",{type:"button",id:"submit"},"Submit batch");sb.disabled=ro;
  sb.onclick=async()=>{if(!confirm("Submit the batch? Answers become read-only."))return;try{await q;const r=await api("mine",{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({submit:true})});submitted=r.submitted;render();say("Submitted. Thank you.")}catch(e){say("Could not submit ("+e.message+")")}};
  b.append($("div",{class:"card"},sb));
  window.updateSubmit=()=>{const n=progress();sb.disabled=!!submitted||n<cards.length};window.updateSubmit();
}
(async()=>{try{
  const [i,m]=await Promise.all([api("items"),api("mine")]);cards=i.cards;canDl=i.download===true;doctors=i.doctors||[];marks=m.t||{};submitted=m.submitted||null;render();if(m.stale)say("The clip set was replaced after answers were saved; earlier answers are not shown and new answers are refused. Ask for a new run.");
}catch(e){document.getElementById("prog").textContent="No voices loaded for this run yet ("+e.message+")."}})();
</script></main></body></html>`;
