// Real-browser check of the Doctor Voice Check page (Chromium via Playwright): phone width and desktop, light and dark.
// Run through browser-check.sh. Invented mock cards only.
const {chromium}=require("playwright");
const {spawn}=require("child_process");
const fs=require("fs"),path=require("path");
const out=process.argv[2],port=20000+Math.floor(Math.random()*30000);
fs.mkdirSync(path.join(out,"shots"),{recursive:true});
(async()=>{
 // a plain server WITHOUT Range support: the page must not depend on it
 const srv=spawn("python3",["-m","http.server",String(port),"--bind","127.0.0.1"],{cwd:out,stdio:"ignore"});
 process.on('exit',()=>{try{srv.kill()}catch(e){}});
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
  await p.goto(`http://127.0.0.1:${port}/harness.html`);await p.waitForSelector(".clip");
  const phone=opts.viewport.width<=560;
  const kinds=await p.evaluate(()=>cards.map(c=>c.kind).join(","));
  const m=await p.evaluate(()=>{const q=s=>[...document.querySelectorAll(s)],H=e=>Math.round(e.getBoundingClientRect().height);
   return{minOpt:Math.min(...q(".opt span").map(H)),minPb:Math.min(...q(".pb").map(H)),nextH:H(document.getElementById("next")),
    overflow:document.documentElement.scrollWidth>innerWidth,hdr:getComputedStyle(document.getElementById("hdr")).position,
    leak:/tier|pqm_score|cluster|true_doctor|confidence|HIGH|LOW/.test(document.body.innerText+document.body.innerHTML.replace(/<(script|style)[\s\S]*?<\/\1>/g,""))}});
  await p.screenshot({path:path.join(out,"shots",name+"-card1.png")});
  // walk all cards: audio on the first, one verdict of each kind on the rest
  let audio=null,seenWho=false,linkN=0,steps=[];
  for(let i=0;i<5;i++){
   const kind=await p.evaluate(()=>curC().kind);
   if(i===0){ // play clip 1 (blob), then clip 2 must stop clip 1
     await p.click('.clip[data-k="0"] .pb');await p.waitForTimeout(1100);
     const a1=await p.evaluate(()=>({src:P.audio&&P.audio.src.slice(0,5),key:P.key,t:+P.audio.currentTime.toFixed(1)}));
     await p.click('.clip[data-k="1"] .pb');await p.waitForTimeout(300);
     const a2=await p.evaluate(()=>({key:P.key}));
     await p.click('.clip[data-k="1"] .pb');
     audio={a1,a2,stopped:await p.evaluate(()=>P.audio===null)};
   }
   if(kind==="link"){
    linkN++;
    if(linkN===1)await p.click("#a-agree");
    else if(linkN===2){await p.click("#a-disagree");await p.waitForSelector("#whois");seenWho=true;
      const done0=await p.evaluate(()=>answered(curC(),mine.v[curC().id]));steps.push("disagree-without-who-open:"+(!done0));
      await p.selectOption("#whois","unknown")}
    else await p.click("#a-unsure");
   } else {await p.click(steps.filter(s=>s==="pair").length===0?"#a-agree":"#a-disagree");steps.push("pair")}
   await p.fill("#note","n"+i);
   if(i<4){await p.click("#next");await p.waitForTimeout(150)}
  }
  await p.waitForTimeout(1000);
  const saved=await p.evaluate(()=>{const c=window.__verdicts&&window.__verdicts.u1;return{n:c?Object.keys(c.v).length:0,who:c?Object.values(c.v).filter(a=>a.who==="unknown").length:0,
    kinds:c?Object.values(c.v).map(a=>a.a).sort().join(","):"",prog:document.getElementById("prog").textContent}});
  await p.screenshot({path:path.join(out,"shots",name+"-last.png")});
  await p.click("#next");await p.waitForTimeout(150);
  const done=await p.evaluate(()=>document.getElementById("done").textContent);
  await p.click("#tab-res");await p.waitForTimeout(250);
  const res=await p.evaluate(()=>document.getElementById("res").textContent.replace(/\s+/g," ").slice(0,220));
  await p.screenshot({path:path.join(out,"shots",name+"-results.png")});
  const ok=kinds.split(",").length===5&&!m.overflow&&!m.leak&&audio.a1.src==="blob:"&&audio.a1.t>0.5&&audio.a1.key==="0"&&audio.a2.key==="1"&&audio.stopped
    &&seenWho&&saved.n===5&&saved.who===1&&/5 \/ 5 answered/.test(saved.prog)&&/All cards are answered/.test(done)&&/Link cards/.test(res)&&errs.length===0
    &&m.minOpt>=48&&m.minPb>=44&&(!phone||(m.nextH>=44&&m.hdr==="static"));
  if(!ok)bad++;
  lines.push(`${ok?"PASS":"FAIL"} ${name}: cards ${kinds.split(",").length}, answers min ${m.minOpt}px, play buttons min ${m.minPb}px, overflow ${m.overflow}, leak ${m.leak}, audio ${audio.a1.src} at ${audio.a1.t}s then clip ${audio.a2.key} (first stopped: ${audio.stopped}), who-is-it ${seenWho}, saved ${saved.n}/5, errors ${errs.length}`);
  await ctx.close();
 }
 await br.close();srv.kill();
 console.log(lines.join("\n"));console.log("screenshots:",path.join(out,"shots"));
 process.exit(bad?1:0);
})();
