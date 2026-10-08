import type { LogPage } from "@/lib/rooms-live/steward-log-page";

const BASE = "/rooms-live/steward";
const INK = "#22262B";
const MUTED = "#4F535A";
const tone = { ok: ["#E6F1EC", "#1D6B57"], amber: ["#FBE9D6", "#8A3F05"], red: ["#7A1410", "#FFFFFF"], off: ["#ECEBE6", INK], unavailable: ["#ECEBE6", MUTED] } as const;

/** href for this page with some query changes. The room lives in the path (one room) or in ?room= (all view). */
export function logHref(p: Pick<LogPage, "room" | "day" | "actionsOnly">, over: { room?: string | null; date?: string; show?: "everything" | "acts"; offset?: number }): string {
  const room = over.room === undefined ? (p.room?.room_id ?? null) : over.room;
  const qs = new URLSearchParams();
  if ((over.date ?? p.day.date) !== p.day.maxDate) qs.set("date", over.date ?? p.day.date);
  if ((over.show ?? (p.actionsOnly ? "acts" : "everything")) === "everything") qs.set("show", "everything");
  if (over.offset) qs.set("offset", String(over.offset));
  const q = qs.toString();
  return `${BASE}${room ? `/${room}` : ""}${q ? `?${q}` : ""}`;
}

/** Server-rendered, no client JS: links and one GET form. Mobile-friendly: one column, wrapped controls, 44 px targets. */
export function StewardLogView({ page }: { page: LogPage }) {
  const [bg, fg] = tone[page.strip.tone];
  const title = page.room ? `${page.room.label}: Steward log` : "All Steward logs";
  const link = { color: "#1D4F8C", fontSize: 15, display: "inline-flex", alignItems: "center", minHeight: 44 } as const;
  const empty = page.day.isToday ? "No Steward activity today" : `No Steward activity on ${page.day.date}`;
  return (
    <main style={{ background: "#F6F5F2", minHeight: "100vh", padding: "16px 16px 48px", fontFamily: '"Atkinson Hyperlegible Next", "Atkinson Hyperlegible", system-ui, -apple-system, "Segoe UI", sans-serif', color: INK, maxWidth: 800, margin: "0 auto" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
        <a href="/rooms-live" style={link}>← Rooms</a>
        {page.room ? <a href="/rooms-live/steward" style={link}>All Steward logs</a> : null}
      </div>
      <h1 style={{ margin: "0 0 4px", fontSize: 24 }}>{title}</h1>
      {page.room ? <div style={{ fontSize: 14, color: MUTED }}>{page.machine ? `Kiosk: ${page.machine}` : "No kiosk linked"}</div> : null}
      <p data-testid="steward-strip" role="status" style={{ background: bg, color: fg, borderRadius: 10, padding: "8px 12px", fontSize: 14, margin: "10px 0" }}>{page.strip.text}</p>
      <form method="get" action={page.room ? `${BASE}/${page.room.room_id}` : BASE} style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", marginBottom: 10 }}>
        <label style={{ fontSize: 15, display: "inline-flex", gap: 6, alignItems: "center" }}>
          Day
          <input type="date" name="date" defaultValue={page.day.date} min={page.day.minDate} max={page.day.maxDate} style={{ minHeight: 44, borderRadius: 10, border: "1px solid #C9CBCF", padding: "0 8px", fontSize: 16 }} />
        </label>
        {!page.room ? (
          <label style={{ fontSize: 15, display: "inline-flex", gap: 6, alignItems: "center" }}>
            Room
            <select name="room" defaultValue="" style={{ minHeight: 44, borderRadius: 10, border: "1px solid #C9CBCF", padding: "0 8px", fontSize: 16 }}>
              <option value="">All rooms</option>
              {page.rooms.map((r) => (
                <option key={r.room_id} value={r.room_id}>{r.label}</option>
              ))}
            </select>
          </label>
        ) : null}
        <input type="hidden" name="show" value={page.actionsOnly ? "acts" : "everything"} />
        <button type="submit" style={{ minHeight: 44, padding: "0 16px", borderRadius: 10, border: "1px solid #22262B", background: "#fff", fontSize: 15, cursor: "pointer" }}>Show</button>
      </form>
      <div role="group" aria-label="What to show" style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
        {(["acts", "everything"] as const).map((k) => {
          const on = (k === "acts") === page.actionsOnly;
          return (
            <a key={k} href={logHref(page, { show: k, offset: 0 })} aria-current={on ? "true" : undefined} style={{ minHeight: 44, display: "inline-flex", alignItems: "center", padding: "0 14px", borderRadius: 999, border: "1px solid #22262B", background: on ? "#22262B" : "#fff", color: on ? "#fff" : INK, fontSize: 14, textDecoration: "none" }}>
              {k === "acts" ? "Things it did or wanted to do" : "Everything"}
            </a>
          );
        })}
      </div>
      {page.readFailed ? <p role="status" style={{ background: "#FBE9D6", color: "#8A3F05", borderRadius: 10, padding: "8px 12px", fontSize: 14 }}>The Steward log can't be read right now. Try again in a minute.</p> : null}
      {!page.readFailed && page.items.length === 0 ? <p data-testid="steward-empty" style={{ fontSize: 16, color: MUTED }}>{empty}</p> : null}
      {page.items.length > 0 ? (
        <ul aria-label="Steward log" style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
          {page.items.map((it, i) =>
            it.type === "fine" ? (
              <li key={i} style={{ fontSize: 14, color: MUTED, padding: "4px 2px" }}>{!page.room ? `${page.labels[it.room_id] ?? "A room"}: ` : ""}{it.text}</li>
            ) : (
              <li key={i} style={{ background: "#fff", border: "1px solid #E4E2DC", borderRadius: 10, padding: "8px 12px", fontSize: 15 }}>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                  <b>{it.hm}</b>
                  {!page.room ? <span style={{ color: MUTED }}>{page.labels[it.room_id] ?? "A room"}</span> : null}
                  <span style={{ background: it.line.mode === "live" ? "#E6F1EC" : "#ECEBE6", color: it.line.mode === "live" ? "#1D6B57" : MUTED, borderRadius: 999, padding: "1px 8px", fontSize: 12 }}>{it.line.mode === "live" ? "Live" : "Watching only"}</span>
                  {it.result ? <span style={{ fontSize: 13, color: MUTED }}>{it.result}</span> : null}
                </div>
                <div>{it.line.text}</div>
                {it.why ? <div style={{ fontSize: 13, color: MUTED }}>Why: {it.why}</div> : null}
              </li>
            ),
          )}
        </ul>
      ) : null}
      <nav aria-label="Pages" style={{ display: "flex", gap: 16, marginTop: 12 }}>
        {page.offset > 0 ? <a href={logHref(page, { offset: Math.max(0, page.offset - 200) })} style={link}>← Newer</a> : null}
        {page.hasNext ? <a href={logHref(page, { offset: page.offset + 200 })} style={link}>Older →</a> : null}
      </nav>
    </main>
  );
}
