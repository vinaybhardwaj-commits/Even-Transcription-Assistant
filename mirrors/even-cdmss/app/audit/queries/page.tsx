import type { CSSProperties } from 'react';
import { redirect } from 'next/navigation';
import { auditAccessAllowed } from '@/lib/pharmacist-cookie';
import { sql } from '@/lib/db';

export const dynamic = 'force-dynamic';

interface Pair { a: string; b: string; severity: string; source: string }
interface Row {
  id: string; drugs: string[]; pairs: Pair[]; pair_count: number;
  sources: string[]; max_severity: string | null; created_at: string;
}

const sevColor = (s: string | null) =>
  s === 'major' || s === 'contraindicated' ? '#dc2626' : s === 'moderate' ? '#d97706' : '#64748b';

export default async function QueriesPage({ searchParams }: { searchParams: Promise<{ empty?: string }> }) {
  if (!(await auditAccessAllowed())) redirect('/audit/login');
  const sp = await searchParams;
  const onlyEmpty = sp?.empty === '1';

  try {
    await sql`CREATE TABLE IF NOT EXISTS ddi_query_log (
      id BIGSERIAL PRIMARY KEY, drugs JSONB NOT NULL, pairs JSONB DEFAULT '[]'::jsonb,
      pair_count INT DEFAULT 0, sources TEXT[] DEFAULT '{}', max_severity TEXT,
      app_source TEXT DEFAULT 'medaudit', created_at TIMESTAMPTZ DEFAULT NOW())`;
  } catch { /* ignore */ }

  const sumRows = (await sql`
    SELECT count(*)::int total,
           count(*) FILTER (WHERE pair_count > 0)::int with_hits,
           count(*) FILTER (WHERE pair_count = 0)::int no_hits,
           count(*) FILTER (WHERE max_severity IN ('major','contraindicated'))::int major_plus
    FROM ddi_query_log`) as { total: number; with_hits: number; no_hits: number; major_plus: number }[];
  const s = sumRows[0] || { total: 0, with_hits: 0, no_hits: 0, major_plus: 0 };

  const rows = (onlyEmpty
    ? await sql`SELECT id, drugs, pairs, pair_count, sources, max_severity, created_at FROM ddi_query_log WHERE pair_count = 0 ORDER BY created_at DESC LIMIT 300`
    : await sql`SELECT id, drugs, pairs, pair_count, sources, max_severity, created_at FROM ddi_query_log ORDER BY created_at DESC LIMIT 300`) as Row[];

  const card: CSSProperties = { background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, padding: '14px 16px', flex: 1 };
  const big: CSSProperties = { fontSize: 26, fontWeight: 800 };
  const lbl: CSSProperties = { fontSize: 11.5, color: '#64748b', textTransform: 'uppercase', letterSpacing: '.3px', fontWeight: 700 };

  return (
    <div style={{ minHeight: '100vh', background: '#f4f7fb', fontFamily: 'system-ui, -apple-system, sans-serif', color: '#0f172a' }}>
      <div style={{ background: '#fff', borderBottom: '1px solid #e2e8f0', padding: '13px 22px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 800, fontSize: 18 }}>Interaction Query Log</span>
          <span style={{ background: '#0f766e', color: '#fff', borderRadius: 999, padding: '3px 11px', fontSize: 11.5, fontWeight: 800 }}>CLINICAL PHARMACIST</span>
          <a href="/audit" style={{ marginLeft: 'auto', color: '#1d4ed8', fontSize: 13, fontWeight: 700, textDecoration: 'none' }}>← Back to audit</a>
        </div>
        <div style={{ color: '#64748b', fontSize: 12, marginTop: 4 }}>Every interaction check is logged (drug names only — no patient data) so you can spot misses and false alerts and tune the rules.</div>
      </div>

      <div style={{ maxWidth: 1180, margin: '0 auto', padding: '18px 22px 80px' }}>
        <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
          <div style={card}><div style={lbl}>Total checks</div><div style={big}>{s.total}</div></div>
          <div style={card}><div style={lbl}>With interaction(s)</div><div style={{ ...big, color: '#16a34a' }}>{s.with_hits}</div></div>
          <div style={card}><div style={lbl}>No interaction found</div><div style={{ ...big, color: '#64748b' }}>{s.no_hits}</div><div style={{ fontSize: 11, color: '#94a3b8' }}>review for misses</div></div>
          <div style={card}><div style={lbl}>Major / contraindicated</div><div style={{ ...big, color: '#dc2626' }}>{s.major_plus}</div></div>
        </div>

        <div style={{ marginBottom: 12, fontSize: 13 }}>
          <a href="/audit/queries" style={{ fontWeight: onlyEmpty ? 400 : 800, color: '#1d4ed8', textDecoration: 'none', marginRight: 14 }}>All checks</a>
          <a href="/audit/queries?empty=1" style={{ fontWeight: onlyEmpty ? 800 : 400, color: '#1d4ed8', textDecoration: 'none' }}>No interaction found (miss-hunting)</a>
        </div>

        <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f8fafc', textAlign: 'left', color: '#475569', fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '.3px' }}>
                <th style={{ padding: '9px 12px' }}>When</th>
                <th style={{ padding: '9px 12px' }}>Drugs checked</th>
                <th style={{ padding: '9px 12px' }}>Interactions found</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={3} style={{ padding: 16, color: '#94a3b8', fontStyle: 'italic' }}>No checks logged yet.</td></tr>
              )}
              {rows.map((r) => (
                <tr key={r.id} style={{ borderTop: '1px solid #eef2f7', verticalAlign: 'top' }}>
                  <td style={{ padding: '9px 12px', color: '#64748b', whiteSpace: 'nowrap' }}>{new Date(r.created_at).toLocaleString()}</td>
                  <td style={{ padding: '9px 12px', fontWeight: 600 }}>{(r.drugs || []).join(', ')}</td>
                  <td style={{ padding: '9px 12px' }}>
                    {r.pair_count === 0
                      ? <span style={{ color: '#94a3b8' }}>none</span>
                      : (r.pairs || []).map((p, i) => (
                        <div key={i} style={{ marginBottom: 2 }}>
                          <span style={{ fontWeight: 700, color: sevColor(p.severity) }}>{p.severity.toUpperCase()}</span>
                          {' '}{p.a} + {p.b} <span style={{ color: '#94a3b8', fontSize: 11.5 }}>({p.source})</span>
                        </div>
                      ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ color: '#94a3b8', fontSize: 11.5, marginTop: 10 }}>Showing the most recent {rows.length} checks. Auth is a single shared pharmacist token, so checks aren&apos;t attributed per user yet.</div>
      </div>
    </div>
  );
}
