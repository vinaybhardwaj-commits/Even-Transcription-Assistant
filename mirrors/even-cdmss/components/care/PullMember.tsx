'use client';

// Care-manager entry: search a member by Member ID, phone, name, individual UID, or UHID
// ("same as Pulse search") → pick from the matches → open their brief. Replaces the old
// prescription-uid-only box that 404'd on every member-level identifier.
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search, Loader2, ArrowRight, Phone, Hash, Clock } from 'lucide-react';

interface EpisodeLite { uid: string; type: string; date: string | null }
interface MemberHit {
  individualUid: string; name: string; gender: string | null; age: number | null;
  mobile: string | null; uhid: string | null; membershipId: string | null;
  episodeCount: number; lastVisit: string | null; latestEpisodeUid: string | null;
  recentEpisodes: EpisodeLite[];
}

const prettyType = (t: string) => (t || '').replace(/^HOSPITAL_/, '').replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
const prettyPhone = (m: string | null) => (m ? m.replace(/^(\+91)(\d{5})(\d{5})$/, '$1 $2 $3') : '');

export default function PullMember() {
  const [q, setQ] = useState('');
  const [members, setMembers] = useState<MemberHit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const router = useRouter();
  const seq = useRef(0);

  async function run(query: string) {
    const term = query.trim();
    if (term.length < 2) { setMembers(null); setErr(''); return; }
    const mine = ++seq.current;
    setLoading(true); setErr('');
    try {
      const resp = await fetch(`/api/ccb/search?q=${encodeURIComponent(term)}`);
      if (mine !== seq.current) return; // a newer keystroke superseded this one
      if (!resp.ok) { setErr(`Search failed (${resp.status})`); setMembers([]); return; }
      const j = await resp.json();
      setMembers(Array.isArray(j.members) ? j.members : []);
    } catch (e) {
      if (mine === seq.current) { setErr(String((e as Error).message)); setMembers([]); }
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }

  // Debounced live search.
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setMembers(null); setErr(''); setLoading(false); return; }
    const h = setTimeout(() => { run(term); }, 350);
    return () => clearTimeout(h);
  }, [q]);

  function openMember(individualUid: string) { router.push(`/care/m/${encodeURIComponent(individualUid)}`); }
  function openEpisode(uid: string) { router.push(`/care/${encodeURIComponent(uid)}`); }

  return (
    <div>
      <form onSubmit={(e) => { e.preventDefault(); run(q); }} className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoFocus
          placeholder="Search by Member ID, phone, name, or UHID"
          className="w-full rounded-lg border border-slate-200 py-2.5 pl-9 pr-10 text-[13px] outline-none focus:border-teal-400"
        />
        {loading && <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-teal-500" />}
      </form>

      {err && <p className="mt-2 text-[12px] text-red-600">{err}</p>}

      {members && members.length === 0 && !loading && !err && (
        <p className="mt-3 text-[12.5px] text-slate-400">No members found for “{q.trim()}”. Try a Member ID, 10-digit phone, full name, or UHID.</p>
      )}

      {members && members.length > 0 && (
        <ul className="mt-3 space-y-2">
          {members.map((m) => {
            return (
              <li key={m.individualUid} className="rounded-xl border border-slate-200 bg-white p-3.5 hover:border-teal-300">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[14px] font-semibold text-slate-900">{m.name}</span>
                      {(m.gender || m.age != null) && (
                        <span className="text-[12px] text-slate-500">
                          {[m.gender ? m.gender[0].toUpperCase() + m.gender.slice(1).toLowerCase() : null, m.age != null ? `${m.age}y` : null].filter(Boolean).join(' · ')}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-slate-500">
                      {m.mobile && <span className="inline-flex items-center gap-1"><Phone className="h-3 w-3" />{prettyPhone(m.mobile)}</span>}
                      {m.uhid && <span className="inline-flex items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 text-slate-600">{m.uhid}</span>}
                      {m.membershipId && <span className="inline-flex items-center gap-1"><Hash className="h-3 w-3" />{m.membershipId}</span>}
                    </div>
                    <div className="mt-1.5 flex items-center gap-1 text-[12px] text-slate-500">
                      <Clock className="h-3 w-3" />
                      {m.episodeCount > 0
                        ? <span>{m.episodeCount} OPD visit{m.episodeCount === 1 ? '' : 's'} · last {m.lastVisit || '—'}</span>
                        : <span className="text-slate-400">No OPD episode yet</span>}
                    </div>
                  </div>
                  <button
                    onClick={() => openMember(m.individualUid)}
                    className="shrink-0 inline-flex items-center gap-1 rounded-lg bg-teal-600 px-3 py-2 text-[12.5px] font-medium text-white hover:bg-teal-700"
                  >
                    Open record <ArrowRight className="h-3.5 w-3.5" />
                  </button>
                </div>

                {m.recentEpisodes.length > 1 && (
                  <div className="mt-2 flex flex-wrap gap-1.5 border-t border-slate-100 pt-2">
                    <span className="text-[11px] text-slate-400">Recent:</span>
                    {m.recentEpisodes.map((e) => (
                      <button key={e.uid} onClick={() => openEpisode(e.uid)}
                        className="rounded-full border border-slate-200 px-2 py-0.5 text-[11px] text-slate-600 hover:border-teal-300 hover:text-teal-700">
                        {e.date || '—'} · {prettyType(e.type)}
                      </button>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
