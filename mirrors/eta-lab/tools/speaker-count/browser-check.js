// Real-browser check of the Speaker Count page (Chromium via Playwright): phone width and desktop, light and dark.
// Run through browser-check.sh. Invented mock windows only.
const {chromium}=require("playwright");
const {spawn}=require("child_process");
const fs=require("fs"),path=require("path");
const out=process.argv[2],here=__dirname,port=20000+Math.floor(Math.random()*30000);
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
  const H=e=>Math.round(e.getBoundingClientRect().height);
  const m=await p.evaluate(()=>{const q=s=>[...document.querySelectorAll(s)],H=e=>Math.round(e.getBoundingClientRect().height);
   return{chips:q(".chip").length,radios:q(".grid .opt span").length,minAns:Math.min(...q(".opt span").map(H)),minPl:Math.min(...q(".pl-b").map(H)),
    overflow:document.documentElement.scrollWidth>innerWidth,
    leak:/teacher|nemotron|pyannote|Room \d|2026-09/i.test(document.body.innerText+document.body.innerHTML.replace(/<script[\s\S]*?<\/script>/g,"")),
    nextH:H(document.getElementById("next"))}});
  await p.screenshot({path:path.join(out,"shots",name+"-window.png")});
  // play, scrub, answer, next, reload-safe state
  await p.click("#pl-play");await p.waitForTimeout(1300);
  const t1=await p.evaluate(()=>({time:document.getElementById("pl-time").textContent,src:P.audio&&P.audio.src.slice(0,5),playing:P.playing}));
  await p.evaluate(()=>{const s=document.getElementById("pl-seek");s.value="12";s.dispatchEvent(new Event("input",{bubbles:true}))});await p.waitForTimeout(500);
  const t2=await p.evaluate(()=>document.getElementById("pl-time").textContent);
  await p.click("#pl-play");
  await p.click("#n-3");await p.click("#conf-unsure");await p.fill("#note","test note");await p.waitForTimeout(1000);
  const saved=await p.evaluate(()=>{const c=window.__counts&&window.__counts.u1;const k=c&&Object.keys(c.w)[0];return{k,a:c&&c.w[k],prog:document.getElementById("prog").textContent}});
  await p.screenshot({path:path.join(out,"shots",name+"-answered.png")});
  await p.click("#next");await p.waitForTimeout(300);
  const nx=await p.evaluate(()=>({h2:document.querySelector(".wh h2").textContent,checked:document.querySelectorAll("input:checked").length}));
  const first=(await p.evaluate(()=>[...document.querySelectorAll(".wh h2")].map(x=>x.textContent)))[0];
  // owner results tab
  await p.click("#tab-res");await p.waitForTimeout(200);
  const res=await p.evaluate(()=>document.getElementById("res").textContent.replace(/\s+/g," ").slice(0,140));
  const ok=m.chips===4&&m.radios===9&&!m.overflow&&!m.leak&&t1.src==="blob:"&&t1.playing&&t2.startsWith("0:12")&&saved.a&&saved.a.n===3&&saved.a.conf==="unsure"&&saved.a.note==="test note"
    &&nx.checked===0&&/1 \/ 4 answered|Raters: 1/.test(saved.prog+res)&&errs.length===0&&m.minAns>=48&&(opts.viewport.width>560||(m.minPl>=44&&m.nextH>=44));
  if(!ok)bad++;
  lines.push(`${ok?"PASS":"FAIL"} ${name}: chips ${m.chips}, count buttons ${m.radios} (min ${m.minAns}px), player buttons min ${m.minPl}px, overflow ${m.overflow}, hidden-field leak ${m.leak}, audio ${t1.src} playing ${t1.playing}, scrub -> ${t2}, saved n=${saved.a&&saved.a.n} ${saved.a&&saved.a.conf}, next -> "${nx.h2}", errors ${errs.length}`);
  await ctx.close();
 }
 await br.close();srv.kill();
 console.log(lines.join("\n"));console.log("screenshots:",path.join(out,"shots"));
 process.exit(bad?1:0);
})();
