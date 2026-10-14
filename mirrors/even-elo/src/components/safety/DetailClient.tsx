"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

type Inc = Record<string, unknown>;
type Rca = Record<string, unknown>;
/** Evidence attached at intake by the reporter, or here by a reviewer (A1-D21). */
type Attachment = {
  id: string; blob_url: string; pathname: string; content_type: string | null;
  size_bytes: number | null; uploaded_by: string | null; source: string; created_at: string;
};

const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "application/pdf"];
const MAX_MB = 10;
const MAX_FILES = 5;
const isImage = (ct: string | null) => !!ct && ct.startsWith("image/") && ct !== "image/heic";
const prettySize = (n: number | null) => (!n ? "" : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const fileNameOf = (a: Attachment) => (a.pathname || "").split("/").pop() || a.pathname;

const SEV_COLOR: Record<string, string> = { negligible: "#94a3b8", minor: "#3b82f6", moderate: "#d97706", major: "#ea580c", catastrophic: "#dc2626" };
const STATUS = [["open", "Open"], ["under_investigation", "Investigating"], ["capa_assigned", "CAPA assigned"], ["closed", "Closed"], ["verified", "Verified"]];

export default function IncidentDetail() {
  const { id } = useParams<{ id: string }>();
  const [inc, setInc] = useState<Inc | null>(null);
  const [rcas, setRcas] = useState<Rca[]>([]);
  const [cluster, setCluster] = useState<Record<string, unknown> | null>(null);
  const [siblings, setSiblings] = useState<Record<string, unknown>[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [owner, setOwner] = useState("");
  const [saving, setSaving] = useState<string | null>(null);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachEnabled, setAttachEnabled] = useState(false);

  function load() {
    fetch(`/api/safety/office/incidents/${id}`).then((r) => r.json()).then((j) => {
      if (j.ok) {
        setInc(j.incident); setRcas(j.rcas || []); setCluster(j.cluster || null); setSiblings(j.siblings || []);
        setOwner((j.incident.owner_name as string) || "");
        setAttachments(j.attachments || []);
        setAttachEnabled(j.attachmentsEnabled === true);
      }
      else setErr(j.error || "Failed to load");
    }).catch(() => setErr("Failed to load"));
  }
  useEffect(load, [id]);

  /**
   * Upload evidence browser-direct to Vercel Blob (A1-D8, M&M decision 11 —
   * bytes NEVER pass through a route handler, in either app).
   *
   * even-elo carries no Blob SDK, so this runs the handshake by hand:
   * even-incident mints a short-lived, size- and type-constrained client token
   * and tells us the upload URL and protocol version; we PUT once. Reusing its
   * per-request state machine: setSaving / setSaveNote / setSaveErr.
   */
  async function uploadFile(file: File) {
    setSaveErr(null); setSaveNote(null);
    if (!ALLOWED_TYPES.includes(file.type)) { setSaveErr("Only JPEG, PNG, WEBP, HEIC or PDF can be attached."); return; }
    if (file.size > MAX_MB * 1024 * 1024) { setSaveErr(`${file.name} is larger than ${MAX_MB} MB.`); return; }
    if (attachments.length >= MAX_FILES) { setSaveErr(`This incident already has the maximum of ${MAX_FILES} attachments.`); return; }

    setSaving("attach");
    try {
      const t = await fetch(`/api/safety/office/incidents/${id}/attachments`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "token", pathname: file.name, contentType: file.type, size: file.size }),
      }).then((r) => r.json());
      if (!t.ok || !t.token) { setSaveErr(t.error || "Could not authorise the upload."); return; }

      const put = await fetch(t.uploadUrl, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${t.token}`,
          "x-api-version": String(t.apiVersion),
          "x-content-type": file.type,
          "x-add-random-suffix": "1",
        },
        body: file,
      });
      if (!put.ok) { setSaveErr(`Upload failed (${put.status}).`); return; }
      const blob = (await put.json()) as { url?: string; pathname?: string };
      if (!blob?.url) { setSaveErr("Upload did not return a file reference."); return; }

      const rec = await fetch(`/api/safety/office/incidents/${id}/attachments`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ record: { url: blob.url, pathname: blob.pathname || file.name, contentType: file.type, size: file.size } }),
      }).then((r) => r.json());
      if (!rec.ok) { setSaveErr(rec.error || "Uploaded, but could not be recorded."); return; }

      setSaveNote("Attachment added ✓");
      setTimeout(() => setSaveNote(null), 2500);
      load();
    } catch {
      setSaveErr("Network error — the file was not attached.");
    } finally { setSaving(null); }
  }

  async function removeAttachment(attachmentId: string) {
    setSaving("attach"); setSaveErr(null); setSaveNote(null);
    try {
      const j = await fetch(`/api/safety/office/incidents/${id}/attachments?attachmentId=${encodeURIComponent(attachmentId)}`, { method: "DELETE" })
        .then((r) => r.json());
      if (j.ok) { setSaveNote("Attachment removed ✓"); setTimeout(() => setSaveNote(null), 2500); load(); }
      else setSaveErr(j.error || "Could not remove the attachment.");
    } catch {
      setSaveErr("Network error — not removed.");
    } finally { setSaving(null); }
  }

  async function patch(body: Record<string, unknown>, tag: string) {
    setSaving(tag); setSaveErr(null); setSaveNote(null);
    try {
      const r = await fetch(`/api/safety/office/incidents/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      let j: { ok?: boolean; error?: string } = {};
      try { j = await r.json(); } catch { /* non-JSON (e.g. gateway error page) */ }
      if (r.ok && j.ok !== false) {
        setSaveNote(tag === "owner" ? "Owner saved ✓" : "Status saved ✓");
        setTimeout(() => setSaveNote(null), 2500);
        load();
      } else {
        setSaveErr(j.error || `Save failed (${r.status})`);
      }
    } catch {
      setSaveErr("Network error — not saved.");
    } finally { setSaving(null); }
  }

  async function patchRca(rcaId: string, action: string) {
    setSaving("rca");
    try { await fetch(`/api/safety/office/rca/${rcaId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) }); load(); }
    finally { setSaving(null); }
  }

  if (err) return <main style={S.wrap}><a href="/safety" style={S.back}>← Queue</a><div style={S.err}>{err}</div></main>;
  if (!inc) return <main style={S.wrap}><div style={S.muted}>Loading…</div></main>;

  const g = (k: string) => (inc[k] == null ? null : String(inc[k]));
  const sev = g("severity");
  const conf = g("confidentiality");
  const hasPatient = g("phi_patient_name") || g("phi_uhid") || g("phi_patient_age");

  const Field = ({ label, value }: { label: string; value: React.ReactNode }) =>
    value ? <div style={S.field}><div style={S.flabel}>{label}</div><div style={S.fvalue}>{value}</div></div> : null;

  // Closure SLA — 7 working days from report date (PRD Addendum A1, A1-D16).
  // sla_state is computed upstream in even-incident; null due_at renders nothing.
  const slaState = g("sla_state");
  const dueAt = g("due_at");
  const SLA_LOOK: Record<string, { label: string; bg: string; fg: string }> = {
    overdue: { label: "Overdue", bg: "#fee2e2", fg: "#b91c1c" },
    due_soon: { label: "Due soon", bg: "#fef3c7", fg: "#b45309" },
    on_track: { label: "On track", bg: "#f1f5f9", fg: "#475569" },
    closed: { label: "Closed", bg: "#dcfce7", fg: "#15803d" },
  };
  const sla = slaState ? SLA_LOOK[slaState] : null;

  return (
    <main style={S.wrap}>
      <a href="/safety" style={S.back}>← Queue</a>

      <div style={S.headRow}>
        <span style={{ ...S.sevDot, background: SEV_COLOR[sev || ""] || "#cbd5e1" }} />
        <h1 style={S.id}>{g("id")}</h1>
        {g("near_miss") === "true" && <span style={S.nearMiss}>near miss</span>}
        <span style={S.sevTag}>{sev || "unrated"}</span>
        {sla && <span style={{ ...S.slaTag, background: sla.bg, color: sla.fg }}>{sla.label}</span>}
      </div>
      <div style={S.subhead}>{g("type_name") || "Unclassified"} · {g("dept_name") || "—"}{g("location_name") ? ` · ${g("location_name")}` : ""}</div>

      {cluster && Number(cluster.recurrence_count) >= 2 && (() => {
        const priorCapas = siblings.flatMap((s) => ((s.rcas as { capas?: { action: string; control_level: string }[] }[]) || []).flatMap((r) => r.capas || [])).filter(Boolean);
        return (
          <section style={S.recur}>
            <div style={S.recurHead}>🔁 Recurring — {String(cluster.recurrence_count)} occurrences of “{String(cluster.label)}”</div>
            {priorCapas.length > 0 ? (
              <div style={S.recurBody}>
                <div style={S.recurLabel}>Prior CAPAs on this pattern — did they hold?</div>
                {priorCapas.map((c, i) => (
                  <div key={i} style={S.recurCapa}>• {c.action}<span style={{ fontWeight: 600, color: c.control_level === "training" || c.control_level === "ppe" ? "#b45309" : "#15803d" }}> · {c.control_level}</span></div>
                ))}
              </div>
            ) : <div style={S.recurBody}>No prior CAPA recorded on this pattern yet.</div>}
          </section>
        );
      })()}

      <section style={S.card}>
        <div style={S.flabel}>What happened</div>
        <p style={S.narrative}>{g("narrative")}</p>
        <Field label="Immediate action taken" value={g("immediate_action")} />
      </section>

      <section style={S.grid}>
        <Field label="Who / what affected" value={g("impact_domain")} />
        <Field label="Occurred" value={g("occurred_at") ? new Date(g("occurred_at")!).toLocaleString() : null} />
        <Field label="Reported" value={new Date(g("reported_at")!).toLocaleString()} />
        <Field label="Reporter role" value={g("role_name")} />
        <Field label="Source" value={g("source")} />
        <Field label="Confidentiality" value={conf} />
        <Field label="Reporter" value={conf === "named" ? g("reporter_name") : conf === "confidential" ? `${g("reporter_name") || "—"} (confidential)` : "Anonymous"} />
        <Field label="Reporter contact" value={conf === "confidential" ? g("reporter_contact") : null} />
      </section>

      {hasPatient && (
        <section style={S.card}>
          <div style={S.flabel}>Patient (contained)</div>
          <div style={S.grid}>
            <Field label="Name" value={g("phi_patient_name")} />
            <Field label="UHID" value={g("phi_uhid")} />
            <Field label="Age" value={g("phi_patient_age")} />
            <Field label="Sex" value={g("phi_patient_sex")} />
          </div>
        </section>
      )}

      <section style={S.card}>
        <div style={S.flabel}>Lifecycle</div>
        <div style={S.lifeRow}>
          <select style={S.sel} value={g("status") || "open"} onChange={(e) => patch({ status: e.target.value }, "status")}>
            {STATUS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <input style={S.owner} placeholder="Assign owner" value={owner} onChange={(e) => setOwner(e.target.value)} />
          <button style={S.btnSm} onClick={() => patch({ owner_name: owner }, "owner")} disabled={saving === "owner"}>{saving === "owner" ? "Saving…" : "Save owner"}</button>
        </div>
        {saveNote && <div style={{ marginTop: 8, fontSize: 13, color: "#15803d", fontWeight: 600 }}>{saveNote}</div>}
        {saveErr && <div style={{ marginTop: 8, fontSize: 13, color: "#b91c1c", fontWeight: 600 }}>{saveErr}</div>}

        {/* 7-working-day closure clock. Weekends are skipped and there is no
            holiday calendar (A1-D16), so a due date can land on a holiday. */}
        <div style={S.grid}>
          <Field
            label="Due (7 working days)"
            value={dueAt ? new Date(dueAt).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" }) : null}
          />
          <Field label="Closed" value={g("closed_at") ? new Date(g("closed_at")!).toLocaleString() : null} />
          <Field
            label="Owner assigned"
            value={g("owner_assigned_by")
              ? `${g("owner_assigned_by")}${g("owner_assigned_at") ? ` on ${new Date(g("owner_assigned_at")!).toLocaleDateString()}` : ""}`
              : g("owner_assigned_at") ? new Date(g("owner_assigned_at")!).toLocaleDateString() : null}
          />
        </div>
      </section>

      {/* Evidence (A1-D21). Deepthi: "so we don't have to back and forth
          looking for evidence." Hidden entirely when Blob is not configured. */}
      {(attachEnabled || attachments.length > 0) && (
        <section style={S.card}>
          <div style={S.rcaHead}>
            <div style={S.flabel}>Evidence</div>
            {attachEnabled && attachments.length < MAX_FILES && (
              <label style={{ ...S.btnSm, display: "inline-block", cursor: saving === "attach" ? "wait" : "pointer" }}>
                {saving === "attach" ? "Uploading…" : "+ Add file"}
                <input type="file" style={{ display: "none" }} disabled={saving === "attach"}
                  accept={ALLOWED_TYPES.join(",")}
                  onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) uploadFile(f); }} />
              </label>
            )}
          </div>
          {attachments.length === 0 ? (
            <div style={S.muted}>No evidence attached.</div>
          ) : (
            <div style={S.attachGrid}>
              {attachments.map((a) => (
                <div key={a.id} style={S.attachCard}>
                  <a href={a.blob_url} target="_blank" rel="noreferrer" style={S.attachLink}>
                    {isImage(a.content_type) ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={a.blob_url} alt={fileNameOf(a)} style={S.thumb} />
                    ) : (
                      <div style={S.fileIcon}>{a.content_type === "application/pdf" ? "PDF" : "FILE"}</div>
                    )}
                    <div style={S.attachName} title={fileNameOf(a)}>{fileNameOf(a)}</div>
                  </a>
                  <div style={S.attachMeta}>
                    {prettySize(a.size_bytes)}
                    {a.size_bytes ? " · " : ""}
                    {a.source === "office" ? (a.uploaded_by || "reviewer") : "reporter"}
                  </div>
                  <button style={S.attachX} disabled={saving === "attach"} onClick={() => removeAttachment(a.id)}>Remove</button>
                </div>
              ))}
            </div>
          )}
          <div style={S.attachHelp}>Up to {MAX_FILES} files, {MAX_MB} MB each. JPEG, PNG, WEBP, HEIC or PDF.</div>
          {saving === "attach" && <div style={{ marginTop: 8, fontSize: 13, color: "#64748b" }}>Working…</div>}
        </section>
      )}

      <section style={S.card}>
        <div style={S.rcaHead}>
          <div style={S.flabel}>Root cause & CAPA</div>
          <a href={`/safety/incidents/${id}/rca`} style={{ ...S.btn, textDecoration: "none" }}>{rcas.length ? "Add another RCA" : "Start guided RCA"}</a>
        </div>
        {rcas.length === 0 ? <div style={S.muted}>No RCA yet.</div> : rcas.map((r, i) => {
          const cf = (r.contributory_factors || {}) as { factors?: { category: string; note: string }[]; fiveWhys?: string[] };
          const capas = (r.capas || []) as { kind: string; action: string; control_level: string }[];
          const rcaId = String(r.id);
          return (
            <div key={i} style={S.rcaItem}>
              <div style={S.fvalue}><b>Root cause:</b> {String(r.root_cause || "—")}</div>
              {!!cf.factors?.length && (
                <div style={{ marginTop: 8 }}>
                  <div style={S.flabel}>Contributory factors</div>
                  {cf.factors.map((f, k) => <div key={k} style={S.factLine}><span style={S.factCat}>{f.category}</span> {f.note}</div>)}
                </div>
              )}
              {!!capas.length && (
                <div style={{ marginTop: 8 }}>
                  <div style={S.flabel}>CAPAs</div>
                  {capas.map((c, k) => (
                    <div key={k} style={S.factLine}>
                      <span style={S.kind}>{c.kind}</span> {c.action}
                      <span style={{ ...S.ctrl, color: c.control_level === "training" || c.control_level === "ppe" ? "#b45309" : "#15803d" }}>· {c.control_level}</span>
                    </div>
                  ))}
                </div>
              )}
              <div style={S.rcaFoot}>
                <span style={S.muted}>{r.effectiveness_verified ? "✓ Verified effective" : r.closed_at ? "Closed" : "Open"}</span>
                {!r.closed_at && <button style={S.btnSm} disabled={saving === "rca"} onClick={() => patchRca(rcaId, "close")}>Close</button>}
                {!r.effectiveness_verified && <button style={S.btnSm} disabled={saving === "rca"} onClick={() => patchRca(rcaId, "verify")}>Mark verified</button>}
              </div>
            </div>
          );
        })}
      </section>
    </main>
  );
}

const S: Record<string, React.CSSProperties> = {
  wrap: { maxWidth: 760, margin: "0 auto", padding: "24px 20px 60px", color: "#0f172a" },
  back: { display: "inline-block", color: "#2b5191", fontSize: 13, textDecoration: "none", marginBottom: 14 },
  headRow: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
  sevDot: { width: 12, height: 12, borderRadius: 6 },
  id: { fontFamily: "ui-monospace, Menlo, monospace", fontSize: 20, margin: 0 },
  nearMiss: { fontSize: 11, fontWeight: 700, color: "#0369a1", background: "#e0f2fe", borderRadius: 6, padding: "2px 7px" },
  sevTag: { fontSize: 12, fontWeight: 700, color: "#475569", background: "#f1f5f9", borderRadius: 6, padding: "3px 9px", textTransform: "capitalize" },
  subhead: { color: "#475569", fontSize: 15, margin: "8px 0 18px" },
  card: { background: "#fff", border: "1px solid #e6eaf0", borderRadius: 12, padding: "16px 18px", marginBottom: 14 },
  narrative: { fontSize: 15, lineHeight: 1.6, color: "#1e293b", margin: "8px 0 0", whiteSpace: "pre-wrap" },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 14, marginBottom: 14 },
  field: {},
  flabel: { fontSize: 12, fontWeight: 700, letterSpacing: ".03em", textTransform: "uppercase", color: "#94a3b8" },
  fvalue: { fontSize: 15, color: "#1e293b", marginTop: 3 },
  lifeRow: { display: "flex", gap: 10, marginTop: 10, flexWrap: "wrap", alignItems: "center" },
  sel: { padding: "9px 12px", fontSize: 14, border: "1px solid #cbd5e1", borderRadius: 9, background: "#fff" },
  owner: { flex: "1 1 160px", padding: "9px 12px", fontSize: 14, border: "1px solid #cbd5e1", borderRadius: 9 },
  slaTag: { fontSize: 11, fontWeight: 700, borderRadius: 6, padding: "3px 9px" },
  attachGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(148px, 1fr))", gap: 12, marginTop: 10 },
  attachCard: { border: "1px solid #e6eaf0", borderRadius: 10, padding: 8, background: "#fff" },
  attachLink: { display: "block", textDecoration: "none", color: "inherit" },
  thumb: { width: "100%", height: 96, objectFit: "cover", borderRadius: 7, display: "block", background: "#f1f5f9" },
  fileIcon: { width: "100%", height: 96, borderRadius: 7, background: "#f1f5f9", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, color: "#64748b", letterSpacing: ".06em" },
  attachName: { fontSize: 12.5, marginTop: 6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#1e293b" },
  attachMeta: { fontSize: 11.5, color: "#94a3b8", marginTop: 2 },
  attachX: { marginTop: 6, border: "none", background: "none", color: "#dc2626", fontSize: 12, fontWeight: 600, cursor: "pointer", padding: 0 },
  attachHelp: { fontSize: 12, color: "#94a3b8", marginTop: 10 },
  btn: { padding: "9px 14px", fontSize: 14, fontWeight: 600, color: "#fff", background: "#2b5191", border: "none", borderRadius: 9, cursor: "pointer" },
  btnSm: { padding: "9px 12px", fontSize: 13, fontWeight: 600, color: "#2b5191", background: "#eef2fb", border: "1px solid #dbe4f5", borderRadius: 9, cursor: "pointer" },
  rcaHead: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, marginBottom: 8 },
  rcaItem: { borderTop: "1px solid #f1f5f9", paddingTop: 10, marginTop: 10 },
  muted: { color: "#94a3b8", fontSize: 14 },
  err: { color: "#dc2626", fontSize: 14 },
  factLine: { fontSize: 14, color: "#1e293b", margin: "4px 0", lineHeight: 1.5 },
  factCat: { fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "#6d28d9", background: "#ede9fe", borderRadius: 5, padding: "1px 6px", marginRight: 4 },
  kind: { fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "#475569", background: "#f1f5f9", borderRadius: 5, padding: "1px 6px", marginRight: 4 },
  ctrl: { fontWeight: 600, marginLeft: 4 },
  rcaFoot: { display: "flex", alignItems: "center", gap: 10, marginTop: 10, flexWrap: "wrap" },
  recur: { background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: 12, padding: "14px 16px", marginBottom: 14 },
  recurHead: { fontSize: 15, fontWeight: 700, color: "#9a3412" },
  recurBody: { marginTop: 8, fontSize: 14, color: "#7c2d12" },
  recurLabel: { fontSize: 12, fontWeight: 700, textTransform: "uppercase", color: "#b45309", marginBottom: 4 },
  recurCapa: { fontSize: 13.5, color: "#7c2d12", margin: "3px 0", lineHeight: 1.5 },
};
