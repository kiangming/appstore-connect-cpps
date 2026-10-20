/**
 * PA2.3 — the Per-App matrix page with NO template still offers "Import
 * edited file" (KB P26 — the page wires the target; no component test sees
 * it). A Per-App template emptied by a write that broke at its first batch
 * shows this page, and the Settings upload refuses an edit file — so this
 * button is the only way "import the same file again" can happen. Open to
 * members, like a Per-App upload.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactElement } from "react";

const requireIapSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/iap-management/auth", () => ({ requireIapSession }));
vi.mock("@/lib/get-active-account", () => ({
  getActiveAccount: vi.fn(async () => ({ id: "acct-topnav", name: "TopNav Account", keyId: "k", issuerId: "i", privateKey: "p" })),
}));
const app = { id: "app-uuid-1", name: "Demo", bundle_id: "com.vng.demo" };
vi.mock("@/lib/iap-management/db", () => ({
  iapDb: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: app, error: null }) }) }) }) }),
}));
const fetchPerAppMatrix = vi.hoisted(() => vi.fn());
vi.mock("@/lib/iap-management/queries/template-matrix", () => ({ fetchPerAppMatrix }));
vi.mock("@/lib/iap-management/queries/templates", () => ({ templateExists: vi.fn(async () => true) }));
vi.mock("@/lib/iap-management/queries/price-tiers", () => ({
  listTierNames: vi.fn(async () => new Map([["TIER_1", "Tier 1"]])),
}));

import PerAppMatrixPage from "./page";
import { EmptyMatrixImport } from "@/components/iap-management/pricing-templates/EmptyMatrixImport";
import { findElements } from "../../matrix-page-tree.test-helper";

beforeEach(() => {
  vi.clearAllMocks();
  fetchPerAppMatrix.mockResolvedValue(null);
});

describe("PA2.3 — the Per-App matrix page with no template", () => {
  it.each(["admin", "member"] as const)("%s: Import edited file, aimed at THIS app", async (role) => {
    requireIapSession.mockResolvedValue({ user: { email: "u@example.test", role } });
    const tree = (await PerAppMatrixPage({ params: { appId: "app-uuid-1" } })) as ReactElement;
    const [imp] = findElements(tree, EmptyMatrixImport);
    expect(imp?.props).toEqual({
      target: { kind: "APP", appId: "app-uuid-1" },
      label: "Per-App template · Demo (com.vng.demo)",
      isPerApp: true,
      tierNames: [{ tier_id: "TIER_1", tier_name: "Tier 1" }],
    });
  });
});
