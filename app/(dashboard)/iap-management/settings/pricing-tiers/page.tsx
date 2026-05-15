import { redirect } from "next/navigation";
import { requireIapAdmin, IapForbiddenError } from "@/lib/iap-management/auth";
import {
  getImportSummary,
  listTiers,
} from "@/lib/iap-management/queries/price-tiers";
import { PricingTiersClient } from "./PricingTiersClient";

export const dynamic = "force-dynamic";

export default async function PricingTiersPage() {
  try {
    await requireIapAdmin();
  } catch (err) {
    if (err instanceof IapForbiddenError) {
      redirect("/");
    }
    throw err;
  }

  const [summary, tiers] = await Promise.all([
    getImportSummary(),
    listTiers(),
  ]);

  return <PricingTiersClient summary={summary} tiers={tiers} />;
}
