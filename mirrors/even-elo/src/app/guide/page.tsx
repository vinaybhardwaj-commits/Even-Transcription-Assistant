import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import { TopNav } from "@/components/TopNav";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

const SOURCE_URL = "https://docs.google.com/document/d/1BBbTznasZSAgN_RR9oubvlfF1kqqN2JN8HBgWSRFQRI/edit";

type Item = { term: string; body: string };

function DefList({ items }: { items: Item[] }) {
  return (
    <div className="divide-y divide-stone-100">
      {items.map((it) => (
        <div key={it.term} className="py-3.5 grid grid-cols-1 sm:grid-cols-[200px_1fr] gap-1 sm:gap-5">
          <div className="text-sm font-semibold text-stone-800">{it.term}</div>
          <div className="text-[13.5px] text-stone-600 leading-relaxed">{it.body}</div>
        </div>
      ))}
    </div>
  );
}

function Section({ id, no, title, subtitle, children }: { id: string; no: string; title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24 bg-white border border-stone-200 rounded-xl p-6 sm:p-7">
      <div className="flex items-baseline gap-3 mb-1">
        <span className="text-[11px] font-semibold text-brand bg-brand/10 rounded-full px-2 py-0.5">{no}</span>
        <h2 className="text-[17px] font-semibold tracking-tight text-stone-900">{title}</h2>
      </div>
      <p className="text-[13px] text-stone-500 mb-4">{subtitle}</p>
      {children}
    </section>
  );
}

export default async function GuidePage() {
  const user = await getCurrentUser();
  if (!user) return null;

  return (
    <>
      <TopNav />
      <main className="max-w-[1000px] mx-auto px-8 py-8">
        <div className="mb-6">
          <div className="text-[11px] font-medium text-stone-400 tracking-wider uppercase mb-1">Reference</div>
          <h1 className="text-[22px] font-semibold tracking-tight">Credentialing &amp; Governance Guide</h1>
          <p className="text-sm text-stone-500 mt-1.5 max-w-2xl">
            How medical-staff categories, clinical privileges, and practice evaluations work in the Even Healthcare System —
            the framework behind the Credentialing, Feedback, and Surgical Governance modules.
          </p>
        </div>

        {/* On this page */}
        <nav className="flex flex-wrap gap-2 mb-6 text-[12px]">
          {[
            ["#categories", "1 · Staff categories"],
            ["#privileges", "2 · Clinical privileges"],
            ["#supervision", "3 · Supervision & review (FPPE / OPPE)"],
          ].map(([href, label]) => (
            <a key={href} href={href} className="px-3 py-1.5 rounded-full border border-stone-200 bg-white text-stone-600 hover:bg-stone-50 hover:text-stone-900 transition">{label}</a>
          ))}
        </nav>

        <div className="space-y-4">
          <Section id="categories" no="1" title="Medical staff categories" subtitle={`The "level" of a physician's involvement — their standing, independence, and administrative responsibilities.`}>
            <DefList items={[
              { term: "Provisional / Probationary", body: "Every new physician or surgeon starts here, regardless of experience. For the first 6–12 months their cases are proctored (closely observed) to confirm their skills match their credentials before full independence is granted." },
              { term: "Active / Attending", body: "Core physicians who regularly admit and treat patients. Full independent privileges; can vote on policies, take on-call shifts, attend department meetings, and serve on committees." },
              { term: "Visiting Consultant", body: "Fully qualified but only occasional users of the hospital (e.g. fewer than 5–10 patients a year). They treat independently but carry fewer administrative burdens and usually have no voting rights." },
              { term: "Affiliate / Referring", body: "Outpatient-only doctors. They can refer patients to the hospital and view their patients' records, but cannot treat patients or order tests inside the hospital." },
              { term: "Temporary / Locum Tenens", body: "Privileges granted for a strictly limited time — for example a travelling doctor covering maternity leave or a temporary staffing gap." },
            ]} />
          </Section>

          <Section id="privileges" no="2" title="Types of clinical privileges" subtitle={`The "what" — exactly which medical acts a physician is permitted to perform.`}>
            <DefList items={[
              { term: "Core privileges", body: "The standard bundle for a specialty, granted automatically on appointment. e.g. a General Surgeon's core privileges include appendectomy, gallbladder removal, and hernia repair." },
              { term: "Special / Non-core", body: "Advanced, high-risk, or novel procedures outside the standard bundle, needing extra proof of training and case volume — e.g. Da Vinci robotic surgery, bariatric procedures, or conscious sedation." },
              { term: "Emergency privileges", body: "In a life-or-death emergency, any privileged physician may do whatever is necessary to save a life, even if it falls outside their normal approved scope." },
              { term: "Disaster privileges", body: "Activated only in a mass-casualty event or disaster, letting the hospital rapidly grant temporary privileges to volunteer doctors from other facilities." },
            ]} />
          </Section>

          <Section id="supervision" no="3" title="Supervision & review statuses" subtitle="How the hospital watches over quality of care — formalised under Joint Commission practice.">
            <div className="space-y-4">
              <div id="fppe" className="scroll-mt-24 rounded-lg border border-amber-200 bg-amber-50/60 p-4">
                <div className="text-sm font-semibold text-amber-900">FPPE — Focused Professional Practice Evaluation</div>
                <p className="text-[13.5px] text-stone-700 leading-relaxed mt-1">
                  The formal term for <strong>care under supervision</strong>. Triggered when a doctor is newly hired, requests a brand-new
                  special privilege (e.g. learning a new surgical robot), or when a concern is raised about their clinical competence.
                  Another doctor directly observes or reviews a set number of their cases before independence is confirmed.
                </p>
              </div>
              <div id="oppe" className="scroll-mt-24 rounded-lg border border-sky-200 bg-sky-50/60 p-4">
                <div className="text-sm font-semibold text-sky-900">OPPE — Ongoing Professional Practice Evaluation</div>
                <p className="text-[13.5px] text-stone-700 leading-relaxed mt-1">
                  A <strong>continuous background review</strong> for every privileged doctor, no matter how senior. Complication rates,
                  mortality, and length-of-stay are reviewed every 6–8 months to confirm safe standards of independent care are being maintained.
                </p>
              </div>
              <div className="rounded-lg border border-stone-200 bg-white p-4">
                <div className="text-sm font-semibold text-stone-800">Suspended / Revoked privileges</div>
                <p className="text-[13.5px] text-stone-700 leading-relaxed mt-1">
                  If a physician repeatedly fails to meet standards, breaks hospital rules, or loses their licence, privileges are
                  <strong> suspended</strong> (temporarily halted pending investigation) or <strong>revoked</strong> (permanently removed).
                </p>
              </div>
            </div>
          </Section>
        </div>

        <div className="mt-6 text-[12px] text-stone-400">
          Source: <a href={SOURCE_URL} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">Physician Privileges in the Even Healthcare System</a>
          {" · "}<Link href="/home" className="text-brand hover:underline">Back to dashboard</Link>
        </div>
      </main>
    </>
  );
}
