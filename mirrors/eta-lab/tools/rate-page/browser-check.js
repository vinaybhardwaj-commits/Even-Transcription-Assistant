// Real-browser check of the /rate page (Chromium via Playwright) against mock-server.mjs: phone + desktop, light + dark, the viewer's CSP.
const {chromium}=require("playwright");
const {spawn}=require("child_process");
const fs=require("fs"),path=require("path");
const out=process.argv[2];
fs.mkdirSync(path.join(out,"shots"),{recursive:true});
(async()=>{
 const srv=spawn("node",[path.join(__dirname,"mock-server.mjs"),"0"],{stdio:["ignore","pipe","inherit"]});
 process.on("exit",()=>{try{srv.kill()}catch(e){}});
 const port=await new Promise(r=>srv.stdout.on("data",d=>{const m=/listening (\d+)/.exec(String(d));if(m)r(+m[1])}));
 const base="http://127.0.0.1:"+port;
 const state=async()=>(await fetch(base+"/__state")).json();
 const br=await chromium.launch();
 const settings=[
  ["phone-light",{viewport:{width:375,height:667},deviceScaleFactor:2,isMobile:true,hasTouch:true}],
  ["phone-dark",{viewport:{width:375,height:667},deviceScaleFactor:2,isMobile:true,hasTouch:true,colorScheme:"dark"}],
  ["desktop-light",{viewport:{width:1280,height:800}}],
  ["desktop-dark",{viewport:{width:1280,height:800},colorScheme:"dark"}]];
 let bad=0;const lines=[];
 for(const [name,opts] of settings){
  const ctx=await br.newContext(opts),p=await ctx.newPage(),errs=[],ext=[];
  p.on("pageerror",e=>errs.push(e.message));p.on("console",m=>{if(m.type()==="error"||/Content Security|Refused/i.test(m.text()))errs.push(m.text())});
  p.on("request",r=>{if(!r.url().startsWith(base)&&!r.url().startsWith("data:"))ext.push(r.url())});
  await fetch(base+"/__reset");const puts0=0;
  await p.goto(base+"/rate");await p.waitForSelector(".opt");
  const phone=opts.viewport.width<=560;
  const q=(f,a)=>p.evaluate(f,a);
  // set 1: label200
  const a=await q(()=>{const H=e=>Math.round(e.getBoundingClientRect().height);return{tabs:[...document.querySelectorAll("#sets a")].map(x=>x.textContent),on:document.querySelector("#sets a.on").textContent,
    labels:document.querySelectorAll(".opt input").length,minOpt:Math.min(...[...document.querySelectorAll(".opt .b")].map(H)),h2:document.querySelector(".card h2").textContent,prog:document.getElementById("prog").textContent,
    overflow:document.documentElement.scrollWidth>innerWidth,leak:/repeat loop|sravaani|whisper|indicconformer|mock-w\d|"flag"|score/i.test(document.body.innerText),nextH:H(document.getElementById("next")),hdr:getComputedStyle(document.querySelector("header")).position}});
  await p.screenshot({path:path.join(out,"shots",name+"-label.png")});
  await p.click("#r-label-garbled",{force:true});await p.fill("#note","test note");await p.waitForTimeout(1200);
  const s1=await state();const put1=s1.puts.slice(puts0).filter(x=>x.set==="label200");
  const saved1=Object.values(s1.store.label200)[0];
  let kb="n/a";
  if(!phone){await q(()=>document.activeElement.blur());await p.keyboard.press("n");await p.waitForTimeout(150);await p.keyboard.press("5");await p.waitForTimeout(900);
   kb=(await state()).store.label200;kb=Object.values(kb).some(x=>x.label==="unsure")}
  // reload: my answers come back from /mine and progress remembers them
  await p.reload();await p.waitForSelector(".opt");
  const prog0=await q(()=>document.getElementById("prog").textContent);
  await p.selectOption("#jump","0");await p.waitForTimeout(150);
  const back=await q(()=>({prog:document.getElementById("prog").textContent,checked:(document.querySelector(".opt input:checked")||{}).value||null,note:(document.getElementById("note")||{}).value}));
  // set 2: rate20
  await p.click("#sets a:nth-child(2)");await p.waitForSelector(".tx");
  const seen={};
  for(let i=0;i<5;i++){const t=await q(()=>({h:document.querySelector(".card h2").textContent,qs:document.querySelectorAll("fieldset").length,noen:document.querySelectorAll(".noen").length,en:document.querySelectorAll(".ln .en").length,ovf:document.documentElement.scrollWidth>innerWidth,minOpt:Math.min(...[...document.querySelectorAll(".opt .b")].map(e=>Math.round(e.getBoundingClientRect().height)))}));seen[t.h]=t;await p.click("#next");await p.waitForTimeout(100)}
  await p.click("#nextopen");
  await p.screenshot({path:path.join(out,"shots",name+"-rate20.png")});
  const ids=await q(()=>[...document.querySelectorAll("fieldset")].map(f=>f.querySelector("input").name));
  for(const nme of ids)await p.click("#r-"+nme+"-"+await q(n=>document.querySelector("input[name="+n+"]").value,nme),{force:true});
  await p.waitForTimeout(1200);
  const s2=await state();const put2=s2.puts.slice(puts0).filter(x=>x.set==="rate20");
  const prog2=await q(()=>document.getElementById("prog").textContent);
  const vals=Object.values(seen);
  const ok=a.labels===5&&a.tabs.length===2&&!a.overflow&&!a.leak&&/0 \/ 4 labelled/.test(a.prog)&&put1.length>=1&&saved1&&saved1.label==="garbled"&&saved1.note==="test note"&&put1.every(x=>x.keys.every(k=>k==="label"||k==="note"))
    &&(phone||kb===true)&&(phone?/^1 \/ 4/:/^2 \/ 4/).test(prog0)&&back.checked==="garbled"&&back.note==="test note"
    &&vals.some(t=>t.qs===4)&&vals.some(t=>t.qs===5)&&vals.some(t=>t.noen>0)&&vals.some(t=>t.en>0)&&!vals.some(t=>t.ovf)&&put2.length>=1&&Object.keys(s2.store.rate20).length===1&&Object.keys(Object.values(s2.store.rate20)[0]).filter(k=>k!=="id"&&k!=="note").length>=4&&/^1 \/ 5 rated/.test(prog2)
    &&errs.length===0&&ext.length===0&&a.minOpt>=48&&Math.min(...vals.map(t=>t.minOpt))>=48&&(!phone||(a.nextH>=44&&a.hdr==="static"));
  if(!ok)bad++;
  lines.push(`${ok?"PASS":"FAIL"} ${name}: tabs ${a.tabs.join(" | ")}, ${a.labels} labels (min ${a.minOpt}px), saved ${saved1&&saved1.label}, PUT keys ok ${put1.every(x=>x.keys.every(k=>k==="label"||k==="note"))}, keyboard ${kb}, after reload "${prog0}", first item shows ${back.checked}/${back.note}, rate20 questions ${[...new Set(vals.map(t=>t.qs))]}, rate20 PUTs ${put2.length}, ${prog2}, overflow ${a.overflow}, leak ${a.leak}, external requests ${ext.length}, errors/CSP ${errs.length}${errs.length?" "+errs[0].slice(0,100):""}`);
  await ctx.close();
 }
 await br.close();srv.kill();
 console.log(lines.join("\n"));console.log("screenshots:",path.join(out,"shots"));
 process.exit(bad?1:0);
})();
