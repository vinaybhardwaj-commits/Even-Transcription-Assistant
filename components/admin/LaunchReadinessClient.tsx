"use client";

/**
 * LaunchReadinessClient — Sprint 12 page rendering PRD §10.1's nine
 * launch-day correctness criteria. Pulls live from /api/admin/launch-
 * readiness. Lets V toggle the manual offline-test attestation.
 */
import * as React from "react";
import { Button } from "@/components/ui/Button";

type Criterion = {
  id: string;
  label: string;
  target: string;
  current: string;
  status: "pass" | "fail" | "manual" | "skipped" | "info";
  detail: string;
  doc_anchor: string;
};
type Bundle = {
  criteria: Criterion[];
  overall: { pass: number; fail: number; manual: number; skipped: number; info: number };
  attestation: { audio_offline_test_passed: boolean; audio_offline_test_at: string | null };
};

export function LaunchReadinessClient() {
  const [data, setData] = React.useState<Bundle | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [banner, setBanner] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/launch-readiness", { cache: "no-store" });
      const j = await res.json();
      if (!res.ok) throw new Error((j as { error?: { message?: string } }).error?.message ?? `http_${res.status}`);
      setData(j as Bundle);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);
  React.useEffect(() => { void load(); }, [load]);

  const toggleAttestation = async (next: boolean) => {
    setSubmitting(true);
    try {
      const res = await fetch("/api/admin/launch-readiness", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passed: next }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error((j as { error?: { message?: string } }).error?.message ?? `http_${res.status}`);
      setBanner(next ? "✓ Audio offline test marked passed." : "Attestation cleared.");
      await load();
    } catch (e) {
      setBanner(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading && !data) return <p className="text-body text-even-ink-500">Computing criteria…</p>;
  if (error) return <div className="rounded-md border border-danger-500 bg-danger-100/40 p-3 text-body text-danger-700">Could not load: {error}</div>;
  if (!data) return null;

  const blockingFailures = data.overall.fail;
  const manualPending = data.overall.manual;
  const launchReady = blockingFailures === 0 && manualPending === 0;

  return (
    <div className="space-y-6">
      {/* Overall verdict */}
      <div className={`rounded-xl border p-5 ${
        launchReady
          ? "border-success-500/40 bg-success-100/40"
          : blockingFailures > 0
          ? "border-danger-500/40 bg-danger-100/40"
          : "border-amber-300 bg-amber-50"
      }`}>
        <p className={`text-heading font-semibold ${
          launchReady ? "text-success-700" :
          blockingFailures > 0 ? "text-danger-700" : "text-amber-800"
        }`}>
          {launchReady ? "✅ Ready to launch" :
           blockingFailures > 0 ? `⚠ ${blockingFailures} criterion${blockingFailures === 1 ? "" : "a"} not yet met` :
           `◔ ${manualPending} manual attestation${manualPending === 1 ? "" : "s"} pending`}
        </p>
        <p className="text-caption text-even-ink-700 mt-1">
          {data.overall.pass} pass · {data.overall.fail} fail · {data.overall.manual} manual ·
          {" "}{data.overall.skipped} no-data · {data.overall.info} architectural
        </p>
      </div>

      {banner ? (
        <div className="rounded-md border border-even-blue-300 bg-even-blue-50 p-3 text-body text-even-navy-800 flex items-center justify-between">
          <span>{banner}</span>
          <button type="button" onClick={() => setBanner(null)} className="text-caption text-even-ink-500 hover:underline">Dismiss</button>
        </div>
      ) : null}

      {/* Criteria table */}
      <div className="rounded-xl border border-even-ink-100 bg-even-white overflow-hidden">
        <table className="w-full text-left">
          <thead className="text-[10px] uppercase tracking-[0.14em] text-even-ink-500 bg-even-ink-50/40 border-b border-even-ink-100">
            <tr>
              <th className="px-4 py-2.5 font-semibold w-12">#</th>
              <th className="px-4 py-2.5 font-semibold">Criterion</th>
              <th className="px-4 py-2.5 font-semibold">Target</th>
              <th className="px-4 py-2.5 font-semibold">Current</th>
              <th className="px-4 py-2.5 font-semibold">Status</th>
            </tr>
          </thead>
          <tbody className="text-body">
            {data.criteria.map((c, i) => (
              <tr key={c.id} className="border-t border-even-ink-100 align-top">
                <td className="px-4 py-3 text-caption text-even-ink-400">{i + 1}</td>
                <td className="px-4 py-3">
                  <p className="text-even-navy-800 font-medium">{c.label}</p>
                  <p className="text-caption text-even-ink-500 mt-0.5">{c.detail}</p>
                  <p className="text-[10px] font-mono text-even-ink-400 mt-1">PRD {c.doc_anchor}</p>
                  {c.id === "audio_data_loss" ? (
                    <div className="mt-3">
                      {data.attestation.audio_offline_test_passed ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => void toggleAttestation(false)}
                          disabled={submitting}
                        >
                          Clear attestation
                        </Button>
                      ) : (
                        <div className="space-y-2">
                          <p className="text-caption text-even-ink-700">
                            Manual test procedure: open doctor app → tap Record → put
                            phone in airplane mode → record 60s → re-enable network →
                            confirm transcript reaches Whisper-cleaned state without
                            audio gaps.
                          </p>
                          <Button
                            variant="primary"
                            size="sm"
                            onClick={() => void toggleAttestation(true)}
                            disabled={submitting}
                          >
                            ✓ Attest test passed
                          </Button>
                        </div>
                      )}
                    </div>
                  ) : null}
                </td>
                <td className="px-4 py-3 text-caption text-even-ink-700 font-mono whitespace-nowrap">{c.target}</td>
                <td className="px-4 py-3 text-caption text-even-ink-800 font-mono whitespace-nowrap">{c.current}</td>
                <td className="px-4 py-3"><StatusPill status={c.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-caption text-even-ink-500">
        Auto-refresh on page load only. Use the browser refresh to recompute.
      </p>
    </div>
  );
}

function StatusPill({ status }: { status: Criterion["status"] }) {
  const map = {
    pass:    { cls: "bg-success-100/60 text-success-700 border-success-500/40", label: "✓ PASS" },
    fail:    { cls: "bg-danger-100/60 text-danger-700 border-danger-500/40",    label: "✕ FAIL" },
    manual:  { cls: "bg-amber-100 text-amber-800 border-amber-300",             label: "◔ MANUAL" },
    skipped: { cls: "bg-even-ink-100 text-even-ink-500 border-even-ink-200",    label: "— NO DATA" },
    info:    { cls: "bg-even-blue-100 text-even-blue-700 border-even-blue-300", label: "ⓘ INFO" },
  };
  const { cls, label } = map[status];
  return <span className={`inline-block px-2 py-0.5 rounded-full border text-[10px] font-bold ${cls}`}>{label}</span>;
}
