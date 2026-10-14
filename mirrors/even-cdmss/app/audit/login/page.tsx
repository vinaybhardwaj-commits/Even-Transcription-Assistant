'use client';
import { useState } from 'react';

export default function AuditLogin() {
  const [token, setToken] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      const r = await fetch('/api/audit/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (r.ok) { window.location.href = '/audit'; return; }
      const d = await r.json().catch(() => ({}));
      setErr(d.error || 'Login failed');
    } catch { setErr('Network error'); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: '#f4f7fb', fontFamily: 'system-ui, sans-serif' }}>
      <form onSubmit={submit} style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 14, padding: 28, width: 360 }}>
        <div style={{ fontWeight: 800, fontSize: 18 }}>Medication Audit</div>
        <div style={{ color: '#0f766e', fontWeight: 700, fontSize: 12, margin: '4px 0 18px' }}>CLINICAL PHARMACIST · EHRC</div>
        <label style={{ fontSize: 12, fontWeight: 700, color: '#64748b' }}>Access token</label>
        <input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoFocus
          style={{ width: '100%', padding: '9px 10px', border: '1px solid #e2e8f0', borderRadius: 9, margin: '6px 0 12px' }} />
        {err && <div style={{ color: '#dc2626', fontSize: 12.5, marginBottom: 10 }}>{err}</div>}
        <button type="submit" disabled={busy}
          style={{ width: '100%', border: 0, background: '#0f766e', color: '#fff', borderRadius: 10, padding: 11, fontWeight: 800, cursor: 'pointer' }}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
