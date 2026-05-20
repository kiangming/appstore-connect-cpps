"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Check, Building2 } from "lucide-react";

import type { GoogleConsoleAccountPublic } from "@/lib/google-iap-management/repository/google-accounts";

/**
 * Header dropdown for picking the active Google Console account.
 *
 * Q-GIAP.H: only rendered when the route is under /google-iap-management/*
 * (the TopNav handles that mutex). The switcher lives in the (dashboard)/
 * layout's TopNav, which is OUTSIDE the GoogleAccountProvider tree (that
 * provider lives in /google-iap-management/layout.tsx). Consequently, this
 * component cannot consume the provider — it self-fetches both the
 * accounts list and the active id on mount, mirroring how the Apple
 * AccountSwitcher already works against /api/asc/accounts.
 *
 * After a switch, full-page reload so the server-side module layout
 * re-renders under the new cookie.
 */
export function GoogleAccountSwitcher() {
  const [accounts, setAccounts] = useState<GoogleConsoleAccountPublic[]>([]);
  const [activeAccountId, setActiveAccountId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/google-iap-management/google-accounts").then((r) => r.json()),
      fetch("/api/google-iap-management/active-account").then((r) => r.json()),
    ])
      .then(([accountsRes, activeRes]) => {
        if (cancelled) return;
        const list = (accountsRes?.accounts ?? []) as GoogleConsoleAccountPublic[];
        setAccounts(list);
        const fromCookie = activeRes?.activeAccountId as string | null | undefined;
        const fallback =
          list.find((a) => a.status === "verified")?.id ?? list[0]?.id ?? null;
        setActiveAccountId(
          fromCookie && list.some((a) => a.id === fromCookie)
            ? fromCookie
            : fallback,
        );
      })
      .catch(() => {
        // Silent — switcher renders empty if the API is unreachable; the
        // module's own pages will surface a clearer error.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  if (accounts.length === 0) return null;
  const activeAccount =
    accounts.find((a) => a.id === activeAccountId) ?? accounts[0];

  async function handleSwitch(accountId: string) {
    if (accountId === activeAccount?.id || switching) return;
    setOpen(false);
    setSwitching(true);
    try {
      const res = await fetch("/api/google-iap-management/active-account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId }),
      });
      if (!res.ok) {
        console.error("[GoogleAccountSwitcher] switch failed:", res.status);
        setSwitching(false);
        return;
      }
      window.location.reload();
    } catch {
      setSwitching(false);
    }
  }

  const canSwitch = accounts.length >= 2;

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => canSwitch && setOpen((v) => !v)}
        disabled={switching || !canSwitch}
        className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium text-emerald-800 border border-emerald-200 bg-emerald-50 hover:bg-emerald-100 hover:border-emerald-300 transition-colors disabled:opacity-60 disabled:cursor-default"
        title={!canSwitch ? "Only one Google Console account configured" : undefined}
      >
        <Building2 className="h-3.5 w-3.5 text-emerald-600 flex-shrink-0" />
        <span className="max-w-[160px] truncate">{activeAccount?.display_name}</span>
        {canSwitch && (
          <ChevronDown
            className={`h-3.5 w-3.5 text-emerald-600 transition-transform flex-shrink-0 ${
              open ? "rotate-180" : ""
            }`}
          />
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1.5 w-72 rounded-xl border border-slate-200 bg-white shadow-lg z-50 py-1 overflow-hidden">
          {accounts.map((account) => {
            const isActive = account.id === activeAccount?.id;
            return (
              <button
                key={account.id}
                onClick={() => handleSwitch(account.id)}
                className={`w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-slate-50 transition-colors ${
                  isActive ? "text-slate-900" : "text-slate-600"
                }`}
              >
                <Check
                  className={`h-3.5 w-3.5 flex-shrink-0 ${isActive ? "text-emerald-600" : "invisible"}`}
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{account.display_name}</p>
                  <p className="text-xs text-slate-400 font-mono truncate">
                    {account.service_account_email}
                  </p>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
