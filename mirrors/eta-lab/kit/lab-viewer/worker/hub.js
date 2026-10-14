// The rating hub (/rate, FABLE W27.4b): ONE page listing every rating set the viewer serves, with how far each rater has got.
// Raters only (the same RATERS gate as the rating pages). COUNTS AND TIMES ONLY: no answer, label, note or row text ever appears here,
// so it cannot unblind anyone. Server-rendered, zero client script, same per-response nonce CSP as the viewer.
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const TITLES = {
  label200: "Label lines (200 lines: is each readable?)",
  rate20: "Rate excerpts (20 excerpts)",
  ba106: "Compare A/B (106 pairs, 10 identical controls)",
  calib30: "Calibration (30 items: 20 lines, 10 pairs)",
};

const CSS = `
:root{--bg:#fbfaf7;--fg:#1d1d1b;--mut:#6b6a63;--line:#dcd9cf;--acc:#0b5cab;--card:#fff;--ok:#1a7f37;--warn:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecebe6;--mut:#a09f96;--line:#33332f;--acc:#7db4f0;--card:#1e1e1c;--ok:#7fd58f;--warn:#f2b8b5}}
*{box-sizing:border-box}body{overflow-wrap:anywhere;margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
header{border-bottom:1px solid var(--line);padding:10px 16px}header h1{font-size:18px;margin:0 0 6px}nav a{margin-right:14px;color:var(--acc);text-decoration:none;font-weight:600}
main{padding:12px 16px 60px;max-width:820px;margin:0 auto}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:12px 0}
.card h2{font-size:17px;margin:0 0 4px}.mut{color:var(--mut);font-size:13px}.who{display:flex;gap:10px;align-items:center;margin:8px 0 0}.who b{min-width:5.5em}
.bar{flex:1;height:10px;accent-color:var(--acc)}.done .bar{accent-color:var(--ok)}.n{font-variant-numeric:tabular-nums;min-width:5.5em;text-align:right}a{color:var(--acc)}.warn{color:var(--warn)}
`;

// model.sets: [{ set, loaded: number|null, raters: [{ name, done: number|null, updated: string|null }] }]
export function hubPage(model) {
  const cards = model.sets.map((s) => {
    const title = TITLES[s.set] ?? s.set;
    if (!s.loaded) return `<div class="card"><h2>${esc(title)}</h2><div class="mut">Not loaded yet: there are no rows to rate.</div></div>`;
    const who = s.raters.map((r) => {
      const cls = r.done !== null && r.done >= s.loaded ? "who done" : "who";
      return `<div class="${cls}"><b>${esc(r.name)}</b><progress class="bar" max="${s.loaded}" value="${r.done ?? 0}"></progress><span class="n">${r.done === null ? "unreadable" : `${r.done} / ${s.loaded}`}</span></div>` +
        `<div class="mut">${r.updated ? `last saved ${esc(r.updated.slice(0, 16).replace("T", " "))} UTC` : "not started"}</div>`;
    }).join("");
    return `<div class="card"><h2><a href="/rate/${esc(s.set)}">${esc(title)}</a></h2>${who}</div>`;
  }).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>ETA lab — rating hub</title><style nonce="__NONCE__">${CSS}</style></head>
<body><header><h1>ETA lab — rating hub</h1><nav><a href="/">Viewer</a></nav></header>
<main><p class="mut">Every open rating task and how far each rater has got. Counts only: nobody's answers are shown here.</p>${cards}</main></body></html>`;
}
