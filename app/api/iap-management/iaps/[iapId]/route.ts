import { NextResponse } from "next/server";
import { z } from "zod";
import {
  requireIapAdmin,
  IapForbiddenError,
  IapUnauthorizedError,
} from "@/lib/iap-management/auth";
import {
  updateIap,
  deleteIap,
  replaceLocalizations,
  getIapWithRelations,
} from "@/lib/iap-management/queries/iaps";
import { log } from "@/lib/logger";

export const runtime = "nodejs";

const PatchSchema = z.object({
  reference_name: z.string().min(1).max(64).optional(),
  tier_id: z.string().nullable().optional(),
  family_sharable: z.boolean().optional(),
  review_note: z.string().nullable().optional(),
  localizations: z
    .record(
      z.string(),
      z.object({
        locale: z.string(),
        display_name: z.string(),
        description: z.string(),
      }),
    )
    .optional(),
});

async function authAdmin(): Promise<
  | { session: Awaited<ReturnType<typeof requireIapAdmin>> }
  | { error: NextResponse }
> {
  try {
    const session = await requireIapAdmin();
    return { session };
  } catch (err) {
    if (err instanceof IapUnauthorizedError) {
      return {
        error: NextResponse.json({ error: err.message }, { status: 401 }),
      };
    }
    if (err instanceof IapForbiddenError) {
      return {
        error: NextResponse.json({ error: err.message }, { status: 403 }),
      };
    }
    throw err;
  }
}

export async function PATCH(
  req: Request,
  ctx: { params: { iapId: string } },
) {
  const auth = await authAdmin();
  if ("error" in auth) return auth.error;

  let patch;
  try {
    patch = PatchSchema.parse(await req.json());
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Invalid body";
    return NextResponse.json({ error: msg }, { status: 422 });
  }

  try {
    await updateIap(
      ctx.params.iapId,
      {
        reference_name: patch.reference_name,
        tier_id: patch.tier_id,
        family_sharable: patch.family_sharable,
        review_note: patch.review_note,
      },
      auth.session.user.email ?? "unknown",
    );
    if (patch.localizations) {
      await replaceLocalizations(
        ctx.params.iapId,
        Object.values(patch.localizations),
      );
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Update failed";
    await log("iap-update", `error iap=${ctx.params.iapId}: ${msg}`, "ERROR");
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function DELETE(
  _req: Request,
  ctx: { params: { iapId: string } },
) {
  const auth = await authAdmin();
  if ("error" in auth) return auth.error;

  try {
    await deleteIap(
      ctx.params.iapId,
      auth.session.user.email ?? "unknown",
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Delete failed";
    await log("iap-delete", `error iap=${ctx.params.iapId}: ${msg}`, "ERROR");
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function GET(
  _req: Request,
  ctx: { params: { iapId: string } },
) {
  const auth = await authAdmin();
  if ("error" in auth) return auth.error;

  try {
    const result = await getIapWithRelations(ctx.params.iapId);
    if (!result) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Fetch failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
