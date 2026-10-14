"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";

export interface UserSummary {
  email: string;
  full_name: string;
  position_label: string;
  hospital_code: string;
  is_super_admin: boolean;
  is_sgc_member: boolean;
  is_site_medical_head?: boolean;
}

const AVATAR_COLORS = [
  "bg-teal-100 text-teal-800",
  "bg-orange-100 text-orange-800",
  "bg-violet-100 text-violet-800",
  "bg-rose-100 text-rose-800",
  "bg-lime-100 text-lime-800",
  "bg-sky-100 text-sky-800",
];

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function colorFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffff;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

export function UserMenu({ user }: { user: UserSummary }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const router = useRouter();

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/auth/login");
    router.refresh();
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2.5 hover:bg-stone-100 rounded-lg px-2 py-1 transition"
      >
        <span className="flex flex-col items-end leading-tight">
          <span className="text-[13px] text-stone-700 font-medium">{user.full_name}</span>
          <span className="text-[11px] text-stone-500">{user.position_label}</span>
        </span>
        <span className={`w-8 h-8 rounded-full inline-flex items-center justify-center text-[11px] font-medium ${colorFor(user.full_name)}`}>
          {initials(user.full_name)}
        </span>
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-60 bg-white border border-stone-200 rounded-lg shadow-lg py-1 text-sm z-50">
          <div className="px-3 py-2 border-b border-stone-100">
            <div className="text-[13px] font-medium text-stone-900">{user.full_name}</div>
            <div className="text-[11px] text-stone-500">{user.email}</div>
            <div className="text-[11px] text-stone-500 mt-0.5">
              {user.position_label} · {user.hospital_code}
              {user.is_super_admin && <span className="ml-1 text-[10px] bg-teal-50 text-teal-800 rounded-full px-1.5 py-0.5">Super Admin</span>}
            </div>
          </div>
          <button
            onClick={logout}
            className="w-full text-left px-3 py-2 hover:bg-stone-50 text-stone-700"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
