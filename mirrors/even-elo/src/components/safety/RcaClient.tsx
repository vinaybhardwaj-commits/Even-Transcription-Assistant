"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";

type Factor = { category: string; note: string };
type Capa = { action: string; controlLevel: string };

const CATS = ["people", "task", "equipment", "environment", "organisation"];
const CONTROLS: [string, string][] = [
  ["elimination", "Elimination (strongest)"], ["substitution", "Substitution"], ["engineering", "Engineering control"],
  ["administrative", "Administrative / SOP"], ["ppe", "PPE"], ["training", "Training / awareness (weakest)"],
];
const WEAK = new Set(["ppe", "training"]);

export default function RcaWorkspace() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [inc, setInc] = useState<Record<string, unknown> | null>(null);
  const [aiNote, setAiNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [factors, setFactors] = useState<Factor[]>([]);
  const [whys, setWhys] = useState<string[]>([]);
  const [rootCause, setRootCause] = useState("");
  const [corrective, setCorrective] = useState<Capa[]>([]);
  const [preventive, setPreventive] = useState<Capa[]>([]);
  const [ncc, setNcc] = useState("");
  const [author, setAuthor] = useState("");

  useEffect(() => {
    fetch(`/api/safety/office/incidents/${id}`).then((r) => r.json()).then((j) => { if (j.ok) setInc(j.incident); });
  }, [id]);

  async function analyze() {
    setBusy(true); setAiNote("Analysing the incident…"); setError(null);
    try {
      const r = await fetch(`/api/safety/office/incidents/${id}/rca/suggest`, { method: "POST" });
      let j: Record<string, any> = {};
      try { j = await r.json(); } catch { throw new Error(`suggest ${r.status}`); }
      if (!r.ok) { setAiNote(`AI analysis failed (${r.status}${j.error ? `: ${j.error}` : ""}) — try again or fill in manually.`); return; }
      if (j.available && j.suggestion) {
        const s = j.suggestion;
        setFactors(s.contributoryFactors?.length ? s.contributoryFactors : factors);
        setWhys(s.fiveWhys?.length ? s.fiveWhys : whys);
        setRootCause(s.rootCause || rootCause);
        setCorrective(s.correctiveActions?.length ? s.correctiveActions : corrective);
        setPreventive(s.preventiveActions?.length ? s.preventiveActions : preventive);
        setNcc(s.nccMerp || ncc);
        setAiNote("Draft filled in — review, edit, and strengthen the actions before saving.");
      } else setAiNote("AI analysis unavailable — fill it in manually.");
    } catch { setAiNote("Couldn’t run AI analysis — fill it in manually."); }
    finally { setBusy(false); }
  }

  async function save() {
    if (!rootCause.trim()) { setError("Add a root cause before saving."); return; }
    setSaving(true); setError(null);
    try {
      const j = await fetch(`/api/safety/office/incidents/${id}/rca`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: "5_whys", rootCause, contributoryFactors: factors, fiveWhys: whys, corrective, preventive, nccMerp: ncc || null, authorName: author }),
      }).then((r) => r.json());
      if (j.ok) router.push(`/safety/incidents/${id}`);
      else setError(j.error || "Could not save.");
    } catch { setError("Something went wrong."); }
    finally { setSaving(false); }
  }

  const upd = <T,>(arr: T[], set: (v: T[]) => void, i: number, v: T) => set(arr.map((x, j) => (j === i ? v : x)));
  const del = <T,>(arr: T[], set: (v: T[]) => void, i: number) => set(arr.filter((_, j) => j !== i));

  const CapaList = ({ list, set, label }: { list: Capa[]; set: (v: Capa[]) => void; label: string }) => (
    <section style={S.card}>
      <div style={S.flabel}>{label}</div>
      {list.map((c, i) => (
        <div key={i} style={S.capaRow}>
          <input style={S.input} value={c.action} placeholder="Action…" onChange={(e) => upd(list, set, i, { ...c, action: e.target.value })} />
          <select style={{ ...S.sel, borderColor: WEAK.has(c.controlLevel) ? "#f59e0b" : "#cbd5e1" }} value={c.controlLevel} onChange={(e) => upd(list, set, i, { ...c, controlLevel: e.target.value })}>
            {CONTROLS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <button style={S.x} onClick={() => del(list, set, i)}>✕</button>
          {WEAK.has(c.controlLevel) && <div style={S.weak}>⚠ Low-durability control — pair it with a stronger one.</div>}
        </div>
      ))}
      <button style={S.add} onClick={() => set([...list, { action: "", controlLevel: "administrative" }])}>+ Add</button>
    </section>
  );

  return (
    <main style={S.wrap}>
      <a href={`/safety/incidents/${id}`} style={S.back}>← {id}</a>
      <h1 style={S.h1}>Guided root cause analysis</h1>
      {inc && <p style={S.sub}>{String(inc.narrative || "")}</p>}

      <button style={S.aiBtn} onClick={analyze} disabled={busy}>{busy ? "Analysing…" : "✨ Analyse with AI"}</button>
      {aiNote && <div style={S.aiNote}>{aiNote}</div>}

      <section style={S.card}>
        <div style={S.flabel}>Contributory factors (systems)</div>
        {factors.map((f, i) => (
          <div key={i} style={S.facRow}>
            <select style={S.selSm} value={f.category} onChange={(e) => upd(factors, setFactors, i, { ...f, category: e.target.value })}>
              {CATS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <input style={S.input} value={f.note} placeholder="Factor…" onChange={(e) => upd(factors, setFactors, i, { ...f, note: e.target.value })} />
            <button style={S.x} onClick={() => del(factors, setFactors, i)}>✕</button>
          </div>
        ))}
        <button style={S.add} onClick={() => setFactors([...factors, { category: "task", note: "" }])}>+ Add factor</button>
      </section>

      <section style={S.card}>
        <div style={S.flabel}>5 Whys</div>
        {whys.map((w, i) => (
          <div key={i} style={S.facRow}>
            <span style={S.whyN}>{i + 1}</span>
            <input style={S.input} value={w} placeholder="Why…" onChange={(e) => upd(whys, setWhys, i, e.target.value)} />
            <button style={S.x} onClick={() => del(whys, setWhys, i)}>✕</button>
          </div>
        ))}
        <button style={S.add} onClick={() => setWhys([...whys, ""])}>+ Add why</button>
      </section>

      <section style={S.card}>
        <div style={S.flabel}>Root cause (systems statement)</div>
        <textarea style={{ ...S.input, minHeight: 70, resize: "vertical" }} value={rootCause} onChange={(e) => setRootCause(e.target.value)} placeholder="The system/process failure that allowed this — not who erred." />
      </section>

      <CapaList list={corrective} set={setCorrective} label="Corrective actions (fix the immediate problem)" />
      <CapaList list={preventive} set={setPreventive} label="Preventive actions (stop recurrence)" />

      <section style={S.card}>
        <div style={S.row}>
          <div style={S.col}><div style={S.flabel}>NCC-MERP (medication only)</div>
            <select style={S.sel} value={ncc} onChange={(e) => setNcc(e.target.value)}>
              <option value="">n/a</option>{["A", "B", "C", "D", "E", "F", "G", "H", "I"].map((x) => <option key={x} value={x}>{x}</option>)}
            </select></div>
          <div style={S.col}><div style={S.flabel}>Your name</div>
            <input style={S.input} value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="RCA author" /></div>
        </div>
      </section>

      {error && <div style={S.err}>{error}</div>}
      <button style={{ ...S.save, opacity: saving ? 0.6 : 1 }} onClick={save} disabled={saving}>{saving ? "Saving…" : "Save RCA & CAPAs"}</button>
    </main>
  );
}

const S: Record<string, React.CSSProperties> = {
  wrap: { maxWidth: 760, margin: "0 auto", padding: "24px 20px 60px", color: "#0f172a" },
  back: { display: "inline-block", color: "#2b5191", fontSize: 13, textDecoration: "none", marginBottom: 10, fontFamily: "ui-monospace, Menlo, monospace" },
  h1: { fontSize: 24, margin: "2px 0 6px" },
  sub: { color: "#64748b", fontSize: 14, lineHeight: 1.5, marginBottom: 14 },
  aiBtn: { padding: "10px 16px", fontSize: 14, fontWeight: 600, color: "#fff", background: "#7c3aed", border: "none", borderRadius: 10, cursor: "pointer" },
  aiNote: { marginTop: 8, fontSize: 13.5, color: "#64748b" },
  card: { background: "#fff", border: "1px solid #e6eaf0", borderRadius: 12, padding: "14px 16px", margin: "14px 0" },
  flabel: { fontSize: 12, fontWeight: 700, letterSpacing: ".03em", textTransform: "uppercase", color: "#94a3b8", marginBottom: 8 },
  input: { flex: "1 1 auto", padding: "9px 11px", fontSize: 14, border: "1px solid #cbd5e1", borderRadius: 9, boxSizing: "border-box", width: "100%" },
  sel: { padding: "9px 11px", fontSize: 14, border: "1px solid #cbd5e1", borderRadius: 9, background: "#fff" },
  selSm: { padding: "9px 8px", fontSize: 13, border: "1px solid #cbd5e1", borderRadius: 9, background: "#fff", flex: "0 0 120px" },
  facRow: { display: "flex", gap: 8, alignItems: "center", marginBottom: 8 },
  capaRow: { display: "flex", gap: 8, alignItems: "center", marginBottom: 8, flexWrap: "wrap" },
  whyN: { width: 22, height: 22, borderRadius: 11, background: "#ede9fe", color: "#6d28d9", fontSize: 12, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", flex: "0 0 22px" },
  x: { flex: "0 0 auto", border: "none", background: "transparent", color: "#94a3b8", cursor: "pointer", fontSize: 14 },
  weak: { flexBasis: "100%", fontSize: 12, color: "#b45309" },
  add: { marginTop: 4, padding: "6px 10px", fontSize: 13, fontWeight: 600, color: "#2b5191", background: "#eef2fb", border: "1px solid #dbe4f5", borderRadius: 8, cursor: "pointer" },
  row: { display: "flex", gap: 12, flexWrap: "wrap" },
  col: { flex: "1 1 200px" },
  save: { width: "100%", marginTop: 16, padding: "14px", fontSize: 16, fontWeight: 600, color: "#fff", background: "#16a34a", border: "none", borderRadius: 10, cursor: "pointer" },
  err: { color: "#dc2626", fontSize: 14, marginTop: 10 },
};
