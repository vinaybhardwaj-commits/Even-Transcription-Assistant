"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { PinPad } from "@/components/PinPad";

type Props = {
  slug: string;
  doctorName: string;
};

type State =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "error"; message: string; attemptsRemaining?: number }
  | { kind: "locked"; retryAfterSeconds: number; message: string }
  | { kind: "disabled" }
  | { kind: "success" };

export function DoctorPinClient({ slug, doctorName }: Props) {
  const router = useRouter();
  const [state, setState] = React.useState<State>({ kind: "idle" });
  const [shakeCounter, setShakeCounter] = React.useState(0);

  const submit = async (pin: string) => {
    setState({ kind: "submitting" });
    try {
      const r = await fetch("/api/auth/pin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, pin }),
      });
      const j = await r.json();
      if (r.ok) {
        setState({ kind: "success" });
        // Force a server-side re-render so the home shell loads
        router.refresh();
        return;
      }
      const code = j?.error?.code as string | undefined;
      if (code === "PIN_LOCKED") {
        setState({
          kind: "locked",
          retryAfterSeconds: j.error.retry_after_seconds ?? 0,
          message: j.error.message ?? "Account locked",
        });
      } else if (code === "FORBIDDEN") {
        setState({ kind: "disabled" });
      } else {
        setShakeCounter((n) => n + 1);
        setState({
          kind: "error",
          message: j?.error?.message ?? "Incorrect PIN",
          attemptsRemaining: j?.error?.attempts_remaining,
        });
      }
    } catch (e) {
      setShakeCounter((n) => n + 1);
      setState({ kind: "error", message: "Network error. Try again." });
    }
  };

  const disabled = state.kind === "submitting" || state.kind === "locked" || state.kind === "disabled" || state.kind === "success";

  return (
    <>
      <p className="text-label text-even-navy-800 mb-1">Welcome back</p>
      <p className="text-body text-even-ink-700 mb-6">
        {doctorName ? `Dr ${doctorName.replace(/^Dr\.?\s+/i, "")} \u00B7 ` : ""}Enter your 4-digit PIN
      </p>

      <PinPad onComplete={submit} disabled={disabled} errorShake={shakeCounter} />

      {state.kind === "error" && (
        <p className="mt-6 text-caption text-danger-700 text-center" role="alert">
          {state.message}
          {typeof state.attemptsRemaining === "number" && state.attemptsRemaining <= 2 && state.attemptsRemaining > 0 && (
            <> ({state.attemptsRemaining} attempt{state.attemptsRemaining === 1 ? "" : "s"} remaining)</>
          )}
        </p>
      )}
      {state.kind === "locked" && (
        <p className="mt-6 text-caption text-warning-700 text-center" role="alert">
          {state.message}
        </p>
      )}
      {state.kind === "disabled" && (
        <p className="mt-6 text-caption text-danger-700 text-center" role="alert">
          This account is currently disabled. Please contact your administrator.
        </p>
      )}
      {state.kind === "submitting" && (
        <p className="mt-6 text-caption text-even-ink-500 text-center">Checking\u2026</p>
      )}
    </>
  );
}
