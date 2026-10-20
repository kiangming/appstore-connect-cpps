/**
 * PA2.3 — the Default matrix PAGE wires the import's target and gate (KB P26:
 * test the wiring, not only the parts). The page is the one place that knows
 * which account the screen shows (the active account) and the user's role;
 * a page that passed another account, or `canImport` regardless of role,
 * would make every component test above it pass while importing into the
 * wrong template or letting a member replace a Default.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactElement } from "react";

const requireIapSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/iap-management/auth", () => ({ requireIapSession }));
vi.mock("@/lib/get-active-account", () => ({
  getActiveAccount: vi.fn(async () => ({ id: "acct-topnav", name: "TopNav Account", keyId: "k", issuerId: "i", privateKey: "p" })),
}));
const fetchDefaultMatrix = vi.hoisted(() => vi.fn());
vi.mock("@/lib/iap-management/queries/template-matrix", () => ({ fetchDefaultMatrix }));
vi.mock("@/lib/iap-management/queries/price-tiers", () => ({
  listTierNames: vi.fn(async () => new Map([["TIER_1", "Tier 1"]])),
}));

import DefaultMatrixPage from "./page";
import { DefaultMatrixView } from "@/components/iap-management/pricing-templates/DefaultMatrixView";
import { EmptyMatrixImport } from "@/components/iap-management/pricing-templates/EmptyMatrixImport";
import { findElements } from "../matrix-page-tree.test-helper";

beforeEach(() => {
  vi.clearAllMocks();
  fetchDefaultMatrix.mockResolvedValue({
    matrix: { tiers: [], markets: [], cells: {}, currenciesUsed: [], continentCounts: {} },
    header: { id: "t1", uploaded_at: "2026-10-20T00:00:00Z", uploaded_by: "m@example.test", source_filename: null },
  });
});

async function viewProps(role: "admin" | "member") {
  requireIapSession.mockResolvedValue({ user: { email: "u@example.test", role } });
  const tree = (await DefaultMatrixPage()) as ReactElement<{ children: ReactElement }>;
  const view = tree.props.children;
  expect(view.type).toBe(DefaultMatrixView);
  return view.props as { account: { id: string; name: string }; canImport: boolean };
}

describe("PA2.3 — the Default matrix page", () => {
  it("shows (and targets) the account it reads — the active account — and nothing more of it", async () => {
    const props = await viewProps("admin");
    expect(props.account).toEqual({ id: "acct-topnav", name: "TopNav Account" });
    expect(fetchDefaultMatrix).toHaveBeenCalledWith("acct-topnav");
  });

  it("lets an admin import, and NOT a member (the Default-upload gate)", async () => {
    expect((await viewProps("admin")).canImport).toBe(true);
    expect((await viewProps("member")).canImport).toBe(false);
  });
});

describe("PA2.3 — the Default matrix page with NO template (none uploaded, deleted, or emptied by a broken write)", () => {
  it("an admin still gets Import edited file, aimed at the page's account — the only door for 'import the same file again'", async () => {
    fetchDefaultMatrix.mockResolvedValue(null);
    requireIapSession.mockResolvedValue({ user: { email: "u@example.test", role: "admin" } });
    const tree = (await DefaultMatrixPage()) as ReactElement;
    const [imp] = findElements(tree, EmptyMatrixImport);
    expect(imp?.props).toEqual({
      target: { kind: "ACCOUNT", accountId: "acct-topnav" },
      label: "Default template · TopNav Account (acct-topnav)",
      isPerApp: false,
      tierNames: [{ tier_id: "TIER_1", tier_name: "Tier 1" }],
    });
  });

  it("a member does not (admin-only, like uploading a Default)", async () => {
    fetchDefaultMatrix.mockResolvedValue(null);
    requireIapSession.mockResolvedValue({ user: { email: "u@example.test", role: "member" } });
    expect(findElements((await DefaultMatrixPage()) as ReactElement, EmptyMatrixImport)).toEqual([]);
  });
});
