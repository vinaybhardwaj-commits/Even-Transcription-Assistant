// Real-browser check of the Segment Label page (Chromium via Playwright): phone width and desktop, light and dark.
// Run through browser-check.sh. Invented mock rows only.
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
  const m=await p.evaluate(()=>{const q=s=>[...document.querySelectorAll(s)],H=e=>Math.round(e.getBoundingClientRect().height);
   return{opts:q(".opt input").length,minOpt:Math.min(...q(".opt span").filter(e=>e.parentElement.classList.contains("opt")).map(H)),nextH:H(document.getElementById("next")),
    overflow:document.documentElement.scrollWidth>innerWidth,
    leak:/repeat loop|sravaani|whisper|indicconformer|mock-w\d|"flag"|score/i.test(document.body.innerText+document.body.innerHTML.replace(/<(script|style)[\s\S]*?<\/\1>/g,"")),
    hdr:getComputedStyle(document.getElementById("hdr")).position,prog:document.getElementById("prog").textContent,h:document.querySelector(".wh h2").textContent}});
  await p.screenshot({path:path.join(out,"shots",name+"-line.png")});
  // click a label, note, saved payload
  await p.click("#a-garbled",{force:true});await p.fill("#note","test note");await p.waitForTimeout(1000);
  const saved=await p.evaluate(()=>{const c=window.__labels&&window.__labels.u1;const k=c&&Object.keys(c.t)[0];return{a:c&&c.t[k],prog:document.getElementById("prog").textContent}});
  await p.screenshot({path:path.join(out,"shots",name+"-labelled.png")});
  // desktop: keyboard 1-5 on the next line, and move-on-after-label
  let kb="n/a",fol="n/a";
  if(!phone){await p.evaluate(()=>document.activeElement.blur());await p.keyboard.press("n");await p.waitForTimeout(150);await p.keyboard.press("5");await p.waitForTimeout(150);
   kb=await p.evaluate(()=>(document.querySelector("input[name=a]:checked")||{}).value)}
  else{await p.click("#next");await p.waitForTimeout(150)}
  await p.click("#nextopen");await p.waitForTimeout(150);
  await p.check("#auto",{force:true});const h0=await p.evaluate(()=>document.querySelector(".wh h2").textContent);
  await p.click("#a-readable",{force:true});await p.waitForTimeout(700);
  fol=await p.evaluate(h=>document.querySelector(".wh h2").textContent!==h,h0);
  await p.click("#tab-res");await p.waitForTimeout(300);
  const res=await p.evaluate(()=>document.getElementById("res").textContent.replace(/\s+/g," ").slice(0,300));
  await p.screenshot({path:path.join(out,"shots",name+"-results.png")});
  const ok=m.opts===5&&!m.overflow&&!m.leak&&/0 \/ 4 labelled/.test(m.prog)&&saved.a&&saved.a.a==="garbled"&&saved.a.note==="test note"&&/1 \/ 4 labelled/.test(saved.prog)
    &&(phone||kb==="unsure")&&fol===true&&/Raters: 1/.test(res)&&errs.length===0&&m.minOpt>=48&&(!phone||(m.nextH>=44&&m.hdr==="static"));
  if(!ok)bad++;
  lines.push(`${ok?"PASS":"FAIL"} ${name}: ${m.h}, ${m.opts} labels (min ${m.minOpt}px), overflow ${m.overflow}, leak ${m.leak}, saved ${saved.a&&saved.a.a}, progress ${saved.prog}, keyboard ${kb}, move-on ${fol}, errors ${errs.length}${errs.length?" "+errs[0]:""}`);
  await ctx.close();
 }
 await br.close();srv.kill();
 console.log(lines.join("\n"));console.log("screenshots:",path.join(out,"shots"));
 process.exit(bad?1:0);
})();
