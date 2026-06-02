/**
 * Cycle 43 — `listUsdTiersForSource` source→table mapping.
 *
 * The load-bearing data-source guard for the bulk-import cross-path fix.
 * Proves the helper reads:
 *   APPLE            → legacy price_tier_territories (delegates to listUsdTiers)
 *   DEFAULT_TEMPLATE → price_tier_template_entries (GLOBAL scope)
 *   APP_TEMPLATE     → price_tier_template_entries (that app's scope)
 * and returns [] when the selected template scope has no uploaded template.
 *
 * Both preview (via page.tsx) and /execute call THIS helper, so locking its
 * per-source table selection is what keeps the two surfaces in agreement.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const fromMock = vi.hoisted(() => vi.fn());
vi.mock("../db", () => ({ iapDb: () => ({ from: fromMock }) }));
// templates.ts imports asc-account-repository (for listAppsWithTemplates),
// which eagerly constructs the real Supabase client at module load. Stub it
// so importing templates.ts stays hermetic — listUsdTiersForSource never
// touches it.
vi.mock("@/lib/asc-account-repository", () => ({ findAllAccounts: vi.fn() }));

import { listUsdTiersForSource } from "./templates";

/** Chainable Supabase-query stub. `.maybeSingle()` resolves `single`;
 *  awaiting the builder (after `.order()`) resolves `list`. */
function builder(opts: {
  list?: { data: unknown; error: unknown };
  single?: { data: unknown; error: unknown };
}) {
  const b: Record<string, unknown> = {};
  const chain = () => b;
  b.select = chain;
  b.eq = chain;
  b.is = chain;
  b.order = chain;
  b.maybeSingle = () =>
    Promise.resolve(opts.single ?? { data: null, error: null });
  b.then = (
    resolve: (v: unknown) => unknown,
    reject?: (e: unknown) => unknown,
  ) => Promise.resolve(opts.list ?? { data: [], error: null }).then(resolve, reject);
  return b;
}

const GLOBAL_HEADER = {
  id: "tpl-global",
  scope_type: "GLOBAL",
  scope_app_id: null,
  uploaded_at: "2026-01-01T00:00:00Z",
  uploaded_by: "manager",
  source_filename: "default.xlsx",
};
const APP_HEADER = {
  id: "tpl-app-A",
  scope_type: "APP",
  scope_app_id: "app-A",
  uploaded_at: "2026-01-02T00:00:00Z",
  uploaded_by: "manager",
  source_filename: "appA.xlsx",
};

beforeEach(() => {
  fromMock.mockReset();
});

describe("listUsdTiersForSource — Cycle 43 source→table mapping", () => {
  it("APPLE → reads legacy price_tier_territories (back-compat)", async () => {
    const tablesSeen: string[] = [];
    fromMock.mockImplementation((table: string) => {
      tablesSeen.push(table);
      return builder({
        list: {
          data: [
            { tier_id: "TIER_1", customer_price: 0.99 },
            { tier_id: "TIER_5", customer_price: 4.99 },
          ],
          error: null,
        },
      });
    });

    const out = await listUsdTiersForSource({ kind: "APPLE" });
    expect(out).toEqual([
      { tier_id: "TIER_1", customer_price: 0.99 },
      { tier_id: "TIER_5", customer_price: 4.99 },
    ]);
    expect(tablesSeen).toContain("price_tier_territories");
    expect(tablesSeen).not.toContain("price_tier_template_entries");
  });

  it("DEFAULT_TEMPLATE → reads template entries for the GLOBAL scope", async () => {
    const tablesSeen: string[] = [];
    fromMock.mockImplementation((table: string) => {
      tablesSeen.push(table);
      if (table === "price_tier_templates") {
        return builder({ single: { data: GLOBAL_HEADER, error: null } });
      }
      return builder({
        list: {
          data: [{ tier_id: "TIER_8", customer_price: 7.99 }],
          error: null,
        },
      });
    });

    const out = await listUsdTiersForSource({ kind: "DEFAULT_TEMPLATE" });
    expect(out).toEqual([{ tier_id: "TIER_8", customer_price: 7.99 }]);
    expect(tablesSeen).toContain("price_tier_templates");
    expect(tablesSeen).toContain("price_tier_template_entries");
    expect(tablesSeen).not.toContain("price_tier_territories");
  });

  it("APP_TEMPLATE → reads template entries for that app's scope (incl. the new tier)", async () => {
    fromMock.mockImplementation((table: string) => {
      if (table === "price_tier_templates") {
        return builder({ single: { data: APP_HEADER, error: null } });
      }
      return builder({
        list: {
          data: [
            { tier_id: "TIER_1", customer_price: 0.99 },
            { tier_id: "TIER_12", customer_price: 12.99 }, // newly-added tier
          ],
          error: null,
        },
      });
    });

    const out = await listUsdTiersForSource({
      kind: "APP_TEMPLATE",
      app_id: "app-A",
    });
    expect(out).toContainEqual({ tier_id: "TIER_12", customer_price: 12.99 });
  });

  it("returns [] when the selected template scope has no uploaded template", async () => {
    fromMock.mockImplementation((table: string) => {
      if (table === "price_tier_templates") {
        return builder({ single: { data: null, error: null } });
      }
      throw new Error("should not query entries when no template header exists");
    });

    const out = await listUsdTiersForSource({ kind: "DEFAULT_TEMPLATE" });
    expect(out).toEqual([]);
  });

  it("throws when the template entries query errors", async () => {
    fromMock.mockImplementation((table: string) => {
      if (table === "price_tier_templates") {
        return builder({ single: { data: APP_HEADER, error: null } });
      }
      return builder({ list: { data: null, error: { message: "boom" } } });
    });

    await expect(
      listUsdTiersForSource({ kind: "APP_TEMPLATE", app_id: "app-A" }),
    ).rejects.toThrow(/boom/);
  });
});
