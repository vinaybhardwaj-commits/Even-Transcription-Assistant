// The /clarity page (Fable 07:50, CLARITY): one row per label200 clip - audio, router tag, Whisper auto-LID, and the three Phase B engine texts side by side,
// plus an empty FIXED ROUTER column that fills from router-fix's offline eval. Data: clarity/clips.json, clarity/fixed.json and clarity/audio/Lnnn.webm in
// eta-lab-ratings (loaded by tools/clarity_seed.py; READ-ONLY here). Server-rendered and escape-first, ZERO client script; filters are plain links (the CSP has form-action 'none').
// The rows hold PHI (transcripts, clip audio): shown to Access-restricted physicians only (same gate as every route).
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const rstr = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
const TAG = /^[a-z]{2,8}$/;
export const CLIP_ID = /^L\d{3}$/;

// the script a router tag implies; und (and anything unknown) implies none, so it can never be a "mismatch"
export const EXPECT = { en: "Latin", hi: "Devanagari", mr: "Devanagari", kn: "Kannada", te: "Telugu", ta: "Tamil", ml: "Malayalam", bn: "Bengali", gu: "Gujarati", pa: "Gurmukhi", or: "Oriya" };
const SCRIPTS = { Latin: /\p{Script=Latin}/u, Devanagari: /\p{Script=Devanagari}/u, Kannada: /\p{Script=Kannada}/u, Telugu: /\p{Script=Telugu}/u, Tamil: /\p{Script=Tamil}/u,
  Malayalam: /\p{Script=Malayalam}/u, Bengali: /\p{Script=Bengali}/u, Gujarati: /\p{Script=Gujarati}/u, Gurmukhi: /\p{Script=Gurmukhi}/u, Oriya: /\p{Script=Oriya}/u };
// the script most of the letters are in; a letter in none of the ten known scripts (Arabic/Urdu, Cyrillic, CJK...) counts as "Other", so it is a mismatch under any tag with a script; null = no letters at all
export function dominantScript(text) {
  const n = {};
  for (const ch of String(text ?? "")) {
    if (!/\p{L}/u.test(ch)) continue;
    const name = Object.entries(SCRIPTS).find(([, re]) => re.test(ch))?.[0] ?? "Other";
    n[name] = (n[name] || 0) + 1;
  }
  const best = Object.entries(n).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : null;
}

const cleanEng = (e) => ({ st: ["text", "empty", "skipped", "error", "missing"].includes(e?.st) ? e.st : "missing", t: rstr(e?.t, 3000), why: rstr(e?.why, 120) });
// whitelist + type every field; a row with a bad id is dropped
export function clipsOf(doc) {
  const rows = [];
  for (const r of (Array.isArray(doc?.rows) ? doc.rows : []).slice(0, 400)) {
    if (!r || !CLIP_ID.test(r.id ?? "")) continue;
    const L = r.lid && typeof r.lid === "object" ? r.lid : null;
    const num = (v) => (Number.isFinite(+v) && v !== null ? Math.round(+v * 1000) / 1000 : null);
    const row = { id: r.id, n: Number.isInteger(r.n) ? r.n : 0, tag: TAG.test(r.tag ?? "") ? r.tag : "und", dur_s: num(r.dur_s) ?? 0,
      lid: L ? { name: rstr(L.name, 24), code: TAG.test(L.code ?? "") ? L.code : null, p: num(L.p), p_en: num(L.p_en) } : null,
      whisper: cleanEng(r.whisper), sravaani: cleanEng(r.sravaani), indic: cleanEng(r.indic) };
    row.exp = EXPECT[row.tag] ?? null;
    row.got = row.sravaani.st === "text" ? dominantScript(row.sravaani.t) : null;
    row.mismatch = !!(row.exp && row.got && row.exp !== row.got);   // SraVaani's output is not in the script the router tag implies
    row.lowen = !row.lid || row.lid.p_en === null || row.lid.p_en < 0.9;   // unknown p(en) counts as low: the top-3 did not even hold English
    row.lidDiff = !!(row.lid && row.lid.code && row.tag !== "und" && row.lid.code !== row.tag);   // Whisper's auto-LID disagrees with the router tag
    rows.push(row);
  }
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}
export function fixedOf(doc) {
  const out = {};
  const rows = doc && typeof doc.rows === "object" && !Array.isArray(doc.rows) ? doc.rows : {};
  for (const [id, v] of Object.entries(rows).slice(0, 400)) {
    if (!CLIP_ID.test(id) || !v || !TAG.test(v.tag ?? "")) continue;
    out[id] = { tag: v.tag, conf: Number.isFinite(+v.conf) && v.conf !== null ? Math.round(+v.conf * 100) / 100 : null, alt: (Array.isArray(v.alt) ? v.alt : []).filter((a) => TAG.test(a ?? "")).slice(0, 2), note: rstr(v.note, 80) };
  }
  return { run_id: rstr(doc?.run_id, 60), rows: out };
}

export async function clarityModel(env) {
  const get = async (key) => { try { const o = env.RATINGS && (await env.RATINGS.get(key)); return o ? JSON.parse(await o.text()) : null; } catch { return null; } };
  const clips = await get("clarity/clips.json"), fixed = await get("clarity/fixed.json");
  return { rows: clipsOf(clips), fixed: fixedOf(fixed), loaded: !!clips };
}

export function parseFilters(search) {
  const q = new URLSearchParams(search);
  const tag = q.get("tag") ?? "";
  return { tag: TAG.test(tag) ? tag : "", lowen: q.get("lowen") === "1", mm: q.get("mm") === "1", lid: q.get("lid") === "1" };
}
export const applyFilters = (rows, f) => rows.filter((r) => (!f.tag || r.tag === f.tag) && (!f.lowen || r.lowen) && (!f.mm || r.mismatch) && (!f.lid || r.lidDiff));

const CSS = `
:root{--bg:#fbfaf7;--fg:#1d1d1b;--mut:#6b6a63;--line:#dcd9cf;--acc:#0b5cab;--card:#fff;--warn:#b3261e;--hi:#fff3bf}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecebe6;--mut:#a09f96;--line:#33332f;--acc:#7db4f0;--card:#1e1e1c;--warn:#f2b8b5;--hi:#4a3f12}}
*{box-sizing:border-box}body{overflow-wrap:anywhere;margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
header{border-bottom:1px solid var(--line);padding:10px 16px}header h1{font-size:18px;margin:0 0 6px}nav a{margin-right:14px;color:var(--acc);text-decoration:none;font-weight:600}
main{padding:10px 16px 60px;max-width:1400px;margin:0 auto}.mut{color:var(--mut);font-size:13px}a{color:var(--acc)}
.flt{margin:8px 0;display:flex;flex-wrap:wrap;gap:6px;align-items:center}.flt b{margin-right:4px}.flt a{border:1px solid var(--line);border-radius:99px;padding:2px 10px;text-decoration:none;background:var(--card)}.flt a.on{background:var(--acc);color:var(--bg);border-color:var(--acc)}
.clip{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin:10px 0}.clip.mm{border-left:4px solid var(--warn)}
.top{display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center}.top b{font-size:16px}.tag{border:1px solid var(--line);border-radius:99px;padding:0 8px;font-weight:600}
audio{width:100%;max-width:420px;height:36px;margin:6px 0}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:8px}.col{border:1px solid var(--line);border-radius:8px;padding:6px 8px;min-width:0}
.col h3{margin:0 0 3px;font-size:12px;color:var(--mut);font-weight:600;text-transform:uppercase;letter-spacing:.03em}.col p{margin:0;white-space:pre-wrap}.col .none{color:var(--mut);font-style:italic}
.warn{color:var(--warn)}.chg{background:var(--hi)}
`;

const fmtP = (v) => (v === null ? "n/a" : v.toFixed(2));
const colHtml = (title, e, extra = "") => {
  let body;
  if (e.st === "text") body = `<p>${esc(e.t)}</p>`;
  else if (e.st === "skipped") body = `<p class="none">not run${e.why ? ": " + esc(e.why) : ""}</p>`;
  else if (e.st === "empty") body = `<p class="none">(empty output)</p>`;
  else body = `<p class="none">(no result)</p>`;
  return `<div class="col"><h3>${esc(title)}${extra}</h3>${body}</div>`;
};

export function clarityPage(model, f, search = "") {
  const rows = applyFilters(model.rows, f);
  const link = (label, patch, on) => {
    const q = new URLSearchParams();
    const g = { ...f, ...patch };
    if (g.tag) q.set("tag", g.tag); if (g.lowen) q.set("lowen", "1"); if (g.mm) q.set("mm", "1"); if (g.lid) q.set("lid", "1");
    const s = q.toString();
    return `<a class="${on ? "on" : ""}" href="/clarity${s ? "?" + esc(s) : ""}">${esc(label)}</a>`;
  };
  const tags = [...new Set(model.rows.map((r) => r.tag))].sort();
  const flt = `<div class="flt"><b>Router tag</b>${link("all", { tag: "" }, !f.tag)}${tags.map((t) => link(`${t} (${model.rows.filter((r) => r.tag === t).length})`, { tag: t }, f.tag === t)).join("")}</div>` +
    `<div class="flt"><b>Only</b>${link("p(en) < 0.9", { lowen: !f.lowen }, f.lowen)}${link("script mismatch", { mm: !f.mm }, f.mm)}${link("LID differs from tag", { lid: !f.lid }, f.lid)}</div>`;
  const cards = rows.map((r) => {
    const fx = model.fixed.rows[r.id];
    const L = r.lid;
    const lidTxt = L ? `LID: ${esc(L.name || L.code || "?")}${L.code ? ` (${esc(L.code)})` : ""} p=${fmtP(L.p)} · p(en) ${L.p_en === null ? "below the top 3" : fmtP(L.p_en)}` : "LID: none";
    const fixedCol = fx
      ? `<div class="col"><h3>Fixed router</h3><p class="${fx.tag !== r.tag ? "chg" : ""}"><b>${esc(fx.tag)}</b>${fx.conf !== null ? ` · ${fx.conf}` : ""}${fx.alt.length ? ` · alt ${esc(fx.alt.join(", "))}` : ""}${fx.tag !== r.tag ? ` <span class="mut">(was ${esc(r.tag)})</span>` : ""}${fx.note ? `<br><span class="mut">${esc(fx.note)}</span>` : ""}</p></div>`
      : `<div class="col"><h3>Fixed router</h3><p class="none">not filled yet</p></div>`;
    const scr = r.exp ? (r.got ? (r.mismatch ? `<span class="warn">SraVaani script ${esc(r.got)}, tag expects ${esc(r.exp)}</span>` : `<span class="mut">script ok (${esc(r.got)})</span>`) : `<span class="mut">script: no SraVaani text</span>`) : `<span class="mut">script: tag has none</span>`;
    return `<section class="clip${r.mismatch ? " mm" : ""}" id="${esc(r.id)}"><div class="top"><b>${esc(r.id)}</b><span class="tag">router: ${esc(r.tag)}</span><span class="mut">${r.dur_s.toFixed(1)} s</span><span class="${r.lowen ? "warn" : "mut"}">${lidTxt}</span>${scr}</div>` +
      `<audio controls preload="none" src="/api/clarity/audio/${esc(r.id)}"></audio>` +
      `<div class="cols">${colHtml("Whisper (forced English)", r.whisper)}${colHtml("SraVaani", r.sravaani)}${colHtml("IndicConformer (ctc)", r.indic)}${fixedCol}</div></section>`;
  }).join("");
  const nFixed = Object.keys(model.fixed.rows).length;
  const body = !model.loaded ? `<p class="mut">The CLARITY data is not loaded yet (clarity/clips.json is missing).</p>` : `${flt}<p class="mut">Showing ${rows.length} of ${model.rows.length} clips. Fixed router: ${nFixed ? `${nFixed} clips from ${esc(model.fixed.run_id || "router-fix")}` : "empty until router-fix's offline eval is loaded"}. Script check compares SraVaani's output with the script the router tag implies.</p>${cards || `<p class="mut">No clip matches these filters.</p>`}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>ETA lab — CLARITY</title><style nonce="__NONCE__">${CSS}</style></head>
<body><header><h1>ETA lab — CLARITY: label200 clips, engines side by side</h1><nav><a href="/">Viewer</a><a href="/clarity">Reset filters</a></nav></header><main>${body}</main></body></html>`;
}
