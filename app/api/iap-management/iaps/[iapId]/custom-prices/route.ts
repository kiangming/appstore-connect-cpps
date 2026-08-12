/**
 * PUT    /api/iap-management/iaps/[iapId]/custom-prices   — save the set
 * DELETE /api/iap-management/iaps/[iapId]/custom-prices   — clear all
 *
 * The dialog's only write path. Every mutation goes through SC1's single-writer
 * repository — there is no `.from("iap_custom_prices")` here, and
 * `custom-prices/structure.test.ts` fails the build if one appears.
 *
 * PUT carries the whole set (replace-all, matching both Apple's own
 * price-schedule semantics and the module's template-upload convention) plus the
 * baseline fingerprint the set was built against. Which of SC1's three
 * operations that actually is — save / clear / re-baseline — is decided by the
 * pure `decideCustomPriceWrite`, so each gets its correct audit action type
 * rather than everything logging as a generic save.
 *
 * ⚠ `custom_prices` is optional-but-NOT-defaulted in the schema. A zod
 * `.default([])` here would turn "a client forgot to send the field" into "the
 * Manager's custom prices were deliberately cleared" — the exact
 * two-meanings-of-empty collapse SC1's `CustomPricePersistIntent` exists to
 * prevent. An absent field is rejected as a bad request instead of silently
 * destroying data.
 *
 * SC3 owns submit blocking. This route deliberately does NOT refuse a stale
 * save: a Manager mid-review must be able to persist without resolving.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  requireIapSession,
  IapUnauthorizedError,
} from "@/lib/iap-management/auth";
import { getIapWithRelations } from "@/lib/iap-management/queries/iaps";
import {
  clearCustomPrices,
  getCustomPriceState,
  replaceCustomPrices,
  restampCustomPriceBaseline,
} from "@/lib/iap-management/custom-prices/repository";
import {
  decideCustomPriceWrite,
  persistIntentFrom,
  type CustomPriceEntry,
} from "@/lib/iap-management/custom-prices/model";

export const runtime = "nodejs";

const EntrySchema = z.object({
  territory_code: z.string().min(2),
  customer_price: z.number().finite().nonnegative(),
  currency_code: z.string().min(1),
});

const BaselineSchema = z.object({
  tier_id: z.string().min(1),
  pricing_source: z.enum(["APPLE", "DEFAULT_TEMPLATE", "APP_TEMPLATE"]),
  base_territory: z.string().min(1),
});

const PutSchema = z.object({
  // Optional, never defaulted — see the header note.
  custom_prices: z.array(EntrySchema).optional(),
  custom_prices_baseline: BaselineSchema.nullable().optional(),
  /** "manual" | "imported-from-apple" — a payload fact on CUSTOM_PRICES_SAVED,
   *  not a separate action type (SC1). */
  source: z.enum(["manual", "imported-from-apple"]).optional(),
});

async function auth(): Promise<
  { actor: string } | { error: NextResponse }
> {
  try {
    // Member-accessible, matching every other IAP write surface (Hotfix 10).
    const session = await requireIapSession();
    return { actor: session.user.email ?? "unknown" };
  } catch (err) {
    if (err instanceof IapUnauthorizedError) {
      return { error: NextResponse.json({ error: err.message }, { status: 401 }) };
    }
    throw err;
  }
}

export async function PUT(
  req: Request,
  ctx: { params: { iapId: string } },
) {
  const a = await auth();
  if ("error" in a) return a.error;

  let body: z.infer<typeof PutSchema>;
  try {
    body = PutSchema.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid body" },
      { status: 422 },
    );
  }

  const intent = persistIntentFrom(body.custom_prices);
  if (intent.kind === "untouched") {
    // Refuse rather than guess. Treating an absent field as [] would delete the
    // Manager's set on a malformed request.
    return NextResponse.json(
      {
        error:
          "Missing `custom_prices`. Send the full set (an empty array clears it) — " +
          "an absent field is not treated as a clear.",
      },
      { status: 422 },
    );
  }

  const existing = await getIapWithRelations(ctx.params.iapId);
  if (!existing) {
    return NextResponse.json({ error: "IAP not found" }, { status: 404 });
  }

  const stored = await getCustomPriceState(ctx.params.iapId);
  const incomingBaseline = body.custom_prices_baseline ?? null;
  const entries: CustomPriceEntry[] = [...intent.entries];

  if (entries.length > 0 && !incomingBaseline) {
    // A set with no fingerprint can never be evaluated for staleness, so it
    // would ship unreviewed forever. Refuse the shape.
    return NextResponse.json(
      {
        error:
          "custom_prices_baseline is required when saving a non-empty set — " +
          "without it staleness can never be evaluated.",
      },
      { status: 422 },
    );
  }

  try {
    const kind = decideCustomPriceWrite({
      storedEntries: stored.entries,
      storedBaseline: stored.baseline,
      incomingEntries: entries,
      incomingBaseline,
    });

    if (kind === "clear") {
      const cleared = await clearCustomPrices({
        iapId: ctx.params.iapId,
        actor: a.actor,
      });
      return NextResponse.json({ ok: true, kind, entries: [], cleared });
    }

    if (kind === "rebaseline") {
      await restampCustomPriceBaseline({
        iapId: ctx.params.iapId,
        baseline: incomingBaseline!,
        actor: a.actor,
      });
      return NextResponse.json({ ok: true, kind, entries: stored.entries });
    }

    const saved = await replaceCustomPrices({
      iapId: ctx.params.iapId,
      entries,
      baseline: incomingBaseline,
      actor: a.actor,
      source: body.source ?? "manual",
    });
    return NextResponse.json({ ok: true, kind, entries: saved });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[custom-prices] save failed iap=${ctx.params.iapId}: ${message}`,
    );
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  _req: Request,
  ctx: { params: { iapId: string } },
) {
  const a = await auth();
  if ("error" in a) return a.error;

  const existing = await getIapWithRelations(ctx.params.iapId);
  if (!existing) {
    return NextResponse.json({ error: "IAP not found" }, { status: 404 });
  }

  try {
    const cleared = await clearCustomPrices({
      iapId: ctx.params.iapId,
      actor: a.actor,
    });
    return NextResponse.json({ ok: true, cleared });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[custom-prices] clear failed iap=${ctx.params.iapId}: ${message}`,
    );
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
