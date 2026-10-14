// Real-browser check of the review page (Chromium via Playwright) at phone width and desktop, light and dark.
// Run through browser-check.sh. Uses the invented mock consults only; screenshots go to <out>/shots.
const {chromium}=require("playwright");
const {spawn}=require("child_process");
const fs=require("fs"),path=require("path");
const out=process.argv[2],here=__dirname,port=8781;
fs.mkdirSync(path.join(out,"shots"),{recursive:true});
(async()=>{
 const srv=spawn("python3",[path.join(here,"serve-harness.py"),out,String(port)],{stdio:"ignore"});
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
  await p.goto(`http://127.0.0.1:${port}/harness.html`);await p.waitForSelector(".chip");
  await p.click('.chip[data-go="T01"]');
  const m=await p.evaluate(()=>{const H=e=>Math.round(e.getBoundingClientRect().height),q=s=>[...document.querySelectorAll(s)];
   return{rows:q("#qs .q").length,overflow:document.documentElement.scrollWidth>innerWidth,
    minAct:Math.min(...q("[data-act]").map(H)),minPl:Math.min(...q(".pl-b").map(H)),hdr:getComputedStyle(document.getElementById("hdr")).position}});
  await p.screenshot({path:path.join(out,"shots",name+"-T01.png")});
  await p.evaluate(()=>scrollTo(0,900));await p.waitForTimeout(150);
  const top=await p.evaluate(()=>Math.round(document.getElementById("player").getBoundingClientRect().top));
  await p.click("#pl-play");await p.waitForTimeout(1300);
  const t1=await p.evaluate(()=>document.getElementById("pl-time").textContent);
  const seeks=await p.$$(".seek");await seeks[6].scrollIntoViewIfNeeded();await seeks[6].click();await p.waitForTimeout(900);
  const t2=await p.evaluate(()=>({time:document.getElementById("pl-time").textContent,now:(document.querySelector(".turn.now")||{}).id}));
  await p.screenshot({path:path.join(out,"shots",name+"-playing.png")});
  await p.click("#pl-play");
  await p.click('.chip[data-go="T02"]');await p.evaluate(()=>scrollTo(0,0));
  const t02=await p.evaluate(()=>({rows:document.querySelectorAll("#qs .q").length,grey:document.querySelectorAll(".turn.outside").length}));
  await p.screenshot({path:path.join(out,"shots",name+"-T02.png")});
  const phone=opts.viewport.width<=560;
  const ok=m.rows===9&&!m.overflow&&t02.rows===2&&t02.grey===3&&t2.time.startsWith("0:5")&&errs.length===0&&(!phone||(m.minAct>=44&&m.minPl>=44&&m.hdr==="static"&&top===0));
  if(!ok)bad++;
  lines.push(`${ok?"PASS":"FAIL"} ${name}: rows ${m.rows}/${t02.rows}, overflow ${m.overflow}, min button ${m.minAct}/${m.minPl}px, header ${m.hdr}, player top ${top}, audio ${t1} -> tap -> ${t2.time} (now ${t2.now}), errors ${errs.length}`);
  await ctx.close();
 }
 await br.close();srv.kill();
 console.log(lines.join("\n"));console.log("screenshots:",path.join(out,"shots"));
 process.exit(bad?1:0);
})();
