// Real-browser check of the Chain Check page (Chromium via Playwright): phone width and desktop, light and dark.
// Run through browser-check.sh. Invented mock chains only.
const {chromium}=require("playwright");
const {spawn}=require("child_process");
const fs=require("fs"),path=require("path");
const out=process.argv[2],port=20000+Math.floor(Math.random()*30000);
fs.mkdirSync(path.join(out,"shots"),{recursive:true});
(async()=>{
 // a plain server WITHOUT Range support: the page must not depend on it
 const srv=spawn("python3",["-m","http.server",String(port),"--bind","127.0.0.1"],{cwd:out,stdio:"ignore"});
 process.on("exit",()=>{try{srv.kill()}catch(e){}});
 await new Promise(r=>setTimeout(r,900));
 const br=await chromium.launch({args:["--autoplay-policy=no-user-gesture-required"]});
 const settings=[
  ["phone-light",{viewport:{width:375,height:667},deviceScaleFactor:2,isMobile:true,hasTouch:true}],
  ["phone-dark",{viewport:{width:375,height:667},deviceScaleFactor:2,isMobile:true,hasTouch:true,colorScheme:"dark"}],
  ["desktop-light",{viewport:{width:1280,height:800}}],
  ["desktop-dark",{viewport:{width:1280,height:800},colorScheme:"dark"}]];
 let bad=0;const lines=[];
 for(const [name,opts] of settings){
  const ctx=await br.newContext(opts),p=await ctx.newPage(),errs=[];
  p.on("pageerror",e=>errs.push(e.message));p.on("console",m=>{if(m.type()==="error")errs.push(m.text())});
  await p.goto(`http://127.0.0.1:${port}/harness.html`);await p.waitForSelector(".rx");
  const phone=opts.viewport.width<=560;
  const m=await p.evaluate(()=>{const q=s=>[...document.querySelectorAll(s)],H=e=>Math.round(e.getBoundingClientRect().height);
   return{chains:chains.length,hasRx:!!document.querySelector(".rx").textContent.trim(),facts:q("dl.facts dt").length===curC().facts.length&&q("dl.facts dt").length>=2,qrows:q(".qrow").length,minOpt:Math.min(...q(".opt span").map(H)),
    minPl:Math.min(...q(".pl-b").map(H)),overflow:document.documentElement.scrollWidth>innerWidth,hdr:getComputedStyle(document.getElementById("hdr")).position,
    leak:/linker_verdict|link_score|candidate_rank|tier|HIGH|"class"/.test(document.body.innerText+document.body.innerHTML.replace(/<(script|style)[\s\S]*?<\/\1>/g,"")),turns:q(".turn").length,seeks:q(".seek").length}});
  await p.screenshot({path:path.join(out,"shots",name+"-chain.png")});
  // gating: Q1 only at first; No ends the chain; Yes opens Q2; Q2 Yes opens Q3
  await p.click("#same-no");await p.waitForTimeout(150);
  const gNo=await p.evaluate(()=>({q:document.querySelectorAll(".qrow").length,done:isDone(curC())}));
  await p.click("#same-yes");await p.waitForTimeout(150);
  const gYes=await p.evaluate(()=>({q:document.querySelectorAll(".qrow").length,done:isDone(curC())}));
  await p.click("#disc-yes");await p.waitForTimeout(150);
  const gDisc=await p.evaluate(()=>({q:document.querySelectorAll(".qrow").length,done:isDone(curC())}));
  await p.click("#when-this_visit");await p.waitForTimeout(150);
  const gDone=await p.evaluate(()=>({q:document.querySelectorAll(".qrow").length,done:isDone(curC()),prog:document.getElementById("prog").textContent}));
  await p.fill("#note","test note");
  // audio: play, then tap a timestamp lower down
  await p.click("#pl-play");await p.waitForTimeout(1200);
  const a1=await p.evaluate(()=>({t:document.getElementById("pl-time").textContent,playing:full.playing}));
  const seeks=await p.$$(".seek");await seeks[6].scrollIntoViewIfNeeded();await seeks[6].click();await p.waitForTimeout(900);
  const a2=await p.evaluate(()=>({t:document.getElementById("pl-time").textContent,now:(document.querySelector(".turn.now")||{}).id,mode:document.getElementById("player").dataset.mode}));
  await p.click("#pl-play");
  await p.evaluate(()=>scrollTo(0,0));
  await p.screenshot({path:path.join(out,"shots",name+"-answered.png")});
  // second chain: a "No" verdict finishes it; then results
  await p.click("#next");await p.waitForTimeout(200);
  await p.click("#same-no");await p.waitForTimeout(900);
  const saved=await p.evaluate(()=>{const c=window.__checks&&window.__checks.u1;return{n:c?Object.keys(c.c).length:0,vals:c?Object.values(c.c).map(a=>[a.same,a.disc||"-",a.when||"-",a.note||"-"].join("/")).sort().join(" | "):"",prog:document.getElementById("prog").textContent}});
  await p.click("#next");await p.waitForTimeout(200);
  const done=await p.evaluate(()=>document.getElementById("done").textContent);
  await p.click("#tab-res");await p.waitForTimeout(250);
  const res=await p.evaluate(()=>document.getElementById("res").textContent.replace(/\s+/g," ").slice(0,200));
  await p.screenshot({path:path.join(out,"shots",name+"-results.png")});
  const ok=m.chains===2&&m.hasRx&&m.facts&&m.qrows===1&&!m.overflow&&!m.leak&&m.turns===9&&m.seeks===9
    &&gNo.q===1&&gNo.done&&gYes.q===2&&!gYes.done&&gDisc.q===3&&!gDisc.done&&gDone.q===3&&gDone.done&&/1 \/ 2 checked/.test(gDone.prog)
    &&a1.playing&&a2.t.startsWith("0:5")&&a2.now==="t-6"&&saved.n===2&&/no\/-\/-\/-/.test(saved.vals)&&/yes\/yes\/this_visit\/test note/.test(saved.vals)&&/2 \/ 2 checked/.test(saved.prog)
    &&/All chains are checked/.test(done)&&/Same visit/.test(res)&&errs.length===0&&m.minOpt>=48&&m.minPl>=44&&(!phone||m.hdr==="static");
  if(!ok)bad++;
  lines.push(`${ok?"PASS":"FAIL"} ${name}: gating ${gNo.q}/${gYes.q}/${gDisc.q}/${gDone.q} rows, done ${gDone.done}, facts ok ${m.facts}, overflow ${m.overflow}, leak ${m.leak}, audio ${a1.t} -> tap -> ${a2.t} (now ${a2.now}, mode ${a2.mode}), saved ${saved.n}/2 [${saved.vals}], min answer ${m.minOpt}px, errors ${errs.length}`);
  await ctx.close();
 }
 await br.close();srv.kill();
 console.log(lines.join("\n"));console.log("screenshots:",path.join(out,"shots"));
 process.exit(bad?1:0);
})();
