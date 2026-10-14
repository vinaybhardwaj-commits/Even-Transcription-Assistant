'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  PARAM_GROUPS, ALL_PARAMS, SEV_CODES, NCC_MERP, AUDIT_CATEGORIES, actorOf,
  type FormularyOption, type AuditPayload,
} from '@/lib/med-audit';

type PState = { state: 'none' | 'error' | 'na'; sev: string; note: string };
interface Drug {
  id: number; cat: string; n: string; d: string; f: string; r: string;
  restricted: boolean; highRisk: boolean; lasa: string; params: Record<number, PState>;
}
interface DdiPair { drug_a: string; drug_b: string; severity: string; mechanism: string; recommendation: string; source: string }

const norm = (s: string) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();

// ---- allergy cross-check (client) ----
const ALLERGY_CLASSES: Record<string, string[]> = {
  penicillin: ['amoxicillin', 'amoxycillin', 'ampicillin', 'piperacillin', 'penicillin', 'cloxacillin', 'sulbactam', 'tazobactam'],
  cephalosporin: ['cefazolin', 'cefuroxime', 'cefixime', 'cefpodoxime', 'ceftriaxone', 'cefotaxime', 'cefoperazone', 'cefepime', 'ceftazidime', 'cefdinir', 'cefprozil', 'cephalexin', 'cefadroxil', 'cef'],
  sulfa: ['sulfamethoxazole', 'sulphamethoxazole', 'cotrimoxazole', 'trimethoprim', 'sulfa'],
  nsaid: ['diclofenac', 'ibuprofen', 'ketorolac', 'aceclofenac', 'naproxen', 'etoricoxib', 'mefenamic', 'indomethacin', 'aspirin', 'piroxicam', 'lornoxicam', 'meloxicam', 'etodolac'],
  macrolide: ['azithromycin', 'clarithromycin', 'erythromycin'],
  fluoroquinolone: ['ciprofloxacin', 'levofloxacin', 'ofloxacin', 'moxifloxacin', 'norfloxacin', 'floxacin'],
  opioid: ['morphine', 'fentanyl', 'tramadol', 'tapentadol', 'buprenorphine', 'pentazocine', 'nalbuphine'],
};
function allergenClasses(a: string): string[] {
  a = a.toLowerCase(); const cls: string[] = [];
  if (/penicill|pcn|amoxi|ampicill|augmentin/.test(a)) cls.push('penicillin');
  if (/cephalospor|\bcef|cephalexin/.test(a)) cls.push('cephalosporin');
  if (/sulfa|sulpha|cotrim|septran|bactrim/.test(a)) cls.push('sulfa');
  if (/nsaid|aspirin|ibuprofen|diclofenac|brufen/.test(a)) cls.push('nsaid');
  if (/macrolide|azithro|erythro|clarithro/.test(a)) cls.push('macrolide');
  if (/quinolone|floxacin/.test(a)) cls.push('fluoroquinolone');
  if (/opioid|morphine|codeine|tramadol/.test(a)) cls.push('opioid');
  return cls;
}
interface AlgHit { di: number; name: string; allergen: string; cross: boolean }

export default function AuditClient() {
  const [meta, setMeta] = useState({ auditor: '', audit_date: '', location: '', uhid: '', admission_date: '', consultant: '' });
  const [allergyDoc, setAllergyDoc] = useState<'yes' | 'no' | null>(null);
  const [allergies, setAllergies] = useState<string[]>([]);
  const [allergyInput, setAllergyInput] = useState('');
  const [drugs, setDrugs] = useState<Drug[]>([]);
  const [data, setData] = useState<Record<string, FormularyOption[]>>({});
  const [all, setAll] = useState<FormularyOption[]>([]);
  const [loadErr, setLoadErr] = useState('');
  const [pickerCat, setPickerCat] = useState<number | null>(null);
  const [pickerQ, setPickerQ] = useState('');
  const [otherName, setOtherName] = useState('');
  const [otherDose, setOtherDose] = useState('');
  const [ddi, setDdi] = useState<DdiPair[]>([]);
  const [saved, setSaved] = useState<{ uhid: string; auditor: string; drugs: number; errors: number; at: string }[]>([]);
  const [saveMsg, setSaveMsg] = useState('');
  const uidRef = useRef(1);

  // load formulary
  useEffect(() => {
    fetch('/api/audit/formulary').then(async (r) => {
      if (!r.ok) { setLoadErr('Could not load formulary (' + r.status + ')'); return; }
      const j = await r.json(); setData(j.DATA || {}); setAll(j.ALL || []);
    }).catch(() => setLoadErr('Could not load formulary'));
  }, []);

  // interaction check (server) — debounced on the set of drug names
  const drugNamesKey = drugs.map((d) => d.n).join('|');
  useEffect(() => {
    const names = drugs.map((d) => d.n);
    if (names.length < 2) { setDdi([]); return; }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      fetch('/api/audit/interactions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ drugs: names }), signal: ctrl.signal,
      }).then((r) => r.ok ? r.json() : { pairs: [] })
        .then((j) => setDdi(j.pairs || [])).catch(() => { });
    }, 400);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [drugNamesKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const ddiNames = useMemo(() => {
    const s = new Set<string>();
    ddi.forEach((p) => { s.add(norm(p.drug_a)); s.add(norm(p.drug_b)); });
    return s;
  }, [ddi]);
  function drugHasDdi(d: Drug) { return ddiNames.has(norm(d.n)); }

  const algHits = useMemo<AlgHit[]>(() => {
    const hits: AlgHit[] = [];
    drugs.forEach((dr) => {
      const dn = norm(dr.n);
      allergies.forEach((a) => {
        const an = norm(a); let hit = false, cross = false;
        if (an.length >= 4 && dn.includes(an)) hit = true;
        const cls = allergenClasses(a);
        cls.forEach((cl) => { if ((ALLERGY_CLASSES[cl] || []).some((m) => dn.includes(m))) hit = true; });
        if (cls.includes('penicillin') && ALLERGY_CLASSES.cephalosporin.some((m) => dn.includes(m))) { hit = true; cross = true; }
        if (hit) hits.push({ di: dr.id, name: dr.n, allergen: a, cross });
      });
    });
    return hits;
  }, [drugs, allergies]);
  const algByDrug = useMemo(() => {
    const m: Record<number, AlgHit[]> = {};
    algHits.forEach((h) => { (m[h.di] ||= []).push(h); });
    return m;
  }, [algHits]);

  // ---- mutations ----
  function addDrug(cat: string, n: string, d: string, restricted: boolean, highRisk: boolean, lasa: string) {
    const params: Record<number, PState> = {};
    ALL_PARAMS.forEach((p) => { params[p.no] = { state: 'none', sev: 'A', note: '' }; });
    setDrugs((prev) => [...prev, { id: uidRef.current++, cat, n, d, f: '', r: inferRoute(d), restricted, highRisk, lasa, params }]);
  }
  function inferRoute(d: string) { d = (d || '').toLowerCase(); if (d.includes('inj')) return 'IV'; if (d.includes('tablet') || d.includes('cap')) return 'PO'; if (d.includes('solution') || d.includes('spray')) return 'Topical'; return ''; }
  function removeDrug(id: number) { setDrugs((p) => p.filter((x) => x.id !== id)); }
  function patchDrug(id: number, patch: Partial<Drug>) { setDrugs((p) => p.map((x) => x.id === id ? { ...x, ...patch } : x)); }
  function setParam(id: number, no: number, patch: Partial<PState>) {
    setDrugs((p) => p.map((x) => x.id === id ? { ...x, params: { ...x.params, [no]: { ...x.params[no], ...patch } } } : x));
  }
  function cycleState(id: number, no: number, st: PState['state']) {
    setDrugs((p) => p.map((x) => {
      if (x.id !== id) return x;
      const cur = x.params[no].state;
      const next = (cur === st && st !== 'none') ? 'none' : st;
      return { ...x, params: { ...x.params, [no]: { ...x.params[no], state: next } } };
    }));
  }
  function applyDdi(aName: string, bName: string) {
    setDrugs((p) => p.map((x) => (norm(x.n) === norm(aName) || norm(x.n) === norm(bName))
      ? { ...x, params: { ...x.params, 12: { ...x.params[12], state: 'error' } } } : x));
  }
  function addAllergyVal(v: string) {
    const parts = (v || '').split(',').map((s) => s.trim()).filter(Boolean);
    setAllergies((prev) => { const next = [...prev]; parts.forEach((p) => { if (!next.includes(p)) next.push(p); }); return next; });
  }

  // totals
  const totals = useMemo(() => {
    let doc = 0, dn = 0, ph = 0, nu = 0;
    drugs.forEach((dr) => ALL_PARAMS.forEach((p) => {
      if (dr.params[p.no].state !== 'error') return;
      const a = actorOf(p.no);
      if (a === 'doctor') doc++; else if (a === 'doctor_nurse') dn++; else if (a === 'pharmacist') ph++; else nu++;
    }));
    return { doc, dn, ph, nu, total: doc + dn + ph + nu };
  }, [drugs]);

  // ---- save / export ----
  function buildPayload(): AuditPayload {
    return {
      meta, allergies_documented: allergyDoc, known_allergies: allergies,
      drugs: drugs.map((dr) => ({
        name: dr.n, category: dr.cat, dose: dr.d, frequency: dr.f, route: dr.r,
        reserve: dr.restricted, high_alert: dr.highRisk,
        findings: ALL_PARAMS.filter((p) => dr.params[p.no].state !== 'none').map((p) => ({
          param: p.no, status: dr.params[p.no].state as 'error' | 'na',
          ncc_merp: dr.params[p.no].state === 'error' ? dr.params[p.no].sev : null, note: dr.params[p.no].note,
        })),
      })),
    };
  }
  async function saveAudit() {
    setSaveMsg('Saving…');
    try {
      const r = await fetch('/api/audit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(buildPayload()) });
      const j = await r.json();
      if (r.ok) {
        setSaved((s) => [{ uhid: meta.uhid || '(no UHID)', auditor: meta.auditor || '', drugs: drugs.length, errors: totals.total, at: new Date().toLocaleString() }, ...s]);
        setSaveMsg('Saved (audit #' + j.id + ').');
      } else setSaveMsg('Save failed: ' + (j.error || r.status));
    } catch { setSaveMsg('Network error saving.'); }
  }
  function dl(name: string, text: string, type: string) {
    const b = new Blob([text], { type }); const u = URL.createObjectURL(b);
    const a = document.createElement('a'); a.href = u; a.download = name; a.click(); URL.revokeObjectURL(u);
  }
  function downloadJSON() { dl('med-audit-' + (meta.uhid || 'draft') + '.json', JSON.stringify(buildPayload(), null, 2), 'application/json'); }
  function downloadCSV() {
    const rows: string[] = [];
    rows.push(['UHID', meta.uhid].join(','));
    rows.push(['Auditor', meta.auditor].join(','));
    rows.push(['Date', meta.audit_date].join(','));
    rows.push(['Allergies documented', allergyDoc || ''].join(','));
    rows.push('Known allergies,"' + allergies.join('; ') + '"');
    rows.push('');
    rows.push(['#', 'Parameter', ...drugs.map((d) => '"' + d.n + '"')].join(','));
    ALL_PARAMS.forEach((p) => {
      const r = [String(p.no), '"' + p.label + '"'];
      drugs.forEach((d) => { const st = d.params[p.no]; r.push(st.state === 'error' ? st.sev : st.state === 'na' ? 'NA' : '0'); });
      rows.push(r.join(','));
    });
    rows.push('');
    rows.push(['Totals', '', 'Doctor:' + totals.doc, 'Nurse:' + totals.nu, 'Pharmacist:' + totals.ph, 'Total:' + totals.total].join(','));
    dl('med-audit-' + (meta.uhid || 'draft') + '.csv', rows.join('\n'), 'text/csv');
  }

  // ---- picker list ----
  const pickerList = useMemo<FormularyOption[]>(() => {
    if (pickerCat === null) return [];
    const c = AUDIT_CATEGORIES[pickerCat];
    let list = (c.bucket === 'other' ? all : (data[c.bucket] || [])).slice();
    if (c.restrictedOnly) list = list.filter((d) => d.restricted);
    const q = norm(pickerQ);
    if (q) list = list.filter((d) => norm(d.n).includes(q));
    else if (c.bucket === 'other') list = list.slice(0, 120);
    return list.slice(0, 200);
  }, [pickerCat, pickerQ, data, all]);

  const QUICK = ['Penicillin', 'Cephalosporins', 'Sulfa', 'NSAIDs', 'Aspirin', 'Opioids'];

  return (
    <div className="ma">
      <style>{CSS}</style>
      <header className="ma-bar">
        <div className="ma-row"><h1>Medication Chart Audit</h1><span className="ma-pharm">CLINICAL PHARMACIST</span><a href="/audit/queries" style={{ marginLeft: 'auto', color: '#1d4ed8', fontSize: 13, fontWeight: 700, textDecoration: 'none' }}>Query log →</a></div>
        <div className="ma-sub">medaudit.evenos.app · prospective on-rounds capture · EHRC Pharmacy Formulary 2026 · allergy &amp; interaction cross-check</div>
      </header>

      <div className="ma-wrap">
        <div className="ma-card" style={{ marginBottom: 18 }}>
          <h2>Patient &amp; Audit</h2>
          <div className="ma-meta">
            <Field label="Auditor (pharmacist)" v={meta.auditor} on={(v) => setMeta({ ...meta, auditor: v })} ph="Clinical pharmacist name" />
            <Field label="Date of audit" type="date" v={meta.audit_date} on={(v) => setMeta({ ...meta, audit_date: v })} />
            <Field label="Location / ward" v={meta.location} on={(v) => setMeta({ ...meta, location: v })} ph="e.g. Surgical IP" />
            <Field label="UHID" v={meta.uhid} on={(v) => setMeta({ ...meta, uhid: v })} ph="UHID / patient no." />
            <Field label="Date of admission" type="date" v={meta.admission_date} on={(v) => setMeta({ ...meta, admission_date: v })} />
            <Field label="Primary consultant" v={meta.consultant} on={(v) => setMeta({ ...meta, consultant: v })} ph="Consultant" />
          </div>
          <div className="ma-allergy"><b>Drug allergies documented in chart?</b>
            <span className="ma-seg">
              <button className={allergyDoc === 'yes' ? 'on-yes' : ''} onClick={() => setAllergyDoc('yes')}>Yes</button>
              <button className={allergyDoc === 'no' ? 'on-no' : ''} onClick={() => setAllergyDoc('no')}>No</button>
            </span>
            <span style={{ color: '#64748b', fontSize: 12 }}>NABH audit field (was it recorded?)</span>
          </div>
          <div className="ma-algbox">
            <label>Known allergies — captured for live cross-check against every drug added</label>
            <div className="ma-algrow">
              <input value={allergyInput} placeholder="Type an allergen or class, press Enter (e.g. Penicillin, Sulfa, NSAIDs, Ceftriaxone)"
                onChange={(e) => setAllergyInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { addAllergyVal(allergyInput); setAllergyInput(''); } }} />
              <button onClick={() => { addAllergyVal(allergyInput); setAllergyInput(''); }}>Add</button>
            </div>
            <div className="ma-quick">{QUICK.map((q) => <span key={q} className="ma-qa" onClick={() => addAllergyVal(q)}>+ {q}</span>)}</div>
            <div className="ma-algchips">
              {allergies.length === 0 ? <span className="ma-empty">None entered yet.</span> :
                allergies.map((a, i) => <span key={i} className="ma-achip">{a}<span className="x" onClick={() => setAllergies(allergies.filter((_, j) => j !== i))}>✕</span></span>)}
            </div>
          </div>
        </div>

        <div className="ma-grid">
          <div>
            <div className="ma-card">
              <h2>Medications on chart</h2>
              <div className="ma-addlabel">Add a medication — pick a category, search, click. (&ldquo;Other&rdquo; searches the whole formulary.)</div>
              {loadErr && <div className="ma-alertin">{loadErr}</div>}
              <div className="ma-addbar">
                {AUDIT_CATEGORIES.map((c, i) => (
                  <button key={c.label} className={'ma-cat' + (c.restrictedOnly ? ' restricted' : '') + (c.bucket === 'other' ? ' other' : '')}
                    onClick={() => { setPickerCat(i); setPickerQ(''); }}>+ {c.label}</button>
                ))}
              </div>

              {pickerCat !== null && (
                <div className="ma-picker">
                  <div className="ma-phead">{AUDIT_CATEGORIES[pickerCat].label}<span className="x" onClick={() => setPickerCat(null)}>close</span></div>
                  <input className="ma-psearch" autoFocus value={pickerQ} placeholder="Filter drugs…" onChange={(e) => setPickerQ(e.target.value)} />
                  <div className="ma-opts">
                    {pickerList.length === 0 ? <div className="ma-empty">No matches — use free-text below.</div> :
                      pickerList.map((d, i) => (
                        <div key={i} className={'ma-opt' + (d.restricted ? ' restricted' : '')}
                          onClick={() => { addDrug(AUDIT_CATEGORIES[pickerCat!].label, d.n, d.d || '', d.restricted, d.highRisk, d.lasa); setPickerCat(null); }}>
                          <span><span className="nm">{d.n}</span> <span className="ds">{d.d}</span>
                            <span className="ma-chips">
                              {d.restricted && <span className="c r">RESERVE</span>}
                              {d.highRisk && <span className="c hr">HIGH-ALERT</span>}
                              {d.sch && d.sch !== 'OTC' && d.sch !== 'H' && <span className="c sc">Sch {d.sch}</span>}
                              {d.ved === 'V' && <span className="c ved">Vital</span>}
                            </span>
                          </span>
                        </div>
                      ))}
                  </div>
                  <div className="ma-freetext">
                    <input value={otherName} placeholder="Not in formulary? Type drug name…" onChange={(e) => setOtherName(e.target.value)} />
                    <input value={otherDose} placeholder="Dose" style={{ maxWidth: 90 }} onChange={(e) => setOtherDose(e.target.value)} />
                    <button onClick={() => { if (otherName.trim()) { addDrug('Other', otherName.trim(), otherDose.trim() || '—', false, false, ''); setOtherName(''); setOtherDose(''); setPickerCat(null); } }}>Add free-text</button>
                  </div>
                </div>
              )}

              {drugs.length === 0 && <div className="ma-empty">No drugs added. Pick a category — the formulary fills the dropdown, the standard strength pre-fills, and all 35 checks default to &ldquo;No error&rdquo;.</div>}
              {drugs.map((dr) => {
                const myAlg = algByDrug[dr.id] || [];
                const errs = ALL_PARAMS.filter((p) => dr.params[p.no].state === 'error').length;
                const sev = ddi.find((p) => norm(p.drug_a) === norm(dr.n) || norm(p.drug_b) === norm(dr.n))?.severity;
                return (
                  <div key={dr.id} className={'ma-drug' + (dr.restricted ? ' restricted' : '') + (myAlg.length ? ' allergy' : '')}>
                    <div className="ma-dh">
                      <span className="nm">{dr.n}</span>
                      {dr.restricted && <span className="pill r">RESERVE</span>}
                      {dr.highRisk && <span className="pill hr">HIGH-ALERT</span>}
                      {myAlg.length > 0 && <span className="pill al">ALLERGY</span>}
                      {drugHasDdi(dr) && <span className={'pill ddi ' + (sev || '')}>DDI</span>}
                      <span className="cat">{dr.cat}</span>
                      {errs > 0 && <span className="errc">{errs} err</span>}
                      <span style={{ marginLeft: 'auto' }} />
                      <button className="rm" onClick={() => removeDrug(dr.id)}>✕</button>
                    </div>
                    <div className="ma-db">
                      {myAlg.length > 0 && <div className="ma-alertin">⚠ ALLERGY: patient is allergic to {myAlg.map((h) => h.allergen + (h.cross ? ' (β-lactam cross-reactivity)' : '')).join(', ')}. Verify drug selection (param #1).</div>}
                      <div className="ma-doserow">
                        <Field label="Dose (editable)" v={dr.d} on={(v) => patchDrug(dr.id, { d: v })} />
                        <Field label="Frequency" v={dr.f} ph="OD/BD/TDS" on={(v) => patchDrug(dr.id, { f: v })} />
                        <Field label="Route" v={dr.r} on={(v) => patchDrug(dr.id, { r: v })} />
                      </div>
                      {dr.lasa && <div className="ma-lasa">⚠ LASA — look-alike/sound-alike: {dr.lasa}</div>}
                      {PARAM_GROUPS.map((g) => (
                        <div key={g.title} className="ma-grp">
                          <div className="ma-glabel">{g.title}</div>
                          {g.items.map((p) => {
                            const st = dr.params[p.no];
                            return (
                              <div key={p.no} className={'ma-prow' + (st.state === 'error' ? ' iserr' : '')}>
                                <div className="pn">{p.no}</div>
                                <div className="pl">{p.label}
                                  {(p.no === 12 || p.no === 13) && drugHasDdi(dr) && <span className="hint">interaction</span>}
                                  {p.no === 1 && myAlg.length > 0 && <span className="hint al">allergy</span>}
                                </div>
                                <div className="stb">
                                  <button className={'none' + (st.state === 'none' ? ' on' : '')} onClick={() => cycleState(dr.id, p.no, 'none')}>No error</button>
                                  <button className={'err' + (st.state === 'error' ? ' on' : '')} onClick={() => cycleState(dr.id, p.no, 'error')}>Error</button>
                                  <button className={'na' + (st.state === 'na' ? ' on' : '')} onClick={() => cycleState(dr.id, p.no, 'na')}>NA</button>
                                </div>
                                {st.state === 'error' && (
                                  <div className="ma-errd">
                                    <span className="lbl">NCC MERP</span>
                                    <select value={st.sev} onChange={(e) => setParam(dr.id, p.no, { sev: e.target.value })}>
                                      {SEV_CODES.map((s) => <option key={s} value={s}>{s}</option>)}
                                    </select>
                                    <input placeholder="What was the error? (free text)" value={st.note} onChange={(e) => setParam(dr.id, p.no, { note: e.target.value })} />
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="ma-side">
            <div className="ma-card"><h2>Allergy alerts</h2>
              {algHits.length === 0 ? <div className="ma-empty">{allergies.length ? 'None of the current drugs match the known allergies.' : 'No known allergies entered, or none match.'}</div> :
                algHits.map((h, i) => (
                  <div key={i} className="ma-item major"><span className="sev">{h.cross ? 'caution' : 'allergy'}</span>
                    <div className="pair">{h.name}</div>
                    <div className="mech">Patient reports allergy to <b>{h.allergen}</b>{h.cross ? ' — possible β-lactam cross-reactivity' : ''}.</div>
                    <div className="rec"><b>Rec:</b> verify selection; flag param #1 if administered.</div>
                  </div>
                ))}
            </div>

            <div className="ma-card"><h2>Interaction check</h2>
              {ddi.length === 0 ? <div className="ma-empty">{drugs.length < 2 ? 'Add two or more drugs to screen for interactions.' : 'No interactions detected.'}</div> :
                ddi.map((x, i) => (
                  <div key={i} className={'ma-item ' + x.severity}><span className="sev">{x.severity}</span>
                    <div className="pair">{x.drug_a} + {x.drug_b}</div>
                    <div className="mech">{x.mechanism}</div>
                    <div className="rec"><b>Rec:</b> {x.recommendation}</div>
                    <div className="ev">Evidence: {x.source}</div>
                    <button className="apply" onClick={() => applyDdi(x.drug_a, x.drug_b)}>Flag #12 on both drugs</button>
                  </div>
                ))}
              <div className="ma-legend" style={{ marginTop: 8 }}>Auto-feeds parameter <b>#12</b> (drug–drug) &amp; <b>#13</b> (food–drug). Curated EHRC rules + RxLabelGuard (FDA SPL).</div>
            </div>

            <div className="ma-card"><h2>Error totals</h2>
              <div className="ma-totals">
                <div className="lab">Doctor errors (1–13)</div><div className="val">{totals.doc}</div>
                <div className="lab">Doctor/Nurse (14–16)</div><div className="val">{totals.dn}</div>
                <div className="lab">Pharmacist (17–23)</div><div className="val">{totals.ph}</div>
                <div className="lab">Nurse (24–35)</div><div className="val">{totals.nu}</div>
                <div className="lab tot">Total errors</div><div className="val tot">{totals.total}</div>
              </div>
              <button className="ma-save" onClick={saveAudit}>Save audit</button>
              <div className="ma-dlrow"><button onClick={downloadJSON}>Download JSON</button><button onClick={downloadCSV}>Download CSV</button></div>
              {saveMsg && <div className="ma-legend" style={{ marginTop: 6 }}>{saveMsg}</div>}
              {saved.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  <div className="ma-addlabel" style={{ margin: '6px 0' }}>Saved this session ({saved.length})</div>
                  {saved.map((a, i) => <div key={i} className="ma-saved"><div className="t">{a.uhid} — {a.drugs} drug(s), {a.errors} error(s)</div><div className="m">{a.at} · {a.auditor || 'no auditor'}</div></div>)}
                </div>
              )}
            </div>

            <div className="ma-card"><h2>A–I severity legend</h2>
              <div className="ma-legend"><b>NCC MERP harm index.</b><br />
                {NCC_MERP.map((s) => <span key={s.code}><b>{s.code}</b> {s.label} · </span>)}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, v, on, ph, type }: { label: string; v: string; on: (v: string) => void; ph?: string; type?: string }) {
  return (
    <div className="ma-field">
      <label>{label}</label>
      <input type={type || 'text'} value={v} placeholder={ph || ''} onChange={(e) => on(e.target.value)} />
    </div>
  );
}

const CSS = `
.ma{--blue:#1d4ed8;--muted:#64748b;--line:#e2e8f0;--red:#dc2626;--amber:#d97706;--teal:#0f766e;--slate:#475569;font:14px/1.5 system-ui,-apple-system,sans-serif;color:#0f172a;background:#f4f7fb;min-height:100vh}
.ma *{box-sizing:border-box}
.ma-bar{background:#fff;border-bottom:1px solid var(--line);padding:13px 22px;position:sticky;top:0;z-index:50}
.ma-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.ma-bar h1{margin:0;font-size:18px;font-weight:800}
.ma-pharm{background:var(--teal);color:#fff;border-radius:999px;padding:3px 11px;font-size:11.5px;font-weight:800}
.ma-sub{color:var(--muted);font-size:12px;margin-top:4px}
.ma-wrap{max-width:1280px;margin:0 auto;padding:18px 22px 90px}
.ma-grid{display:grid;grid-template-columns:1fr 340px;gap:18px;align-items:start}
@media(max-width:980px){.ma-grid{grid-template-columns:1fr}}
.ma-card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:16px;margin-bottom:0}
.ma-card h2{margin:0 0 12px;font-size:14px;font-weight:800;text-transform:uppercase;letter-spacing:.4px;color:var(--slate)}
.ma-meta{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
@media(max-width:680px){.ma-meta{grid-template-columns:1fr 1fr}}
.ma-field label{display:block;font-size:11.5px;font-weight:700;color:var(--muted);margin-bottom:3px;text-transform:uppercase;letter-spacing:.3px}
.ma-field input{width:100%;padding:8px 9px;border:1px solid var(--line);border-radius:9px;font-size:13.5px}
.ma-field input:focus{outline:none;border-color:var(--blue);box-shadow:0 0 0 3px #eff4ff}
.ma-allergy{display:flex;align-items:center;gap:10px;margin-top:12px;padding:10px 12px;border:1px dashed var(--line);border-radius:10px;background:#fbfdff;flex-wrap:wrap}
.ma-seg{display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden}
.ma-seg button{border:0;background:#fff;padding:6px 12px;font-size:12.5px;cursor:pointer;font-weight:700;color:var(--muted)}
.ma-seg button.on-yes{background:#ecfdf3;color:#16a34a}.ma-seg button.on-no{background:#fef2f2;color:var(--red)}
.ma-algbox{margin-top:10px;padding:11px 12px;border:1px solid #fecaca;border-radius:10px;background:#fef2f2}
.ma-algbox label{font-size:11.5px;font-weight:800;color:var(--red);text-transform:uppercase;letter-spacing:.3px}
.ma-algrow{display:flex;gap:8px;margin:7px 0}.ma-algrow input{flex:1;padding:8px 9px;border:1px solid #fecaca;border-radius:9px;font-size:13px}
.ma-algrow button{border:0;background:var(--red);color:#fff;border-radius:9px;padding:0 14px;font-weight:700;cursor:pointer}
.ma-quick{display:flex;gap:6px;flex-wrap:wrap}.ma-qa{font-size:11px;border:1px dashed #fecaca;background:#fff;color:var(--red);border-radius:999px;padding:2px 9px;cursor:pointer}
.ma-algchips{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.ma-achip{background:#fff;border:1px solid #fecaca;color:var(--red);border-radius:999px;padding:3px 10px;font-size:12px;font-weight:700;display:flex;gap:6px;align-items:center}
.ma-achip .x{cursor:pointer;font-weight:800}
.ma-addlabel{font-size:11.5px;font-weight:800;color:var(--slate);text-transform:uppercase;letter-spacing:.3px;margin-bottom:7px}
.ma-addbar{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:6px}
.ma-cat{border:1px solid #cfe0ff;background:#eff4ff;color:var(--blue);border-radius:999px;padding:7px 13px;font-size:12.5px;font-weight:700;cursor:pointer}
.ma-cat.restricted{border-color:#fecaca;background:#fef2f2;color:var(--red)}.ma-cat.other{border-color:var(--line);background:#f8fafc;color:var(--slate)}
.ma-picker{margin:8px 0 14px;border:1px solid #cfe0ff;border-radius:12px;padding:12px;background:#fbfdff}
.ma-phead{font-weight:800;font-size:13px;margin-bottom:8px;display:flex;justify-content:space-between}.ma-phead .x{cursor:pointer;color:var(--muted)}
.ma-psearch{width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:9px;margin-bottom:10px;font-size:13px}
.ma-opts{display:grid;grid-template-columns:1fr 1fr;gap:8px;max-height:320px;overflow:auto}
@media(max-width:680px){.ma-opts{grid-template-columns:1fr}}
.ma-opt{display:flex;justify-content:space-between;align-items:center;gap:8px;border:1px solid var(--line);border-radius:9px;padding:8px 10px;cursor:pointer;background:#fff}
.ma-opt:hover{border-color:var(--blue)}.ma-opt .nm{font-weight:700;font-size:13px}.ma-opt .ds{color:var(--muted);font-size:11.5px}
.ma-opt.restricted .nm{color:var(--red)}
.ma-chips{display:inline-flex;gap:4px;flex-wrap:wrap;margin-left:4px}
.ma-chips .c{font-size:9.5px;font-weight:800;border-radius:999px;padding:1px 6px;border:1px solid}
.ma-chips .c.r{color:var(--red);background:#fef2f2;border-color:#fecaca}.ma-chips .c.hr{color:var(--amber);background:#fffbeb;border-color:#fde68a}
.ma-chips .c.sc{color:var(--slate);background:#f1f5f9;border-color:#cbd5e1}.ma-chips .c.ved{color:var(--teal);background:#f0fdfa;border-color:#99f6e4}
.ma-freetext{display:flex;gap:8px;margin-top:10px;border-top:1px dashed var(--line);padding-top:10px}
.ma-freetext input{flex:1;padding:8px 9px;border:1px solid var(--line);border-radius:9px}
.ma-freetext button{border:0;background:var(--slate);color:#fff;border-radius:9px;padding:0 14px;font-weight:700;cursor:pointer}
.ma-drug{border:1px solid var(--line);border-radius:12px;margin-bottom:12px;overflow:hidden}
.ma-drug.restricted{border-color:#fecaca}.ma-drug.allergy{border-color:var(--red);box-shadow:0 0 0 2px #fef2f2}
.ma-dh{display:flex;align-items:center;gap:9px;padding:11px 13px;background:#fafcff;flex-wrap:wrap}
.ma-drug.restricted .ma-dh{background:#fef2f2}.ma-dh .nm{font-weight:800;font-size:14.5px}.ma-drug.restricted .ma-dh .nm{color:var(--red)}
.ma-dh .cat{font-size:11px;font-weight:700;color:var(--muted);background:#eef2f7;border-radius:999px;padding:2px 9px}
.ma-dh .errc{font-size:12px;font-weight:800;color:var(--red)}
.ma-dh .rm{border:0;background:none;color:#94a3b8;font-size:16px;cursor:pointer}
.ma-dh .pill{font-size:10px;font-weight:800;border-radius:999px;padding:1px 7px;border:1px solid}
.ma-dh .pill.r{color:var(--red);background:#fef2f2;border-color:#fecaca}.ma-dh .pill.hr{color:var(--amber);background:#fffbeb;border-color:#fde68a}
.ma-dh .pill.al{color:#fff;background:var(--red);border-color:var(--red)}
.ma-dh .pill.ddi{color:var(--red);background:#fef2f2;border-color:#fecaca}.ma-dh .pill.ddi.moderate{color:var(--amber);background:#fffbeb;border-color:#fde68a}
.ma-db{padding:12px 13px;border-top:1px solid var(--line)}
.ma-doserow{display:grid;grid-template-columns:2fr 1fr 1fr;gap:8px;margin-bottom:6px}
.ma-alertin{font-size:12px;color:var(--red);font-weight:700;margin:2px 0 8px;padding:6px 9px;background:#fef2f2;border:1px solid #fecaca;border-radius:8px}
.ma-lasa{font-size:11.5px;color:var(--amber);margin:2px 0 10px}
.ma-glabel{font-size:11px;font-weight:800;letter-spacing:.4px;color:var(--blue);text-transform:uppercase;margin:6px 0;border-top:1px dashed var(--line);padding-top:8px}
.ma-prow{display:flex;align-items:flex-start;gap:10px;padding:4px 0;flex-wrap:wrap}
.ma-prow .pn{width:22px;color:var(--muted);font-weight:700;font-size:12px;text-align:right}
.ma-prow .pl{flex:1;font-size:13px;min-width:140px}
.ma-prow .pl .hint{font-size:10.5px;font-weight:800;color:var(--amber);background:#fffbeb;border:1px solid #fde68a;border-radius:999px;padding:0 7px;margin-left:6px}
.ma-prow .pl .hint.al{color:#fff;background:var(--red);border-color:var(--red)}
.ma-prow .stb{display:flex;gap:4px}
.ma-prow .stb button{border:1px solid var(--line);background:#fff;color:var(--muted);border-radius:7px;padding:3px 9px;font-size:11.5px;font-weight:700;cursor:pointer}
.ma-prow .stb button.none.on{background:#ecfdf3;color:#16a34a;border-color:#bbf7d0}
.ma-prow .stb button.err.on{background:#fef2f2;color:var(--red);border-color:#fecaca}
.ma-prow .stb button.na.on{background:#f1f5f9;color:var(--slate);border-color:#cbd5e1}
.ma-errd{flex-basis:100%;margin:6px 0 4px 32px;padding:8px 10px;border:1px solid #fecaca;background:#fef2f2;border-radius:9px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.ma-errd .lbl{font-size:11px;font-weight:800;color:var(--red);text-transform:uppercase}
.ma-errd select,.ma-errd input{padding:6px 8px;border:1px solid var(--line);border-radius:8px;font-size:12.5px}
.ma-errd input{flex:1;min-width:160px}
.ma-side{position:sticky;top:84px;display:flex;flex-direction:column;gap:16px}
.ma-item{border:1px solid var(--line);border-radius:11px;padding:10px 11px;margin-bottom:9px}
.ma-item.major,.ma-item.contraindicated{border-color:#fecaca;background:#fef2f2}.ma-item.moderate{border-color:#fde68a;background:#fffbeb}
.ma-item .pair{font-weight:800;font-size:13px}.ma-item .sev{font-size:10.5px;font-weight:800;text-transform:uppercase;float:right}
.ma-item.major .sev,.ma-item.contraindicated .sev{color:var(--red)}.ma-item.moderate .sev{color:var(--amber)}
.ma-item .mech,.ma-item .rec{font-size:12px;margin-top:3px;color:var(--slate)}.ma-item .ev{font-size:10.5px;color:var(--muted);margin-top:5px}
.ma-item .apply{margin-top:7px;border:1px solid #fecaca;background:#fff;color:var(--red);border-radius:8px;padding:4px 9px;font-size:11.5px;font-weight:700;cursor:pointer}
.ma-empty{color:var(--muted);font-size:12.5px;font-style:italic}
.ma-totals{display:grid;grid-template-columns:1fr auto;row-gap:7px;font-size:13px}
.ma-totals .lab{color:var(--slate)}.ma-totals .val{font-weight:800;text-align:right}
.ma-totals .tot{border-top:1px solid var(--line);padding-top:7px;font-weight:900}.ma-totals .val.tot{color:var(--red)}
.ma-save{margin-top:8px;width:100%;border:0;background:var(--teal);color:#fff;border-radius:10px;padding:11px;font-weight:800;font-size:14px;cursor:pointer}
.ma-dlrow{display:flex;gap:8px;margin-top:8px}
.ma-dlrow button{flex:1;border:1px solid var(--teal);background:#fff;color:var(--teal);border-radius:9px;padding:8px;font-weight:700;font-size:12.5px;cursor:pointer}
.ma-saved{border:1px solid var(--line);border-radius:9px;padding:8px 10px;margin-bottom:7px;font-size:12.5px}
.ma-saved .t{font-weight:800}.ma-saved .m{color:var(--muted);font-size:11.5px}
.ma-legend{font-size:11px;color:var(--muted);line-height:1.7}.ma-legend b{color:var(--slate)}
`;
