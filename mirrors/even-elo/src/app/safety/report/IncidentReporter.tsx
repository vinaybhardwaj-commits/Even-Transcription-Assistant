"use client";

import { useEffect, useState, type CSSProperties, type FormEvent } from "react";

type Opt = { id: string; name: string; category?: string };
type Unit = { code: string; name: string };
type Meta = {
  departments: Opt[];
  locations: Opt[];
  roles: Opt[];
  types: Opt[];
  units?: Unit[];
  attachmentsEnabled?: boolean;
};
type Attachment = {
  url: string;
  pathname: string;
  contentType: string;
  size: number;
  name: string;
};

const MAX_FILES = 5;
const MAX_MB = 10;
const ALLOWED = ["image/jpeg", "image/png", "image/webp", "image/heic", "application/pdf"];

// NABH 4-tier (A1-D1). Sentinel is assigned only by a Quality reviewer.
const NABH = [
  ["near_miss", "Near Miss (Potential error that was caught before it reached individual)"],
  ["no_harm", "No Harm Incident (Caused no harm)"],
  ["adverse_event", "Adverse Event (Serious, largely preventable event)"],
];
const CARE = [
  ["clinical", "Clinical"],
  ["non_clinical", "Non-Clinical"],
];
const SEVERITY = [
  ["negligible", "Negligible — no real harm/impact"],
  ["minor", "Minor"],
  ["moderate", "Moderate"],
  ["major", "Major"],
  ["catastrophic", "Catastrophic"],
];
const IMPACT = [
  ["patient", "A patient"],
  ["staff", "A staff member"],
  ["visitor", "A visitor / attender"],
  ["property_asset", "Equipment / property"],
  ["operations", "Operations / service"],
  ["data_privacy", "Data / privacy"],
  ["environment", "Environment"],
  ["none", "No one / nothing yet"],
];

const clean = (value: unknown) => {
  const stringValue = String(value ?? "").trim();
  return !stringValue || stringValue === "null" || stringValue === "undefined" ? "" : stringValue;
};

function localNow(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function occurredAtForSubmit(value: string): string | null {
  const stringValue = (value || "").trim();
  if (!stringValue) return null;
  const date = new Date(stringValue);
  return Number.isFinite(date.getTime()) ? date.toISOString() : stringValue;
}

function initialForm(reporterName: string) {
  return {
    narrative: "",
    primaryTypeId: "",
    impactDomain: "",
    severity: "",
    nearMiss: false,
    departmentId: "",
    locationId: "",
    reporterRoleId: "",
    occurredAt: "",
    immediateAction: "",
    confidentiality: "named",
    reporterName,
    reporterContact: "",
    involvesPatient: false,
    pName: "",
    pAge: "",
    pSex: "",
    pUhid: "",
    nabhClass: "",
    careType: "",
    probableReason: "",
    unitCode: "",
  };
}

export default function IncidentReporter({
  reporterName,
  reporterEmail,
}: {
  reporterName: string;
  reporterEmail: string;
}) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [result, setResult] = useState<{ id: string; displayNo: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aiNote, setAiNote] = useState<string | null>(null);
  const [whenErr, setWhenErr] = useState<string | null>(null);
  const [unitErr, setUnitErr] = useState<string | null>(null);
  const [maxWhen, setMaxWhen] = useState("");
  const [files, setFiles] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadNote, setUploadNote] = useState<string | null>(null);
  const [uploadsEnabled, setUploadsEnabled] = useState(false);
  const [form, setForm] = useState(() => initialForm(reporterName));
  const set = (key: string, value: unknown) => setForm((previous) => ({ ...previous, [key]: value }));

  useEffect(() => {
    const now = localNow();
    setMaxWhen(now);
    setForm((previous) => (previous.occurredAt ? previous : { ...previous, occurredAt: now }));
  }, []);

  useEffect(() => {
    fetch("/api/safety/incident/meta", { cache: "no-store" })
      .then((response) => response.json())
      .then((json) => {
        if (!json.ok) {
          setError(json.error || "Could not load incident reporting options.");
          return;
        }
        setMeta(json);
        const units: Unit[] = json.units || [];
        if (units.length === 1) {
          setForm((previous) => (previous.unitCode ? previous : { ...previous, unitCode: units[0].code }));
        }
        setUploadsEnabled(json.attachmentsEnabled === true);
      })
      .catch(() => setError("Could not load incident reporting options."));
  }, []);

  const setNearMiss = (checked: boolean) =>
    setForm((previous) => ({
      ...previous,
      nearMiss: checked,
      nabhClass: checked ? "near_miss" : previous.nabhClass === "near_miss" ? "" : previous.nabhClass,
    }));

  const setNabhClass = (value: string) =>
    setForm((previous) => ({ ...previous, nabhClass: value, nearMiss: value === "near_miss" }));

  async function addFile(file: File) {
    setUploadNote(null);
    if (!ALLOWED.includes(file.type)) {
      setUploadNote(`${file.name}: only JPEG, PNG, WEBP, HEIC or PDF can be attached.`);
      return;
    }
    if (file.size > MAX_MB * 1024 * 1024) {
      setUploadNote(`${file.name} is larger than ${MAX_MB} MB.`);
      return;
    }
    if (files.length >= MAX_FILES) {
      setUploadNote(`You can attach at most ${MAX_FILES} files.`);
      return;
    }

    setUploading(true);
    try {
      const { upload } = await import("@vercel/blob/client");
      const blob = await upload(file.name, file, {
        access: "public",
        handleUploadUrl: "/api/safety/incident/intake/attachments/token",
        contentType: file.type,
      });
      setFiles((previous) => [
        ...previous,
        {
          url: blob.url,
          pathname: blob.pathname,
          contentType: file.type,
          size: file.size,
          name: file.name,
        },
      ]);
    } catch (uploadError) {
      setUploadNote(
        uploadError instanceof Error
          ? `Could not attach ${file.name}: ${uploadError.message}`
          : `Could not attach ${file.name}.`,
      );
    } finally {
      setUploading(false);
    }
  }

  async function autofill() {
    if (form.narrative.trim().length < 10) {
      setAiNote("Write a sentence or two first.");
      return;
    }
    setAiNote("Reading your description…");
    try {
      const json = await fetch("/api/safety/incident/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ narrative: form.narrative }),
      }).then((response) => response.json());
      if (json.available && json.suggestion) {
        const suggestion = json.suggestion;
        setForm((previous) => {
          const nabhClass = clean(suggestion.nabhClass) || previous.nabhClass;
          const nearMissRaw =
            typeof suggestion.nearMiss === "boolean" ? suggestion.nearMiss : previous.nearMiss;
          const nearMiss = nabhClass ? nabhClass === "near_miss" : nearMissRaw;
          return {
            ...previous,
            primaryTypeId: suggestion.primaryTypeId || previous.primaryTypeId,
            nabhClass: nabhClass || (nearMiss ? "near_miss" : ""),
            careType: clean(suggestion.careType) || previous.careType,
            impactDomain: suggestion.impactDomain || previous.impactDomain,
            severity: suggestion.severity || previous.severity,
            nearMiss,
            departmentId: suggestion.departmentId || previous.departmentId,
            locationId: suggestion.locationId || previous.locationId,
            immediateAction: clean(suggestion.immediateAction) || previous.immediateAction,
          };
        });
        setAiNote(
          suggestion.followUpQuestion
            ? `Suggestions filled in below. One thing to add: ${suggestion.followUpQuestion}`
            : "Suggestions filled in below — please review and adjust.",
        );
      } else {
        setAiNote("AI assist isn’t available right now — please fill the details below.");
      }
    } catch {
      setAiNote("Couldn’t reach AI assist — fill the details below.");
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const when = (form.occurredAt || "").trim();
    if (!when) {
      setWhenErr("Please enter when the incident happened.");
      setError(null);
      return;
    }
    const whenDate = new Date(when);
    if (!Number.isFinite(whenDate.getTime())) {
      setWhenErr("That date and time could not be read — please re-enter it.");
      setError(null);
      return;
    }
    if (whenDate.getTime() > Date.now() + 60_000) {
      setWhenErr("An incident cannot have happened in the future — please check the date and time.");
      setError(null);
      return;
    }
    setWhenErr(null);

    if (!form.unitCode) {
      setUnitErr("Please choose the unit where this happened.");
      setError(null);
      return;
    }
    setUnitErr(null);
    setBusy(true);
    setError(null);

    try {
      const json = await fetch("/api/safety/incident/intake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          narrative: form.narrative,
          primaryTypeId: form.primaryTypeId || null,
          impactDomain: form.impactDomain || null,
          severity: form.severity || null,
          nearMiss: form.nearMiss,
          departmentId: form.departmentId || null,
          locationId: form.locationId || null,
          reporterRoleId: form.reporterRoleId || null,
          occurredAt: occurredAtForSubmit(form.occurredAt),
          immediateAction: clean(form.immediateAction) || null,
          nabhClass: form.nabhClass || null,
          careType: form.careType || null,
          probableReason: clean(form.probableReason) || null,
          unitCode: form.unitCode || null,
          attachments: files.map((attachment) => ({
            url: attachment.url,
            pathname: attachment.pathname,
            contentType: attachment.contentType,
            size: attachment.size,
          })),
          confidentiality: form.confidentiality,
          reporterName: form.confidentiality === "anonymous" ? null : form.reporterName,
          reporterContact: form.confidentiality === "confidential" ? form.reporterContact : null,
          phi: form.involvesPatient
            ? { name: form.pName, age: form.pAge, sex: form.pSex, uhid: form.pUhid }
            : null,
        }),
      }).then((response) => response.json());
      if (json.ok) {
        setResult({ id: json.id, displayNo: json.displayNo ?? null });
        setFiles([]);
      } else {
        setError(json.error || "Could not submit.");
      }
    } catch {
      setError("Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  function reportAnother() {
    const now = localNow();
    const next = initialForm(reporterName);
    setMaxWhen(now);
    setWhenErr(null);
    setUnitErr(null);
    setAiNote(null);
    setError(null);
    setResult(null);
    setForm({
      ...next,
      occurredAt: now,
      unitCode: meta?.units?.length === 1 ? meta.units[0].code : "",
    });
  }

  if (result) {
    return (
      <main style={styles.wrap}>
        <div style={styles.card}>
          <div style={styles.okDot}>✓</div>
          <h2 style={styles.h1}>Reported. Thank you.</h2>
          <p style={styles.sub}>Your incident reference is</p>
          <div style={styles.idBox}>{result.displayNo || result.id}</div>
          <p style={styles.foot}>
            Note it down if you may need to follow up. The safety team has been notified.
          </p>
          <a href="/safety#queue" style={styles.linkButton}>
            View in queue
          </a>
          <button type="button" style={styles.secondaryButton} onClick={reportAnother}>
            Report another
          </button>
        </div>
      </main>
    );
  }

  const clinical = meta?.types.filter((type) => type.category === "clinical") ?? [];
  const nonClinical = meta?.types.filter((type) => type.category === "non_clinical") ?? [];
  const activeUnits = meta?.units ?? [];

  return (
    <main style={styles.wrap}>
      <div style={styles.card}>
        <div style={styles.kicker}>Even Governance · Incident Reporting</div>
        <h2 style={styles.h1}>Tell us what happened</h2>
        <p style={styles.sub}>
          Anything that went wrong, nearly went wrong, or isn’t safe — clinical or not. Describe it
          in your own words.
        </p>

        <form onSubmit={submit}>
          <label style={styles.label}>
            When did it happen? <span style={styles.required}>*</span>
          </label>
          <input
            type="datetime-local"
            style={{ ...styles.input, ...(whenErr ? styles.inputBad : null) }}
            value={form.occurredAt}
            max={maxWhen || undefined}
            onChange={(event) => {
              set("occurredAt", event.target.value);
              if (whenErr) setWhenErr(null);
            }}
          />
          {whenErr && <div style={styles.fieldError}>{whenErr}</div>}

          <label style={styles.label}>
            Unit <span style={styles.required}>*</span>
          </label>
          {activeUnits.length === 1 ? (
            <input
              style={{ ...styles.input, background: "#f8fafc", color: "#475569" }}
              value={activeUnits[0].name}
              readOnly
            />
          ) : (
            <select
              style={{ ...styles.input, ...(unitErr ? styles.inputBad : null) }}
              value={form.unitCode}
              onChange={(event) => {
                set("unitCode", event.target.value);
                if (unitErr) setUnitErr(null);
              }}
            >
              <option value="">Select…</option>
              {activeUnits.map((unit) => (
                <option key={unit.code} value={unit.code}>
                  {unit.name}
                </option>
              ))}
            </select>
          )}
          {unitErr && <div style={styles.fieldError}>{unitErr}</div>}

          <label style={styles.label}>Location</label>
          <select
            style={styles.input}
            value={form.locationId}
            onChange={(event) => set("locationId", event.target.value)}
          >
            <option value="">Select…</option>
            {meta?.locations.map((location) => (
              <option key={location.id} value={location.id}>
                {location.name}
              </option>
            ))}
          </select>

          <label style={styles.label}>Classification</label>
          <select
            style={styles.input}
            value={form.nabhClass}
            onChange={(event) => setNabhClass(event.target.value)}
          >
            <option value="">Select…</option>
            {NABH.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>

          <label style={styles.label}>Clinical / Non-Clinical</label>
          <select
            style={styles.input}
            value={form.careType}
            onChange={(event) => set("careType", event.target.value)}
          >
            <option value="">Select…</option>
            {CARE.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>

          <label style={styles.label}>Category</label>
          <select
            style={styles.input}
            value={form.primaryTypeId}
            onChange={(event) => set("primaryTypeId", event.target.value)}
          >
            <option value="">Select…</option>
            <optgroup label="Clinical">
              {clinical.map((type) => (
                <option key={type.id} value={type.id}>
                  {type.name}
                </option>
              ))}
            </optgroup>
            <optgroup label="Non-clinical / operational">
              {nonClinical.map((type) => (
                <option key={type.id} value={type.id}>
                  {type.name}
                </option>
              ))}
            </optgroup>
          </select>

          <label style={styles.label}>Incident Description (what happened?)</label>
          <textarea
            style={{ ...styles.input, minHeight: 120, resize: "vertical" }}
            value={form.narrative}
            onChange={(event) => set("narrative", event.target.value)}
            placeholder="Describe what happened, where, and who or what was involved…"
          />
          <button type="button" style={styles.ghost} onClick={autofill}>
            ✨ Auto-fill details from my description
          </button>
          {aiNote && <div style={styles.note}>{aiNote}</div>}

          <label style={styles.label}>Immediate action taken (if any)</label>
          <textarea
            style={{ ...styles.input, minHeight: 60, resize: "vertical" }}
            value={form.immediateAction}
            onChange={(event) => set("immediateAction", event.target.value)}
            placeholder="What was done right away?"
          />

          <label style={styles.label}>Probable reason for the incident</label>
          <div style={styles.help}>
            Your own view of what may have caused this — this is not treated as the final cause.
          </div>
          <textarea
            style={{ ...styles.input, minHeight: 60, resize: "vertical" }}
            value={form.probableReason}
            onChange={(event) => set("probableReason", event.target.value)}
            placeholder="What do you think led to this?"
          />

          {uploadsEnabled && (
            <>
              <label style={styles.label}>Photos or documents (optional)</label>
              <div style={styles.help}>
                Up to {MAX_FILES} files, {MAX_MB} MB each. JPEG, PNG, WEBP, HEIC or PDF.
              </div>
              {files.length > 0 && (
                <div style={styles.fileList}>
                  {files.map((attachment, index) => (
                    <div key={attachment.url} style={styles.fileRow}>
                      <span style={styles.fileName}>{attachment.name}</span>
                      <span style={styles.fileSize}>
                        {Math.max(1, Math.round(attachment.size / 1024))} KB
                      </span>
                      <button
                        type="button"
                        style={styles.fileRemove}
                        onClick={() =>
                          setFiles((previous) => previous.filter((_, itemIndex) => itemIndex !== index))
                        }
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {files.length < MAX_FILES && (
                <input
                  type="file"
                  style={{ ...styles.input, padding: 9 }}
                  disabled={uploading}
                  accept="image/jpeg,image/png,image/webp,image/heic,application/pdf"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (file) addFile(file);
                  }}
                />
              )}
              {uploadNote && <div style={styles.note}>{uploadNote}</div>}
            </>
          )}

          <div style={styles.divider} />
          <div style={styles.sectionHeading}>Additional detail (optional)</div>
          <div style={styles.sectionSubheading}>
            Helpful if you know it — the safety team can fill these in later.
          </div>

          <label style={styles.checkRow}>
            <input
              type="checkbox"
              checked={form.nearMiss}
              onChange={(event) => setNearMiss(event.target.checked)}
            />{" "}
            This was a near miss (caught before it reached anyone)
          </label>

          <div style={styles.row}>
            <div style={styles.column}>
              <label style={styles.label}>Who / what was affected?</label>
              <select
                style={styles.input}
                value={form.impactDomain}
                onChange={(event) => set("impactDomain", event.target.value)}
              >
                <option value="">Select…</option>
                {IMPACT.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div style={styles.column}>
              <label style={styles.label}>How serious?</label>
              <select
                style={styles.input}
                value={form.severity}
                onChange={(event) => set("severity", event.target.value)}
              >
                <option value="">Select…</option>
                {SEVERITY.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div style={styles.row}>
            <div style={styles.column}>
              <label style={styles.label}>Department</label>
              <select
                style={styles.input}
                value={form.departmentId}
                onChange={(event) => set("departmentId", event.target.value)}
              >
                <option value="">Select…</option>
                {meta?.departments.map((department) => (
                  <option key={department.id} value={department.id}>
                    {department.name}
                  </option>
                ))}
              </select>
            </div>
            <div style={styles.column}>
              <label style={styles.label}>Your role</label>
              <select
                style={styles.input}
                value={form.reporterRoleId}
                onChange={(event) => set("reporterRoleId", event.target.value)}
              >
                <option value="">Select…</option>
                {meta?.roles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <label style={styles.checkRow}>
            <input
              type="checkbox"
              checked={form.involvesPatient}
              onChange={(event) => set("involvesPatient", event.target.checked)}
            />{" "}
            This involves a specific patient
          </label>
          {form.involvesPatient && (
            <div style={styles.row}>
              <div style={styles.column}>
                <input
                  style={styles.input}
                  placeholder="Patient name"
                  value={form.pName}
                  onChange={(event) => set("pName", event.target.value)}
                />
              </div>
              <div style={styles.column}>
                <input
                  style={styles.input}
                  placeholder="UHID"
                  value={form.pUhid}
                  onChange={(event) => set("pUhid", event.target.value)}
                />
              </div>
              <div style={styles.column}>
                <input
                  style={styles.input}
                  placeholder="Age"
                  inputMode="numeric"
                  value={form.pAge}
                  onChange={(event) => set("pAge", event.target.value)}
                />
              </div>
              <div style={styles.column}>
                <select
                  style={styles.input}
                  value={form.pSex}
                  onChange={(event) => set("pSex", event.target.value)}
                >
                  <option value="">Sex</option>
                  <option value="M">M</option>
                  <option value="F">F</option>
                  <option value="O">Other</option>
                </select>
              </div>
            </div>
          )}

          <div style={styles.identityBlock}>
            <label style={styles.label}>How would you like to report?</label>
            {[
              ["named", "With my name"],
              ["confidential", "Confidentially (only the safety lead sees who I am)"],
              ["anonymous", "Anonymously"],
            ].map(([value, label]) => (
              <label key={value} style={styles.radioRow}>
                <input
                  type="radio"
                  name="confidentiality"
                  checked={form.confidentiality === value}
                  onChange={() => set("confidentiality", value)}
                />{" "}
                {label}
              </label>
            ))}
            {form.confidentiality !== "anonymous" && (
              <input
                style={styles.input}
                placeholder="Your name"
                value={form.reporterName}
                onChange={(event) => set("reporterName", event.target.value)}
              />
            )}
            {form.confidentiality === "confidential" && (
              <input
                style={{ ...styles.input, marginTop: 8 }}
                placeholder="Phone or email (safety lead only)"
                value={form.reporterContact}
                onChange={(event) => set("reporterContact", event.target.value)}
              />
            )}
            {form.confidentiality === "named" && reporterEmail && (
              <div style={styles.prefillNote}>Signed in as {reporterEmail}</div>
            )}
          </div>

          {error && <div style={styles.error}>{error}</div>}
          <button style={{ ...styles.button, opacity: busy ? 0.6 : 1 }} disabled={busy || uploading}>
            {busy ? "Submitting…" : uploading ? "Finishing attachment…" : "Submit report"}
          </button>
        </form>
      </div>
    </main>
  );
}

const styles: Record<string, CSSProperties> = {
  wrap: { padding: "8px 0 32px", display: "flex", justifyContent: "center" },
  card: {
    width: "100%",
    maxWidth: 680,
    background: "#fff",
    border: "1px solid #e6eaf0",
    borderRadius: 16,
    padding: "30px 28px",
    boxShadow: "0 8px 30px rgba(15,23,42,.06)",
  },
  kicker: {
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: ".04em",
    textTransform: "uppercase",
    color: "#0f766e",
  },
  h1: { fontSize: 24, fontWeight: 700, margin: "6px 0 4px", color: "#0f172a" },
  sub: { color: "#475569", fontSize: 15, lineHeight: 1.5, marginBottom: 14 },
  label: { display: "block", fontSize: 13, fontWeight: 600, color: "#334155", margin: "14px 0 6px" },
  required: { color: "#dc2626", fontWeight: 700 },
  input: {
    width: "100%",
    padding: "11px 12px",
    fontSize: 15,
    border: "1px solid #cbd5e1",
    borderRadius: 10,
    outline: "none",
    boxSizing: "border-box",
    background: "#fff",
  },
  inputBad: { borderColor: "#fca5a5", background: "#fef2f2" },
  fieldError: { marginTop: 6, fontSize: 13, color: "#dc2626", lineHeight: 1.45 },
  row: { display: "flex", gap: 10, flexWrap: "wrap" },
  column: { flex: "1 1 45%", minWidth: 130 },
  checkRow: { display: "flex", alignItems: "center", gap: 8, fontSize: 14, color: "#334155", margin: "14px 0 2px" },
  radioRow: { display: "flex", alignItems: "center", gap: 8, fontSize: 14, color: "#334155", margin: "8px 0" },
  identityBlock: { marginTop: 18, padding: 14, background: "#f8fafc", border: "1px solid #e6eaf0", borderRadius: 12 },
  ghost: { marginTop: 8, padding: "8px 12px", fontSize: 13, fontWeight: 600, color: "#2b5191", background: "#eef2fb", border: "1px solid #dbe4f5", borderRadius: 9, cursor: "pointer" },
  note: { marginTop: 8, fontSize: 13, color: "#64748b" },
  help: { fontSize: 12.5, color: "#64748b", lineHeight: 1.45, margin: "-2px 0 6px" },
  divider: { height: 1, background: "#e6eaf0", margin: "26px 0 16px" },
  sectionHeading: { fontSize: 12, fontWeight: 700, letterSpacing: ".04em", textTransform: "uppercase", color: "#94a3b8" },
  sectionSubheading: { fontSize: 12.5, color: "#94a3b8", lineHeight: 1.45, marginTop: 3 },
  fileList: { display: "flex", flexDirection: "column", gap: 6, marginBottom: 8 },
  fileRow: { display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", background: "#f8fafc", border: "1px solid #e6eaf0", borderRadius: 9, fontSize: 13 },
  fileName: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#334155" },
  fileSize: { color: "#94a3b8", fontSize: 12, whiteSpace: "nowrap" },
  fileRemove: { border: "none", background: "none", color: "#dc2626", fontSize: 12.5, fontWeight: 600, cursor: "pointer", padding: 0 },
  button: { width: "100%", marginTop: 18, padding: "14px", fontSize: 16, fontWeight: 600, color: "#fff", background: "#173b63", border: "none", borderRadius: 10, cursor: "pointer" },
  secondaryButton: { width: "100%", marginTop: 10, padding: "12px", fontSize: 15, fontWeight: 600, color: "#334155", background: "#fff", border: "1px solid #cbd5e1", borderRadius: 10, cursor: "pointer" },
  linkButton: { display: "block", width: "100%", boxSizing: "border-box", marginTop: 18, padding: "14px", fontSize: 16, fontWeight: 600, color: "#fff", background: "#0f766e", borderRadius: 10, textAlign: "center", textDecoration: "none" },
  error: { marginTop: 12, color: "#dc2626", fontSize: 14 },
  okDot: { width: 44, height: 44, borderRadius: 22, background: "#16a34a", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24, marginBottom: 6 },
  idBox: { fontFamily: "ui-monospace, Menlo, monospace", fontSize: 20, fontWeight: 700, color: "#0f172a", background: "#f1f5f9", borderRadius: 10, padding: "12px 14px", textAlign: "center", letterSpacing: ".02em" },
  foot: { marginTop: 14, color: "#64748b", fontSize: 12.5, lineHeight: 1.5 },
  prefillNote: { marginTop: 7, color: "#94a3b8", fontSize: 12 },
};
