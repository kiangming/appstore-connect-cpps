"use client";

import { useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { ChevronDown, Check, Building2 } from "lucide-react";

interface AccountPublic {
  id: string;
  name: string;
  keyId: string;
}

export function AccountSwitcher() {
  const { data: session, update } = useSession();
  const [accounts, setAccounts] = useState<AccountPublic[]>([]);
  const [activeAccountId, setActiveAccountId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Fetch account list on mount
  useEffect(() => {
    fetch("/api/asc/accounts")
      .then((r) => r.json())
      .then((data: { accounts: AccountPublic[]; activeAccountId: string | null }) => {
        setAccounts(data.accounts ?? []);
        setActiveAccountId(data.activeAccountId ?? data.accounts[0]?.id ?? null);
      })
      .catch(() => {/* ignore */});
  }, []);

  // Sync activeAccountId from session when it changes externally
  useEffect(() => {
    if (session?.activeAccountId !== undefined) {
      setActiveAccountId(session.activeAccountId ?? accounts[0]?.id ?? null);
    }
  }, [session?.activeAccountId, accounts]);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  // Hide if only 1 account
  if (accounts.length <= 1) return null;

  const activeAccount = accounts.find((a) => a.id === activeAccountId) ?? accounts[0];

  async function handleSwitch(account: AccountPublic) {
    if (account.id === activeAccountId || switching) return;
    setOpen(false);
    setSwitching(true);

    try {
      // Step 1: Validate on server
      const res = await fetch("/api/asc/accounts/active", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: account.id }),
      });

      if (!res.ok) {
        console.error("[AccountSwitcher] Invalid account:", account.id);
        setSwitching(false);
        return;
      }

      // Step 2: Update NextAuth session JWT
      await update({ activeAccountId: account.id });

      // Step 3: Full page reload to refresh all data
      window.location.reload();
    } catch {
      setSwitching(false);
    }
  }

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={switching}
        className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium text-slate-700 border border-slate-200 hover:bg-slate-50 hover:border-slate-300 transition-colors disabled:opacity-60"
      >
        <Building2 className="h-3.5 w-3.5 text-slate-400 flex-shrink-0" />
        <span className="max-w-[140px] truncate">{activeAccount?.name ?? "Account"}</span>
        <ChevronDown className={`h-3.5 w-3.5 text-slate-400 transition-transform flex-shrink-0 ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1.5 w-64 rounded-xl border border-slate-200 bg-white shadow-lg z-50 py-1 overflow-hidden">
          {accounts.map((account) => {
            const isActive = account.id === activeAccountId;
            return (
              <button
                key={account.id}
                onClick={() => handleSwitch(account)}
                className={`w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-slate-50 transition-colors ${
                  isActive ? "text-slate-900" : "text-slate-600"
                }`}
              >
                <Check
                  className={`h-3.5 w-3.5 flex-shrink-0 ${isActive ? "text-[#0071E3]" : "invisible"}`}
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{account.name}</p>
                  <p className="text-xs text-slate-400 font-mono truncate">key: {account.keyId}</p>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
