import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  findAllAccountsPublic,
  createAccount,
} from "@/lib/asc-account-repository";

function requireAdmin() {
  // Returns session or throws — used by all admin routes
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const accounts = await findAllAccountsPublic();
  return NextResponse.json({ accounts });
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { id, name, keyId, issuerId, privateKey } = body as Record<string, unknown>;

  if (
    typeof id !== "string" || !id.trim() ||
    typeof name !== "string" || !name.trim() ||
    typeof keyId !== "string" || !keyId.trim() ||
    typeof issuerId !== "string" || !issuerId.trim() ||
    typeof privateKey !== "string" || !privateKey.trim()
  ) {
    return NextResponse.json(
      { error: "Missing required fields: id, name, keyId, issuerId, privateKey" },
      { status: 400 }
    );
  }

  try {
    await createAccount({
      id: id.trim(),
      name: name.trim(),
      keyId: keyId.trim(),
      issuerId: issuerId.trim(),
      privateKey: privateKey.trim(),
      createdBy: session.user.email ?? "unknown",
    });
    return new NextResponse(null, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
