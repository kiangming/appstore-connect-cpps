import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";

import { authOptions } from "@/lib/auth";
import {
  deleteAccount,
  getAccountById,
} from "@/lib/google-iap-management/repository/google-accounts";
import { appendAction } from "@/lib/google-iap-management/repository/actions-log";

export const dynamic = "force-dynamic";

export async function DELETE(
  _req: Request,
  { params }: { params: { id: string } },
) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const id = params.id;
  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  try {
    const existing = await getAccountById(id);
    if (!existing) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 });
    }
    await deleteAccount(id);
    await appendAction({
      actionType: "ACCOUNT_DELETE",
      actorEmail: session.user.email ?? null,
      targetId: id,
      payload: {
        display_name: existing.display_name,
        service_account_email: existing.service_account_email,
      },
    });
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to delete account";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
