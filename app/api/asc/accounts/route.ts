import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getAscAccountsPublic, getDefaultAscAccount } from "@/lib/asc-accounts";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const accounts = getAscAccountsPublic();
  const activeAccountId = session.activeAccountId ?? getDefaultAscAccount().id;

  return NextResponse.json({ accounts, activeAccountId });
}
