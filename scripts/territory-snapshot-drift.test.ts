/**
 * PA2.3 review — step 2.7 of the snapshot refresh runbook must report a
 * CURRENCY change, not only added / removed codes: since PA2.3 the
 * snapshot's currency gates "Export for editing" and its import, and a
 * code-only diff printed "IN SYNC" for VNM VND→USD (measured). Fed the REAL
 * snapshot source and a fake Apple response built from it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { APPLE_TERRITORIES } from "@/lib/iap-management/apple/apple-territories.snapshot";

import { territorySnapshotDrift } from "./territory-snapshot-drift.mjs";

const SRC = readFileSync(join(process.cwd(), "lib/iap-management/apple/apple-territories.snapshot.ts"), "utf8");
const live = (edit: (rows: Array<{ id: string; attributes: { currency: string } }>) => void = () => {}) => {
  const rows = APPLE_TERRITORIES.map((t) => ({ id: t.code, attributes: { currency: t.currency } }));
  edit(rows);
  return rows;
};

describe("territorySnapshotDrift — codes AND currencies", () => {
  it("T1 Apple = the snapshot ⇒ in sync; every one of the 175 entries was read with its currency", () => {
    const d = territorySnapshotDrift(SRC, live());
    expect(d).toMatchObject({ snapshotCount: 175, liveCount: 175, added: [], removed: [], currencyChanged: [], unreadCurrencies: [], inSync: true });
  });

  it("T2 the same 175 codes, one currency changed ⇒ NOT in sync, and it names the change", () => {
    const d = territorySnapshotDrift(SRC, live((rows) => (rows.find((r) => r.id === "VNM")!.attributes.currency = "USD")));
    expect(d.inSync).toBe(false);
    expect(d.currencyChanged).toEqual([{ code: "VNM", snapshot: "VND", live: "USD" }]);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
  });

  it("T3 a code added and one removed are still reported", () => {
    const d = territorySnapshotDrift(
      SRC,
      live((rows) => {
        rows.splice(rows.findIndex((r) => r.id === "XKS"), 1);
        rows.push({ id: "ZZZ", attributes: { currency: "USD" } });
      }),
    );
    expect(d).toMatchObject({ added: ["ZZZ"], removed: ["XKS"], inSync: false });
  });

  it("T4 a snapshot entry whose currency cannot be read breaks the sync claim (count guard)", () => {
    const d = territorySnapshotDrift(SRC.replace('{ code: "VNM", currency: "VND" }', '{ code: "VNM" }'), live());
    expect(d.unreadCurrencies).toEqual(["VNM"]);
    expect(d.inSync).toBe(false);
  });
});
