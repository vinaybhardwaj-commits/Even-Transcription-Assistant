import Link from "next/link";

export default function PendingPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-stone-50 px-4">
      <div className="w-full max-w-[480px] bg-white border border-stone-200 rounded-xl p-8 text-center">
        <div className="w-12 h-12 rounded-full bg-amber-50 mx-auto flex items-center justify-center mb-4">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#92400e" strokeWidth="2">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v6l4 2" />
          </svg>
        </div>
        <h1 className="text-lg font-semibold tracking-tight mb-2">Awaiting admin approval</h1>
        <p className="text-sm text-stone-500 leading-relaxed mb-6">
          Your account has been created and is pending review by a Super Admin.
          You&apos;ll be able to sign in once it&apos;s activated.
        </p>
        <Link href="/auth/login" className="text-sm text-brand font-medium">
          Back to sign in
        </Link>
      </div>
    </div>
  );
}
