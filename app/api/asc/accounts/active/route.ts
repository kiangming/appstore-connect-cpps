import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getAscAccountById } from "@/lib/asc-accounts";

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let accountId: string;
  try {
    const body = (await req.json()) as { accountId?: unknown };
    if (typeof body.accountId !== "string" || !body.accountId) {
      return NextResponse.json({ error: "Missing accountId" }, { status: 400 });
    }
    accountId = body.accountId;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  // Validate account exists in ASC_ACCOUNTS — prevent session pollution
  const account = getAscAccountById(accountId);
  if (!account) {
    return NextResponse.json({ error: "Invalid account" }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
