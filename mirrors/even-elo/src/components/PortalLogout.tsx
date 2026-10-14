"use client";
export function PortalLogout() {
  async function logout() {
    await fetch("/api/portal/auth/logout", { method: "POST" });
    window.location.href = "/portal/login";
  }
  return <button onClick={logout} className="text-sm text-stone-500 hover:text-stone-900">Sign out</button>;
}
