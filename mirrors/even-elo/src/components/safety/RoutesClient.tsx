"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * A1-D19 — an ABSENT channel means WhatsApp. That is what keeps the six seeded
 * routes working with no data migration, so existing rows render as WhatsApp
 * without ever having carried the field.
 */
type Channel = "whatsapp" | "email";
type Target = { to: string; name?: string; channel?: Channel };
const channelOf = (t: Target): Channel => (t.channel === "email" ? "email" : "whatsapp");
/** Shape only. Deliverability is the provider's problem, not this form's. */
const targetLooksValid = (t: Target) =>
  channelOf(t) === "email" ? t.to.includes("@") && !t.to.trim().endsWith("@g.us") : !!t.to.trim();
type Route = { id: string; label: string; match_field: string; match_value: string | null; targets: Target[]; active: boolean };
type Meta = { types: { name: string }[]; departments: { name: string }[]; units: { code: string; name: string }[] };

const FIELDS: [string, string][] = [
  ["any", "All incidents"], ["category", "Category is…"], ["type", "Type is…"],
  ["department", "Department is…"], ["severity", "Severity is…"], ["severity_min", "Severity at least…"],
  // A1-D29. A rule that does NOT use this field still matches every unit, so
  // adding it changes nothing for the six rules that already exist.
  ["unit", "Unit is…"],
];
const SEVS = ["negligible", "minor", "moderate", "major", "catastrophic"];
const CATS = ["clinical", "non_clinical"];

/**
 * The EFFECTIVE rule, in plain words, derived from match_field + match_value and
 * NEVER from the label.
 *
 * Live on 25 Jul a rule labelled "Clinical incidents → Clinical safety" had its
 * match_field silently changed to "any", so the list read as two identical
 * All-incidents rules. Labels are free text and stay free text; this line is
 * what the engine will actually do.
 */
function notifiesOn(r: Route): { text: string; warn: boolean } {
  const v = (r.match_value || "").trim();
  if (r.match_field === "any") return { text: "every incident", warn: false };
  if (!v) return { text: "nothing — no value chosen, so this rule never matches", warn: true };
  const pretty = v === "non_clinical" ? "Non-clinical" : v === "clinical" ? "Clinical" : v;
  switch (r.match_field) {
    case "category": return { text: `${pretty} incidents`, warn: false };
    case "type": return { text: `type = ${pretty}`, warn: false };
    case "department": return { text: `department = ${pretty}`, warn: false };
    case "severity": return { text: `severity = ${pretty}`, warn: false };
    case "severity_min": return { text: `severity ${pretty} or worse`, warn: false };
    case "unit": return { text: `unit = ${pretty}`, warn: false };
    default: return { text: `${r.match_field} = ${pretty}`, warn: true };
  }
}

/**
 * Normalised form of exactly the fields save() PATCHes, so "dirty" means "differs
 * from what the server holds" and nothing else. Both sides go through this, so a
 * saved card can never read dirty forever because of whitespace or key order.
 */
function patchShape(r: Route): string {
  return JSON.stringify({
    label: (r.label || "").trim(),
    match_field: r.match_field,
    match_value: (r.match_value || "").trim(),
    active: !!r.active,
    targets: (r.targets || [])
      .filter((t) => t.to.trim())
      .map((t) => ({
        to: t.to.trim(),
        name: (t.name || "").trim() || undefined,
        // Mirrors the server's cleanTargets: the key is written ONLY for email,
        // so an untouched WhatsApp target keeps its original {to, name} shape.
        channel: t.channel === "email" ? "email" : undefined,
      })),
  });
}

const recipientKey = (t: Target) => `${channelOf(t)}:${t.to.trim()}`;

export default function Routes() {
  const [routes, setRoutes] = useState<Route[]>([]);
  /** Last-known server truth. Dirty state is `routes` measured against this. */
  const [saved, setSaved] = useState<Route[]>([]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [noteErr, setNoteErr] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(() => {
    fetch("/api/safety/office/routes", { cache: "no-store" }).then((r) => r.json()).then((j) => {
      if (j.ok) {
        const rs: Route[] = j.routes.map((r: Route) => ({ ...r, targets: r.targets || [] }));
        setRoutes(rs);
        setSaved(rs.map((r) => ({ ...r, targets: r.targets.map((t) => ({ ...t })) })));
        setLoaded(true);
      }
    });
    fetch("/api/safety/incident/meta", { cache: "no-store" }).then((r) => r.json()).then((j) => { if (j.ok) setMeta({ types: j.types, departments: j.departments, units: j.units || [] }); });
  }, []);
  useEffect(() => { load(); }, [load]);

  const savedById = useMemo(() => new Map(saved.map((r) => [r.id, patchShape(r)])), [saved]);
  const isDirty = useCallback(
    (r: Route) => { const s = savedById.get(r.id); return s === undefined ? true : s !== patchShape(r); },
    [savedById],
  );
  const dirtyRoutes = useMemo(() => routes.filter(isDirty), [routes, isDirty]);
  const dirtyCount = dirtyRoutes.length;

  /**
   * Warn before losing work. Every link in SafetyNav is a plain <a href>, i.e.
   * a full document navigation, so beforeunload already intercepts those clicks
   * — a second in-app confirm would double-prompt. See the build report.
   */
  useEffect(() => {
    if (!dirtyCount) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirtyCount]);

  const say = (msg: string, err = false) => { setNote(msg); setNoteErr(err); };

  const upd = (i: number, patch: Partial<Route>) => setRoutes((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const updTarget = (i: number, k: number, patch: Partial<Target>) => upd(i, { targets: routes[i].targets.map((t, m) => (m === k ? { ...t, ...patch } : t)) });

  /** PATCH one route. Returns ok so saveAll can count failures. */
  async function patchRoute(r: Route): Promise<{ ok: boolean; error?: string }> {
    try {
      const j = await fetch(`/api/safety/office/routes/${r.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: r.label, match_field: r.match_field, match_value: r.match_value,
          targets: r.targets.filter((t) => t.to.trim()), active: r.active,
        }),
      }).then((x) => x.json());
      return j.ok ? { ok: true } : { ok: false, error: j.error || "save failed" };
    } catch {
      return { ok: false, error: "network error" };
    }
  }

  /**
   * Per-card save, now SECONDARY. It deliberately does NOT reload: a full reload
   * here would discard every other dirty card, which is the exact defect this
   * phase exists to fix. Only this card's snapshot advances to server truth.
   */
  async function save(i: number) {
    const r = routes[i];
    setBusy(`row-${r.id}`); say("Saving…");
    const res = await patchRoute(r);
    setBusy(null);
    if (res.ok) {
      setSaved((ss) => ss.map((s) => (s.id === r.id ? { ...r, targets: r.targets.map((t) => ({ ...t })) } : s)));
      say("Saved ✓");
      setTimeout(() => setNote((n) => (n === "Saved ✓" ? null : n)), 2500);
    } else say(`Error: ${res.error}`, true);
  }

  /** PATCH every dirty rule, sequentially, and report per rule. */
  async function saveAll() {
    if (!dirtyCount) return;
    setBusy("all"); say(`Saving ${dirtyCount} rule(s)…`);
    const failed: string[] = [];
    const ok: string[] = [];
    for (const r of dirtyRoutes) {
      const res = await patchRoute(r);
      if (res.ok) ok.push(r.id);
      else failed.push(`${(r.label || "").trim() || "Untitled rule"} (${res.error})`);
    }
    setBusy(null);

    if (!failed.length) {
      // Everything landed — re-read server truth rather than trusting local state.
      load();
      say(`Saved ${ok.length} rule(s) ✓`);
      setTimeout(() => setNote((n) => (n?.startsWith("Saved ") ? null : n)), 2500);
      return;
    }
    // Some failed: advance only the successful snapshots so the failures stay
    // dirty and editable. Reloading here would throw away unsaved work.
    setSaved((ss) => ss.map((s) => {
      const r = routes.find((x) => x.id === s.id);
      return r && ok.includes(s.id) ? { ...r, targets: r.targets.map((t) => ({ ...t })) } : s;
    }));
    say(`Saved ${ok.length}, failed ${failed.length}: ${failed.join("; ")}`, true);
  }

  /** Local removal keeps other dirty cards intact — no reload. */
  async function del(i: number) {
    const r = routes[i];
    if (!window.confirm(`Delete the rule “${(r.label || "").trim() || "Untitled"}”? This cannot be undone.`)) return;
    setBusy(`row-${r.id}`);
    try {
      await fetch(`/api/safety/office/routes/${r.id}`, { method: "DELETE" });
      setRoutes((rs) => rs.filter((x) => x.id !== r.id));
      setSaved((ss) => ss.filter((x) => x.id !== r.id));
      say("Rule deleted.");
    } finally { setBusy(null); }
  }

  /**
   * Append locally rather than reloading, for the same reason as del(): a reload
   * would discard unsaved edits elsewhere. The appended shape mirrors exactly
   * what the POST handler stores for this body, so the new card starts clean.
   */
  async function add() {
    setBusy("add");
    try {
      const j = await fetch("/api/safety/office/routes", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "New rule", match_field: "any", targets: [], active: false }),
      }).then((x) => x.json());
      if (!j.ok || !j.id) { say(`Could not create the rule: ${j.error || "unknown error"}`, true); return; }
      const fresh: Route = { id: j.id, label: "New rule", match_field: "any", match_value: "", targets: [], active: false };
      setRoutes((rs) => [...rs, fresh]);
      setSaved((ss) => [...ss, { ...fresh }]);
      say("New rule added — it is inactive until you switch it on.");
    } finally { setBusy(null); }
  }

  async function testAll() {
    say("Sending test…");
    const j = await fetch("/api/safety/office/notify/test", { method: "POST" }).then((x) => x.json());
    // Report per rail, so "it didn't arrive" points at a rail instead of a guess.
    const perRail = [
      j.whatsapp ? `WhatsApp ${j.whatsapp.sent}/${j.whatsapp.attempted}${j.whatsapp.configured === false ? " (not configured)" : ""}` : null,
      j.email ? `Email ${j.email.sent}/${j.email.attempted}${j.email.configured === false ? " (not configured)" : ""}` : null,
    ].filter(Boolean).join(" · ");
    say(
      j.ok
        ? `✅ Test sent to ${j.sent}/${j.attempted} recipient(s).${perRail ? ` ${perRail}` : ""}`
        : `Not sent: ${j.error || j.reason}${perRail ? ` — ${perRail}` : ""}`,
      !j.ok,
    );
  }

  const valueOptions = (field: string): string[] | null =>
    field === "category" ? CATS : field === "type" ? (meta?.types || []).map((t) => t.name)
    : field === "department" ? (meta?.departments || []).map((d) => d.name)
    // The CODE, not the name: notify.ts compares match_value against the
    // incident's unit_code, so storing "Altius Hospital" would never match.
    : field === "unit" ? (meta?.units || []).map((u) => u.code)
    : (field === "severity" || field === "severity_min") ? SEVS : null;

  /**
   * Who actually gets notified, derived from the SAVED state (never the unsaved
   * edits) so it answers "who gets emailed right now?" without reading six cards.
   * Purely client-side — no endpoint was added for this.
   */
  const effect = useMemo(() => {
    const active = saved.filter((r) => r.active);
    const dedupe = (rs: Route[]) => {
      const m = new Map<string, Target>();
      for (const r of rs) for (const t of r.targets || []) if (t.to.trim()) m.set(recipientKey(t), t);
      // Array.from, not spread: this repo's tsconfig target predates
      // downlevelIteration, so [...map.values()] does not compile here.
      return Array.from(m.values());
    };
    return {
      activeCount: active.length,
      everyIncident: dedupe(active.filter((r) => r.match_field === "any")),
      all: dedupe(active),
    };
  }, [saved]);

  const describe = (t: Target) => `${t.to.trim()}${t.name?.trim() ? ` (${t.name.trim()})` : ""}`;

  return (
    <main style={S.wrap}>
      <div style={S.head}>
        <div>
          <div style={S.kicker}>EHRC Incident — Safety Office</div>
          <h1 style={S.h1}>Notification rules</h1>
          {/* The live confusion this fixes: rules read as if they belonged to
              whichever incident you were just looking at. They never did. */}
          <p style={S.subtitle}>These rules apply to every incident, not just the one you were viewing.</p>
          <p style={S.counts}>
            {loaded ? `${effect.activeCount} active rule${effect.activeCount === 1 ? "" : "s"}, ${effect.all.length} recipient${effect.all.length === 1 ? "" : "s"}.` : "Loading…"}
          </p>
        </div>
        <div style={S.nav}>
          <a href="/safety" style={S.link}>Queue</a>
          <a href="/safety#dashboard" style={S.link}>Dashboard</a>
          <button style={S.test} onClick={testAll} disabled={!!busy}>Send test</button>
          <button
            style={{ ...S.saveAll, ...(dirtyCount ? null : S.saveAllIdle) }}
            onClick={saveAll}
            disabled={!dirtyCount || busy === "all"}
          >
            {busy === "all" ? "Saving…" : dirtyCount ? `Save all changes (${dirtyCount})` : "Save all changes"}
          </button>
        </div>
      </div>

      {dirtyCount > 0 && (
        <div style={S.dirtyBar}>
          <b>{dirtyCount} unsaved change{dirtyCount === 1 ? "" : "s"}.</b> Nothing is stored until you save — leaving this page will discard them.
        </div>
      )}

      <p style={S.intro}>Each rule fans an alert out to its recipients when an incident matches. A recipient is either an <b>email</b> address or a <b>WhatsApp</b> number (E.164, e.g. +9163…) or group id (…@g.us) — pick the channel per recipient. Everyone on email for one incident receives a single message, with all recipients visible. Rules combine — an incident notifies everyone in every matching rule. Inactive rules are ignored.</p>

      {note && <div style={{ ...S.note, ...(noteErr ? S.noteErr : null) }}>{note}</div>}

      {/* What will actually happen, from saved state. */}
      {loaded && (
        <section style={S.effect}>
          <div style={S.effectHead}>Who gets notified right now</div>
          {effect.all.length === 0 ? (
            <div style={S.effectMuted}>Nobody. No active rule has a recipient, so no incident will notify anyone.</div>
          ) : (
            <>
              <div style={S.effectRow}>
                <span style={S.effectLabel}>Every incident</span>
                {effect.everyIncident.length === 0
                  ? <span style={S.effectMuted}>no always-on rule — recipients depend on what the incident matches</span>
                  : <span>{effect.everyIncident.map((t) => <span key={recipientKey(t)} style={S.pill}>{channelOf(t) === "email" ? "✉" : "▪"} {describe(t)}</span>)}</span>}
              </div>
              <div style={S.effectRow}>
                <span style={S.effectLabel}>All {effect.activeCount} active rule{effect.activeCount === 1 ? "" : "s"}</span>
                <span>{effect.all.length} distinct recipient{effect.all.length === 1 ? "" : "s"} — {effect.all.filter((t) => channelOf(t) === "email").length} email, {effect.all.filter((t) => channelOf(t) === "whatsapp").length} WhatsApp</span>
              </div>
            </>
          )}
          <div style={S.effectFoot}>Reflects saved rules only. A server-side WhatsApp catch-all, if configured, is not shown here.</div>
        </section>
      )}

      {loaded && routes.length === 0 && <div style={S.muted}>No rules yet.</div>}

      {routes.map((r, i) => {
        const opts = valueOptions(r.match_field);
        const dirty = isDirty(r);
        const on = notifiesOn(r);
        return (
          <section key={r.id} style={{ ...S.card, ...(dirty ? S.cardDirty : null), opacity: r.active ? 1 : 0.75 }}>
            <div style={S.cardTop}>
              <input style={S.label} value={r.label} onChange={(e) => upd(i, { label: e.target.value })} />
              {dirty && <span style={S.chip}>● Unsaved</span>}
              <label style={S.activeRow}><input type="checkbox" checked={r.active} onChange={(e) => upd(i, { active: e.target.checked })} /> active</label>
            </div>

            {/* Derived from match_field + match_value, NEVER from the label. */}
            <div style={{ ...S.effective, ...(on.warn ? S.effectiveWarn : null) }}>
              Notifies on: <b>{on.text}</b>{!r.active && <span style={S.inactiveTag}> · inactive, so it notifies nobody</span>}
            </div>

            <div style={S.matchRow}>
              <span style={S.when}>When</span>
              <select style={S.sel} value={r.match_field} onChange={(e) => upd(i, { match_field: e.target.value, match_value: "" })}>
                {FIELDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
              {opts && (
                <select style={S.sel} value={r.match_value || ""} onChange={(e) => upd(i, { match_value: e.target.value })}>
                  <option value="">Select…</option>{opts.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              )}
            </div>
            <div style={S.flabel}>Notify</div>
            {r.targets.map((t, k) => {
              const ch = channelOf(t);
              const bad = t.to.trim() !== "" && !targetLooksValid(t);
              return (
                <div key={k} style={S.tRow}>
                  <select style={S.tChan} value={ch}
                    onChange={(e) => updTarget(i, k, { channel: e.target.value as Channel })}>
                    <option value="whatsapp">WhatsApp</option>
                    <option value="email">Email</option>
                  </select>
                  <input style={{ ...S.tTo, ...(bad ? S.tBad : null) }}
                    placeholder={ch === "email" ? "name@even.in" : "+9163… or group@g.us"}
                    value={t.to} onChange={(e) => updTarget(i, k, { to: e.target.value })} />
                  <input style={S.tName} placeholder="name (optional)" value={t.name || ""} onChange={(e) => updTarget(i, k, { name: e.target.value })} />
                  <button style={S.x} onClick={() => upd(i, { targets: r.targets.filter((_, m) => m !== k) })}>✕</button>
                </div>
              );
            })}
            {r.targets.some((t) => t.to.trim() && !targetLooksValid(t)) && (
              <div style={S.tWarn}>An email recipient needs an address containing “@”. A WhatsApp recipient needs a number or group id.</div>
            )}
            <button style={S.add} onClick={() => upd(i, { targets: [...r.targets, { to: "", name: "", channel: "whatsapp" }] })}>+ Add recipient to this rule</button>
            <div style={S.cardFoot}>
              <button style={{ ...S.save, ...(dirty ? null : S.saveIdle) }} onClick={() => save(i)} disabled={!dirty || busy === `row-${r.id}`}>
                {busy === `row-${r.id}` ? "Saving…" : "Save this rule"}
              </button>
              <button style={S.del} onClick={() => del(i)} disabled={!!busy}>Delete</button>
            </div>
          </section>
        );
      })}

      {/* Rule-level action, deliberately OUTSIDE and below the cards so it can
          no longer be mistaken for "+ Add recipient" inside one. */}
      <div style={S.addRuleWrap}>
        <button style={S.addRule} onClick={add} disabled={!!busy}>+ New notification rule</button>
        <div style={S.addRuleHint}>Creates a whole new rule, applying to every incident. To add a person to an existing rule, use “+ Add recipient to this rule” inside its card.</div>
      </div>
    </main>
  );
}

const S: Record<string, React.CSSProperties> = {
  wrap: { maxWidth: 760, margin: "0 auto", padding: "28px 20px 60px", color: "#0f172a" },
  head: { display: "flex", alignItems: "flex-end", justifyContent: "space-between", marginBottom: 10, flexWrap: "wrap", gap: 10 },
  kicker: { fontSize: 12, fontWeight: 700, letterSpacing: ".04em", textTransform: "uppercase", color: "#94a3b8" },
  h1: { fontSize: 26, margin: "4px 0 0" },
  subtitle: { fontSize: 13.5, color: "#334155", margin: "6px 0 0", fontWeight: 600 },
  counts: { fontSize: 12.5, color: "#94a3b8", margin: "3px 0 0" },
  nav: { display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" },
  link: { color: "#2b5191", fontSize: 13, fontWeight: 600, textDecoration: "none" },
  test: { padding: "8px 13px", fontSize: 13, fontWeight: 600, color: "#15803d", background: "#dcfce7", border: "1px solid #bbf7d0", borderRadius: 9, cursor: "pointer" },
  saveAll: { padding: "9px 15px", fontSize: 13.5, fontWeight: 700, color: "#fff", background: "#16a34a", border: "none", borderRadius: 9, cursor: "pointer" },
  saveAllIdle: { background: "#e2e8f0", color: "#94a3b8", cursor: "default" },
  dirtyBar: { fontSize: 13.5, color: "#7c2d12", background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: 9, padding: "9px 12px", marginBottom: 12, lineHeight: 1.5 },
  intro: { color: "#64748b", fontSize: 13.5, lineHeight: 1.6, margin: "6px 0 14px" },
  note: { fontSize: 13.5, color: "#334155", background: "#f1f5f9", borderRadius: 8, padding: "8px 12px", marginBottom: 12 },
  noteErr: { color: "#b91c1c", background: "#fef2f2", border: "1px solid #fecaca" },
  effect: { background: "#f8fafc", border: "1px solid #e6eaf0", borderRadius: 12, padding: "12px 14px", marginBottom: 16 },
  effectHead: { fontSize: 12, fontWeight: 700, letterSpacing: ".03em", textTransform: "uppercase", color: "#64748b", marginBottom: 8 },
  effectRow: { display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap", fontSize: 13.5, color: "#334155", marginBottom: 6 },
  effectLabel: { fontSize: 12, fontWeight: 700, color: "#94a3b8", flex: "0 0 auto", minWidth: 120 },
  effectMuted: { color: "#94a3b8", fontSize: 13 },
  effectFoot: { fontSize: 11.5, color: "#94a3b8", marginTop: 6 },
  pill: { display: "inline-block", background: "#fff", border: "1px solid #e2e8f0", borderRadius: 999, padding: "2px 9px", fontSize: 12.5, marginRight: 6, marginBottom: 4 },
  card: { background: "#fff", border: "1px solid #e6eaf0", borderRadius: 12, padding: "14px 16px", marginBottom: 12 },
  cardDirty: { borderColor: "#fdba74", boxShadow: "0 0 0 3px rgba(253,186,116,.18)" },
  cardTop: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" },
  chip: { fontSize: 11, fontWeight: 700, color: "#b45309", background: "#fef3c7", border: "1px solid #fde68a", borderRadius: 999, padding: "2px 8px", flex: "0 0 auto" },
  label: { flex: 1, minWidth: 160, padding: "9px 11px", fontSize: 15, fontWeight: 600, border: "1px solid #cbd5e1", borderRadius: 9 },
  activeRow: { display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#475569", flex: "0 0 auto" },
  effective: { fontSize: 13, color: "#334155", background: "#f1f5f9", borderRadius: 8, padding: "6px 10px", margin: "10px 0 0" },
  effectiveWarn: { color: "#b45309", background: "#fffbeb", border: "1px solid #fde68a" },
  inactiveTag: { color: "#94a3b8" },
  matchRow: { display: "flex", gap: 8, alignItems: "center", margin: "10px 0", flexWrap: "wrap" },
  when: { fontSize: 13, color: "#94a3b8" },
  sel: { padding: "8px 10px", fontSize: 14, border: "1px solid #cbd5e1", borderRadius: 9, background: "#fff" },
  flabel: { fontSize: 12, fontWeight: 700, letterSpacing: ".03em", textTransform: "uppercase", color: "#94a3b8", margin: "6px 0" },
  tRow: { display: "flex", gap: 8, alignItems: "center", marginBottom: 7 },
  tTo: { flex: "1 1 200px", padding: "8px 10px", fontSize: 14, border: "1px solid #cbd5e1", borderRadius: 9, fontFamily: "ui-monospace, Menlo, monospace" },
  tName: { flex: "1 1 120px", padding: "8px 10px", fontSize: 14, border: "1px solid #cbd5e1", borderRadius: 9 },
  tChan: { flex: "0 0 auto", padding: "8px 10px", fontSize: 13.5, border: "1px solid #cbd5e1", borderRadius: 9, background: "#fff" },
  tBad: { borderColor: "#fca5a5", background: "#fef2f2" },
  tWarn: { fontSize: 12.5, color: "#b45309", margin: "2px 0 6px" },
  x: { border: "none", background: "transparent", color: "#94a3b8", cursor: "pointer", fontSize: 14, flex: "0 0 auto" },
  add: { marginTop: 2, padding: "6px 10px", fontSize: 13, fontWeight: 600, color: "#2b5191", background: "#eef2fb", border: "1px solid #dbe4f5", borderRadius: 8, cursor: "pointer" },
  cardFoot: { display: "flex", gap: 10, marginTop: 12, alignItems: "center" },
  save: { padding: "8px 14px", fontSize: 13.5, fontWeight: 600, color: "#15803d", background: "#dcfce7", border: "1px solid #bbf7d0", borderRadius: 9, cursor: "pointer" },
  saveIdle: { color: "#94a3b8", background: "#f1f5f9", border: "1px solid #e2e8f0", cursor: "default" },
  del: { padding: "8px 14px", fontSize: 13, fontWeight: 600, color: "#b91c1c", background: "#fee2e2", border: "1px solid #fecaca", borderRadius: 9, cursor: "pointer" },
  addRuleWrap: { marginTop: 18, paddingTop: 16, borderTop: "1px solid #e6eaf0" },
  addRule: { padding: "11px 18px", fontSize: 15, fontWeight: 600, color: "#fff", background: "#2b5191", border: "none", borderRadius: 10, cursor: "pointer" },
  addRuleHint: { fontSize: 12.5, color: "#94a3b8", marginTop: 7, lineHeight: 1.5 },
  muted: { color: "#94a3b8", fontSize: 14, padding: "12px 0" },
};
