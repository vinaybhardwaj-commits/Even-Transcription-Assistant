"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Editor } from "@tiptap/react";
import NoteEditor from "@/components/notegen/NoteEditor";
import { computeCoverage, type Coverage, type FloorField } from "@/lib/notegen/coverage";
import { Sparkles, Check, X, ChevronUp, Shield, AlertCircle } from "lucide-react";

// EvenScribe note types available to the typed editor. Coverage lights up only for
// types with a NABH floor (operative_procedure today; discharge/Rx land in P3).
const NOTE_TYPES = [
  { key: "clinic_encounter", label: "Consult" },
  { key: "general_medical", label: "Ward" },
  { key: "operative_procedure", label: "Op note" },
  { key: "dietetic_consult", label: "Dietetics" },
  { key: "physiotherapy", label: "Physio" },
];

type SaveState = "idle" | "saving" | "saved" | "error";

// R7 throttle: responsive but never fires the LLM on every keystroke.
const A_DEBOUNCE = 450;
const A_MIN_INTERVAL = 2500;
const A_MIN_DELTA = 6;
const A_IDLE_CATCHUP = 1300;
const A_TAIL = 800;

export default function NoteComposerClient({ slug }: { slug: string }) {
  const router = useRouter();
  const [noteType, setNoteType] = useState("operative_procedure");
  const [patient, setPatient] = useState("");
  const [text, setText] = useState("");
  const [save, setSave] = useState<SaveState>("idle");
  const [floor, setFloor] = useState<FloorField[]>([]);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [chips, setChips] = useState<string[]>([]);
  const [rewrites, setRewrites] = useState<{ from: string; to: string }[]>([]);
  const [thinking, setThinking] = useState(false);
  const [busy, setBusy] = useState(false);

  const words = useMemo(() => (text.trim() ? text.trim().split(/\s+/).length : 0), [text]);
  const current = NOTE_TYPES.find((n) => n.key === noteType)!;
  const coverage = useMemo<Coverage>(() => computeCoverage(floor, text), [floor, text]);
  const gaps = coverage.total - coverage.covered;
  const needed = coverage.items.filter((i) => !i.covered);
  const have = coverage.items.filter((i) => i.covered);

  const encIdRef = useRef<string>("");
  const textRef = useRef<string>("");
  const noteTypeRef = useRef<string>(noteType); noteTypeRef.current = noteType;
  const patientRef = useRef<string>(patient); patientRef.current = patient;
  const coverageRef = useRef<Coverage>(coverage); coverageRef.current = coverage;
  const editorRef = useRef<Editor | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const analyzeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const analyzeCtrl = useRef<AbortController | null>(null);
  const lastAnalyzed = useRef<string>("");
  const lastAnalyzeAt = useRef<number>(0);

  const api = useCallback(
    (path: string, init?: RequestInit) =>
      fetch(`/${slug}${path}`, { ...init, headers: { "content-type": "application/json", ...(init?.headers || {}) } }),
    [slug],
  );

  // Load the NABH floor for the chosen note type (drives the coverage stream).
  useEffect(() => {
    let cancelled = false;
    api(`/api/notegen/nabh-requirements?note_type=${noteType}`).then((r) => r.json())
      .then((j) => { if (!cancelled) setFloor((j.fields || []) as FloorField[]); }).catch(() => {});
    return () => { cancelled = true; };
  }, [noteType, api]);

  // Lazily create the draft encounter on first real edit (no orphan empties).
  const ensureEncounter = useCallback(async (): Promise<string> => {
    if (encIdRef.current) return encIdRef.current;
    const r = await api("/api/encounters", { method: "POST", body: JSON.stringify({ note_type: noteTypeRef.current, patient_label: patientRef.current || undefined }) });
    const j = await r.json().catch(() => ({}));
    encIdRef.current = j?.data?.encounter?.id || j?.encounter?.id || "";
    return encIdRef.current;
  }, [api]);

  const flushSave = useCallback(async () => {
    if (!textRef.current.trim()) return;
    setSave("saving");
    try {
      const id = await ensureEncounter();
      if (!id) { setSave("error"); return; }
      const r = await api(`/api/encounters/${id}/editor`, { method: "PUT", body: JSON.stringify({ editor_text: textRef.current }) });
      setSave(r.ok ? "saved" : "error");
    } catch { setSave("error"); }
  }, [api, ensureEncounter]);

  const runAnalyze = useCallback(async () => {
    const t = textRef.current.trim();
    lastAnalyzed.current = t;
    lastAnalyzeAt.current = Date.now();
    analyzeCtrl.current?.abort();
    const ctrl = new AbortController(); analyzeCtrl.current = ctrl; setThinking(true);
    try {
      const gapLabels = coverageRef.current.items.filter((i) => !i.covered).map((i) => i.label);
      const r = await api("/api/notegen/analyze", { method: "POST", body: JSON.stringify({ text: t.slice(-A_TAIL), note_type: noteTypeRef.current, gaps: gapLabels }), signal: ctrl.signal });
      const j = await r.json();
      if (ctrl.signal.aborted) return;
      setChips(Array.isArray(j.chips) ? j.chips : []);
      const rw = Array.isArray(j.rewrites) ? j.rewrites : [];
      setRewrites(rw);
      if (editorRef.current) editorRef.current.commands.setRewrites(rw);
      if (j.inline && editorRef.current) editorRef.current.commands.setSuggestion(" " + String(j.inline).trim());
    } catch { /* aborted */ } finally { if (!ctrl.signal.aborted) setThinking(false); }
  }, [api]);

  const scheduleAnalyze = useCallback((delay: number) => {
    if (analyzeTimer.current) clearTimeout(analyzeTimer.current);
    analyzeTimer.current = setTimeout(function tick() {
      if (typeof document !== "undefined" && document.hidden) { scheduleAnalyze(A_IDLE_CATCHUP); return; }
      if (typeof navigator !== "undefined" && navigator.onLine === false) { scheduleAnalyze(A_IDLE_CATCHUP); return; }
      const full = textRef.current.trim();
      if (full.length < 8) { setChips([]); return; }
      if (full === lastAnalyzed.current) return;
      const sinceCall = Date.now() - lastAnalyzeAt.current;
      if (sinceCall < A_MIN_INTERVAL) { scheduleAnalyze(A_MIN_INTERVAL - sinceCall); return; }
      const newChars = Math.abs(full.length - lastAnalyzed.current.length);
      const boundary = /[.\n:;,]\s*$/.test(textRef.current);
      if (newChars < A_MIN_DELTA && !boundary && full.length > 40) { scheduleAnalyze(A_IDLE_CATCHUP); return; }
      runAnalyze();
    }, delay);
  }, [runAnalyze]);

  const onEditorChange = useCallback((t: string) => {
    setText(t); textRef.current = t;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSave("saving"); saveTimer.current = setTimeout(flushSave, 800);
    setChips([]); setRewrites([]);
    scheduleAnalyze(A_DEBOUNCE);
  }, [flushSave, scheduleAnalyze]);

  const handleReady = useCallback((ed: Editor) => { editorRef.current = ed; }, []);

  function applyChip(c: string) {
    const ed = editorRef.current; if (!ed) return;
    const lead = textRef.current && !/\s$/.test(textRef.current) ? " " : "";
    ed.chain().focus().insertContent(lead + c).run(); setChips([]);
  }
  function acceptRewrite(r: { from: string; to: string }) {
    const ed = editorRef.current;
    if (ed) ed.chain().focus().acceptRewrite(r.from, r.to).run();
    if (encIdRef.current) api(`/api/encounters/${encIdRef.current}/editor`, { method: "PUT", body: JSON.stringify({ editor_text: editorRef.current?.getText() ?? textRef.current, expansion: { from: r.from, to: r.to } }) }).catch(() => {});
    setRewrites([]);
  }
  function dismissRewrite(r: { from: string; to: string }) {
    const rest = rewrites.filter((x) => x.from !== r.from || x.to !== r.to);
    setRewrites(rest); if (editorRef.current) editorRef.current.commands.setRewrites(rest);
  }
  function pickNoteType(key: string) {
    setNoteType(key); lastAnalyzed.current = ""; setChips([]); setRewrites([]);
  }

  // "Done" — hand the typed text to the SAME pipeline audio uses, then go to review.
  async function done() {
    const ed = editorRef.current; if (!ed) return;
    const t = ed.getText().trim(); if (t.length < 2) return;
    setBusy(true);
    try {
      const id = await ensureEncounter();
      if (!id) { setBusy(false); return; }
      const r = await api(`/api/encounters/${id}/finalize-text`, { method: "POST", body: JSON.stringify({ text: t }) });
      if (r.ok) { router.push(`/${slug}/encounter/${id}`); return; }
      setBusy(false);
    } catch { setBusy(false); }
  }

  const saveLabel = save === "saving" ? "saving…" : save === "saved" ? "saved" : save === "error" ? "save failed" : "";
  const pillFull = coverage.total > 0 && coverage.covered >= coverage.total;
  const canAct = words >= 2 && !busy;

  return (
    <div className="notegen-root">
      <header className="mng-header">
        <span className="mng-title">Type a note</span>
        <span className={"mng-pill" + (pillFull ? " ok" : "")}>
          <Shield size={14} /> NABH {floor.length ? `${coverage.covered}/${coverage.total}` : "—"}
        </span>
      </header>

      <div className="mng-slider" role="tablist" aria-label="Note type">
        {NOTE_TYPES.map((n) => (
          <button key={n.key} role="tab" aria-selected={noteType === n.key}
            className={"mng-seg" + (noteType === n.key ? " on" : "")} onClick={() => pickNoteType(n.key)}>{n.label}</button>
        ))}
      </div>

      <div className="mng-patient">
        <input value={patient} onChange={(e) => setPatient(e.target.value)} placeholder="Patient (name / UHID — optional)" aria-label="Patient label" />
      </div>

      <main className="mng-editorwrap">
        <div className="mng-editor-label">{current.label} · you are the author{thinking ? " · thinking…" : ""}</div>
        <NoteEditor onChange={onEditorChange} onReady={handleReady} />
      </main>

      <button className="mng-assistant-handle" onClick={() => setSheetOpen(true)} aria-label="Open assistant">
        <span><Sparkles size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />Assistant · {floor.length ? `${gaps} gap${gaps === 1 ? "" : "s"}` : "live nudges"}{rewrites.length ? ` · ${rewrites.length} rewrite${rewrites.length === 1 ? "" : "s"}` : ""}</span>
        <ChevronUp size={16} />
      </button>

      {rewrites.length > 0 && (
        <div className="mng-rwbar">
          <Sparkles size={16} className="mng-ai" />
          {rewrites.map((r, i) => (
            <span key={i} className="mng-rwpill">
              <span style={{ textDecoration: "line-through", color: "var(--mng-muted)" }}>{r.from}</span>
              <span className="arrow">→</span> {r.to}
              <button className="mng-rwbtn ok" onClick={() => acceptRewrite(r)} aria-label="Accept"><Check size={15} /></button>
              <button className="mng-rwbtn no" onClick={() => dismissRewrite(r)} aria-label="Dismiss"><X size={15} /></button>
            </span>
          ))}
        </div>
      )}

      {chips.length > 0 && (
        <div className="mng-sugbar">
          <Sparkles size={16} className="mng-ai" />
          {chips.map((c, i) => (<button key={i} className="mng-chip" onClick={() => applyChip(c)}>{c}</button>))}
        </div>
      )}

      <div className="mng-actionbar">
        <button className="mng-primary" disabled={!canAct} onClick={done}>{busy ? "Generating…" : "Done — generate note"}</button>
      </div>
      <div className="mng-foot">{words} words{saveLabel && ` · ${saveLabel}`}</div>

      {sheetOpen && (
        <div className="mng-scrim" onClick={() => setSheetOpen(false)}>
          <div className="mng-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="mng-sheet-head">
              <span>Vital info · NABH <b>{coverage.covered}/{coverage.total}</b></span>
              <button className="mng-sheet-x" onClick={() => setSheetOpen(false)} aria-label="Close"><X size={18} /></button>
            </div>
            <div className="mng-sheet-body">
              {needed.length > 0 && <div className="mng-sheet-section">Needed ({needed.length})</div>}
              {needed.map((i) => (<div key={i.field_key} className="mng-cov-row need"><AlertCircle size={16} /> {i.label}</div>))}
              {have.length > 0 && <div className="mng-sheet-section">Covered ({have.length})</div>}
              {have.map((i) => (<div key={i.field_key} className="mng-cov-row has"><Check size={16} /> {i.label}</div>))}
              {coverage.total === 0 && <div className="mng-cov-row has">Start writing — NABH items light up as you cover them.</div>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
