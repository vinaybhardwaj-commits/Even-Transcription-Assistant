/**
 * lib/markdown-min.ts — dependency-free Markdown → HTML for TRUSTED internal
 * docs (the bug log). We can't add a markdown dependency (the sandbox can't
 * update the lockfile, which would break `npm ci` on Vercel), so this renders a
 * safe subset by hand. EVERYTHING is HTML-escaped first and there is no raw-HTML
 * passthrough, so the output can't inject markup even if the source had tags.
 *
 * Supported: ATX headings, fenced code blocks, inline code, **bold**,
 * [text](url) links (http(s)/relative only), blockquotes, ordered & unordered
 * lists, horizontal rules, paragraphs.
 */

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Apply inline markdown to ALREADY-escaped text. Split on inline-code spans so
// bold/link rules never touch the inside of a code span (no placeholder/sentinel
// trickery, so nothing in the text can collide with it).
function inline(text: string): string {
  const parts = text.split(/(`[^`]+`)/g);
  return parts
    .map((part) => {
      if (/^`[^`]+`$/.test(part)) return `<code>${part.slice(1, -1)}</code>`;
      part = part.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, url) => {
        const safe = /^(https?:|\/)/.test(url) ? url : "#";
        const ext = /^https?:/.test(safe);
        return `<a href="${safe}"${ext ? ' target="_blank" rel="noopener noreferrer"' : ""}>${label}</a>`;
      });
      part = part.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      return part;
    })
    .join("");
}

export function renderMarkdown(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  let inCode = false;
  let codeBuf: string[] = [];
  let listType: "ul" | "ol" | null = null;

  const closeList = () => {
    if (listType) { out.push(`</${listType}>`); listType = null; }
  };

  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {
      if (!inCode) { closeList(); inCode = true; codeBuf = []; }
      else { out.push(`<pre><code>${codeBuf.map(escapeHtml).join("\n")}</code></pre>`); inCode = false; }
      i++; continue;
    }
    if (inCode) { codeBuf.push(line); i++; continue; }

    if (/^\s*$/.test(line)) { closeList(); i++; continue; }

    if (/^\s*([-_*])\1{2,}\s*$/.test(line)) { closeList(); out.push("<hr/>"); i++; continue; }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { closeList(); const lvl = h[1].length; out.push(`<h${lvl}>${inline(escapeHtml(h[2].trim()))}</h${lvl}>`); i++; continue; }

    if (/^\s*>\s?/.test(line)) {
      closeList();
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
      out.push(`<blockquote>${inline(escapeHtml(buf.join(" ")))}</blockquote>`);
      continue;
    }

    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    if (ul) {
      if (listType !== "ul") { closeList(); out.push("<ul>"); listType = "ul"; }
      out.push(`<li>${inline(escapeHtml(ul[1]))}</li>`); i++; continue;
    }
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ol) {
      if (listType !== "ol") { closeList(); out.push("<ol>"); listType = "ol"; }
      out.push(`<li>${inline(escapeHtml(ol[1]))}</li>`); i++; continue;
    }

    closeList();
    const para: string[] = [line]; i++;
    while (
      i < lines.length && !/^\s*$/.test(lines[i]) && !/^```/.test(lines[i]) &&
      !/^(#{1,6})\s/.test(lines[i]) && !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) && !/^\s*>\s?/.test(lines[i]) &&
      !/^\s*([-_*])\1{2,}\s*$/.test(lines[i])
    ) { para.push(lines[i]); i++; }
    out.push(`<p>${inline(escapeHtml(para.join(" ")))}</p>`);
  }
  if (inCode) out.push(`<pre><code>${codeBuf.map(escapeHtml).join("\n")}</code></pre>`);
  closeList();
  return out.join("\n");
}
