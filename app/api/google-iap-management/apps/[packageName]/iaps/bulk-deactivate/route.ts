/**
 * Cycle 41 — POST /api/google-iap-management/apps/[packageName]/iaps/bulk-deactivate
 *
 * Destructive sibling of bulk-activate. UI guards the destructive intent
 * via a confirmation dialog before sending the request; the server-side
 * orchestrator is otherwise identical except for the action verb +
 * resulting cache status.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";

import { authOptions } from "@/lib/auth";
import { jwtClientFromEncrypted } from "@/lib/google-iap-management/google/auth";
import {
  getEncryptedCredentials,
  listAccounts,
} from "@/lib/google-iap-management/repository/google-accounts";
import { getAppByPackage } from "@/lib/google-iap-management/repository/apps";
import {
  readActiveAccountId,
  resolveActiveAccountId,
} from "@/lib/google-iap-management/active-account";
import { executeBulkStatus } from "@/lib/google-iap-management/orchestration/bulk-status";

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
      {
        error:
          "No Google Console accounts configured. Add one in Settings → Google Console Accounts first.",
      },
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
    const json = (await req.json()) as unknown;
    parsed = bodySchema.parse(json);
  } catch (err) {
    const message =
      err instanceof z.ZodError
        ? err.issues.map((i) => i.message).join("; ")
        : "Invalid JSON body.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  try {
    const encrypted = await getEncryptedCredentials(accountId);
    const jwt = jwtClientFromEncrypted(encrypted);
    const result = await executeBulkStatus({
      jwt,
      appId: app.id,
      packageName,
      skus: parsed.skus,
      action: "deactivate",
      actorEmail: session.user?.email ?? null,
    });
    return NextResponse.json(result);
  } catch (err) {
    const e = err as { code?: number; status?: number; message?: string };
    const message = e?.message ?? "Bulk Deactivate failed.";
    const httpStatus =
      typeof e?.code === "number" && e.code >= 400 && e.code < 600 ? e.code : 500;
    return NextResponse.json({ error: message }, { status: httpStatus });
  }
}
