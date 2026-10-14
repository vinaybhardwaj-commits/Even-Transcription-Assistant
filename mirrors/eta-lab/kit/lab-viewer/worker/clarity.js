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

// ---- SCORECARD (W33.5): S1 synthetic truth, S2 clinical truth, S3 language truth; old router vs new router. Numbers only, whitelisted and typed here.
// Shapes: /home/eta/oc/lab-viewer/SCORECARD-SHAPES.md. The viewer shows old, new and the difference; it never invents a verdict (an evaluator's own `verdict` is shown as theirs).
const LANGS = new Set(["en", "hi", "kn", "ta", "te", "ml", "hi-en", "kn-en", "mr", "bn", "gu", "pa", "or", "und", "mixed", "none", "all"]);
const CONDS = new Set(["clean", "fan10", "babble5", "all"]);
const fnum = (v, lo, hi) => (v !== null && v !== "" && Number.isFinite(+v) && +v >= lo && +v <= hi ? Math.round(+v * 10000) / 10000 : null);
const pair = (o, keys, ranges) => { const out = {}; for (const [i, k] of keys.entries()) out[k] = fnum(o?.[k], ...ranges[i]); return out; };
const vOf = (v) => (v && ["win", "no-win", "worse", "pending"].includes(v.status) ? { status: v.status, note: rstr(v.note, 120) } : null);
const head = (d) => ({ run_id: rstr(d?.run_id, 60), prereg: rstr(d?.prereg_sha256, 64).replace(/[^0-9a-f]/gi, ""), old: rstr(d?.old, 60), new: rstr(d?.new, 60), verdict: vOf(d?.verdict) });
const rowsOf = (d) => (Array.isArray(d?.rows) ? d.rows.slice(0, 200) : []).filter((r) => r && typeof r === "object");
export function scorecardOf(doc) {
  const out = { s1: null, s2: null, s3: null };
  if (doc?.s1 && typeof doc.s1 === "object") {
    const K = ["wer", "cer", "hit"], R = [[0, 100], [0, 100], [0, 100]];
    out.s1 = { ...head(doc.s1), suite: rstr(doc.s1.suite_id, 60), rows: rowsOf(doc.s1).filter((r) => LANGS.has(r.lang) && CONDS.has(r.cond)).map((r) => ({ lang: r.lang, cond: r.cond, n: fnum(r.n, 0, 1e6), old: pair(r.old, K, R), new: pair(r.new, K, R) })) };
  }
  if (doc?.s2 && typeof doc.s2 === "object") {
    const K = ["captured_pct", "lo", "hi"], R = [[0, 100], [0, 100], [0, 100]];
    out.s2 = { ...head(doc.s2), scorer: rstr(doc.s2.scorer, 20), sample: { consults: fnum(doc.s2.sample?.consults, 0, 1e5), items: fnum(doc.s2.sample?.items, 0, 1e6) },
      rows: rowsOf(doc.s2).filter((r) => r.scope === "overall" || r.scope === "drugs" || LANGS.has(r.scope)).map((r) => ({ scope: r.scope, n: fnum(r.n, 0, 1e6), old: pair(r.old, K, R), new: pair(r.new, K, R) })) };
  }
  if (doc?.s3 && typeof doc.s3 === "object") {
    const j = doc.s3.judge && typeof doc.s3.judge === "object" ? doc.s3.judge : null;
    const per = {};
    for (const [k, v] of Object.entries(j?.accuracy?.per_lang && typeof j.accuracy.per_lang === "object" ? j.accuracy.per_lang : {}).slice(0, 20)) if (LANGS.has(k) && fnum(v, 0, 100) !== null) per[k] = fnum(v, 0, 100);
    out.s3 = { ...head(doc.s3), judge: j ? { model: rstr(j.model, 60), validated_on: rstr(j.validated_on, 60), overall: fnum(j.accuracy?.overall, 0, 100), per_lang: per, usable: j.usable === true } : null,
      rows: rowsOf(doc.s3).filter((r) => LANGS.has(r.lang)).map((r) => ({ lang: r.lang, n: fnum(r.n, 0, 1e6), old: pair(r.old, ["wrong_pct"], [[0, 100]]), new: pair(r.new, ["wrong_pct"], [[0, 100]]) })) };
  }
  return out;
}
const HIGHER_BETTER = new Set(["hit", "captured_pct"]);
// "old -> new (+delta)": green when better, red when worse; lower is better for wer/cer/wrong_pct
function cmp(o, n, key, unit = "") {
  const a = o?.[key] ?? null, b = n?.[key] ?? null;
  const f = (v) => (v === null ? "—" : String(Math.round(v * 1000) / 1000) + unit);
  if (a === null || b === null) return `<td>${f(a)} → ${f(b)}</td>`;
  const d = Math.round((b - a) * 1000) / 1000, better = HIGHER_BETTER.has(key) ? d > 0 : d < 0;
  return `<td class="${d === 0 ? "" : better ? "good" : "bad"}">${f(a)} → ${f(b)} <span class="mut">(${d > 0 ? "+" : ""}${d}${unit})</span></td>`;
}
const verdictHtml = (v) => (v ? `<span class="vd ${esc(v.status)}">${esc(v.status)}</span>${v.note ? ` <span class="mut">${esc(v.note)}</span>` : ""}` : `<span class="mut">no verdict supplied</span>`);
const meta = (s, extra = "") => `<p class="mut">run ${esc(s.run_id || "?")} · old <code>${esc(s.old || "?")}</code> → new <code>${esc(s.new || "?")}</code> · pre-registered <code>${esc(s.prereg ? s.prereg.slice(0, 12) : "not stated")}</code>${extra} · ${verdictHtml(s.verdict)}</p>`;
const pending = (t, why) => `<div class="sc"><h2>${esc(t)}</h2><p class="none">${esc(why)}</p></div>`;
export function scorecardHtml(sc) {
  if (!sc) return "";
  const parts = [];
  if (!sc.s1) parts.push(pending("S1 synthetic truth (exact)", "pending: the router-fix eval on the SELFTEST suite has not been loaded."));
  else {
    const per = sc.s1.rows.filter((r) => r.cond === "all"), other = sc.s1.rows.filter((r) => r.cond !== "all");
    const tr = (r, lab) => `<tr><td>${esc(lab)}</td><td>${r.n ?? "—"}</td>${cmp(r.old, r.new, "wer")}${cmp(r.old, r.new, "cer")}${cmp(r.old, r.new, "hit", "%")}</tr>`;
    const T = (rows, lab) => `<table><thead><tr><th>${lab}</th><th>n</th><th>WER</th><th>CER</th><th>item hit</th></tr></thead><tbody>${rows}</tbody></table>`;
    parts.push(`<div class="sc"><h2>S1 synthetic truth (exact)</h2>${meta(sc.s1, sc.s1.suite ? ` · suite <code>${esc(sc.s1.suite)}</code>` : "")}${T(per.map((r) => tr(r, r.lang)).join("") || `<tr><td colspan="5" class="none">no per-language rows</td></tr>`, "language")}` +
      (other.length ? `<details><summary>per noise condition (${other.length} rows)</summary>${T(other.map((r) => tr(r, `${r.lang} · ${r.cond}`)).join(""), "language · condition")}</details>` : "") + `</div>`);
  }
  if (!sc.s2) parts.push(pending("S2 clinical truth (real consults, CAP scorer)", "pending: cap's router arm has not been loaded."));
  else {
    const tr = (r) => `<tr><td>${esc(r.scope)}</td><td>${r.n ?? "—"}</td>${cmp(r.old, r.new, "captured_pct", "%")}<td class="mut">${r.new.lo === null ? "—" : `${r.new.lo}–${r.new.hi}%`}</td></tr>`;
    parts.push(`<div class="sc"><h2>S2 clinical truth (real consults, CAP scorer)</h2>${meta(sc.s2, ` · scorer <code>${esc(sc.s2.scorer || "?")}</code> · ${sc.s2.sample.consults ?? "?"} consults, ${sc.s2.sample.items ?? "?"} items`)}` +
      `<table><thead><tr><th>scope</th><th>items</th><th>captured</th><th>new: held-out range</th></tr></thead><tbody>${sc.s2.rows.map(tr).join("") || `<tr><td colspan="4" class="none">no rows</td></tr>`}</tbody></table></div>`);
  }
  if (!sc.s3) parts.push(pending("S3 language truth (real windows, listening judge)", "pending: the language-judge run has not been loaded."));
  else {
    const j = sc.s3.judge, usable = !!(j && j.usable);
    const jl = j ? `judge ${esc(j.model || "?")}, proven on ${esc(j.validated_on || "?")}: ${j.overall === null ? "?" : j.overall + "%"} overall${Object.keys(j.per_lang).length ? " (" + Object.entries(j.per_lang).map(([k, v]) => `${esc(k)} ${v}%`).join(", ") + ")" : ""}` : "no judge validation supplied";
    const tr = (r) => `<tr><td>${esc(r.lang)}</td><td>${r.n ?? "—"}</td>${cmp(r.old, r.new, "wrong_pct", "%")}</tr>`;
    parts.push(`<div class="sc${usable ? "" : " grey"}"><h2>S3 language truth (real windows, listening judge)</h2>${meta(sc.s3)}<p class="${usable ? "mut" : "warn"}">${usable ? jl : "Judge not proven (needs ≥95% overall and ≥90% per language on the SELFTEST audio): numbers below are NOT usable. " + jl}</p>` +
      `<table><thead><tr><th>language heard</th><th>windows</th><th>sent down the wrong path</th></tr></thead><tbody>${sc.s3.rows.map(tr).join("") || `<tr><td colspan="3" class="none">no rows</td></tr>`}</tbody></table></div>`);
  }
  return `<section class="scorecard"><h1>Scorecard: old router vs new router, same audio</h1><p class="mut">Three automatic scores, pre-registered. A change wins only if S2 improves and S1 / S3 do not get worse. Green = better, red = worse. The per-clip table below is for spot-checks.</p>${parts.join("")}</section>`;
}

export async function clarityModel(env) {
  const get = async (key) => { try { const o = env.RATINGS && (await env.RATINGS.get(key)); return o ? JSON.parse(await o.text()) : null; } catch { return null; } };
  const clips = await get("clarity/clips.json"), fixed = await get("clarity/fixed.json"), sc = await get("clarity/scorecard.json");
  return { rows: clipsOf(clips), fixed: fixedOf(fixed), loaded: !!clips, sc: scorecardOf(sc) };
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
.scorecard h1{font-size:19px;margin:10px 0 2px}.sc{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px 12px;margin:10px 0;overflow-x:auto}.sc.grey{opacity:.6}.sc h2{font-size:16px;margin:0 0 2px}.sc p{margin:2px 0}
.sc table{border-collapse:collapse;width:100%;font-size:13px;margin:6px 0}.sc th,.sc td{border:1px solid var(--line);padding:3px 6px;text-align:left}.sc th{background:var(--bg)}.sc code{font-size:12px}
.good{color:#1a7f37;font-weight:600}.bad{color:var(--warn);font-weight:600}.vd{border-radius:99px;padding:0 8px;font-weight:600;background:var(--line)}.vd.win{background:#a9d9a3;color:#111}.vd.worse{background:#f0b98f;color:#111}
@media (prefers-color-scheme:dark){.good{color:#7fd58f}}
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
<body><header><h1>ETA lab — CLARITY: label200 clips, engines side by side</h1><nav><a href="/">Viewer</a><a href="/clarity">Reset filters</a></nav></header><main>${scorecardHtml(model.sc)}${body}</main></body></html>`;
}
