// Real-browser check of the Who Is Speaking page (Chromium via Playwright): phone width and desktop, light and dark.
// Run through browser-check.sh. Invented mock turns only.
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
  await p.goto(`http://127.0.0.1:${port}/harness.html`);await p.waitForSelector("#pl-play");
  const phone=opts.viewport.width<=560;
  const m=await p.evaluate(()=>{const q=s=>[...document.querySelectorAll(s)],H=e=>Math.round(e.getBoundingClientRect().height);
   const band=document.getElementById("band").getBoundingClientRect(),sc=document.querySelector(".sc").getBoundingClientRect();
   return{opts:q(".opt span").length,minOpt:Math.min(...q(".opt span").map(H)),minPl:Math.min(...q(".pl-b").map(H)),nextH:H(document.getElementById("next")),
    overflow:document.documentElement.scrollWidth>innerWidth,bandW:Math.round(band.width),bandL:Math.round(band.left-sc.left),
    leak:/machine_label|doubtful|speaker_basis|margin|Room \d|Dr\. Mock/i.test(document.body.innerText+document.body.innerHTML.replace(/<(script|style)[\s\S]*?<\/\1>/g,"")),
    hdr:getComputedStyle(document.getElementById("hdr")).position}});
  await p.screenshot({path:path.join(out,"shots",name+"-turn.png")});
  // play all: blob source, clock advances, the marked band lights up at 3-5.5 s
  await p.click("#pl-play");await p.waitForTimeout(1300);
  const t1=await p.evaluate(()=>({time:document.getElementById("pl-time").textContent,src:P.audio&&P.audio.src.slice(0,5),playing:P.playing}));
  await p.click("#pl-play");
  // marked turn only: starts at the band start and stops by itself at its end
  await p.click("#pl-turn");await p.waitForTimeout(600);
  const inTurn=await p.evaluate(()=>({playing:P.playing,now:document.getElementById("now").textContent,pos:+P.audio.currentTime.toFixed(1)}));
  await p.waitForTimeout(4200);
  const after=await p.evaluate(()=>({playing:P.playing,pos:+P.audio.currentTime.toFixed(1),te:curI().te}));
  // answer, note, saved payload, progress
  await p.click("#a-patient");await p.fill("#note","test note");await p.waitForTimeout(1000);
  const saved=await p.evaluate(()=>{const c=window.__labels&&window.__labels.u1;const k=c&&Object.keys(c.t)[0];return{a:c&&c.t[k],prog:document.getElementById("prog").textContent}});
  await p.screenshot({path:path.join(out,"shots",name+"-answered.png")});
  if(!phone){await p.click("#next");await p.waitForTimeout(200);await p.keyboard.press("2");await p.waitForTimeout(200)}
  const kb=!phone?await p.evaluate(()=>({checked:(document.querySelector("input[name=a]:checked")||{}).value})):{checked:"n/a"};
  if(phone){await p.click("#next");await p.waitForTimeout(200)}
  const nx=await p.evaluate(()=>({h2:document.querySelector(".wh h2").textContent,checked:document.querySelectorAll("input[name=a]:checked").length}));
  await p.click("#nextopen");await p.waitForTimeout(150);
  await p.click("#tab-res");await p.waitForTimeout(250);
  const res=await p.evaluate(()=>document.getElementById("res").textContent.replace(/\s+/g," ").slice(0,200));
  await p.screenshot({path:path.join(out,"shots",name+"-results.png")});
  const ok=m.opts===5&&!m.overflow&&!m.leak&&m.bandW>0&&m.bandL>0&&t1.src==="blob:"&&t1.playing&&inTurn.playing&&inTurn.now==="Marked turn"&&!after.playing&&Math.abs(after.pos-after.te)<0.6
    &&saved.a&&saved.a.a==="patient"&&saved.a.note==="test note"&&/1 \/ 5 answered/.test(saved.prog)&&nx.checked===(phone?0:1)&&(phone||kb.checked==="patient")&&/Scored/.test(res)&&errs.length===0
    &&m.minOpt>=48&&m.minPl>=44&&(!phone||(m.nextH>=44&&m.hdr==="static"));
  if(!ok)bad++;
  lines.push(`${ok?"PASS":"FAIL"} ${name}: answers ${m.opts} (min ${m.minOpt}px), player buttons min ${m.minPl}px, overflow ${m.overflow}, leak ${m.leak}, band ${m.bandL}+${m.bandW}px, audio ${t1.src} at ${t1.time}, turn-only ${inTurn.now} -> stops at ${after.pos}/${after.te}, saved ${saved.a&&saved.a.a}, keyboard ${kb.checked}, errors ${errs.length}`);
  await ctx.close();
 }
 await br.close();srv.kill();
 console.log(lines.join("\n"));console.log("screenshots:",path.join(out,"shots"));
 process.exit(bad?1:0);
})();
