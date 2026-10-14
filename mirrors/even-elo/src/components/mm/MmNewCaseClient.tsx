"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "./MmNav";

/**
 * /mm/new — four-step case creation (mockup screen 2).
 *
 * Seeding is incident-optional (decision 9). When an incident is chosen and no
 * PHI is typed, the `phi` key is OMITTED from the POST body entirely — the API
 * seeds phi_* from the incident row only when the caller supplies no `phi` at
 * all (FR-9.1). Sending `phi: {}` would suppress that seeding.
 *
 * db13 identity match is operator-confirmed, never assumed (FR-1.8). The
 * candidate-search UI arrives with the context-extract backend; here the uid is
 * typed and explicitly confirmed. Because POST does not accept db13_member_uid,
 * a confirmed uid is applied as a follow-up PATCH, which stamps
 * db13_match_confirmed_by/at from the proxy-injected actor identity.
 */

interface Incident {
  id: string;
  reported_at: string;
  severity: string | null;
  status: string;
  type_name: string | null;
  dept_name: string | null;
  location_name: string | null;
  narrative_snippet: string;
  rca_count: number;
}

const STEPS = ["1 · Seed", "2 · Patient identity", "3 · db13 match", "4 · Create"];

export default function MmNewCaseClient() {
  const router = useRouter();
  const [step, setStep] = useState(0);

  const [mode, setMode] = useState<"incident" | "direct">("incident");
  const [incidents, setIncidents] = useState<Incident[] | null>(null);
  const [incidentRef, setIncidentRef] = useState<string>("");

  const [title, setTitle] = useState("");
  const [outcomeType, setOutcomeType] = useState<"death" | "morbidity">("morbidity");
  const [outcomeSummary, setOutcomeSummary] = useState("");
  const [phiName, setPhiName] = useState("");
  const [phiAge, setPhiAge] = useState("");
  const [phiSex, setPhiSex] = useState("");
  const [phiUhid, setPhiUhid] = useState("");

  const [db13Uid, setDb13Uid] = useState("");
  const [db13Confirmed, setDb13Confirmed] = useState(false);

  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [warn, setWarn] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/safety/office/incidents")
      .then((r) => r.json())
      .then((j) => {
        if (j.ok) setIncidents(j.incidents);
        else setIncidents([]);
      })
      .catch(() => setIncidents([]));
  }, []);

  const anyPhi = !!(phiName.trim() || phiAge.trim() || phiSex || phiUhid.trim());
  const seedsPhi = mode === "incident" && !!incidentRef && !anyPhi;

  function next() {
    setErr(null);
    if (step === 0 && mode === "incident" && !incidentRef) {
      setErr("Choose an incident to seed from, or switch to “Create directly”.");
      return;
    }
    if (step === 1 && !title.trim()) {
      setErr("Title is required.");
      return;
    }
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  }

  async function create() {
    setCreating(true);
    setErr(null);
    setWarn(null);
    try {
      const body: Record<string, unknown> = { title: title.trim(), outcome_type: outcomeType };
      if (outcomeSummary.trim()) body.outcome_summary = outcomeSummary.trim();
      if (mode === "incident" && incidentRef) body.incident_ref = incidentRef;
      // Omit `phi` entirely unless the operator typed something — see header note.
      if (anyPhi) {
        body.phi = {
          patient_name: phiName.trim() || null,
          patient_age: phiAge.trim() || null,
          patient_sex: phiSex || null,
          uhid: phiUhid.trim() || null,
        };
      }

      const r = await fetch("/api/safety/mm/cases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      let j: { ok?: boolean; error?: string; audited?: boolean; case?: { id?: string } } = {};
      try {
        j = await r.json();
      } catch {
        /* non-JSON (e.g. gateway error page) */
      }
      if (!r.ok || j.ok === false || !j.case?.id) {
        setErr(j.error || `Could not create the case (${r.status}).`);
        return;
      }
      const id = j.case.id;
      if (j.audited === false) setWarn("Case created but NOT audited — report this.");

      if (db13Uid.trim() && db13Confirmed) {
        const pr = await fetch(`/api/safety/mm/cases/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ db13_member_uid: db13Uid.trim() }),
        });
        let pj: { ok?: boolean; error?: string } = {};
        try {
          pj = await pr.json();
        } catch {
          /* ignore */
        }
        if (!pr.ok || pj.ok === false) {
          setErr(
            `Case ${id} was created, but the db13 match could not be saved: ${pj.error || pr.status}. Set it from the case's Review section.`,
          );
          return;
        }
      }
      router.push(`/mm/cases/${id}`);
    } catch {
      setErr("Network error — the case was not created.");
    } finally {
      setCreating(false);
    }
  }

  const inputCls = "w-full rounded-lg border border-stone-300 px-3 py-2 text-[13.5px]";
  const labelCls = "mb-1 block text-[11px] font-semibold uppercase tracking-wide text-stone-400";

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-4 flex flex-wrap gap-1.5 text-[11.5px]">
        {STEPS.map((s, i) => (
          <span
            key={s}
            className={
              "rounded-full px-2.5 py-1 " +
              (i === step ? "bg-brand font-semibold text-white" : "bg-stone-100 text-stone-500")
            }
          >
            {s}
          </span>
        ))}
      </div>

      {/* ---------- Step 1 · Seed ---------- */}
      {step === 0 && (
        <div className="rounded-xl border border-stone-200 bg-white p-5">
          <button
            type="button"
            onClick={() => setMode("incident")}
            className={
              "mb-2 block w-full rounded-lg border p-3 text-left " +
              (mode === "incident" ? "border-brand bg-brand-softer" : "border-stone-200")
            }
          >
            <b className="text-[13.5px]">Seed from an EHRC incident report</b>
            <div className="text-[12px] text-stone-500">
              Pulls the linked incident and its patient PHI into the case.
            </div>
          </button>

          {mode === "incident" && (
            <div className="mb-3 max-h-80 overflow-y-auto rounded-lg border border-stone-200">
              {!incidents ? (
                <div className="p-4 text-sm text-stone-400">Loading incidents…</div>
              ) : incidents.length === 0 ? (
                <div className="p-4 text-sm text-stone-400">No incidents on file.</div>
              ) : (
                incidents.map((i) => (
                  <button
                    type="button"
                    key={i.id}
                    onClick={() => setIncidentRef(i.id)}
                    className={
                      "block w-full border-b border-stone-100 p-3 text-left last:border-b-0 " +
                      (incidentRef === i.id ? "bg-brand-softer" : "hover:bg-stone-50")
                    }
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[12.5px] font-bold">{i.id}</span>
                      <span className="text-[12px] text-stone-500">{i.type_name || "Unclassified"}</span>
                      <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[11px] font-semibold text-stone-600">
                        {i.severity || "unrated"}
                      </span>
                      {i.rca_count > 0 && (
                        <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
                          RCA on file
                        </span>
                      )}
                      <span className="ml-auto text-[11.5px] text-stone-400">{i.dept_name || "—"}</span>
                    </div>
                    <div className="mt-1 line-clamp-2 text-[12px] text-stone-500">{i.narrative_snippet}</div>
                  </button>
                ))
              )}
            </div>
          )}

          <button
            type="button"
            onClick={() => {
              setMode("direct");
              setIncidentRef("");
            }}
            className={
              "block w-full rounded-lg border p-3 text-left " +
              (mode === "direct" ? "border-brand bg-brand-softer" : "border-stone-200")
            }
          >
            <b className="text-[13.5px]">Create directly — no incident on file</b>
            <div className="text-[12px] text-stone-500">
              For deaths/morbidity that were never incident-reported. An incident can be back-filed and linked later.
            </div>
          </button>
        </div>
      )}

      {/* ---------- Step 2 · Patient identity ---------- */}
      {step === 1 && (
        <div className="rounded-xl border border-stone-200 bg-white p-5">
          <div className="mb-3">
            <label className={labelCls}>Case title *</label>
            <input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Unexpected death D3 post-laparotomy" />
          </div>
          <div className="mb-3 grid gap-3 sm:grid-cols-2">
            <div>
              <label className={labelCls}>Outcome type *</label>
              <select className={inputCls} value={outcomeType} onChange={(e) => setOutcomeType(e.target.value as "death" | "morbidity")}>
                <option value="morbidity">morbidity</option>
                <option value="death">death</option>
              </select>
            </div>
          </div>
          <div className="mb-4">
            <label className={labelCls}>Outcome summary</label>
            <textarea className={inputCls} rows={2} value={outcomeSummary} onChange={(e) => setOutcomeSummary(e.target.value)} />
          </div>

          <div className="rounded-lg border border-stone-200 p-3">
            <div className="mb-2 text-[12.5px] font-semibold">Patient (contained)</div>
            {seedsPhi && (
              <div className="mb-3 rounded-lg border border-sky-100 bg-sky-50 px-3 py-2 text-[12px] text-sky-900">
                Leave these blank and patient details seed automatically from {incidentRef} when the case is created
                (FR-9.1). Typing any field here overrides the seed entirely.
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className={labelCls}>Name</label>
                <input className={inputCls} value={phiName} onChange={(e) => setPhiName(e.target.value)} />
              </div>
              <div>
                <label className={labelCls}>UHID</label>
                <input className={inputCls} value={phiUhid} onChange={(e) => setPhiUhid(e.target.value)} />
              </div>
              <div>
                <label className={labelCls}>Age</label>
                <input className={inputCls} value={phiAge} onChange={(e) => setPhiAge(e.target.value)} inputMode="numeric" placeholder="0–130" />
              </div>
              <div>
                <label className={labelCls}>Sex</label>
                <select className={inputCls} value={phiSex} onChange={(e) => setPhiSex(e.target.value)}>
                  <option value="">—</option>
                  <option value="M">M</option>
                  <option value="F">F</option>
                  <option value="O">O</option>
                </select>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ---------- Step 3 · db13 match ---------- */}
      {step === 2 && (
        <div className="space-y-4">
          <div className="rounded-xl border border-stone-200 bg-white p-5">
            <div className="mb-1 flex items-center gap-2">
              <h2 className="text-[15px] font-semibold">db13 identity match</h2>
              <span className="rounded-full bg-brand-softer px-2 py-0.5 text-[11px] font-semibold text-brand">
                operator-confirmed, never assumed
              </span>
            </div>
            <p className="mb-3 text-[12.5px] text-stone-500">
              Optional. Links this case to the patient&apos;s db13 member record so pre-admission context can be pulled
              later (FR-1.8). Leave blank to skip.
            </p>
            <div className="mb-2">
              <label className={labelCls}>db13 member uid</label>
              <input className={inputCls} value={db13Uid} onChange={(e) => setDb13Uid(e.target.value)} />
            </div>
            <label className="flex items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                checked={db13Confirmed}
                disabled={!db13Uid.trim()}
                onChange={(e) => setDb13Confirmed(e.target.checked)}
              />
              Confirm match — I have verified this uid is the same patient.
            </label>
            {db13Uid.trim() && !db13Confirmed && (
              <div className="mt-2 text-[12px] font-semibold text-amber-700">
                Unconfirmed — the uid will not be saved until you confirm the match.
              </div>
            )}
          </div>

          {/* Disabled preview of the candidate-search UI (mockup screen 2, step-3 card). */}
          <div className="rounded-xl border border-stone-200 bg-white p-5 opacity-60">
            <div className="mb-2 flex items-center gap-2">
              <h3 className="text-[13.5px] font-semibold">Candidate search</h3>
              <Badge stage="next" />
            </div>
            <table className="w-full border-collapse text-[12.5px]">
              <thead>
                <tr>
                  {["", "From incident (KareXpert)", "db13 candidate"].map((h, i) => (
                    <th key={i} className="border-b border-stone-200 px-2 py-1.5 text-left text-[11px] font-semibold uppercase text-stone-400">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="border-b border-stone-100 px-2 py-2 font-semibold">Patient</td>
                  <td className="border-b border-stone-100 px-2 py-2 text-stone-400">—</td>
                  <td className="border-b border-stone-100 px-2 py-2 text-stone-400">—</td>
                </tr>
                <tr>
                  <td className="border-b border-stone-100 px-2 py-2 font-semibold">Signals</td>
                  <td className="border-b border-stone-100 px-2 py-2 text-stone-400" colSpan={2}>
                    Match signals (karexpert_metadata, name similarity) arrive with the db13 context extract.
                  </td>
                </tr>
              </tbody>
            </table>
            <div className="mt-3 flex gap-2">
              <button type="button" disabled className="cursor-not-allowed rounded-lg bg-emerald-600 px-3 py-1.5 text-[12.5px] font-semibold text-white opacity-45">
                Confirm match
              </button>
              <button type="button" disabled className="cursor-not-allowed rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-[12.5px] font-semibold text-stone-500 opacity-45">
                No match — skip db13 context
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- Step 4 · Create ---------- */}
      {step === 3 && (
        <div className="rounded-xl border border-stone-200 bg-white p-5">
          <h2 className="mb-3 text-[15px] font-semibold">Review and create</h2>
          <dl className="space-y-2 text-[13px]">
            <div className="flex gap-3">
              <dt className="w-44 shrink-0 text-stone-400">Seed</dt>
              <dd>{mode === "incident" ? `From incident ${incidentRef}` : "Direct — no incident on file"}</dd>
            </div>
            <div className="flex gap-3">
              <dt className="w-44 shrink-0 text-stone-400">Title</dt>
              <dd className="font-semibold">{title || "—"}</dd>
            </div>
            <div className="flex gap-3">
              <dt className="w-44 shrink-0 text-stone-400">Outcome</dt>
              <dd>{outcomeType}</dd>
            </div>
            <div className="flex gap-3">
              <dt className="w-44 shrink-0 text-stone-400">Patient details</dt>
              <dd>{anyPhi ? "Entered by operator" : seedsPhi ? `Will seed from ${incidentRef}` : "None"}</dd>
            </div>
            <div className="flex gap-3">
              <dt className="w-44 shrink-0 text-stone-400">db13 match</dt>
              <dd>
                {db13Uid.trim() && db13Confirmed
                  ? `${db13Uid.trim()} (confirmed)`
                  : db13Uid.trim()
                    ? "Not confirmed — will not be saved"
                    : "Skipped"}
              </dd>
            </div>
          </dl>
          <p className="mt-4 text-[11.5px] italic text-stone-400">
            The case is created in <b>draft</b>. Nothing leaves the protected workflow before ratification (FR-11).
          </p>
        </div>
      )}

      {err && <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] font-semibold text-red-700">{err}</div>}
      {warn && <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[13px] font-semibold text-amber-800">{warn}</div>}

      <div className="mt-4 flex justify-end gap-2">
        <a href="/mm" className="rounded-lg border border-stone-200 bg-white px-3.5 py-2 text-[13px] font-semibold text-stone-600">
          Cancel
        </a>
        {step > 0 && (
          <button type="button" onClick={() => setStep((s) => s - 1)} className="rounded-lg border border-stone-200 bg-white px-3.5 py-2 text-[13px] font-semibold text-stone-600">
            ← Back
          </button>
        )}
        {step < STEPS.length - 1 ? (
          <button type="button" onClick={next} className="rounded-lg bg-brand px-3.5 py-2 text-[13px] font-semibold text-white">
            Continue →
          </button>
        ) : (
          <button type="button" onClick={create} disabled={creating} className="rounded-lg bg-brand px-3.5 py-2 text-[13px] font-semibold text-white disabled:opacity-60">
            {creating ? "Creating…" : "Create case"}
          </button>
        )}
      </div>
    </div>
  );
}
