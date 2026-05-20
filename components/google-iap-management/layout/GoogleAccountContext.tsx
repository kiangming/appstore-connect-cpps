"use client";

/**
 * Google Console Account context — module-scoped active-account selection.
 *
 * Q-GIAP.H: the Google IAP Management module always operates against a
 * specific Google Console account (a service-account credential row).
 * The layout server-component fetches the list + reads the active cookie
 * and feeds both into this provider. Children read via useGoogleAccount().
 *
 * Switching: handled by GoogleAccountSwitcher (POSTs to the active-account
 * route which sets the cookie, then full-page reload so the server tree
 * picks up the new active id).
 */
import { createContext, useContext, type ReactNode } from "react";

import type { GoogleConsoleAccountPublic } from "@/lib/google-iap-management/repository/google-accounts";

interface GoogleAccountContextValue {
  accounts: GoogleConsoleAccountPublic[];
  activeAccountId: string | null;
  activeAccount: GoogleConsoleAccountPublic | null;
}

const Ctx = createContext<GoogleAccountContextValue | null>(null);

export function GoogleAccountProvider({
  accounts,
  activeAccountId,
  children,
}: {
  accounts: GoogleConsoleAccountPublic[];
  activeAccountId: string | null;
  children: ReactNode;
}) {
  const activeAccount =
    accounts.find((a) => a.id === activeAccountId) ?? null;
  return (
    <Ctx.Provider value={{ accounts, activeAccountId, activeAccount }}>
      {children}
    </Ctx.Provider>
  );
}

export function useGoogleAccount(): GoogleAccountContextValue {
  const v = useContext(Ctx);
  if (!v) {
    throw new Error(
      "useGoogleAccount must be called inside a GoogleAccountProvider (i.e. under /google-iap-management/* routes).",
    );
  }
  return v;
}
