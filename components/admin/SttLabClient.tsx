"use client";

/**
 * SttLabClient — STT Engine Lab (L0: Health tab).
 * Lists every registered engine with a live health probe, capabilities, and
 * its enabled / fan-out / cost flags. Later phases add Leaderboard / Runs /
 * Gold set / Routing / Engines tabs alongside Health.
 */
import * as React from "react";
import { Button } from "@/components/ui/Button";

type Capabilities = {
  tiers?: string[]; stages?: string[]; languages?: string[];
  streaming?: boolean; translates?: boolean; async?: boolean;
};
type EngineHealth = { ok: boolean; latencyMs: number; error?: string };
type EngineRow = {
  id: string; display_name: string; adapter_key: string;
  enabled: boolean; fanout_enabled: boolean; is_paid: boolean;
  cost_per_min_usd: number | null; capabilities: Capabilities;
  has_adapter: boolean; health: EngineHealth;
};
type Bundle = { engines: EngineRow[]; checked_at: string };

const TABS = ["Health", "Leaderboard", "Runs", "Gold set", "Routing", "Engines"] as const;

export function SttLabClient() {
  const [data, setData] = React.useState<Bundle | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [tab, setTab] = React.useState<(typeof TABS)[number]>("Health");

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/stt-lab/health", { cache: "no-store" });
      const j = await res.json();
      if (!res.ok) throw new Error((j as { error?: { message?: string } }).error?.message ?? `http_${res.status}`);
      setData(j as Bundle);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }, []);
  React.useEffect(() => { void load(); }, [load]);

  const dot = (h: EngineHealth, hasAdapter: boolean) => {
    const color = !hasAdapter ? "bg-even-ink-300" : h.ok ? "bg-success-500" : "bg-danger-500";
    return <span className={`inline-block w-2.5 h-2.5 rounded-full ${color}`} />;
  };
  const caps = (c: Capabilities) => {
    const parts: string[] = [];
    if (c.tiers?.length) parts.push(c.tiers.join("+"));
    if (c.languages?.length) parts.push(c.languages.join("/"));
    if (c.streaming) parts.push("streaming");
    if (c.translates) parts.push("translate");
    if (c.async) parts.push("async");
    return parts.join(" · ");
  };

  return (
    <div className="space-y-6">
      {/* Tabs */}
      <div className="flex gap-1 border-b border-even-ink-100">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-2 text-label rounded-t-md ${
              tab === t ? "text-even-navy-800 border-b-2 border-even-blue-600 font-semibold" : "text-even-ink-500 hover:text-even-navy-800"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "Gold set" ? (
        <GoldTab />
      ) : tab !== "Health" ? (
        <div className="rounded-xl border border-even-ink-100 bg-even-white p-8 text-center text-body text-even-ink-400">
          {tab} — coming in a later sprint.
        </div>
      ) : (
        <section className="rounded-xl border border-even-ink-100 bg-even-white p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-label text-even-navy-800">Engine health</h3>
              <p className="text-caption text-even-ink-500">
                {data ? `Checked ${new Date(data.checked_at).toLocaleTimeString()}` : "Probing engines…"}
              </p>
            </div>
            <button onClick={() => void load()} disabled={loading} className="text-caption text-even-blue-600 hover:underline disabled:opacity-50">
              {loading ? "Checking…" : "↻ Re-check"}
            </button>
          </div>

          {error ? (
            <p className="text-body text-danger-700">Could not load: {error}</p>
          ) : !data ? (
            <p className="text-body text-even-ink-400">Loading…</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-body">
                <thead>
                  <tr className="text-caption text-even-ink-500 text-left border-b border-even-ink-100">
                    <th className="py-2 pr-3">Status</th>
                    <th className="py-2 pr-3">Engine</th>
                    <th className="py-2 pr-3">Capabilities</th>
                    <th className="py-2 pr-3">Latency</th>
                    <th className="py-2 pr-3">Enabled</th>
                    <th className="py-2 pr-3">Fan-out</th>
                    <th className="py-2 pr-3">Cost/min</th>
                  </tr>
                </thead>
                <tbody>
                  {data.engines.map((e) => (
                    <tr key={e.id} className="border-b border-even-ink-100 last:border-b-0">
                      <td className="py-2.5 pr-3">{dot(e.health, e.has_adapter)}</td>
                      <td className="py-2.5 pr-3">
                        <span className="text-even-navy-800">{e.display_name}</span>
                        <span className="text-even-ink-400 font-mono text-caption ml-2">{e.id}</span>
                        {!e.has_adapter && <span className="ml-2 text-caption text-warning-700">no adapter yet</span>}
                        {e.health.error && <div className="text-caption text-danger-600 truncate max-w-md">{e.health.error}</div>}
                      </td>
                      <td className="py-2.5 pr-3 text-caption text-even-ink-600">{caps(e.capabilities)}</td>
                      <td className="py-2.5 pr-3 font-mono text-caption text-even-ink-600">{e.has_adapter ? `${e.health.latencyMs}ms` : "—"}</td>
                      <td className="py-2.5 pr-3 text-caption">{e.enabled ? "✓" : <span className="text-even-ink-400">off</span>}</td>
                      <td className="py-2.5 pr-3 text-caption">{e.fanout_enabled ? "✓" : <span className="text-even-ink-400">off</span>}</td>
                      <td className="py-2.5 pr-3 font-mono text-caption text-even-ink-600">{e.cost_per_min_usd === 0 ? "free" : e.cost_per_min_usd === null ? "—" : `$${e.cost_per_min_usd}`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

// ---- Gold set tab (L3) -----------------------------------------------------
type GoldRow = { encounter_id: string; reference_language: string | null; terms_model: string | null; labeled_at: string; terms: number; patient_label_raw: string | null; recorded_at: string | null };
type Candidate = { id: string; patient_label_raw: string | null; recorded_at: string | null; detected_language: string | null; engines: number };
type GoldPerEngine = { engine: string; gold_n: number; avg_wer: number | null; avg_cer: number | null; avg_term_recall: number | null };
type GoldBundle = { gold: GoldRow[]; candidates: Candidate[]; per_engine: GoldPerEngine[] };
type GoldRunRow = { engine: string; transcript_english: string | null; transcript_original: string | null; wer: number | null; cer: number | null; med_term_recall: number | null; error: string | null };
type GoldDetail = { encounter: { id: string; patient_label_raw: string | null; detected_language: string | null }; runs: GoldRunRow[]; gold: { reference_original: string | null; reference_english: string | null; reference_language: string | null; critical_terms_json: Array<{ term: string; type: string }>; terms_model: string | null } | null };

function GoldTab() {
  const [data, setData] = React.useState<GoldBundle | null>(null);
  const [sel, setSel] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<GoldDetail | null>(null);
  const [refText, setRefText] = React.useState("");
  const [refLang, setRefLang] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const loadList = React.useCallback(async () => {
    const r = await fetch("/api/admin/stt-lab/gold", { cache: "no-store" });
    const j = await r.json();
    if (r.ok) setData(j as GoldBundle);
  }, []);
  React.useEffect(() => { void loadList(); }, [loadList]);

  const open = React.useCallback(async (id: string) => {
    setSel(id); setDetail(null); setMsg(null);
    const r = await fetch(`/api/admin/stt-lab/gold/${id}`, { cache: "no-store" });
    const j = await r.json();
    if (!r.ok) { setMsg("Load failed"); return; }
    const d = j as GoldDetail;
    setDetail(d);
    if (d.gold) {
      setRefText(d.gold.reference_english || d.gold.reference_original || "");
      setRefLang(d.gold.reference_language || "");
    } else {
      const texts = (d.runs || []).map((x) => x.transcript_english || x.transcript_original || "").filter(Boolean);
      texts.sort((a, b) => b.length - a.length);
      setRefText(texts[0] || "");
      setRefLang(d.encounter?.detected_language || "");
    }
  }, []);

  const save = async () => {
    if (!sel || busy) return;
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(`/api/admin/stt-lab/gold/${sel}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ referenceEnglish: refText, referenceLanguage: refLang || null }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error((j as { error?: { message?: string } }).error?.message ?? `http_${r.status}`);
      setMsg(`Saved — ${j.terms} critical terms (${j.terms_model}); scored ${j.engines} engines.`);
      await open(sel); await loadList();
    } catch (e) { setMsg("Save failed: " + (e instanceof Error ? e.message : String(e))); }
    finally { setBusy(false); }
  };

  const fmtWer = (v: number | null) => (v === null || v === undefined ? "—" : `${Math.round(v * 100)}%`);

  return (
    <div className="space-y-5">
      {/* per-engine WER leaderboard over the gold set */}
      <section className="rounded-xl border border-even-ink-100 bg-even-white p-5">
        <h3 className="text-label text-even-navy-800 mb-1">Accuracy on gold set</h3>
        <p className="text-caption text-even-ink-500 mb-3">{data ? `${data.gold.length} encounter(s) labeled` : "Loading…"}</p>
        {data && data.per_engine.length > 0 ? (
          <table className="w-full text-body">
            <thead><tr className="text-caption text-even-ink-500 text-left border-b border-even-ink-100">
              <th className="py-1.5 pr-3">Engine</th><th className="py-1.5 pr-3">Gold n</th><th className="py-1.5 pr-3">WER ↓</th><th className="py-1.5 pr-3">CER ↓</th><th className="py-1.5 pr-3">Med-term recall ↑</th>
            </tr></thead>
            <tbody>
              {data.per_engine.map((e) => (
                <tr key={e.engine} className="border-b border-even-ink-100 last:border-b-0">
                  <td className="py-1.5 pr-3 text-even-navy-800">{e.engine}</td>
                  <td className="py-1.5 pr-3 font-mono text-caption">{e.gold_n}</td>
                  <td className="py-1.5 pr-3 font-mono">{fmtWer(e.avg_wer)}</td>
                  <td className="py-1.5 pr-3 font-mono text-even-ink-600">{fmtWer(e.avg_cer)}</td>
                  <td className="py-1.5 pr-3 font-mono">{e.avg_term_recall === null ? "—" : `${Math.round(e.avg_term_recall * 100)}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="text-body text-even-ink-400">No gold labels yet — pick an encounter below and save a verbatim reference.</p>}
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-[300px,1fr] gap-5">
        {/* picker */}
        <section className="rounded-xl border border-even-ink-100 bg-even-white p-4 max-h-[600px] overflow-y-auto">
          <h4 className="text-[10px] uppercase tracking-[0.14em] text-even-ink-500 mb-2">Labeled ({data?.gold.length ?? 0})</h4>
          <ul className="space-y-1 mb-4">
            {data?.gold.map((g) => (
              <li key={g.encounter_id}>
                <button onClick={() => void open(g.encounter_id)} className={`w-full text-left px-2 py-1.5 rounded-md text-caption ${sel === g.encounter_id ? "bg-even-blue-100 text-even-navy-800" : "hover:bg-even-ink-50"}`}>
                  <span className="text-success-600">✓</span> {g.patient_label_raw || g.encounter_id} <span className="text-even-ink-400">· {g.terms} terms</span>
                </button>
              </li>
            ))}
          </ul>
          <h4 className="text-[10px] uppercase tracking-[0.14em] text-even-ink-500 mb-2">To label ({data?.candidates.length ?? 0})</h4>
          <ul className="space-y-1">
            {data?.candidates.map((c) => (
              <li key={c.id}>
                <button onClick={() => void open(c.id)} className={`w-full text-left px-2 py-1.5 rounded-md text-caption ${sel === c.id ? "bg-even-blue-100 text-even-navy-800" : "hover:bg-even-ink-50"}`}>
                  {c.patient_label_raw || c.id} <span className="text-even-ink-400">· {c.engines} eng</span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        {/* editor */}
        <section className="rounded-xl border border-even-ink-100 bg-even-white p-5">
          {!sel || !detail ? (
            <p className="text-body text-even-ink-400">Select an encounter to label its gold reference.</p>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-label text-even-navy-800">{detail.encounter.patient_label_raw || detail.encounter.id}</h3>
                <span className="text-caption text-even-ink-400">{detail.encounter.detected_language || ""}</span>
              </div>

              {/* engine transcripts (read-only, to compare while correcting) */}
              <div className="space-y-2">
                {detail.runs.map((r) => (
                  <details key={r.engine} className="rounded-md border border-even-ink-100">
                    <summary className="px-3 py-1.5 text-caption cursor-pointer flex items-center justify-between">
                      <span className="text-even-navy-800">{r.engine}</span>
                      <span className="font-mono text-even-ink-500">
                        {r.error ? <span className="text-danger-600">error</span> : <>WER {fmtWer(r.wer)} · terms {r.med_term_recall === null ? "—" : `${Math.round(r.med_term_recall * 100)}%`}</>}
                      </span>
                    </summary>
                    <p className="px-3 py-2 text-caption text-even-ink-700 whitespace-pre-wrap border-t border-even-ink-100">{r.transcript_english || r.transcript_original || r.error || "(empty)"}</p>
                  </details>
                ))}
              </div>

              <div>
                <label className="text-[10px] uppercase tracking-[0.14em] text-even-ink-500">Verbatim reference (the "truth" — correct the best engine output word-for-word)</label>
                <textarea value={refText} onChange={(e) => setRefText(e.target.value)} rows={8} className="mt-1 w-full rounded-md border border-even-ink-200 p-2 text-body font-mono" />
                <div className="flex items-center gap-2 mt-2">
                  <input value={refLang} onChange={(e) => setRefLang(e.target.value)} placeholder="lang (e.g. en, hi)" className="w-28 rounded-md border border-even-ink-200 px-2 py-1 text-caption" />
                  <Button variant="primary" size="sm" onClick={() => void save()} disabled={busy || !refText.trim()}>{busy ? "Scoring…" : "Save + score"}</Button>
                  {detail.gold && <span className="text-caption text-even-ink-500">{detail.gold.critical_terms_json?.length ?? 0} terms · {detail.gold.terms_model}</span>}
                </div>
                {msg && <p className="text-caption text-even-ink-600 mt-2">{msg}</p>}
              </div>

              {detail.gold && detail.gold.critical_terms_json?.length > 0 && (
                <div>
                  <h4 className="text-[10px] uppercase tracking-[0.14em] text-even-ink-500 mb-1">Critical terms</h4>
                  <div className="flex flex-wrap gap-1">
                    {detail.gold.critical_terms_json.map((t, i) => (
                      <span key={i} className="inline-block rounded bg-even-ink-100 px-1.5 py-0.5 text-caption text-even-ink-700">{t.term} <span className="text-even-ink-400">{t.type}</span></span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
