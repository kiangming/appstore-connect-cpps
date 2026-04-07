import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { updateAccount, deleteAccount } from "@/lib/asc-account-repository";

export async function PATCH(
  req: Request,
  { params }: { params: { id: string } }
) {
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

  const { name, keyId, issuerId, privateKey } = body as Record<string, unknown>;

  // At least one field must be provided
  if (!name && !keyId && !issuerId && !privateKey) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  try {
    await updateAccount(params.id, {
      name: typeof name === "string" ? name.trim() : undefined,
      keyId: typeof keyId === "string" ? keyId.trim() : undefined,
      issuerId: typeof issuerId === "string" ? issuerId.trim() : undefined,
      privateKey: typeof privateKey === "string" ? privateKey.trim() : undefined,
    });
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    await deleteAccount(params.id);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
