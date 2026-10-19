/**
 * Pure HTML renderers for the read-only board. Server-rendered, no SPA, no
 * build step, no external assets: every byte of the page is produced here and
 * the only link to the outside would be an <img>/<script>/<link> to a remote
 * host, of which there are none. Light and dark via prefers-color-scheme.
 *
 * Invariants the tests pin down:
 *  - every string from the hub is HTML-escaped before it is emitted;
 *  - a body is never rendered beyond 280 chars (long content is a file pointer);
 *  - the page refreshes itself every 15 s via <meta http-equiv=refresh>;
 *  - no absolute or external URL appears anywhere in the output.
 */
import type { AgentView, BoardViews, LaneView, MessageView } from "./types.js";

export const BODY_CLIP_CHARS = 280;
export const REFRESH_SECONDS = 15;

/** Escape a string for safe interpolation into HTML text or a double-quoted attr. */
export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Never render a body beyond 280 chars. Content that long is a file pointer;
 * the board shows the first 280 chars plus an ellipsis and the pointer.
 */
export function clipBody(body: string): string {
  const points = Array.from(body ?? "");
  if (points.length <= BODY_CLIP_CHARS) return points.join("");
  return `${points.slice(0, BODY_CLIP_CHARS).join("")}…`;
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

/** Format a heartbeat age for display. Returns "" when unknown. */
export function ageLabel(iso: string | null, nowMs: number): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  let s = Math.max(0, Math.round((nowMs - then) / 1000));
  if (s >= 24 * 3600) return `${Math.floor(s / (24 * 3600))}d ${pad(Math.floor((s % (24 * 3600)) / 3600), 2)}h`;
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${pad(Math.floor((s % 3600) / 60), 2)}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m ${pad(s % 60, 2)}s`;
  return `${s}s`;
}

const ACKED = new Set(["acked", "done"]);

/** Recipients that have not yet acked (rejected recipients are not waiting on anything). */
export function missingRecipients(m: MessageView): string[] {
  const who = new Set<string>([...m.to, ...Object.keys(m.states)]);
  return [...who].filter((r) => {
    const st = m.states[r]?.state;
    return !(st && (ACKED.has(st) || st === "rejected"));
  }).sort();
}

/**
 * An order is a `request` (P0 kind), a legacy order/ask, or anything with an SLA.
 * It is unacked while at least one recipient has not acked.
 */
export function isUnackedOrder(m: MessageView): boolean {
  const order = m.kind === "request" || m.kind === "order" || m.kind === "ask" || (m.sla_s ?? 0) > 0;
  if (!order) return false;
  if (!m.to.length && !Object.keys(m.states).length) return true;
  return missingRecipients(m).length > 0;
}

const STATE_CLASS: Record<string, string> = {
  working: "st-working",
  idle: "st-idle",
  stalled: "st-stalled",
  errored: "st-errored",
  finished: "st-finished",
  offline: "st-offline",
};

const LANE_STATE_CLASS: Record<string, string> = {
  proposed: "ls-proposed",
  claimed: "ls-claimed",
  building: "ls-building",
  built: "ls-built",
  refuting: "ls-refuting",
  pass: "ls-pass",
  fail: "ls-fail",
  merged: "ls-merged",
  abandoned: "ls-abandoned",
};

function stateCell(state: string, table: Record<string, string>, fallback: string): string {
  const cls = table[state] ?? fallback;
  return `<span class="pill ${cls}">${esc(state)}</span>`;
}

export interface BoardPage {
  title: string;
  nav: string;
  body: string;
  /** Relative URL the page should refresh to (keeps any active filter). */
  refreshUrl: string;
  /** Server time used for heartbeat ages, so the output is deterministic in tests. */
  nowMs?: number;
}

const CSS = `
:root{color-scheme:light dark;--bg:#f6f7f9;--fg:#16181d;--muted:#5c6470;--card:#ffffff;--line:#d9dde3;--accent:#2456d6;--ok:#1b8a3f;--warn:#b76e00;--err:#c62828;--idle:#5c6470;--off:#9aa1ab}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--fg:#e6e9ef;--muted:#9aa3b2;--card:#171a21;--line:#262b35;--accent:#7aa2ff;--ok:#4cc36e;--warn:#ffb454;--err:#ff6b6b;--idle:#9aa3b2;--off:#5b6472}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
header{display:flex;align-items:baseline;gap:12px;padding:10px 14px;border-bottom:1px solid var(--line);background:var(--card)}
header h1{font-size:15px;margin:0}
nav{display:flex;gap:4px;flex-wrap:wrap}
nav a{color:var(--accent);text-decoration:none;padding:3px 8px;border-radius:6px}
nav a.on{background:color-mix(in srgb,var(--accent) 16%,transparent);text-decoration:underline}
main{padding:12px 14px;max-width:1100px;margin:0 auto}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin:0 0 14px}
.card h2{font-size:13px;margin:0 0 8px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:5px 8px;border-bottom:1px solid var(--line);vertical-align:top;word-break:break-word}
th{color:var(--muted);font-weight:600;font-size:12px}
tr:last-child td{border-bottom:none}
.pill{display:inline-block;padding:1px 8px;border-radius:999px;border:1px solid var(--line);font-size:12px;white-space:nowrap}
.st-working{color:var(--ok);border-color:var(--ok)}
.st-idle{color:var(--idle);border-color:var(--idle)}
.st-stalled{color:var(--warn);border-color:var(--warn)}
.st-errored{color:var(--err);border-color:var(--err)}
.st-finished{color:var(--accent);border-color:var(--accent)}
.st-offline{color:var(--off);border-color:var(--off)}
.ls-pass{color:var(--ok);border-color:var(--ok)}
.ls-fail{color:var(--err);border-color:var(--err)}
.ls-building,.ls-claimed,.ls-refuting{color:var(--warn);border-color:var(--warn)}
.ls-merged{color:var(--accent);border-color:var(--accent)}
.ls-abandoned,.ls-proposed,.ls-built{color:var(--idle);border-color:var(--idle)}
.muted{color:var(--muted)}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
.mono{font-family:inherit;word-break:break-all}
.msg{border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin:0 0 10px}
.msg.unacked{border-color:var(--err);background:color-mix(in srgb,var(--err) 8%,var(--card))}
.msg .row{display:flex;gap:8px;flex-wrap:wrap;align-items:baseline}
.msg .who{color:var(--accent)}
.msg .subj{font-weight:600}
.msg .body{margin:4px 0 0;color:var(--fg);white-space:pre-wrap;word-break:break-word}
.msg .ref{color:var(--muted);font-size:12px}
.msg.unacked .flag{color:var(--err);font-weight:700}
.empty{color:var(--muted);padding:8px 0}
footer{color:var(--muted);font-size:12px;padding:8px 14px 18px;text-align:center}
@media (max-width:640px){th,td{padding:4px 6px}header{flex-direction:column;gap:6px}}
`;

const NAV_ITEMS: Array<[string, string]> = [
  ["fleet", "Fleet"],
  ["lanes", "Lanes"],
  ["messages", "Messages"],
  ["history", "History"],
];

function nav(active: string): string {
  const links = NAV_ITEMS.map(([key, label]) => {
    const on = key === active ? " on" : "";
    return `<a href="/${key}" class="${on.trim()}">${esc(label)}</a>`;
  }).join("");
  return `<nav>${links}</nav>`;
}

/** Wrap a rendered body in a full standalone page. */
export function page(opts: { title: string; active: string; body: string; refreshUrl: string }): string {
  const { title, active, body, refreshUrl } = opts;
  const rel = esc(refreshUrl);
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<meta http-equiv="refresh" content="${REFRESH_SECONDS}; url=${rel}">`,
    `<title>${esc(title)} — ubus v3 board</title>`,
    `<style>${CSS}</style>`,
    "</head>",
    "<body>",
    `<header><h1>${esc(title)} · ubus v3 board</h1>${nav(active)}</header>`,
    `<main>${body}</main>`,
    `<footer>read-only · refreshes every ${REFRESH_SECONDS}s · rendered from hub JSON views</footer>`,
    "</body>",
    "</html>",
  ].join("\n");
}

export function renderFleet(views: BoardViews, nowMs: number): string {
  const byNode = new Map<string, AgentView[]>();
  for (const a of views.agents) {
    const list = byNode.get(a.node) ?? [];
    list.push(a);
    byNode.set(a.node, list);
  }
  const nodes = [...byNode.keys()].sort();
  if (!nodes.length) return `<div class="card"><h2>Fleet</h2><p class="empty">no agents reported</p></div>`;
  const tables = nodes.map((node) => {
    const rows = byNode
      .get(node)!
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((a) => {
        const age = ageLabel(a.last_heartbeat, nowMs);
        return `<tr>
          <td class="mono">${esc(a.id)}</td>
          <td>${stateCell(a.state, STATE_CLASS, "pill")}</td>
          <td class="mono">${a.lane ? esc(a.lane) : '<span class="muted">—</span>'}</td>
          <td class="mono muted">${a.model ? esc(a.model) : "—"}</td>
          <td class="mono muted">${a.last_message ? esc(Array.from(a.last_message).slice(0, 80).join("")) : "—"}</td>
          <td class="muted">${age ? esc(age) : "—"}</td>
        </tr>`;
      })
      .join("");
    return `<div class="card"><h2>${esc(node)} · ${byNode.get(node)!.length}</h2>
      <div class="scroll"><table><thead><tr><th>agent</th><th>state</th><th>lane / task</th><th>model</th><th>last msg</th><th>heartbeat</th></tr></thead>
      <tbody>${rows}</tbody></table></div></div>`;
  });
  return tables.join("\n");
}

export function renderLanes(views: BoardViews): string {
  const lanes = views.lanes.slice().sort((a, b) => a.lane_id.localeCompare(b.lane_id));
  if (!lanes.length) return `<div class="card"><h2>Lanes</h2><p class="empty">no lanes</p></div>`;
  const rows = lanes
    .map((l: LaneView) => {
      return `<tr>
        <td class="mono">${esc(l.lane_id)}</td>
        <td class="mono muted">${esc(l.brief_ref)}</td>
        <td class="mono">${esc(l.owner)}</td>
        <td class="mono muted">${l.builder ? esc(l.builder) : "—"}</td>
        <td class="mono muted">${l.refuter ? esc(l.refuter) : "—"}</td>
        <td class="mono muted">${l.branch ? esc(l.branch) : "—"}</td>
        <td>${stateCell(l.state, LANE_STATE_CLASS, "pill")}</td>
        <td class="mono muted">${l.verdict_ref ? esc(l.verdict_ref) : "—"}</td>
      </tr>`;
    })
    .join("");
  return `<div class="card"><h2>Lanes · ${lanes.length}</h2>
    <div class="scroll"><table><thead><tr><th>lane</th><th>brief</th><th>owner</th><th>builder</th><th>refuter</th><th>branch</th><th>state</th><th>verdict</th></tr></thead>
    <tbody>${rows}</tbody></table></div></div>`;
}

export interface MessageFilters {
  agent?: string;
  lane?: string;
  state?: string;
}

function matchFilters(m: MessageView, f: MessageFilters): boolean {
  if (f.agent && m.from !== f.agent && !m.to.includes(f.agent)) return false;
  if (f.lane && m.lane !== f.lane) return false;
  if (f.state) {
    const states: string[] = Object.values(m.states).map((s) => s.state);
    if (!states.includes(f.state)) return false;
  }
  return true;
}

export function renderMessages(views: BoardViews, filters: MessageFilters = {}): string {
  const all = views.messages.slice().filter((m) => matchFilters(m, filters));
  // Unacked orders float to the top; within each group, newest first.
  const unacked = all.filter(isUnackedOrder).sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  const rest = all.filter((m) => !isUnackedOrder(m)).sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  const ordered = [...unacked, ...rest];
  if (!ordered.length) return `<div class="card"><h2>Messages</h2><p class="empty">no messages${filters.agent || filters.lane || filters.state ? " match the filter" : ""}</p></div>`;
  const rows = ordered
    .map((m: MessageView) => {
      const un = isUnackedOrder(m);
      const flag = un ? `<span class="flag">UNACKED${esc(" · waiting on " + missingRecipients(m).join(", "))}</span>` : "";
      const bodyText = m.body ? esc(clipBody(m.body)) : "";
      const ref = m.body_ref ? `<div class="ref">ref ${esc(m.body_ref)}</div>` : "";
      const states = Object.entries(m.states)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([who, s]) => `<span class="pill">${esc(who)}: ${esc(s.state)}${s.reason ? ` (${esc(s.reason)})` : ""}</span>`)
        .join(" ");
      return `<div class="msg${un ? " unacked" : ""}">
        <div class="row"><span class="who">${esc(m.from)}</span><span class="muted">→</span><span class="mono muted">${m.to.map(esc).join(", ")}</span><span class="pill">${esc(m.kind)}</span><span class="muted">${esc(m.ts)}</span>${flag}</div>
        <div class="subj">${esc(m.subject)}</div>
        ${bodyText ? `<pre class="body">${bodyText}</pre>` : ""}
        ${ref}
        <div>${states}</div>
      </div>`;
    })
    .join("\n");
  return `<div class="card"><h2>Messages · ${ordered.length}</h2>${rows}</div>`;
}

export function renderHistory(): string {
  return `<div class="card"><h2>History</h2><p class="empty">full-text search over subjects and metadata is P3 — not wired in P1.</p></div>`;
}

export function renderIndex(views: BoardViews): string {
  const counts = [
    ["fleet", `${views.agents.length} agents`],
    ["lanes", `${views.lanes.length} lanes`],
    ["messages", `${views.messages.length} messages`],
  ] as Array<[string, string]>;
  const rows = counts.map(([k, v]) => `<tr><td><a href="/${esc(k)}">${esc(k)}</a></td><td class="muted">${esc(v)}</td></tr>`).join("");
  return `<div class="card"><h2>Overview</h2><div class="scroll"><table><tbody>${rows}</tbody></table></div></div>`;
}
