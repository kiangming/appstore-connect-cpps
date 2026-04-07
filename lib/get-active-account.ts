/**
 * lib/get-active-account.ts — Server-side only.
 *
 * Reads the active ASC account from the current NextAuth session and returns
 * the full credentials (including private key) for use in API routes.
 *
 * Falls back to the default account when no activeAccountId is set or
 * the stored ID no longer exists.
 */

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  findAccountById,
  findDefaultAccount,
} from "@/lib/asc-account-repository";
import type { AscCredentials } from "@/lib/asc-accounts";

export type { AscCredentials };

export async function getActiveAccount(): Promise<AscCredentials> {
  const session = await getServerSession(authOptions);
  if (!session) throw new Error("Unauthorized");

  const id = session.activeAccountId;
  const account = id ? await findAccountById(id) : null;
  return account ?? (await findDefaultAccount());
}
