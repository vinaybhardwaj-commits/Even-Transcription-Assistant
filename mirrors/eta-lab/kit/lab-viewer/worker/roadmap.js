// The /roadmap page (FABLE 459.5): renders the embedded docs snapshot (worker/roadmap_docs.js) to HTML SERVER-side.
// No client script at all, no external requests, same per-response nonce CSP as the viewer shell. The renderer is escape-first:
// text is HTML-escaped BEFORE any markup is added, so the docs can never inject tags or attributes; the only elements emitted
// are the fixed set in renderMarkdown below. Content refresh = tools/embed_roadmap.py on a fresh main + redeploy (Fable's word).
import { DOCS } from "./roadmap_docs.js";

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// inline runs on ALREADY-ESCAPED text: code spans are lifted out first so ** and * inside them stay literal,
// then bold, then single-star emphasis; sentinels cannot collide because the escaped text has no NUL bytes.
function inline(escaped) {
  const codes = [];
  let s = escaped.replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return "\u0000" + (codes.length - 1) + "\u0000"; });
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => "<code>" + codes[Number(i)] + "</code>");
}

const isListItem = (l) => /^\s*[-*]\s+\S/.test(l);

export function renderMarkdown(md) {
  const lines = String(md).split(/\r?\n/);
  const out = [];
  let para = [];
  const closePara = () => { if (para.length) { out.push("<p>" + inline(esc(para.join(" "))) + "</p>"); para = []; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) { closePara(); continue; }
    const h = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (h) { closePara(); out.push(`<h${h[1].length}>` + inline(esc(h[2])) + `</h${h[1].length}>`); continue; }
    if (/^ {0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { closePara(); out.push("<hr>"); continue; }
    if (line.startsWith("|") && i + 1 < lines.length && /^\|[\s|:-]+\|\s*$/.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      closePara();
      const cells = (l) => l.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
      const head = "<tr>" + cells(line).map((c) => "<th>" + inline(esc(c)) + "</th>").join("") + "</tr>";
      let rows = "", n = i + 2;
      for (; n < lines.length && lines[n].startsWith("|"); n++) rows += "<tr>" + cells(lines[n]).map((c) => "<td>" + inline(esc(c)) + "</td>").join("") + "</tr>";
      out.push("<table><thead>" + head + "</thead><tbody>" + rows + "</tbody></table>");
      i = n - 1;
      continue;
    }
    if (isListItem(line)) {
      closePara();
      const items = [];
      for (; i < lines.length && (isListItem(lines[i]) || (!lines[i].trim() && i + 1 < lines.length && isListItem(lines[i + 1]))); i++) {
        if (!lines[i].trim()) continue;
        const m = lines[i].match(/^(\s*)[-*]\s+(.*)$/);
        items.push({ lvl: m[1].length >= 2 ? 1 : 0, txt: m[2] });
      }
      i--;
      let html = "<ul>";
      for (let k = 0; k < items.length; k++) {
        const it = items[k];
        html += "<li>" + inline(esc(it.txt));
        if (it.lvl === 0 && items[k + 1]?.lvl === 1) {
          html += "<ul>";
          let j = k + 1;
          for (; j < items.length && items[j].lvl === 1; j++) html += "<li>" + inline(esc(items[j].txt)) + "</li>";
          html += "</ul>";
          k = j - 1;
        }
        html += "</li>";
      }
      out.push(html + "</ul>");
      continue;
    }
    para.push(line.trim());
  }
  closePara();
  return out.join("\n");
}

const CSS = `
:root{--bg:#fbfaf7;--fg:#1d1d1b;--mut:#6b6a63;--line:#dcd9cf;--acc:#0b5cab;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecebe6;--mut:#a09f96;--line:#33332f;--acc:#7db4f0;--card:#1e1e1c}}
*{box-sizing:border-box}body{overflow-wrap:anywhere;margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,sans-serif}
header{position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--line);padding:10px 16px}
header h1{font-size:18px;margin:0 0 6px}nav a{margin-right:14px;color:var(--acc);text-decoration:none;font-weight:600}
main{padding:12px 16px 80px;max-width:900px;margin:0 auto}
h1{font-size:26px;margin:18px 0 8px}h2{font-size:21px;margin:22px 0 6px;border-bottom:1px solid var(--line);padding-bottom:2px}h3{font-size:17px;margin:16px 0 4px}
p,li{margin:6px 0}ul{margin:6px 0;padding-left:22px}ul ul{margin:2px 0}hr{border:none;border-top:1px solid var(--line);margin:18px 0}
code{background:var(--card);border:1px solid var(--line);border-radius:4px;padding:0 4px;font:0.86em ui-monospace,monospace}
table{border-collapse:collapse;margin:10px 0;width:100%;font-size:14px}th,td{border:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
th{background:var(--card)}section{margin-bottom:34px}.snap{color:var(--mut);font-size:12px;border-top:1px dashed var(--line);padding-top:8px}
a{color:var(--acc)}
`;

const docHtml = (d) => `<section id="${d.anchor}">\n${renderMarkdown(d.text)}\n` +
  `<p class="snap">snapshot of <code>${esc(d.src)}</code> from main at build time, sha256 <code>${d.sha256.slice(0, 16)}…</code> — the page refreshes only when the viewer is rebuilt from a newer main.</p></section>`;

export function roadmapPage() {
  const body = [
    { ...DOCS.roadmap, anchor: "roadmap" },
    { ...DOCS.decisions, anchor: "decisions" },
  ].map(docHtml).join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ETA lab — roadmap</title><style nonce="__NONCE__">${CSS}</style></head>
<body><header><h1>ETA lab — roadmap</h1><nav><a href="#roadmap">Roadmap</a><a href="#decisions">Decisions</a><a href="/">Viewer</a></nav></header>
<main>${body}</main></body></html>`;
}
