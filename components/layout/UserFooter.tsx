"use client";

import { useState } from "react";
import { useSession, signOut } from "next-auth/react";
import { LogOut } from "lucide-react";

const ICONS = ["🦊", "🐻", "🐼", "🦁", "🐯", "🦝", "🦔", "🐨", "🦦", "🦋"];

function iconForEmail(email: string): string {
  const seed = email.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0);
  return ICONS[seed % ICONS.length];
}

export function UserFooter() {
  const { data: session } = useSession();
  const [loggingOut, setLoggingOut] = useState(false);

  const email = session?.user?.email ?? "";
  if (!email) return null;

  const icon = iconForEmail(email);

  async function handleLogout() {
    setLoggingOut(true);
    await signOut({ callbackUrl: "/login" });
  }

  return (
    <div className="border-t border-slate-100 px-3 py-3 flex items-center gap-2 flex-shrink-0">
      {/* Avatar icon */}
      <span className="text-lg leading-none flex-shrink-0">{icon}</span>

      {/* Email */}
      <span className="flex-1 min-w-0 text-xs text-slate-500 truncate" title={email}>
        {email}
      </span>

      {/* Logout button */}
      <button
        onClick={handleLogout}
        disabled={loggingOut}
        title="Sign out"
        className="flex-shrink-0 p-1 rounded-md text-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <LogOut className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
