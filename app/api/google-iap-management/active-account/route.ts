import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";

import { authOptions } from "@/lib/auth";
import {
  readActiveAccountId,
  writeActiveAccountId,
} from "@/lib/google-iap-management/active-account";
import { getAccountById } from "@/lib/google-iap-management/repository/google-accounts";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ activeAccountId: readActiveAccountId() });
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const { accountId } = (body ?? {}) as Record<string, unknown>;
  if (typeof accountId !== "string" || !accountId.trim()) {
    return NextResponse.json({ error: "accountId is required" }, { status: 400 });
  }

  // Validate the account exists before pinning it (otherwise a stale id
  // could persist and silently break the apps list page).
  const account = await getAccountById(accountId.trim());
  if (!account) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }

  writeActiveAccountId(account.id);
  return NextResponse.json({ activeAccountId: account.id });
}
