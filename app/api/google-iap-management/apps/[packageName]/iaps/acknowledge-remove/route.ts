/**
 * POST /api/google-iap-management/apps/[packageName]/iaps/acknowledge-remove
 *
 * Manager acknowledges + removes flagged (deleted-on-Google) items from the
 * cache — the resolution path for the soft-delete flow. Removal is always an
 * explicit, human-gated action; the sync never hard-deletes.
 *
 * Safety: acknowledgeRemoveIaps deletes ONLY rows that are actually flagged
 * (deleted_on_google_at IS NOT NULL) for this app, so a present-on-Google
 * item can never be removed here even if its SKU is passed. Children cascade
 * via FK. Each removal is audited (append-only IAP_ACKNOWLEDGE_REMOVE).
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";

import { authOptions } from "@/lib/auth";
import {
  listAccounts,
} from "@/lib/google-iap-management/repository/google-accounts";
import { getAppByPackage } from "@/lib/google-iap-management/repository/apps";
import { acknowledgeRemoveIaps } from "@/lib/google-iap-management/repository/iaps";
import { appendAction } from "@/lib/google-iap-management/repository/actions-log";
import {
  readActiveAccountId,
  resolveActiveAccountId,
} from "@/lib/google-iap-management/active-account";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  skus: z.array(z.string().min(1)).min(1).max(1000),
});

export async function POST(
  req: Request,
  { params }: { params: { packageName: string } },
) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const accounts = await listAccounts().catch(() => []);
  const accountId = resolveActiveAccountId(accounts, readActiveAccountId());
  if (!accountId) {
    return NextResponse.json(
      { error: "No Google Console accounts configured." },
      { status: 400 },
    );
  }

  const packageName = decodeURIComponent(params.packageName);
  const app = await getAppByPackage(accountId, packageName);
  if (!app) {
    return NextResponse.json(
      { error: `App "${packageName}" is not cached. Refresh the apps list first.` },
      { status: 404 },
    );
  }

  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse((await req.json()) as unknown);
  } catch (err) {
    const message =
      err instanceof z.ZodError
        ? err.issues.map((i) => i.message).join("; ")
        : "Invalid JSON body.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  try {
    const { removed } = await acknowledgeRemoveIaps(app.id, parsed.skus);

    // Audit only when something was actually removed (append-only).
    if (removed.length > 0) {
      await appendAction({
        actionType: "IAP_ACKNOWLEDGE_REMOVE",
        actorEmail: session.user.email ?? null,
        targetId: app.id,
        payload: {
          package_name: packageName,
          removed_count: removed.length,
          removed_skus: removed,
          requested_count: parsed.skus.length,
        },
      });
    }

    return NextResponse.json({
      ok: true,
      removed: removed.length,
      removed_skus: removed,
      // SKUs requested but not removed (weren't flagged / not found) — the
      // guard silently skips them; surface the count for the client.
      skipped: parsed.skus.length - removed.length,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to remove flagged IAPs";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
