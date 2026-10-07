"use client";
import { useState } from "react";
import { GROUND } from "@/lib/rooms-live/present";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "⌫"];

export default function LoginScreen() {
  const [pin, setPin] = useState("");
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const press = (k: string) => {
    setErr(null);
    if (k === "⌫") setPin((p) => p.slice(0, -1));
    else if (k && pin.length < 12) setPin((p) => p + k);
  };
  const submit = async () => {
    if (busy) return;
    if (!name.trim()) return setErr("Type your name first.");
    if (!pin) return setErr("Enter the PIN.");
    setBusy(true);
    try {
      const res = await fetch("/api/rooms-live/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin, name: name.trim() }) });
      if (res.ok) {
        window.location.reload();
        return;
      }
      setPin("");
      setErr(res.status === 429 ? "Too many tries. Wait a minute." : res.status === 503 ? "Staff login is not set up yet. Tell the ETA team." : "That PIN or name did not work.");
    } catch {
      setErr("Can't reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main style={{ background: GROUND, minHeight: "100vh", display: "flex", justifyContent: "center", padding: 16, fontFamily: '"Atkinson Hyperlegible Next", "Atkinson Hyperlegible", system-ui, -apple-system, "Segoe UI", sans-serif', color: "#22262B" }}>
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }} style={{ width: "100%", maxWidth: 360, marginTop: 24 }}>
        <h1 style={{ fontSize: 28, margin: "0 0 4px" }}>Rooms</h1>
        <p style={{ margin: "0 0 16px", color: "#4F535A", fontSize: 15 }}>Sign in to see the OPD rooms.</p>
        <label htmlFor="rl-name" style={{ fontSize: 15, fontWeight: 700 }}>Your name</label>
        <input id="rl-name" value={name} onChange={(e) => setName(e.target.value.slice(0, 64))} autoComplete="name" style={{ width: "100%", boxSizing: "border-box", minHeight: 48, fontSize: 18, padding: "0 12px", margin: "6px 0 16px", borderRadius: 10, border: "1px solid #C9CBCF" }} />
        <div aria-live="polite" aria-label="PIN" style={{ minHeight: 48, display: "flex", alignItems: "center", justifyContent: "center", gap: 10, background: "#fff", borderRadius: 10, border: "1px solid #C9CBCF", marginBottom: 12 }}>
          {pin.length === 0 ? <span style={{ color: "#6B6F76", fontSize: 15 }}>PIN</span> : [...pin].map((_, i) => <span key={i} aria-hidden="true" style={{ width: 14, height: 14, borderRadius: 14, background: "#22262B" }} />)}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
          {KEYS.map((k, i) =>
            k === "" ? <span key={i} /> : (
              <button key={i} type="button" onClick={() => press(k)} aria-label={k === "⌫" ? "Delete" : k} style={{ minHeight: 60, fontSize: 24, fontWeight: 700, borderRadius: 12, border: "1px solid #C9CBCF", background: "#fff", color: "#22262B", cursor: "pointer" }}>{k}</button>
            ),
          )}
        </div>
        {err ? <p role="alert" style={{ color: "#9E2A1E", fontSize: 15, margin: "12px 0 0" }}>{err}</p> : null}
        <button type="submit" disabled={busy} style={{ width: "100%", minHeight: 56, marginTop: 16, fontSize: 18, fontWeight: 700, borderRadius: 12, border: "none", background: "#1D6B57", color: "#fff", cursor: busy ? "default" : "pointer", opacity: busy ? 0.7 : 1 }}>{busy ? "Checking…" : "Sign in"}</button>
      </form>
    </main>
  );
}
