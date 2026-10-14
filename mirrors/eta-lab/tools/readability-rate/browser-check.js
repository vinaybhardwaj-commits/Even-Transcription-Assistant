// Real-browser check of the Transcript Readability page (Chromium via Playwright): phone width and desktop, light and dark.
// Run through browser-check.sh. Invented mock excerpts only.
const {chromium}=require("playwright");
const {spawn}=require("child_process");
const fs=require("fs"),path=require("path");
const out=process.argv[2],port=20000+Math.floor(Math.random()*30000);
fs.mkdirSync(path.join(out,"shots"),{recursive:true});
(async()=>{
 const srv=spawn("python3",["-m","http.server",String(port),"--bind","127.0.0.1"],{cwd:out,stdio:"ignore"});
 process.on('exit',()=>{try{srv.kill()}catch(e){}});
 await new Promise(r=>setTimeout(r,900));
 const br=await chromium.launch();
 const settings=[
  ["phone-light",{viewport:{width:375,height:667},deviceScaleFactor:2,isMobile:true,hasTouch:true}],
  ["phone-dark",{viewport:{width:375,height:667},deviceScaleFactor:2,isMobile:true,hasTouch:true,colorScheme:"dark"}],
  ["desktop-light",{viewport:{width:1280,height:800}}],
  ["desktop-dark",{viewport:{width:1280,height:800},colorScheme:"dark"}]];
 let bad=0;const lines=[];
 for(const [name,opts] of settings){
  const ctx=await br.newContext(opts),p=await ctx.newPage(),errs=[];
  p.on("pageerror",e=>errs.push(e.message));p.on("console",m=>{if(m.type()==="error")errs.push(m.text())});
  await p.goto(`http://127.0.0.1:${port}/harness.html`);await p.waitForSelector(".opt");
  const phone=opts.viewport.width<=560;
  const first=await p.evaluate(()=>{const q=s=>[...document.querySelectorAll(s)],H=e=>Math.round(e.getBoundingClientRect().height);
   return{title:document.querySelector(".wh h2").textContent,lines:q(".ln").length,qs:q("fieldset").length,minOpt:Math.min(...q(".opt span").map(H)),nextH:H(document.getElementById("next")),
    overflow:document.documentElement.scrollWidth>innerWidth,en:q(".ln .en").length,noen:q(".ln .noen").length,
    leak:/Mock Room|mock-w\d|kind_hidden|whisper|"engine"/.test(document.body.innerText+document.body.innerHTML.replace(/<(script|style)[\s\S]*?<\/\1>/g,"")),
    hdr:getComputedStyle(document.getElementById("hdr")).position,prog:document.getElementById("prog").textContent}});
  await p.screenshot({path:path.join(out,"shots",name+"-excerpt.png")});
  // answer all questions of the current excerpt by clicking; the excerpt counts as rated only when every question is answered
  const nq=first.qs;
  const ids=await p.evaluate(()=>[...document.querySelectorAll("fieldset")].map(f=>f.querySelector("input").name));
  for(let i=0;i<ids.length;i++){ if(i===ids.length-1) {const mid=await p.evaluate(()=>document.getElementById("prog").textContent);first.mid=mid}
    await p.click(`#${ids[i]}-${await p.evaluate(n=>document.querySelectorAll(`input[name=${n}]`)[0].value,ids[i])}`,{force:true}); }
  await p.fill("#note","test note");await p.waitForTimeout(1000);
  const saved=await p.evaluate(()=>{const c=window.__ratings&&window.__ratings.u1;const k=c&&Object.keys(c.t)[0];return{a:c&&c.t[k],prog:document.getElementById("prog").textContent}});
  await p.screenshot({path:path.join(out,"shots",name+"-rated.png")});
  // keyboard (desktop): next excerpt, "1" answers the first open question
  let kb="n/a";
  if(!phone){await p.evaluate(()=>document.activeElement.blur());await p.keyboard.press("n");await p.waitForTimeout(150);await p.keyboard.press("1");await p.waitForTimeout(150);
   kb=await p.evaluate(()=>document.querySelectorAll("input[type=radio]:checked").length)}
  // walk to an excerpt with Indic lines and one without English: shows "No English for this line yet."
  const seen={};
  for(let i=0;i<5;i++){const t=await p.evaluate(()=>({h:document.querySelector(".wh h2").textContent,en:document.querySelectorAll(".ln .en").length,noen:document.querySelectorAll(".ln .noen").length,qs:document.querySelectorAll("fieldset").length,ovf:document.documentElement.scrollWidth>innerWidth}));seen[t.h]=t;
   await p.click("#next");await p.waitForTimeout(120)}
  await p.click("#tab-res");await p.waitForTimeout(300);
  const res=await p.evaluate(()=>document.getElementById("res").textContent.replace(/\s+/g," ").slice(0,300));
  await p.screenshot({path:path.join(out,"shots",name+"-results.png")});
  const anyNoEn=Object.values(seen).some(t=>t.noen>0),fiveQ=Object.values(seen).some(t=>t.qs===5),fourQ=Object.values(seen).some(t=>t.qs===4),ovf=Object.values(seen).some(t=>t.ovf);
  const ok=first.qs>=4&&first.lines>=2&&!first.overflow&&!ovf&&!first.leak&&saved.a&&saved.a.note==="test note"&&saved.a.readable&&saved.a.garbled
    &&/^0 \/ 5 rated$/.test(first.mid)&&/1 \/ 5 rated/.test(saved.prog)&&(phone||kb===1)&&anyNoEn&&fiveQ&&fourQ&&/Raters: 1/.test(res)&&/best answer|Complete ratings: 1/.test(res)&&errs.length===0
    &&first.minOpt>=48&&(!phone||(first.nextH>=44&&first.hdr==="static"));
  if(!ok)bad++;
  lines.push(`${ok?"PASS":"FAIL"} ${name}: ${first.title}, ${first.lines} lines, ${first.qs} questions (option min ${first.minOpt}px), overflow ${first.overflow||ovf}, leak ${first.leak}, before ${first.mid} after ${saved.prog}, saved ${saved.a&&saved.a.readable}/${saved.a&&saved.a.garbled}, no-English line ${anyNoEn}, 4-q ${fourQ} 5-q ${fiveQ}, keyboard ${kb}, errors ${errs.length}${errs.length?" "+errs[0]:""}`);
  await ctx.close();
 }
 await br.close();srv.kill();
 console.log(lines.join("\n"));console.log("screenshots:",path.join(out,"shots"));
 process.exit(bad?1:0);
})();
