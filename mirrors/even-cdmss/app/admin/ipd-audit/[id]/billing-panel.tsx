/**
 * app/admin/ipd-audit/[id]/billing-panel.tsx — S7, the billing slot of the audit report.
 * Server component; every ₹ here is a READ-TIME db13 join (lib/ipd-audit/billing.ts) on this
 * access-controlled view. Only the `billed_total` scalar is ever persisted.
 *
 * PALETTE (semantics): the ₹ chart uses the Clarity teal ramp for clinical categories and the
 * warm-neutral ramp for facility/admin overhead. It NEVER touches bandColor/scoreColor — the
 * A–E scored-band palette belongs to the Care-Value Index alone, and money is not a verdict.
 * lib/__tests__/ipd-audit-billing.test.ts asserts this.
 *
 * SCOPE (v1): display + COARSE category-level reconciliation. The line-item billed-vs-documented
 * audit is BILL-1 (v2) — nothing here adjudicates an individual bill line.
 */
import type { BillingEnvelope, Reconciliation, PeerBand } from '@/lib/ipd-audit/billing';

// Clinical = teal ramp (the Clarity accent). Facility/admin = warm neutrals: present in the ₹,
// deliberately recessive, because room rent is not a documentation question.
const CLINICAL_RAMP = ['#0f766e', '#2f9e8c', '#0b5f58', '#5cbfae', '#0a3f3a', '#8ed6c9'];
const FACILITY_RAMP = ['#a8a08f', '#c9c2b2', '#78715f', '#d4cfc1'];

const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;

const EVIDENCE_LABEL: Record<string, string> = {
  medications: 'medications',
  investigations: 'investigations',
  treatments: 'treatments',
  procedures: 'a procedure',
};

function colorFor(categories: BillingEnvelope['categories']) {
  let c = 0, f = 0;
  const map: Record<string, string> = {};
  for (const cat of categories) {
    map[cat.category] = cat.clinical
      ? CLINICAL_RAMP[c++ % CLINICAL_RAMP.length]
      : FACILITY_RAMP[f++ % FACILITY_RAMP.length];
  }
  return map;
}

/** The graceful empty state — ~8% of audited admissions have no kx billing record at all. */
export function NoEnvelope() {
  return (
    <div className="mt-5 rounded-xl border border-slate-200 bg-white">
      <div className="border-b border-slate-100 px-4 py-2.5 text-[13px] font-semibold text-slate-800">Billing envelope</div>
      <div className="px-4 py-3 text-[12px] text-slate-500">
        No linked billing record for this admission — the discharge document has no matching IP bill in db13.
        <span className="ml-1 text-slate-400">The audit above is unaffected; only the ₹ view needs the link.</span>
      </div>
    </div>
  );
}

export default function BillingPanel({ envelope, recon, peer }: {
  envelope: BillingEnvelope;
  recon: Reconciliation;
  peer: PeerBand | null;
}) {
  const color = colorFor(envelope.categories);
  const barTotal = envelope.categories.reduce((s, c) => s + Math.max(0, c.net), 0) || 1;
  const flagged = recon.scriptNotes;
  const matched = flagged.filter((s) => s.billed);
  const undetermined = flagged.length - matched.length;

  return (
    <div className="mt-5 rounded-xl border border-slate-200 bg-white">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-100 px-4 py-2.5">
        <span className="text-[13px] font-semibold text-slate-800">Billing envelope</span>
        <span className="text-[11px] text-slate-500">
          {envelope.lineCount} lines · {envelope.billCount} bill{envelope.billCount === 1 ? '' : 's'} · db13 read-time join
        </span>
      </div>

      {/* ₹ envelope — total + stacked categories */}
      <div className="px-4 py-3">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-serif text-[26px] font-semibold leading-none text-slate-900">{inr(envelope.netTotal)}</span>
          <span className="text-[11px] text-slate-500">billed, net</span>
          {envelope.refundTotal < 0 && (
            <span className="text-[11px] text-amber-700">{inr(Math.abs(envelope.refundTotal))} refunded · gross {inr(envelope.saleTotal)}</span>
          )}
        </div>
        {/* 17/1,475 admissions net ≤ ₹0 — refunds exceeding sales, or a zero-rated stay. Real, and
            rare enough that a reader will otherwise read it as a bug. */}
        {envelope.netTotal <= 0 && (
          <div className="mt-1 text-[11px] text-amber-700">
            This admission nets to {inr(envelope.netTotal)} — refunds meet or exceed what was billed. Rare but real
            (~1% of admissions); it is excluded from peer bands rather than distorting them.
          </div>
        )}

        <div className="mt-2.5 flex h-3.5 w-full overflow-hidden rounded-full bg-slate-100">
          {envelope.categories.filter((c) => c.net > 0).map((c) => (
            <div
              key={c.category}
              title={`${c.category} — ${inr(c.net)} · ${c.lines} lines`}
              style={{ width: `${(c.net / barTotal) * 100}%`, background: color[c.category] }}
            />
          ))}
        </div>

        <div className="mt-2.5 space-y-1">
          {envelope.categories.map((c) => (
            <div key={c.category} className="flex items-center gap-2 text-[12px]">
              <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: color[c.category] }} />
              <span className="min-w-0 flex-1 truncate text-slate-700">
                {c.category}
                {!c.clinical && <span className="ml-1.5 text-[10px] text-slate-400">facility / admin</span>}
              </span>
              <span className="text-[11px] text-slate-400">{c.lines}</span>
              <span className="w-20 text-right tabular-nums text-slate-800">{inr(c.net)}</span>
              <span className="w-9 text-right text-[10.5px] tabular-nums text-slate-400">
                {Math.round((Math.max(0, c.net) / barTotal) * 100)}%
              </span>
            </div>
          ))}
        </div>

        {envelope.wardClasses.length > 0 && (
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <span className="text-[10.5px] text-slate-400">ward class:</span>
            {envelope.wardClasses.map((w) => (
              <span key={w.label} className="rounded-full border border-slate-200 px-1.5 py-0.5 text-[10.5px] text-slate-600">
                {w.label} · {inr(w.net)}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* documented-vs-billed — COARSE, category level */}
      <div className="border-t border-slate-100 px-4 py-3">
        <div className="flex items-baseline justify-between">
          <span className="text-[12px] font-semibold text-slate-600">Documented vs billed</span>
          <span className="text-[10.5px] text-slate-400">
            {recon.packaged && <span className="mr-1.5 rounded bg-slate-100 px-1.5 py-0.5 font-medium text-slate-600">packaged</span>}
            category level · {recon.reconciledCategories} clinical categories
          </span>
        </div>

        {recon.billedNotDocumented.length === 0 && recon.documentedNotBilled.length === 0 ? (
          <div className="mt-1 text-[12px] text-slate-500">
            Every billed clinical category is accounted for in the summary, and vice versa.
          </div>
        ) : (
          <div className="mt-1.5 space-y-1.5">
            {recon.billedNotDocumented.map((g) => (
              <div key={g.category} className="rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11.5px] text-amber-900">
                <b>{g.category}</b> billed ({inr(g.net)} · {g.lines} line{g.lines === 1 ? '' : 's'}) but the summary does not document {EVIDENCE_LABEL[g.evidence]}.
              </div>
            ))}
            {recon.documentedNotBilled.map((d) => (
              <div key={d.evidence} className="rounded-lg border border-sky-200 bg-sky-50 px-2.5 py-1.5 text-[11.5px] text-sky-900">
                Summary documents {EVIDENCE_LABEL[d.evidence]} but no {d.categories.join(' / ')} line is billed.
              </div>
            ))}
          </div>
        )}
        <div className="mt-1.5 text-[10.5px] leading-relaxed text-slate-400">
          Documented side = this summary’s own NABH completeness fields. A gap is a question, not a verdict —
          it can mean an under-documented summary or a mis-categorised bill line. Line-item adjudication is
          out of scope for this view.
          {recon.packaged && (
            <> This admission is <b>package-billed</b>: a bundled IP Package line covers the clinical care, so a
            missing category line proves nothing — the documented-but-not-billed direction is suppressed here.</>
          )}
        </div>
      </div>

      {/* Flagged items vs the bill — POSITIVE matches only. The kickoff wanted a "billed line vs
          discharge script" note; measurement says the SCRIPT half is not computable here (findings
          name classes/themes, the bill names molecules, item_category is ~12% populated), so we
          assert only what the bill proves and call the rest undetermined. See billing.ts. */}
      {flagged.length > 0 && (
        <div className="border-t border-slate-100 px-4 py-3">
          <div className="flex items-baseline justify-between">
            <span className="text-[12px] font-semibold text-slate-600">Flagged items found on the bill</span>
            <span className="text-[10.5px] text-slate-400">{matched.length} of {flagged.length} flagged</span>
          </div>
          {matched.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {matched.map((s) => (
                <span
                  key={s.subject}
                  title={`matched a billed pharmacy line by ${s.via} — this flag carries ₹ in this admission`}
                  className="rounded-full border border-slate-300 bg-slate-50 px-2 py-0.5 text-[11px] text-slate-700"
                >
                  {s.subject}
                  <span className="ml-1 text-[9.5px] uppercase tracking-wide text-slate-400">billed · {s.via}</span>
                </span>
              ))}
            </div>
          )}
          {undetermined > 0 && (
            <div className="mt-1.5 text-[10.5px] leading-relaxed text-slate-400">
              The other {undetermined} flagged item{undetermined === 1 ? '' : 's'} could not be matched to a bill line —
              which is <b>not</b> evidence they went unbilled. Findings name drug classes and themes while the bill names
              molecules, and only ~12% of pharmacy lines carry a drug class, so the “discharge script, costs nothing”
              read is not decidable from this data. Reliable matching needs a semantic pass (BILL-1, v2).
            </div>
          )}
        </div>
      )}

      {/* peer band — from the audited corpus's own billed_totals */}
      <div className="border-t border-slate-100 px-4 py-3">
        <div className="flex items-baseline justify-between">
          <span className="text-[12px] font-semibold text-slate-600">Peer context</span>
          {peer && <span className="text-[10.5px] text-slate-400">{peer.speciality} · n={peer.n} audited</span>}
        </div>
        {!peer || !peer.ready ? (
          <div className="mt-1 text-[12px] text-slate-500">
            {inr(envelope.netTotal)} billed · peer band building{peer && peer.n > 0 ? ` — only ${peer.n} audited peer${peer.n === 1 ? '' : 's'} in this speciality so far` : ' — no audited peers in this speciality yet'}.
          </div>
        ) : (
          <PeerBar net={envelope.netTotal} peer={peer} />
        )}
      </div>
    </div>
  );
}

/** This episode's ₹ against the audited-peer quartile band. Neutral ink — not a scored verdict. */
function PeerBar({ net, peer }: { net: number; peer: PeerBand }) {
  const max = Math.max(peer.p75, net) * 1.12 || 1;
  const pos = (v: number) => `${Math.min(100, (v / max) * 100)}%`;
  const vsMedian = peer.median > 0 ? Math.round(((net - peer.median) / peer.median) * 100) : null;

  return (
    <div className="mt-2">
      <div className="relative h-7 w-full rounded-md bg-slate-100">
        {/* p25–p75 band */}
        <div
          className="absolute inset-y-0 rounded-md bg-brand/15"
          style={{ left: pos(peer.p25), width: `calc(${pos(peer.p75)} - ${pos(peer.p25)})` }}
          title={`peer p25–p75: ${inr(peer.p25)} – ${inr(peer.p75)}`}
        />
        {/* median */}
        <div className="absolute inset-y-0 w-px bg-brand/60" style={{ left: pos(peer.median) }} title={`peer median ${inr(peer.median)}`} />
        {/* this episode */}
        <div className="absolute inset-y-1 w-[3px] rounded-sm bg-slate-800" style={{ left: pos(net) }} title={`this episode ${inr(net)}`} />
      </div>
      <div className="mt-1.5 flex flex-wrap items-baseline gap-x-3 text-[11px]">
        <span className="text-slate-800"><b>{inr(net)}</b> this episode</span>
        <span className="text-slate-500">peer median {inr(peer.median)}</span>
        <span className="text-slate-400">p25–p75 {inr(peer.p25)} – {inr(peer.p75)}</span>
        {vsMedian != null && (
          <span className={vsMedian > 0 ? 'text-slate-600' : 'text-slate-500'}>
            {vsMedian > 0 ? '+' : ''}{vsMedian}% vs median
          </span>
        )}
      </div>
      <div className="mt-1 text-[10.5px] text-slate-400">
        Band = quartiles of {peer.n} audited {peer.speciality} admissions with a linked bill — a working reference from
        what we have audited, not a case-mix-adjusted benchmark.
      </div>
    </div>
  );
}
