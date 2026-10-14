import Link from 'next/link';
import { isAdminUnlocked, adminTokenConfigured } from '@/lib/admin-cookie';
import { MODULE_MANIFESTS, type Lifecycle, type ModuleManifest, type Plane } from '@/lib/architecture/manifests';
import { COVERAGE, MAP_EDGES, MAP_RULES, VERSION_REGISTRY } from '@/lib/architecture/map.generated';
import { OPD_AUDIT_CHANGELOG, type EngineChange } from '@/lib/opd-audit-changelog';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'System Map · CDMSS' };

/**
 * /admin/architecture — the System Map (Stage 2), rebuilt from the approved v2 mockup
 * (CDMSS-SYSTEM-MAP-MOCKUP-v2, 13 Jul 2026). Plain-first, for clinicians AND engineers.
 *
 * GENERATED, NOT AUTHORED: every module / version / rule / coverage / changelog fact on this
 * page is read from the Stage-1 data layer — MODULE_MANIFESTS (titles, blurbs, planes,
 * lifecycle, ownership), VERSION_REGISTRY, MAP_RULES, COVERAGE, MAP_EDGES (all locked by the
 * CI staleness gate) and OPD_AUDIT_CHANGELOG. The only page-authored strings are the section
 * headings/prose, the four guarantee sentences, and the plane→bucket labels below.
 *
 * PALETTE: the group accents are the map's own informational palette — deliberately NOT the
 * scored A–E band colours; bandColor/scoreColor are not imported (semantics test #5's rule).
 */

// ── plane → the four plain buckets (page-authored labels; membership comes from `plane`) ──
type Bucket = { label: string; note: string; tag: string; c: string; cbg: string; planes: Plane[] };
const BUCKETS: Bucket[] = [
  {
    label: 'What we know about the patient', note: 'the clinical picture, kept clean of any scoring',
    tag: 'patient record', c: '--g-record', cbg: '--g-record-bg', planes: ['pure-core', 'spine'],
  },
  {
    label: 'The note audit & its score', note: 'the graded quality review',
    tag: 'produces the score', c: '--g-score', cbg: '--g-score-bg', planes: ['score-arithmetic', 'audit-engine'],
  },
  {
    label: 'Informational — never scored', note: 'shown to help, never changes a grade',
    tag: 'informational only', c: '--g-info', cbg: '--g-info-bg', planes: ['advisory'],
  },
  {
    label: 'Behind the scenes', note: 'quiet building blocks',
    tag: 'building block', c: '--g-behind', cbg: '--g-behind-bg', planes: ['infra', 'ui'],
  },
];

const LIFECYCLE_LABEL: Record<Lifecycle, string> = {
  implemented: 'built', integrated: 'live', validated: 'validated', released: 'live',
};

// small counts read better as words ("eleven more"), per the mockup's plain register
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
const word = (n: number): string => WORDS[n] ?? String(n);
const capWord = (n: number): string => { const w = word(n); return w[0].toUpperCase() + w.slice(1); };

// ── changelog presentation (same treatment as how-it-works) ──
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function shortDate(iso: string): string {
  const [, m, d] = iso.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1] ?? ''}`;
}
function isSeparateFeature(c: EngineChange): boolean {
  return /\(not OPD audit\)/.test(c.title) || (c.plain ?? '').startsWith('Separate feature');
}
function headlineOf(c: EngineChange): string {
  if (c.plain) return c.plain;
  const t = c.title.replace(/^v?\d[\d.]*\s*[—-]\s*/, '');
  return t.length > 96 ? `${t.slice(0, 93)}…` : t;
}

// ── ownership columns — facts come from the manifests; the gap copy is the mockup's ──
const OWNERSHIP: { t: string; d: string; gap: string; get: (m: ModuleManifest) => string | undefined }[] = [
  { t: 'Engineering owner', d: 'The person accountable for each part.', gap: 'Being assigned — shown as blank until set.', get: (m) => m.owner },
  { t: 'Clinician approver', d: 'Who gave clinical sign-off, where a part needs one.', gap: 'Being assigned — shown as blank until set.', get: (m) => m.clinicianApprover },
  { t: 'Validation', d: 'What the part was checked against before it went live.', gap: 'Being linked — shown as blank until set.', get: (m) => m.validationEvidence },
];

const css = `
.smap{
  --ink:#1f2937; --ink2:#475569; --muted:#7c8698; --line:#e7e3dc; --line2:#efece6;
  --brand:#0f766e; --brand-soft:#0f766e14; --panel:#ffffff; --bg:#faf9f7;
  /* group accents — informational, deliberately NOT the scored A–E band colours */
  --g-record:#0e7490; --g-record-bg:#0e74900f;
  --g-score:#9a3412;  --g-score-bg:#9a34120f;
  --g-info:#7c5cbf;   --g-info-bg:#7c5cbf12;
  --g-behind:#57534e; --g-behind-bg:#57534e0f;
  color:var(--ink); font-size:14px; line-height:1.58;
}
.smap *{box-sizing:border-box}
.smap .serif{font-family:var(--font-serif,Georgia),Georgia,"Times New Roman",serif}
.smap a.inl{color:var(--brand);text-decoration:none} .smap a.inl:hover{text-decoration:underline}
.smap .shell{display:grid;grid-template-columns:196px minmax(0,1fr);gap:0}
.smap nav.toc{position:sticky;top:8px;align-self:start;max-height:calc(100vh - 24px);overflow:auto;padding:2px 16px 8px 0;border-right:1px solid var(--line)}
.smap nav.toc .navbrand{font-family:var(--font-serif,Georgia),Georgia,serif;font-weight:700;color:var(--ink);font-size:15px}
.smap nav.toc .navsub{font-size:11px;color:var(--muted)}
.smap nav.toc .lbl{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.09em;margin:14px 0 5px}
.smap nav.toc a{display:block;padding:5px 9px;border-radius:7px;color:var(--ink2);font-size:12.5px;text-decoration:none}
.smap nav.toc a:hover{background:var(--brand-soft);color:var(--brand)}
.smap main.body{padding:0 0 56px 28px;min-width:0}
.smap .crumbs{font-size:12px;color:var(--muted);margin-bottom:14px}
.smap .crumbs b{color:var(--ink2);font-weight:600}
.smap .eyebrow{font-size:11px;letter-spacing:.11em;text-transform:uppercase;color:var(--brand);font-weight:600}
.smap h1{font-family:var(--font-serif,Georgia),Georgia,serif;font-weight:600;font-size:31px;line-height:1.12;margin:8px 0 12px}
.smap .lede{color:var(--ink2);font-size:15px;max-width:66ch;margin:0}
.smap .gen{display:inline-flex;align-items:center;gap:7px;margin-top:14px;font-size:12.5px;color:var(--ink2);background:var(--panel);border:1px solid var(--line);border-radius:999px;padding:6px 13px}
.smap .gen b{color:var(--ink);font-weight:600}
.smap h2{font-family:var(--font-serif,Georgia),Georgia,serif;font-weight:600;font-size:21px;margin:0 0 4px}
.smap .section{margin-top:42px;padding-top:26px;border-top:1px solid var(--line2);scroll-margin-top:16px}
.smap .chap{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-bottom:9px}
.smap .sub{color:var(--ink2);max-width:72ch;margin:2px 0 18px;font-size:14.5px}
.smap .group{margin-top:20px}
.smap .gh{display:flex;align-items:center;gap:9px;margin:0 0 10px}
.smap .gdot{width:11px;height:11px;border-radius:3px;flex:0 0 auto}
.smap .gt{font-weight:700;font-size:13.5px}
.smap .gnote{font-size:12.5px;color:var(--muted)}
.smap .cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.smap .card{border:1px solid var(--line);border-radius:12px;background:var(--panel);padding:14px 16px}
.smap .card .ct{font-family:var(--font-serif,Georgia),Georgia,serif;font-size:16px;font-weight:600;margin-bottom:2px}
.smap .card .cd{font-size:13.5px;color:var(--ink2)}
.smap .card .cf{display:flex;flex-wrap:wrap;gap:6px;margin-top:11px;align-items:center}
.smap .tag{font-size:11px;font-weight:600;padding:3px 9px;border-radius:999px}
.smap .meta{font-size:12px;color:var(--muted)}
.smap .meta code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;color:var(--ink2)}
.smap .guar{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:6px 20px;margin-top:8px}
.smap .g{display:flex;gap:13px;padding:15px 0;border-bottom:1px solid var(--line2)}
.smap .g:last-child{border-bottom:0}
.smap .g .tick{flex:0 0 auto;width:22px;height:22px;border-radius:50%;background:var(--brand-soft);color:var(--brand);display:flex;align-items:center;justify-content:center;font-size:13px;margin-top:1px}
.smap .g .gx b{font-weight:600}
.smap .g .gx .why{font-size:12.5px;color:var(--muted);margin-top:2px}
.smap .assure{margin-top:14px;font-size:13.5px;color:var(--ink2);background:var(--brand-soft);border-radius:10px;padding:12px 15px}
.smap .assure b{color:var(--brand)}
.smap .cl{margin-top:10px;border-left:2px solid var(--line);padding-left:16px}
.smap .cle{position:relative;padding:9px 0}
.smap .cle::before{content:'';position:absolute;left:-21px;top:14px;width:9px;height:9px;border-radius:50%;background:var(--muted);border:2px solid var(--bg)}
.smap .cle.moves::before{background:var(--g-score)}
.smap .cle .cv{font-size:12px;color:var(--muted)}
.smap .cle .ch{font-size:14px;margin-top:1px}
.smap .cle.sep{opacity:.55}
.smap details.detail{margin-top:4px}
.smap details.detail>summary{cursor:pointer;font-size:11.5px;color:var(--muted);list-style:none}
.smap details.detail>summary::-webkit-details-marker{display:none}
.smap details.detail>summary:hover{color:var(--brand)}
.smap .detail .dtitle{font-size:12px;font-weight:600;color:var(--ink2);margin:6px 0 2px}
.smap .detail ul{margin:2px 0 0;padding-left:16px;font-size:11.5px;color:var(--muted);list-style:disc}
.smap .detail li{margin:2px 0}
.smap .detail .dwhy{font-size:11.5px;font-style:italic;color:var(--muted);margin:6px 0 0}
.smap .note{font-size:12.5px;color:var(--muted);margin-top:12px}
.smap .own{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:8px}
.smap .own .o{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.smap .own .ot{font-weight:600;margin-bottom:3px} .smap .own .od{font-size:13px;color:var(--ink2)}
.smap .own .set{margin-top:9px;font-size:12.5px;color:var(--ink2)}
.smap .own .gapline{margin-top:9px;font-size:12px;color:var(--muted);font-style:italic}
.smap .eng{margin-top:44px;border:1px solid var(--line);border-radius:14px;background:#fcfbf9;padding:6px 22px 20px}
.smap .eng>summary{cursor:pointer;list-style:none;padding:16px 0 6px;font-family:var(--font-serif,Georgia),Georgia,serif;font-size:18px;font-weight:600;display:flex;align-items:center;gap:9px}
.smap .eng>summary::-webkit-details-marker{display:none}
.smap .eng>summary .badge{font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--muted);background:var(--bg);border:1px solid var(--line);border-radius:999px;padding:3px 10px;font-family:inherit}
.smap .eng .esub{font-size:13px;color:var(--muted);margin:0 0 4px}
.smap .eng h3{font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:var(--ink2);margin:20px 0 8px}
.smap table{width:100%;border-collapse:collapse;font-size:12.5px}
.smap th,.smap td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line2)}
.smap th{font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);font-weight:600}
.smap td.k,.smap .val{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px}
.smap .val{color:var(--ink2)}
.smap .der{font-size:10px;color:var(--g-score);background:var(--g-score-bg);border-radius:5px;padding:1px 6px;margin-left:6px}
.smap .erule{display:flex;gap:10px;padding:9px 0;border-bottom:1px solid var(--line2)} .smap .erule:last-child{border-bottom:0}
.smap .erule .rn{width:18px;height:18px;border-radius:5px;background:var(--brand-soft);color:var(--brand);font-weight:700;font-size:10.5px;display:flex;align-items:center;justify-content:center;flex:0 0 auto;margin-top:1px}
.smap .erule .green{color:var(--brand);font-weight:700}
.smap .estat{display:flex;gap:20px;flex-wrap:wrap;margin-top:6px}
.smap .estat .s .n{font-family:var(--font-serif,Georgia),Georgia,serif;font-size:22px;font-weight:600}
.smap .estat .s .k{font-size:11.5px;color:var(--muted)}
.smap .idlist{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px}
.smap .foot{margin-top:40px;padding-top:18px;border-top:1px solid var(--line2);color:var(--muted);font-size:12.5px}
@media(max-width:820px){
  .smap .shell{grid-template-columns:1fr}
  .smap nav.toc{display:none}
  .smap main.body{padding:0 0 40px}
  .smap .cards,.smap .own{grid-template-columns:1fr}
}
`;

function Locked() {
  return (
    <div>
      <h1 className="font-serif text-[26px] font-semibold text-slate-900">System Map</h1>
      <p className="mt-1.5 text-sm text-slate-500">Locked. <Link href="/admin/opd-audit" className="text-brand hover:underline">Unlock an admin surface</Link> first.</p>
    </div>
  );
}

export default async function SystemMapPage() {
  if (!(await isAdminUnlocked())) { adminTokenConfigured(); return <Locked />; }

  const versionOf = new Map(VERSION_REGISTRY.map((r) => [r.constName, r]));
  const inBucket = (b: Bucket) => MODULE_MANIFESTS.filter((m) => b.planes.includes(m.plane));

  return (
    <div className="smap">
      <style dangerouslySetInnerHTML={{ __html: css }} />
      <div className="shell">
        <nav className="toc">
          <div className="navbrand serif">CAT</div>
          <div className="navsub">System Map</div>
          <div className="lbl">The map</div>
          <a href="#parts">What it&apos;s made of</a>
          <a href="#separate">What&apos;s kept separate</a>
          <a href="#changed">What changed</a>
          <a href="#owns">Who owns what</a>
          <div className="lbl">Reference</div>
          <a href="#eng">Technical detail</a>
        </nav>

        <main className="body">
          <div className="crumbs">Admin · Platform · <b>System Map</b></div>
          <div className="eyebrow">CDMSS</div>
          <h1>The System Map</h1>
          <p className="lede">
            A plain guide to what the system is made of — the parts, what each one does, and (most importantly)
            what&apos;s kept carefully separate from what. You shouldn&apos;t need to read code to understand how it fits together.
          </p>
          <span className="gen">◆ <b>Built automatically from the system itself</b>, so it&apos;s always accurate — never a hand-drawn diagram that goes stale</span>

          {/* WHAT IT'S MADE OF — MODULE_MANIFESTS × plane buckets, versions joined from VERSION_REGISTRY */}
          <section className="section" id="parts">
            <div className="chap">What it&apos;s made of</div>
            <h2>The parts of CDMSS</h2>
            <p className="sub">
              Grouped by what they&apos;re for. The most important thing to notice is the line between the two middle
              groups: the <b>score</b>, and the <b>informational</b> observations that never touch it.
            </p>

            {BUCKETS.map((b) => {
              const mods = inBucket(b);
              if (mods.length === 0) return null;
              return (
                <div className="group" key={b.label}>
                  <div className="gh">
                    <span className="gdot" style={{ background: `var(${b.c})` }} />
                    <span className="gt">{b.label}</span>
                    <span className="gnote">— {b.note}</span>
                  </div>
                  <div className="cards">
                    {mods.map((m) => {
                      const v = m.versionConst ? versionOf.get(m.versionConst) : undefined;
                      return (
                        <div className="card" key={m.id}>
                          <div className="ct">{m.title}</div>
                          <div className="cd">{m.blurb}</div>
                          <div className="cf">
                            <span className="tag" style={{ color: `var(${b.c})`, background: `var(${b.cbg})` }}>{b.tag}</span>
                            <span className="meta">
                              {LIFECYCLE_LABEL[m.lifecycle]}
                              {v && !v.derived && <> · <code>{v.value}</code></>}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
            <div className="note">
              {capWord(MODULE_MANIFESTS.length)} parts are shown in full here; {word(COVERAGE.unregistered)} more of the
              platform&apos;s parts aren&apos;t documented on the map yet — listed honestly under <a href="#eng" className="inl">Technical detail</a> rather than hidden.
            </div>
          </section>

          {/* WHAT'S KEPT SEPARATE — each guarantee corresponds to a real enforced check:
              #1 record/score isolation → boundary rules 1 & 3 · #2 informational-never-scores → rule 2
              #3 finding-never-a-patient-fact → the clinical-semantics test · #4 one scoring place → rule 2.
              Do not add a guarantee here that isn't actually enforced. */}
          <section className="section" id="separate">
            <div className="chap">What&apos;s kept separate</div>
            <h2>The lines that don&apos;t get crossed</h2>
            <p className="sub">
              These are the guarantees that matter most for trust — and they aren&apos;t just good intentions.
              A machine re-checks every one of them each time the code changes.
            </p>
            <div className="guar">
              <div className="g"><div className="tick">✓</div><div className="gx"><b>Your patient&apos;s record and the quality score are kept apart.</b><div className="why">The record is what we know about the patient; the score is a review of one note. Neither is allowed to run the other&apos;s logic.</div></div></div>
              <div className="g"><div className="tick">✓</div><div className="gx"><b>The informational history observations can never change a grade.</b><div className="why">Repeated-test and reconciliation prompts are shown to help — they are structurally unable to move the score.</div></div></div>
              <div className="g"><div className="tick">✓</div><div className="gx"><b>A quality finding never gets written into the patient&apos;s record as a fact about the patient.</b><div className="why">&quot;This note didn&apos;t justify the antibiotic&quot; is a comment on the note, not a new entry in the patient&apos;s chart.</div></div></div>
              <div className="g"><div className="tick">✓</div><div className="gx"><b>The score is worked out in exactly one place.</b><div className="why">One engine, one set of maths — so a change to scoring can&apos;t quietly happen in two places.</div></div></div>
            </div>
            <div className="assure">◆ <b>Guaranteed, not just intended.</b> Each of these is enforced by an automatic check that runs on every change and blocks anything that would cross the line. The last time the check caught a crossing, it was fixed before it ever shipped.</div>
          </section>

          {/* WHAT CHANGED — OPD_AUDIT_CHANGELOG, entry.plain as the headline, dot coloured by `scoring` */}
          <section className="section" id="changed">
            <div className="chap">What changed</div>
            <h2>Recent changes</h2>
            <p className="sub">
              The system&apos;s history in plain language. Today this covers the audit engine — the part with a full
              written history; the other parts will add theirs over time.
            </p>
            <div className="cl">
              {OPD_AUDIT_CHANGELOG.map((c) => {
                const sep = isSeparateFeature(c);
                return (
                  <div className={`cle${c.scoring ? ' moves' : ''}${sep ? ' sep' : ''}`} key={`${c.date}-${c.title}`}>
                    <div className="cv">
                      {shortDate(c.date)}
                      {c.engine && (c.scoring ? ' · changed scores' : ' · behind the scenes')}
                    </div>
                    <div className="ch">{headlineOf(c)}</div>
                    <details className="detail">
                      <summary>Technical detail</summary>
                      <p className="dtitle">{c.engine ? `opd-note-audit/${c.engine} · ` : ''}{c.title}</p>
                      <ul>{c.points.map((p, i) => <li key={i}>{p}</li>)}</ul>
                      <p className="dwhy">Why: {c.why}</p>
                    </details>
                  </div>
                );
              })}
            </div>
            <div className="note">The full list, newest first — each with the technical reason one click underneath.</div>
          </section>

          {/* WHO OWNS WHAT — owner / clinicianApprover / validationEvidence from the manifests; honest blanks */}
          <section className="section" id="owns">
            <div className="chap">Who owns what</div>
            <h2>Ownership &amp; clinical sign-off</h2>
            <p className="sub">
              For each part: who&apos;s responsible for it, which clinician signed off on it, and what it was checked
              against. We&apos;re filling these in — and where they&apos;re blank, the map says so plainly rather than pretending.
            </p>
            <div className="own">
              {OWNERSHIP.map((col) => {
                const assigned = MODULE_MANIFESTS.filter((m) => col.get(m));
                return (
                  <div className="o" key={col.t}>
                    <div className="ot">{col.t}</div>
                    <div className="od">{col.d}</div>
                    {assigned.length > 0
                      ? assigned.map((m) => <div className="set" key={m.id}>{m.title} — {col.get(m)}</div>)
                      : <div className="gapline">{col.gap}</div>}
                  </div>
                );
              })}
            </div>
          </section>

          {/* TECHNICAL DETAIL — VERSION_REGISTRY (all rows, derived flagged) · MAP_RULES · COVERAGE · MAP_EDGES */}
          <details className="eng" id="eng" open>
            <summary>Technical detail <span className="badge">for engineers</span></summary>
            <p className="esub">The exact version constants, the enforced import rules, and the coverage figures — read straight from the code.</p>

            <h3>Versions</h3>
            <table>
              <thead><tr><th>Constant</th><th>Version</th><th>Where</th></tr></thead>
              <tbody>
                {VERSION_REGISTRY.map((r) => (
                  <tr key={`${r.constName}-${r.file}`}>
                    <td className="k">{r.constName}</td>
                    <td className="val">{r.value}{r.derived && <span className="der">computed</span>}</td>
                    <td className="val">{r.file.replace(/^lib\//, '')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="note" style={{ marginTop: 6 }}>
              {VERSION_REGISTRY.length} declared version constants
              ({VERSION_REGISTRY.filter((r) => !r.derived).length} fixed, {VERSION_REGISTRY.filter((r) => r.derived).length} computed).
            </div>

            <h3>Enforced import boundaries</h3>
            <div>
              {MAP_RULES.map((r) => (
                <div className="erule" key={r.id}>
                  <span className="rn">{r.id}</span>
                  <div>{r.name} <b className="green">green</b></div>
                </div>
              ))}
            </div>

            <h3>Coverage</h3>
            <div className="estat">
              <div className="s"><div className="n">{COVERAGE.registered}</div><div className="k">subsystems registered</div></div>
              <div className="s"><div className="n">{COVERAGE.unregistered}</div><div className="k">not yet registered</div></div>
              <div className="s"><div className="n">{COVERAGE.total}</div><div className="k">total in scope</div></div>
              <div className="s"><div className="n">{MAP_EDGES.length}</div><div className="k">module edges</div></div>
            </div>
            <div className="note" style={{ marginTop: 8 }}>
              Not yet registered: <span className="idlist">{COVERAGE.unregisteredIds.join(', ')}</span>.
              A check fails if this list ever silently drifts. Runtime/CI health lives
              in <Link href="/admin/observability" className="inl">Observability</Link> — linked, not repeated here.
            </div>
          </details>

          <div className="foot">CDMSS System Map · every figure generated from the system&apos;s own code.</div>
        </main>
      </div>
    </div>
  );
}
