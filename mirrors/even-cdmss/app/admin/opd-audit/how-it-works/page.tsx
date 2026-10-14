import Link from 'next/link';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { isCareUnlocked } from '@/lib/care-cookie';
import { OPD_ENGINE_VERSION } from '@/lib/opd-note-audit-core';
import {
  OPD_DEFAULT_WEIGHTS, PDQI9_ATTRS, PDQI9_LABEL,
  SEVERITY, bandFor, type Band, type OpdDomain, type NetValue,
} from '@/lib/opd-note-score-core';
import { DOSE_LIMITS_VERSION } from '@/lib/dose-limits';
import { OPD_AUDIT_CHANGELOG, type EngineChange } from '@/lib/opd-audit-changelog';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'How the audit works · OPD Audit · CAT' };

/**
 * /admin/opd-audit/how-it-works — the plain-language guide to how the OPD note audit works,
 * rebuilt from the approved redesign prototype (12 Jul 2026). Readable by admins AND care
 * managers (they field "how is this scored?" from doctors).
 *
 * EVERY number on this page is imported from the live scoring code — it cannot drift:
 *   · domain weights ....... OPD_DEFAULT_WEIGHTS
 *   · grade cut-offs ....... derived from bandFor() (score-core), never hardcoded
 *   · finding severities ... SEVERITY
 *   · PDQI-9 attributes .... PDQI9_ATTRS / PDQI9_LABEL
 *   · engine version ....... OPD_ENGINE_VERSION
 *   · dose-limits version .. DOSE_LIMITS_VERSION
 *   · the whole change log .. OPD_AUDIT_CHANGELOG (plain headline + detail)
 */

// ── derive the grade ladder from the REAL cut-offs in bandFor() (no hardcoded 85/70/…) ──
const BAND_STYLE: Record<Band, string> = { A: 'a', B: 'b', C: 'c', D: 'd', E: 'e' };
function deriveGradeLadder(): { band: Band; lo: number; hi: number }[] {
  const seen = new Map<Band, { lo: number; hi: number }>();
  for (let n = 0; n <= 100; n++) {
    const b = bandFor(n);
    const cur = seen.get(b);
    if (!cur) seen.set(b, { lo: n, hi: n });
    else { cur.lo = Math.min(cur.lo, n); cur.hi = Math.max(cur.hi, n); }
  }
  return (['A', 'B', 'C', 'D', 'E'] as Band[]).map((band) => ({ band, ...(seen.get(band) ?? { lo: 0, hi: 0 }) }));
}

// ── the five weight bars — friendly names (prototype copy) but the PERCENT is imported ──
const WEIGHT_ROWS: { domain: OpdDomain; name: string; from: string; color: string }[] = [
  { domain: 'documentation', name: 'Documentation', color: 'var(--det)', from: 'The core of the record: complaint, diagnosis, dosing, exam (in-person visits only)' },
  { domain: 'note_quality', name: 'Note quality', color: 'var(--llm)', from: 'A validated 9-point note-quality scale (PDQI-9); left out if not rated' },
  { domain: 'appropriateness', name: 'Appropriateness', color: 'var(--C)', from: 'Findings on tests, referrals and management choices' },
  { domain: 'prescribing_safety', name: 'Prescribing & safety', color: 'var(--E)', from: 'Rule-based and AI-reviewed prescribing findings' },
  { domain: 'patient_centred', name: 'Continuity of care', color: 'var(--A)', from: 'Two things: was advice/a plan given, and was follow-up specified' },
];

// ── finding severity tiers — ORDER + the "never penalised" fact come from SEVERITY ──
const SEVERITY_COPY: Record<NetValue, string> = {
  'low-value': 'clearly low-value or unsafe as written (biggest effect)',
  'context-dependent': "could be right, but the note doesn't justify it",
  uncertain: 'a possible issue, weak signal',
  'high-value': 'good practice, never penalised',
};
const SEVERITY_TIERS = (Object.keys(SEVERITY) as NetValue[])
  .sort((a, b) => SEVERITY[b] - SEVERITY[a]); // low-value → high-value

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function shortDate(iso: string): string {
  const [, m, d] = iso.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1] ?? ''}`;
}
function isSeparateFeature(c: EngineChange): boolean {
  return /\(not OPD audit\)/.test(c.title) || (c.plain ?? '').startsWith('Separate feature');
}
function headlineOf(c: EngineChange): string {
  // entry.plain is the clinician-readable headline; fall back to a graceful shortening of title.
  if (c.plain) return c.plain;
  const t = c.title.replace(/^v?\d[\d.]*\s*[—-]\s*/, '');
  return t.length > 96 ? `${t.slice(0, 93)}…` : t;
}

const css = `
.hiw{
  --ink:#0f172a; --s700:#334155; --s600:#475569; --s500:#64748b; --s400:#94a3b8; --s300:#cbd5e1;
  --s200:#e2e8f0; --s100:#f1f5f9; --s50:#f8fafc; --brand:#0f766e; --brandf:#ecfdf9;
  --A:#15803d; --Abg:#dcfce7; --B:#0d9488; --Bbg:#ccfbf1; --C:#d97706; --Cbg:#fef3c7; --D:#ea580c; --Dbg:#ffedd5; --E:#dc2626; --Ebg:#fee2e2;
  --det:#0369a1; --detbg:#e0f2fe; --llm:#7c3aed; --llmbg:#f3e8ff;
  --adv:#4b57a6; --advbg:#f4f5fb; --advline:#c7cbe8;
  color:var(--s700); font-size:14px; line-height:1.6;
}
.hiw *{box-sizing:border-box}
.hiw .serif{font-family:var(--font-serif,Georgia),Georgia,"Times New Roman",serif}
.hiw .shell{display:grid;grid-template-columns:196px minmax(0,1fr);gap:0}
.hiw nav.toc{position:sticky;top:8px;align-self:start;max-height:calc(100vh - 24px);overflow:auto;padding:2px 16px 8px 0;border-right:1px solid var(--s200)}
.hiw nav.toc .navbrand{font-family:var(--font-serif,Georgia),Georgia,serif;font-weight:700;color:var(--ink);font-size:15px}
.hiw nav.toc .tag{font-size:10px;color:var(--s400);text-transform:uppercase;letter-spacing:.08em;margin:14px 0 5px}
.hiw nav.toc a{display:block;padding:5px 9px;border-radius:7px;color:var(--s600);font-size:12.5px;text-decoration:none}
.hiw nav.toc a:hover{background:var(--s50);color:var(--brand)}
.hiw main.body{padding:0 0 56px 28px;min-width:0}
.hiw h1{font-family:var(--font-serif,Georgia),Georgia,serif;font-size:28px;font-weight:600;color:var(--ink);margin:0 0 4px}
.hiw .lede{font-size:14px;color:var(--s500);max-width:660px;margin:0 0 4px}
.hiw .vchip{font-family:ui-monospace,Menlo,monospace;font-size:12px;background:var(--ink);color:#fff;border-radius:5px;padding:2px 7px;white-space:nowrap;display:inline-block}
.hiw h2{font-family:var(--font-serif,Georgia),Georgia,serif;font-size:21px;font-weight:600;color:var(--ink);margin:0}
.hiw .kick{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.09em;color:var(--s400);margin:0}
.hiw section{margin-top:34px;scroll-margin-top:16px}
.hiw .card{background:#fff;border:1px solid var(--s200);border-radius:14px;padding:22px 24px;margin-top:12px}
.hiw .mono{font-family:ui-monospace,Menlo,monospace;font-size:12.5px}
.hiw .formula{background:var(--s50);border:1px solid var(--s100);border-radius:9px;padding:11px 15px;font-size:13.5px;color:var(--ink)}
.hiw p{margin:0 0 10px}
.hiw b,.hiw strong{font-weight:700}
.hiw i,.hiw em{font-style:italic}

.hiw .flow{display:flex;align-items:stretch;gap:0;flex-wrap:wrap}
.hiw .stage{flex:1;min-width:120px;border:1px solid var(--s200);border-radius:11px;padding:12px;background:#fff;position:relative;text-align:center}
.hiw .stage .n{font-size:10px;color:var(--s400);font-weight:700}
.hiw .stage .t{font-weight:700;color:var(--ink);font-size:13px;margin:2px 0 3px}
.hiw .stage .d{font-size:11px;color:var(--s500);line-height:1.4}
.hiw .arrow{display:flex;align-items:center;justify-content:center;color:var(--s300);font-size:20px;padding:0 3px;flex:0 0 22px}
.hiw .lane{display:flex;flex-direction:column;gap:8px;flex:1.2;min-width:150px}
.hiw .lane .stage{text-align:left}
.hiw .badge{display:inline-block;font-size:10px;font-weight:700;border-radius:5px;padding:1px 6px}
.hiw .b-det{background:var(--detbg);color:var(--det)}
.hiw .b-llm{background:var(--llmbg);color:var(--llm)}
.hiw .b-adv{background:var(--advbg);color:var(--adv)}
.hiw .planebar{margin-top:14px;border:1px dashed var(--advline);background:var(--advbg);border-radius:11px;padding:12px 15px}
.hiw .planebar .t{font-weight:700;color:var(--adv);font-size:13px;margin-top:5px}
.hiw .planebar .d{font-size:12px;color:var(--s600);margin:0}

.hiw .drow{display:flex;align-items:center;gap:12px;margin:9px 0}
.hiw .dname{width:150px;font-size:13px;color:var(--s700);font-weight:600}
.hiw .dbar{flex:1;height:20px;background:var(--s100);border-radius:6px;overflow:hidden;position:relative}
.hiw .dfill{height:100%;border-radius:6px;display:flex;align-items:center;justify-content:flex-end;padding-right:8px;color:#fff;font-size:11px;font-weight:700}
.hiw .dfrom{font-size:11.5px;color:var(--s500);flex:1.3}

.hiw .ladder{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px}
.hiw .rung{border-radius:9px;padding:8px 13px;font-weight:700;font-size:13px}
.hiw .rung.a{background:var(--Abg);color:var(--A)} .hiw .rung.b{background:var(--Bbg);color:var(--B)}
.hiw .rung.c{background:var(--Cbg);color:var(--C)} .hiw .rung.d{background:var(--Dbg);color:var(--D)}
.hiw .rung.e{background:var(--Ebg);color:var(--E)}

.hiw .grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.hiw .mini{border:1px solid var(--s200);border-radius:11px;padding:13px 15px;background:#fff}
.hiw .mini h4{margin:0 0 4px;font-size:13.5px;color:var(--ink)}
.hiw .mini ul{margin:6px 0 0;padding-left:17px;font-size:12.5px;color:var(--s600);list-style:disc}
.hiw .mini li{margin:3px 0}

.hiw .planes{display:grid;grid-template-columns:1fr 22px 1fr;gap:0;align-items:stretch;margin-top:6px}
.hiw .plane{border-radius:12px;padding:15px 17px}
.hiw .p-scored{background:#fff;border:2px solid var(--s200)}
.hiw .p-adv{background:var(--advbg);border:2px solid var(--advline)}
.hiw .plane h4{margin:0 0 2px;font-size:14px;color:var(--ink)}
.hiw .plane .sub{font-size:11px;color:var(--s500);margin-bottom:8px}
.hiw .plane ul{margin:0;padding-left:16px;font-size:12px;color:var(--s600);list-style:disc}
.hiw .firewall{display:flex;align-items:center;justify-content:center;color:var(--s400);font-weight:700;writing-mode:vertical-rl;font-size:10px;letter-spacing:.1em}

.hiw .life{display:flex;align-items:center;gap:0;margin-top:8px;flex-wrap:wrap}
.hiw .lstep{border:1px solid var(--advline);background:#fff;border-radius:9px;padding:8px 12px;text-align:center;flex:1;min-width:120px}
.hiw .lstep b{color:var(--adv);font-size:13px}
.hiw .lstep span{font-size:11px;color:var(--s500);display:block}

.hiw .tl{margin-top:14px;padding-left:0}
.hiw .ev{position:relative;padding:0 0 4px 22px;margin-left:8px;border-left:2px solid var(--s200)}
.hiw .ev:last-child{border-left-color:transparent}
.hiw .dot{position:absolute;left:-8px;top:2px;width:13px;height:13px;border-radius:50%;border:2px solid #fff;box-shadow:0 0 0 1.5px var(--s300);background:#fff}
.hiw .dot.score{background:var(--C);box-shadow:0 0 0 1.5px var(--C)}
.hiw .dot.meta{background:var(--s300);box-shadow:0 0 0 1.5px var(--s300)}
.hiw .evhead{display:flex;flex-wrap:wrap;gap:8px;align-items:baseline}
.hiw .ver{font-family:ui-monospace,Menlo,monospace;font-size:12px;font-weight:700;color:var(--ink);background:var(--s100);border-radius:5px;padding:1px 7px}
.hiw .dt{font-size:11.5px;color:var(--s400)}
.hiw .sc{font-size:10px;font-weight:700;border-radius:4px;padding:1px 6px;background:var(--Cbg);color:var(--C)}
.hiw .mt{font-size:10px;font-weight:700;border-radius:4px;padding:1px 6px;background:var(--s100);color:var(--s500)}
.hiw .evtitle{font-size:13px;color:var(--s700);margin:3px 0 14px}
.hiw .legend{display:flex;gap:16px;font-size:11.5px;color:var(--s500);margin:2px 0 4px;flex-wrap:wrap}
.hiw .legend .sw{width:11px;height:11px;border-radius:50%;display:inline-block;vertical-align:middle;margin-right:5px}
.hiw .note{font-size:12px;color:var(--s500)}

.hiw .clog{list-style:none;margin:6px 0 0;padding:0}
.hiw .clog>li{padding:14px 0;border-top:1px solid var(--s100)}
.hiw .clog>li:first-child{border-top:0}
.hiw .clog.sep{opacity:.62}
.hiw .clog .head{display:flex;flex-wrap:wrap;gap:8px;align-items:baseline}
.hiw .clog .plain{font-size:13.5px;font-weight:600;color:var(--ink);margin:6px 0 0}
.hiw details.detail{margin-top:6px}
.hiw details.detail>summary{cursor:pointer;font-size:11.5px;color:var(--s500);list-style:none}
.hiw details.detail>summary::-webkit-details-marker{display:none}
.hiw details.detail>summary:hover{color:var(--brand)}
.hiw details.detail[open]>summary{color:var(--s600);margin-bottom:6px}
.hiw .detail .dtitle{font-size:12px;font-weight:600;color:var(--s600);margin:4px 0 2px}
.hiw .detail ul{margin:2px 0 0;padding-left:16px;font-size:11.5px;color:var(--s500);list-style:disc}
.hiw .detail li{margin:2px 0}
.hiw .detail .why{font-size:11.5px;font-style:italic;color:var(--s400);margin:6px 0 0}

.hiw a.inl{color:var(--brand);text-decoration:none}
.hiw a.inl:hover{text-decoration:underline}

@media(max-width:820px){
  .hiw .shell{grid-template-columns:1fr}
  .hiw nav.toc{display:none}
  .hiw main.body{padding:0 0 40px}
  .hiw .grid2{grid-template-columns:1fr}
  .hiw .planes{grid-template-columns:1fr}
  .hiw .firewall{writing-mode:horizontal-tb;padding:6px 0}
}
`;

export default async function HowItWorksPage() {
  const admin = await isAdminUnlocked();
  const care = await isCareUnlocked();
  if (!admin && !care) {
    return (
      <div>
        <h1 className="font-serif text-[26px] font-semibold text-slate-900">How the audit works</h1>
        <p className="mt-1.5 text-sm text-slate-500">
          Locked. Unlock an <Link href="/admin/opd-audit" className="text-brand hover:underline">admin surface</Link> or
          sign in as a <Link href="/care/login" className="text-brand hover:underline">care manager</Link> first.
        </p>
      </div>
    );
  }

  const w = OPD_DEFAULT_WEIGHTS;
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const ladder = deriveGradeLadder();
  const version = OPD_ENGINE_VERSION.split('/').pop() ?? OPD_ENGINE_VERSION;
  const pdqiList = PDQI9_ATTRS.map((a) => PDQI9_LABEL[a]).join(' · ');

  // timeline = the engine-versioned entries only; dots coloured by whether scores changed.
  const versioned = OPD_AUDIT_CHANGELOG.filter((c) => c.engine);
  const scoringVers = versioned.filter((c) => c.scoring).map((c) => c.engine);
  const behindVers = versioned.filter((c) => !c.scoring).map((c) => c.engine);
  const latestScoring = scoringVers[0];
  const prevScoring = scoringVers[1];
  const behindRange = behindVers.length ? `${behindVers[behindVers.length - 1]}–${behindVers[0]}` : '';

  return (
    <div className="hiw">
      <style dangerouslySetInnerHTML={{ __html: css }} />
      <div className="shell">
        <nav className="toc">
          <div className="navbrand serif">CAT · OPD Audit</div>
          <div className="tag">Guide</div>
          <a href="#top">Overview</a>
          <a href="#pipeline">1 · How a note flows through</a>
          <a href="#score">2 · How the score is worked out</a>
          <a href="#checks">3 · What we check</a>
          <a href="#framing">4 · Who&apos;s audited &amp; how it&apos;s framed</a>
          <a href="#rightcare">5 · Low-value care</a>
          <a href="#longitudinal">6 · The patient&apos;s history</a>
          <a href="#governance">7 · Review &amp; versions</a>
          <div className="tag">Living record</div>
          <a href="#history">8 · History of changes</a>
          <a href="#changelog">Full change log</a>
        </nav>

        <main className="body" id="top">
          <p className="kick">OPD Audit · The plain-language guide</p>
          <h1 className="serif">How the OPD note audit works</h1>
          <p className="lede">
            Every finalised OPD note from a clinician is read each day, has patient details removed, and is checked for
            documentation and prescribing quality. This guide covers it end to end: how a note flows through, how the score
            is worked out, everything we check, and a dated history of every change.
          </p>
          <p style={{ margin: '9px 0 0' }}><span className="vchip">version {version}</span></p>

          {/* 1 · PIPELINE */}
          <section id="pipeline">
            <p className="kick">Chapter 1 · The big picture</p>
            <h2 className="serif">How a note flows through the audit</h2>
            <div className="card">
              <div className="flow">
                <div className="stage"><div className="n">1 · READ IN</div><div className="t">The note</div><div className="d">The prescription plus the cleaned-up complaint, diagnosis and plan — <b>patient details removed</b></div></div>
                <div className="arrow">→</div>
                <div className="lane">
                  <div className="stage"><span className="badge b-det">fixed rules</span><div className="t" style={{ marginTop: 4 }}>Rule checks</div><div className="d">Record completeness · dosing · duplicate drugs · drug interactions · daily-dose limits · drug-safety facts — no AI</div></div>
                  <div className="stage"><span className="badge b-llm">AI</span><div className="t" style={{ marginTop: 4 }}>Clinical review</div><div className="d">Appropriateness · prescribing · note-quality rating — judged against your specialty, backed by references. It flags and rates; it never sets the score.</div></div>
                </div>
                <div className="arrow">→</div>
                <div className="stage"><div className="n">3 · FINDINGS</div><div className="t">Tag &amp; filter</div><div className="d">Each finding gets a stable label → known false-alarm types (approved by a person) are removed</div></div>
                <div className="arrow">→</div>
                <div className="stage"><div className="n">4 · SCORE</div><div className="t">5 areas → a number</div><div className="d">Simple, checkable maths → 0–100 → Grade A–E</div></div>
                <div className="arrow">→</div>
                <div className="stage"><div className="n">5 · WHERE IT GOES</div><div className="t">Surfaces</div><div className="d">Dashboards · the care-manager review queue · the quality team</div></div>
              </div>
              <div className="planebar">
                <span className="badge b-adv">runs alongside · information only</span>
                <div className="t">The patient&apos;s history — the chart before the visit</div>
                <div className="d">After scoring, we rebuild the patient&apos;s record as it stood on the day of the visit and check for repeated tests, medicines that need reconciling, and continuity of care. These are for information only — they never change the score (see Chapter 6).</div>
              </div>
            </div>
          </section>

          {/* 2 · SCORE */}
          <section id="score">
            <p className="kick">Chapter 2 · The score</p>
            <h2 className="serif">How the score is worked out</h2>
            <div className="card">
              <p style={{ marginTop: 0 }}><b>Five areas, each weighted.</b> The overall score is a weighted average of the areas that apply to the note.</p>
              {WEIGHT_ROWS.map((r) => (
                <div className="drow" key={r.domain}>
                  <span className="dname">{r.name}</span>
                  <div className="dbar"><div className="dfill" style={{ width: pct(w[r.domain]), background: r.color }}>{pct(w[r.domain])}</div></div>
                  <span className="dfrom">{r.from}</span>
                </div>
              ))}
              <div className="formula" style={{ marginTop: 12 }}><b>Overall score</b> = weighted average of the areas that apply &nbsp;→&nbsp; 0–100</div>

              <p style={{ marginBottom: 6, marginTop: 14 }}><b>How findings lower a score.</b> Appropriateness and Prescribing each start at 100. Every finding takes away a <i>share</i> of what&apos;s left — not a flat amount — so several findings lower the score gently rather than crashing it to zero. How big the cut is depends on how serious the finding is and how confident we are.</p>
              <div className="grid2" style={{ marginTop: 10 }}>
                <div className="mini">
                  <h4>How serious is a finding?</h4>
                  <ul>
                    {SEVERITY_TIERS.map((v) => (
                      <li key={v}><b>{v}</b> — {SEVERITY_COPY[v]}</li>
                    ))}
                  </ul>
                </div>
                <div className="mini">
                  <h4>Grades</h4>
                  <div className="ladder">
                    {ladder.map((g) => (
                      <span className={`rung ${BAND_STYLE[g.band]}`} key={g.band}>{g.band} · {g.lo}–{g.hi}</span>
                    ))}
                  </div>
                  <p className="note" style={{ marginTop: 8 }}>Some findings are for information only (high-alert drugs, Schedule X, look-alike/sound-alike pairs, off-formulary items) — shown, but they never change the score.</p>
                </div>
              </div>
            </div>
          </section>

          {/* 3 · CHECKS */}
          <section id="checks">
            <p className="kick">Chapter 3 · The checks</p>
            <h2 className="serif">What we check</h2>
            <div className="card">
              <div className="grid2">
                <div className="mini">
                  <h4><span className="badge b-det">fixed rules</span> No AI involved</h4>
                  <ul>
                    <li><b>Dosing complete?</b> — dose, frequency, route and duration, reading what the note actually says (a strength written into the drug name counts; route can come from the form). Supplements are exempt.</li>
                    <li><b>Duplicates</b> — the same drug prescribed twice, matched on the generic name, so brand-only duplicates are caught.</li>
                    <li><b>Drug interactions</b> — spots an NSAID even inside a combination, and treats a skin cream as milder than a tablet. The interaction and any duplicate-warning for the same pair are merged into one card.</li>
                    <li><b>Daily-dose limits</b> — adds a drug up across combination products; syrups measured in ml aren&apos;t mistaken for tablets. <span className="mono" style={{ color: 'var(--s400)' }}>(limits {DOSE_LIMITS_VERSION})</span></li>
                    <li><b>Drug-safety facts</b> — high-alert drugs, Schedule X, look-alike/sound-alike pairs, unverified brands.</li>
                    <li><b>System labels &amp; coding gaps</b> — if our own drug-class label is wrong, or an ICD code is missing, it&apos;s shown but doesn&apos;t affect the score.</li>
                  </ul>
                </div>
                <div className="mini">
                  <h4><span className="badge b-llm">AI</span> Clinical review, backed by references</h4>
                  <ul>
                    <li><b>Appropriateness</b> — low-value tests, treatments or referrals (Choosing Wisely / RAND framing).</li>
                    <li><b>Prescribing</b> — unsafe or unnecessary prescribing (WHO rational-prescribing framing); a note with no medicines gets none.</li>
                    <li><b>Note quality</b> — a validated {PDQI9_ATTRS.length}-point rating of the documentation; a short, correct note is never marked down for being brief.</li>
                    <li><b>Backed or labelled</b> — every finding is marked by its basis: supported by a reference, general clinical reasoning, or a fixed rule.</li>
                    <li><b>Specialty-aware</b> — judged against your own specialty&apos;s standards, kept current daily.</li>
                  </ul>
                  <p className="note" style={{ marginTop: 8 }}>The {PDQI9_ATTRS.length} note-quality points: {pdqiList}.</p>
                </div>
              </div>
            </div>
          </section>

          {/* 4 · FRAMING */}
          <section id="framing">
            <p className="kick">Chapter 4 · Scope</p>
            <h2 className="serif">Who&apos;s audited, and how it&apos;s framed</h2>
            <div className="card">
              <div className="grid2">
                <div className="mini"><h4>Who&apos;s included</h4><ul><li>Every finalised note on the six medical form types, each day.</li><li>In-house / non-clinician accounts (e.g. health-check or underwriting memos) are left out from the start; older ones are flagged and hidden, never deleted.</li></ul></div>
                <div className="mini"><h4>Phone vs in-person</h4><ul><li>Whether a note is treated as a teleconsult or an in-person visit sets what&apos;s expected — a teleconsult is never marked down for having no examination.</li><li>A documented hands-on examination always means in-person (you can&apos;t examine over video).</li></ul></div>
              </div>
              <p className="note" style={{ marginTop: 10 }}>The visit-type label comes first and the form name second — the form name is just paperwork.</p>
            </div>
          </section>

          {/* 5 · RIGHT CARE */}
          <section id="rightcare">
            <p className="kick">Chapter 5 · Low-value care</p>
            <h2 className="serif">Low-value care</h2>
            <div className="card">
              <p style={{ marginTop: 0 }}>Each low-value finding is tagged by type (antibiotic, imaging, supplement/polypharmacy, plus 8 new overuse types in this version) and counted as a <b>rate</b> — never turned into a second score.</p>
              <p style={{ marginBottom: 6 }}>Before comparing doctors, every patient is graded for <b>complexity</b> from their history in the 12 months <i>before</i> the visit:</p>
              <div className="formula">How many long-term conditions? &nbsp;·&nbsp; Several abnormal labs? &nbsp;·&nbsp; How often did they attend?<br />&nbsp;→&nbsp; complexity grade: <b>New · Low · Moderate · High</b></div>
              <p className="note" style={{ marginTop: 10 }}>The complexity grade deliberately leaves out the doctor&apos;s own prescribing — it uses only long-term diagnoses, excludes the visit being scored, and doesn&apos;t use Even&apos;s own risk rating. Each doctor is then compared to what their <i>own</i> case-mix predicts (observed vs expected), within the same specialty, on a control chart.</p>
            </div>
          </section>

          {/* 6 · LONGITUDINAL */}
          <section id="longitudinal">
            <p className="kick">Chapter 6 · The patient&apos;s history</p>
            <h2 className="serif">The patient&apos;s history — kept separate from the score</h2>
            <div className="card">
              <div className="planes">
                <div className="plane p-scored"><h4>The score</h4><div className="sub">the graded review · seen by governance</div><ul><li>The 5 areas → a number → a grade</li><li>Reviewed by the quality team</li><li>Judges this one visit</li></ul></div>
                <div className="firewall">KEPT SEPARATE</div>
                <div className="plane p-adv"><h4>The history</h4><div className="sub">the patient&apos;s record · information only</div><ul><li>The record as it stood before this visit (problems, medicines, labs)</li><li>Repeated tests, medicines to reconcile, continuity of care</li><li><b>Never changes the score</b>; reviewers only label it</li></ul></div>
              </div>
              <p style={{ margin: '14px 0 4px' }}><b>How a new history check earns its way into the score</b> — deliberately slow, so an unproven check never affects a doctor before it&apos;s shown to be reliable:</p>
              <div className="life">
                <div className="lstep"><b>proposed</b><span>a new idea for a check</span></div><div className="arrow">→</div>
                <div className="lstep"><b>information only</b><span>shown quietly; reviewers label it</span></div><div className="arrow">→</div>
                <div className="lstep"><b>passes the bar</b><span>wrong less than 1 in 5 times, over 50+ reviews</span></div><div className="arrow">→</div>
                <div className="lstep"><b>counts toward the score</b><span>only after a formal update</span></div>
              </div>
            </div>
          </section>

          {/* 7 · GOVERNANCE */}
          <section id="governance">
            <p className="kick">Chapter 7 · Review &amp; versions</p>
            <h2 className="serif">How a finding reaches a doctor, and why dashboards briefly empty</h2>
            <div className="card">
              <p style={{ marginTop: 0 }}><b>Why dashboards briefly empty after a change.</b> Each audit is stamped with the version that produced it, and dashboards only show the current version — scores from different rule-sets are never mixed. So a change that moves scores empties the dashboards until a background re-run re-checks recent notes (usually within a day). Display-only changes don&apos;t do this.</p>
              <div className="flow" style={{ marginTop: 6 }}>
                <div className="stage"><div className="t">AI finding</div></div><div className="arrow">→</div>
                <div className="stage"><div className="t">Care-manager review</div><div className="d">Is it valid? How important? Route it?</div></div><div className="arrow">→</div>
                <div className="stage"><div className="t">Filter false alarms</div><div className="d">known wrong-type findings removed</div></div><div className="arrow">→</div>
                <div className="stage"><div className="t">Quality team</div><div className="d">sees only what a care-manager chose to route</div></div>
              </div>
              <p className="note" style={{ marginTop: 10 }}>Nothing unreviewed reaches a doctor. History findings are information only and never enter this chain unless they&apos;re formally promoted.</p>
            </div>
          </section>

          {/* 8 · HISTORY */}
          <section id="history">
            <p className="kick">Chapter 8 · Living record</p>
            <h2 className="serif">History of changes</h2>
            <div className="legend" style={{ marginTop: 8 }}>
              <span><span className="sw" style={{ background: 'var(--C)' }} />changed scores (needs a re-run)</span>
              <span><span className="sw" style={{ background: 'var(--s300)' }} />behind-the-scenes / display only</span>
            </div>
            <div className="card">
              <div className="tl">
                {versioned.map((c) => (
                  <div className="ev" key={`${c.engine}-${c.date}`}>
                    <span className={`dot ${c.scoring ? 'score' : 'meta'}`} />
                    <div className="evhead">
                      <span className="ver">{c.engine}</span>
                      <span className="dt">{shortDate(c.date)}</span>
                      {c.scoring
                        ? <span className="sc">changed scores</span>
                        : <span className="mt">behind the scenes</span>}
                    </div>
                    <div className="evtitle">{headlineOf(c)}</div>
                  </div>
                ))}
              </div>
              {latestScoring && (
                <p className="note" style={{ marginTop: 6 }}>
                  Version {latestScoring} is the most recent change that moves scores{prevScoring ? ` — the first since ${prevScoring}` : ''}
                  {behindRange ? `; the versions in between (${behindRange}) were behind-the-scenes` : ''}. A few minor updates aren&apos;t
                  shown on this line but appear in the full change log below.
                </p>
              )}
            </div>
          </section>

          {/* FULL CHANGELOG */}
          <section id="changelog">
            <p className="kick">Living record</p>
            <h2 className="serif">Full change log</h2>
            <div className="card">
              <p className="note" style={{ marginTop: 0 }}>Every change in full — each one dated, with the reason behind it. The plain-language headline reads clearly for clinicians; the engineering detail sits underneath each entry.</p>
              <ul className="clog">
                {OPD_AUDIT_CHANGELOG.map((c) => {
                  const sep = isSeparateFeature(c);
                  return (
                    <li key={`${c.date}-${c.title}`} className={sep ? 'sep-row' : undefined} style={sep ? { opacity: 0.62 } : undefined}>
                      <div className="head">
                        <span className={c.engine ? 'ver' : 'mt'}>{c.engine ? `opd-note-audit/${c.engine}` : 'no bump'}</span>
                        <span className="dt">{c.date}</span>
                        {c.engine && (c.scoring
                          ? <span className="sc">changed scores</span>
                          : <span className="mt">behind the scenes</span>)}
                      </div>
                      <p className="plain">{headlineOf(c)}</p>
                      <details className="detail">
                        <summary>Technical detail</summary>
                        <p className="dtitle">{c.title}</p>
                        <ul>{c.points.map((p, i) => <li key={i}>{p}</li>)}</ul>
                        <p className="why">Why: {c.why}</p>
                      </details>
                    </li>
                  );
                })}
              </ul>
            </div>
          </section>

          <p className="note" style={{ marginTop: 22 }}>
            Every number on this page is imported from the live scoring code, so it cannot drift from what the audit
            actually does. <Link href="/admin/opd-audit" className="inl">Back to the OPD Audit dashboard</Link>
          </p>
        </main>
      </div>
    </div>
  );
}
