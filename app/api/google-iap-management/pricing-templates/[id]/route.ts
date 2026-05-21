/**
 * Delete a pricing template — DELETE handler (g1.j).
 * Cascades to entries via FK ON DELETE CASCADE.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";

import { authOptions } from "@/lib/auth";
import { deleteTemplate } from "@/lib/google-iap-management/queries/templates";
import { appendAction } from "@/lib/google-iap-management/repository/actions-log";

export const dynamic = "force-dynamic";

export async function DELETE(
  _req: Request,
  { params }: { params: { id: string } },
) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const id = params.id;
  if (!id) {
    return NextResponse.json({ error: "id is required." }, { status: 400 });
  }

  try {
    await deleteTemplate(id);
    await appendAction({
      actionType: "PRICING_TEMPLATE_UPLOAD",
      actorEmail: session.user.email ?? null,
      targetId: id,
      payload: { action: "delete" },
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Delete failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
