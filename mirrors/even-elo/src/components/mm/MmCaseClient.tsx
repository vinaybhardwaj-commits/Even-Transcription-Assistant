"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import MmNav, { Badge, EmptySection, OutcomeChip, StatusChip, type MmSectionKey } from "./MmNav";

/**
 * /mm/cases/[id] — the case workspace (mockup screens 3–8 chrome).
 *
 * Only "Review" has a backend today. The other five sections render structured
 * empty states that name what will appear and carry the mockup's NEXT/LATER
 * badge. No placeholder clinical content is invented.
 *
 * The detail GET is audited server-side and is FAIL-CLOSED (PRD A1): if the
 * mm_audit row cannot be written, the API withholds the case and returns its
 * reason. That reason is rendered VERBATIM — a generic "something went wrong"
 * would hide a compliance failure.
 *
 * Mutations echo `audited`. A false value means the write landed but was not
 * recorded; that is surfaced as a loud banner, never swallowed.
 */

type Case = Record<string, unknown>;

const inputCls = "w-full rounded-lg border border-stone-300 px-3 py-2 text-[13.5px] disabled:bg-stone-50 disabled:text-stone-500";
const labelCls = "mb-1 block text-[11px] font-semibold uppercase tracking-wide text-stone-400";

function Card({ title, badge, children }: { title: string; badge?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="mb-4 rounded-xl border border-stone-200 bg-white p-5">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-[15px] font-semibold">{title}</h2>
        {badge}
      </div>
      {children}
    </div>
  );
}

export default function MmCaseClient() {
  const { id } = useParams<{ id: string }>();
  const [c, setCase] = useState<Case | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [section, setSection] = useState<MmSectionKey>("review");

  // Review form state
  const [title, setTitle] = useState("");
  const [outcomeType, setOutcomeType] = useState("morbidity");
  const [outcomeSummary, setOutcomeSummary] = useState("");
  const [phiName, setPhiName] = useState("");
  const [phiAge, setPhiAge] = useState("");
  const [phiSex, setPhiSex] = useState("");
  const [phiUhid, setPhiUhid] = useState("");
  const [db13Uid, setDb13Uid] = useState("");
  const [db13Confirmed, setDb13Confirmed] = useState(false);

  const [saving, setSaving] = useState<string | null>(null);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [auditWarn, setAuditWarn] = useState<string | null>(null);

  const g = (k: string): string => (c && c[k] != null ? String(c[k]) : "");

  const load = useCallback(() => {
    fetch(`/api/safety/mm/cases/${id}`)
      .then((r) => r.json())
      .then((j) => {
        if (j.ok && j.case) {
          const k = j.case as Case;
          setCase(k);
          setLoadErr(null);
          setTitle(k.title == null ? "" : String(k.title));
          setOutcomeType(k.outcome_type == null ? "morbidity" : String(k.outcome_type));
          setOutcomeSummary(k.outcome_summary == null ? "" : String(k.outcome_summary));
          setPhiName(k.phi_patient_name == null ? "" : String(k.phi_patient_name));
          setPhiAge(k.phi_patient_age == null ? "" : String(k.phi_patient_age));
          setPhiSex(k.phi_patient_sex == null ? "" : String(k.phi_patient_sex));
          setPhiUhid(k.phi_uhid == null ? "" : String(k.phi_uhid));
          setDb13Uid(k.db13_member_uid == null ? "" : String(k.db13_member_uid));
          setDb13Confirmed(!!k.db13_member_uid);
        } else {
          // Render the API's reason verbatim — includes the fail-closed audit message.
          setLoadErr(j.error || "Failed to load the case.");
        }
      })
      .catch(() => setLoadErr("Network error — the case could not be loaded."));
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  async function patch(body: Record<string, unknown>, tag: string, okNote: string) {
    setSaving(tag);
    setSaveErr(null);
    setSaveNote(null);
    setAuditWarn(null);
    try {
      const r = await fetch(`/api/safety/mm/cases/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      let j: { ok?: boolean; error?: string; audited?: boolean } = {};
      try {
        j = await r.json();
      } catch {
        /* non-JSON (e.g. gateway error page) */
      }
      if (r.ok && j.ok !== false) {
        setSaveNote(okNote);
        if (j.audited === false) setAuditWarn("Change saved but NOT audited — report this.");
        setTimeout(() => setSaveNote(null), 2500);
        load();
      } else {
        setSaveErr(j.error || `Save failed (${r.status})`);
      }
    } catch {
      setSaveErr("Network error — not saved.");
    } finally {
      setSaving(null);
    }
  }

  function saveMetadata() {
    if (!c) return;
    const body: Record<string, unknown> = {};
    if (title.trim() !== g("title")) body.title = title.trim();
    if (outcomeType !== g("outcome_type")) body.outcome_type = outcomeType;
    if (outcomeSummary.trim() !== g("outcome_summary")) body.outcome_summary = outcomeSummary.trim();

    const phi: Record<string, unknown> = {};
    if (phiName.trim() !== g("phi_patient_name")) phi.patient_name = phiName.trim();
    if (phiAge.trim() !== g("phi_patient_age")) phi.patient_age = phiAge.trim();
    if (phiSex !== g("phi_patient_sex")) phi.patient_sex = phiSex;
    if (phiUhid.trim() !== g("phi_uhid")) phi.uhid = phiUhid.trim();
    if (Object.keys(phi).length) body.phi = phi;

    // Operator-confirmed, never assumed: an unconfirmed uid is never written.
    if (db13Uid.trim() !== g("db13_member_uid")) {
      if (db13Uid.trim() && !db13Confirmed) {
        setSaveErr("Confirm the db13 match before saving it.");
        return;
      }
      body.db13_member_uid = db13Uid.trim();
    }

    if (!Object.keys(body).length) {
      setSaveNote("Nothing to save.");
      setTimeout(() => setSaveNote(null), 2000);
      return;
    }
    patch(body, "meta", "Saved ✓");
  }

  function transition(to: string) {
    if (to === "ratified") {
      const ok = window.confirm(
        "Ratify this case?\n\nRatification is terminal — a ratified case cannot be un-ratified in v1. " +
          "It stamps your name and the time, and only ratified findings flow to Governance (FR-11.4).",
      );
      if (!ok) return;
    }
    patch({ status: to }, `status:${to}`, to === "ratified" ? "Case ratified ✓" : "Status saved ✓");
  }

  if (loadErr) {
    return (
      <div>
        <a href="/mm" className="mb-3 inline-block text-[13px] text-brand">
          ← M&amp;M cases
        </a>
        <div className="rounded-xl border border-red-200 bg-red-50 p-5">
          <div className="text-[13.5px] font-semibold text-red-800">{loadErr}</div>
          <div className="mt-1.5 text-[12px] text-red-700">
            If this says the read could not be audited, the case is being withheld deliberately (fail-closed, PRD A1).
            Do not work around it — report it.
          </div>
        </div>
      </div>
    );
  }
  if (!c) return <div className="text-sm text-stone-400">Loading…</div>;

  const status = g("status");
  const ratified = status === "ratified";
  const incidentRef = g("incident_ref");
  const docs = Number(c.document_count ?? 0);
  const events = Number(c.event_count ?? 0);
  const nodes = Number(c.node_count ?? 0);

  return (
    <div>
      {/* ---------- case header ---------- */}
      <div className="mb-4">
        <a href="/mm" className="mb-2 inline-block text-[13px] text-brand">
          ← M&amp;M cases
        </a>
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="font-mono text-[17px] font-bold">{g("id")}</span>
          <StatusChip status={status} />
          <OutcomeChip outcome={g("outcome_type")} />
          {incidentRef ? (
            <a
              href={`/safety/incidents/${incidentRef}`}
              className="rounded bg-brand-softer px-1.5 py-0.5 font-mono text-[10.5px] font-semibold text-brand hover:underline"
            >
              {incidentRef}
            </a>
          ) : (
            <span className="text-[11.5px] italic text-stone-400">— no incident filed</span>
          )}
        </div>
        <div className="mt-1 text-[15px] font-semibold">{g("title")}</div>
        {g("outcome_summary") && <div className="mt-0.5 text-[13px] text-stone-500">{g("outcome_summary")}</div>}
      </div>

      <MmNav active={section} onSelect={setSection} />

      {/* ---------- SOURCES ---------- */}
      {section === "sources" && (
        <EmptySection
          title="Sources & upload"
          stage="next"
          lead={`Bulk load (FR-1.9): browser → Blob direct, per-artefact status, partial failures never block the batch. ${docs} source document${docs === 1 ? "" : "s"} registered.`}
          bullets={[
            "Drop KareXpert exports — PDF · scans · images · CSV · JSON. Uploads go directly to secure storage; nothing routes through the governance proxy.",
            "Each artefact is classified, OCR'd where needed, and tracked pending → processing → ingested | failed.",
            "The incident report auto-registers as a source; db13 supplies structured pre-admission context.",
            "Requested documents (FR-1.10, decision 15): a requisition checklist generated from the case profile, plus cited analysis-driven requests for documents the record references but that are absent.",
            "Ingestion gaps surface loudly (FR-1.7); nothing proceeds silently. Clinician names are de-identified to role tokens at ingestion (FR-1.6).",
          ]}
          foot="Ingestion arrives with the next build."
        />
      )}

      {/* ---------- TIMELINE ---------- */}
      {section === "timeline" && (
        <EmptySection
          title="Clinical timeline"
          stage="later"
          lead={`Every event cited; absence is asserted, never inferred (FR-2.4). ${events} event${events === 1 ? "" : "s"} extracted.`}
          bullets={[
            "A single chronological event stream across all sources, each event carrying a resolvable citation to its exact source location.",
            "Event-time is distinguished from documentation-time; late/retrospective charting is flagged (FR-2.3).",
            "Conflicting timestamps retain both values and flag the conflict rather than silently choosing one (FR-2.2).",
            "Absence is a first-class annotation: “no X is documented,” never “X did not occur.”",
          ]}
        />
      )}

      {/* ---------- DECISION NODES ---------- */}
      {section === "nodes" && (
        <EmptySection
          title="Decision nodes"
          stage="later"
          lead={`Outcome-blinded evaluation against a declared standard of care. ${nodes} node${nodes === 1 ? "" : "s"} detected.`}
          bullets={[
            "🕶 OUTCOME WITHHELD — evaluations are produced from frozen pre-node snapshots only. Causation is a separate, outcome-sighted stage.",
            "Seven node types, including omitted decisions — an escalation a deterioration signal warranted but that is absent (FR-3.2).",
            "Each node declares its standard basis: institutional protocol → external guideline → inferred consensus → no standard exists.",
            "“No standard exists” is an organizational gap, not clinician error — it becomes a Protocol Gap (FR-5.5).",
            "Contributory factors map to SEIPS 2.0 components and London Protocol tiers, attributed to system conditions and never to a named clinician.",
          ]}
        />
      )}

      {/* ---------- CAUSATION ---------- */}
      {section === "causation" && (
        <EmptySection
          title="Causation & preventability"
          stage="later"
          lead="⚠ The only stage that sees the outcome. Counterfactual judgment, then a case-level preventability rating."
          bullets={[
            "Each care-delivery problem is classed causal, contributory-but-not-causal, or incidental learning (FR-7.2).",
            "Every judgment carries a calibrated confidence and an explicit uncertainty statement (§11.4).",
            "The case is reconciled against the institutional incident record; where the two disagree, the discrepancy is surfaced as a finding, never silently reconciled.",
          ]}
        />
      )}

      {/* ---------- REVIEW (LIVE) ---------- */}
      {section === "review" && (
        <div>
          <div className="mb-4">
            <div className="flex items-center gap-2">
              <h2 className="text-[15px] font-semibold">Review &amp; ratify</h2>
              <Badge stage="now" />
              <span className="text-[11.5px] italic text-stone-400">(lifecycle live; finding-level review LATER)</span>
            </div>
            <p className="text-[13px] text-stone-500">
              The model proposes; the clinician disposes (FR-11). Nothing leaves the protected workflow before
              ratification.
            </p>
          </div>

          {ratified && (
            <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-[13px] text-emerald-900">
              <b>Ratified</b> by {g("ratified_by") || "—"}
              {g("ratified_at") ? ` on ${new Date(g("ratified_at")).toLocaleString()}` : ""}. Ratification is terminal in
              v1 — this case is read-only.
            </div>
          )}

          {auditWarn && (
            <div className="mb-4 rounded-xl border-2 border-amber-400 bg-amber-50 px-4 py-3 text-[13px] font-bold text-amber-900">
              ⚠ {auditWarn}
            </div>
          )}

          <Card title="Case metadata">
            <div className="mb-3">
              <label className={labelCls}>Title</label>
              <input className={inputCls} value={title} disabled={ratified} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div className="mb-3 grid gap-3 sm:grid-cols-2">
              <div>
                <label className={labelCls}>Outcome type</label>
                <select className={inputCls} value={outcomeType} disabled={ratified} onChange={(e) => setOutcomeType(e.target.value)}>
                  <option value="morbidity">morbidity</option>
                  <option value="death">death</option>
                </select>
              </div>
            </div>
            <div className="mb-4">
              <label className={labelCls}>Outcome summary</label>
              <textarea className={inputCls} rows={2} value={outcomeSummary} disabled={ratified} onChange={(e) => setOutcomeSummary(e.target.value)} />
            </div>

            <div className="mb-4 rounded-lg border border-stone-200 p-3">
              <div className="mb-2 text-[12.5px] font-semibold">Patient (contained)</div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className={labelCls}>Name</label>
                  <input className={inputCls} value={phiName} disabled={ratified} onChange={(e) => setPhiName(e.target.value)} />
                </div>
                <div>
                  <label className={labelCls}>UHID</label>
                  <input className={inputCls} value={phiUhid} disabled={ratified} onChange={(e) => setPhiUhid(e.target.value)} />
                </div>
                <div>
                  <label className={labelCls}>Age</label>
                  <input className={inputCls} value={phiAge} disabled={ratified} inputMode="numeric" onChange={(e) => setPhiAge(e.target.value)} />
                </div>
                <div>
                  <label className={labelCls}>Sex</label>
                  <select className={inputCls} value={phiSex} disabled={ratified} onChange={(e) => setPhiSex(e.target.value)}>
                    <option value="">—</option>
                    <option value="M">M</option>
                    <option value="F">F</option>
                    <option value="O">O</option>
                  </select>
                </div>
              </div>
              <div className="mt-2 text-[11.5px] italic text-stone-400">
                Every read of this section is written to mm_audit as case_phi_read.
              </div>
            </div>

            <div className="mb-4 rounded-lg border border-stone-200 p-3">
              <div className="mb-2 text-[12.5px] font-semibold">db13 identity match</div>
              <div className="mb-2">
                <label className={labelCls}>db13 member uid</label>
                <input className={inputCls} value={db13Uid} disabled={ratified} onChange={(e) => setDb13Uid(e.target.value)} />
              </div>
              <label className="flex items-center gap-2 text-[13px]">
                <input type="checkbox" checked={db13Confirmed} disabled={ratified || !db13Uid.trim()} onChange={(e) => setDb13Confirmed(e.target.checked)} />
                Confirm match — operator-confirmed, never assumed (FR-1.8).
              </label>
              {g("db13_match_confirmed_by") && (
                <div className="mt-1.5 text-[11.5px] text-stone-400">
                  Confirmed by {g("db13_match_confirmed_by")}
                  {g("db13_match_confirmed_at") ? ` on ${new Date(g("db13_match_confirmed_at")).toLocaleString()}` : ""}
                </div>
              )}
            </div>

            {!ratified && (
              <button
                type="button"
                onClick={saveMetadata}
                disabled={saving === "meta"}
                className="rounded-lg bg-brand px-3.5 py-2 text-[13px] font-semibold text-white disabled:opacity-60"
              >
                {saving === "meta" ? "Saving…" : "Save changes"}
              </button>
            )}
            {saveNote && <div className="mt-2 text-[13px] font-semibold text-emerald-700">{saveNote}</div>}
            {saveErr && <div className="mt-2 text-[13px] font-semibold text-red-700">{saveErr}</div>}
          </Card>

          <Card title="Findings checklist" badge={<Badge stage="later" />}>
            <div className="rounded-lg border border-dashed border-stone-300 bg-stone-50 px-4 py-8 text-center text-[12.5px] text-stone-400">
              No findings yet. Timeline events, decision nodes, and causation judgments appear here for accept / edit /
              reject once the analysis pipeline ships.
            </div>
            <p className="mt-3 text-[11.5px] italic text-stone-400">
              Reviewer-supplied, out-of-record context will be tagged and visually distinct from record-derived facts
              (FR-11.3).
            </p>
          </Card>

          <Card title="Lifecycle">
            <div className="flex flex-wrap items-center gap-2">
              {status === "draft" && (
                <button type="button" onClick={() => transition("in_review")} disabled={!!saving} className="rounded-lg bg-brand px-3.5 py-2 text-[13px] font-semibold text-white disabled:opacity-60">
                  {saving === "status:in_review" ? "Saving…" : "Send to review"}
                </button>
              )}
              {status === "in_review" && (
                <>
                  <button type="button" onClick={() => transition("draft")} disabled={!!saving} className="rounded-lg border border-stone-200 bg-white px-3.5 py-2 text-[13px] font-semibold text-stone-600 disabled:opacity-60">
                    {saving === "status:draft" ? "Saving…" : "Return to draft"}
                  </button>
                  <button type="button" onClick={() => transition("ratified")} disabled={!!saving} className="rounded-lg bg-emerald-600 px-3.5 py-2 text-[13px] font-semibold text-white disabled:opacity-60">
                    {saving === "status:ratified" ? "Ratifying…" : "Ratify case"}
                  </button>
                </>
              )}
              {ratified && <span className="text-[13px] text-stone-500">Ratified — terminal. No further transitions.</span>}
            </div>
            <p className="mt-3 text-[11.5px] italic text-stone-400">
              Ratification requires a named governance identity; it stamps ratified_by/at and is terminal.
            </p>
          </Card>

          <Card title="Audit trail (mm_audit)" badge={<Badge stage="later" />}>
            <div className="rounded-lg border border-dashed border-stone-300 bg-stone-50 px-4 py-6 text-center text-[12.5px] text-stone-400">
              The audit trail is being written from day one — a viewer for it arrives with a later build.
            </div>
            <p className="mt-3 text-[11.5px] italic text-stone-400">
              Every read of PHI and every mutation is a row. If the audit write fails, PHI is withheld (fail-closed, PRD
              A1); if a mutation cannot be audited, this page says so.
            </p>
          </Card>
        </div>
      )}

      {/* ---------- OUTPUTS ---------- */}
      {section === "outputs" && (
        <EmptySection
          title="Outputs"
          stage="later"
          lead="Three renderings of one ratified CAO — they can never diverge in substance (FR-8.4). Unlocked on ratification."
          bullets={[
            "RCA report — synopsis, timeline, pivotal nodes with blinded evaluations and standard bases, CDPs, factors, causation, preventability, learning points; every claim source-linked.",
            "M&M deck — a deliberately non-exhaustive presentation subset: timeline, the 3–5 pivotal nodes, contributory-factor summary, learning points.",
            "Taxonomy rows — machine-readable per-CDP data feeding the shared substrate and the write-back to the linked incident (FR-9.2/9.3).",
          ]}
        />
      )}
    </div>
  );
}
