/**
 * lib/get-active-account.ts — Server-side only.
 *
 * Reads the active ASC account from the current NextAuth session and returns
 * the full credentials (including private key) for use in API routes.
 *
 * Falls back to the default account (first in ASC_ACCOUNTS, or legacy env vars)
 * when no activeAccountId is set or the stored ID no longer exists.
 */

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  getAscAccountById,
  getDefaultAscAccount,
} from "@/lib/asc-accounts";
import type { AscCredentials } from "@/lib/asc-accounts";

export type { AscCredentials };

export async function getActiveAccount(): Promise<AscCredentials> {
  const session = await getServerSession(authOptions);
  const id = session?.activeAccountId;

  const account = (id && getAscAccountById(id)) || getDefaultAscAccount();
  return account;
}
