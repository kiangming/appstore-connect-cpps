import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { findAllAccountsPublic, findDefaultAccount } from "@/lib/asc-account-repository";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [accounts, defaultAccount] = await Promise.all([
    findAllAccountsPublic(),
    findDefaultAccount(),
  ]);

  const activeAccountId = session.activeAccountId ?? defaultAccount.id;
  return NextResponse.json({ accounts, activeAccountId });
}
