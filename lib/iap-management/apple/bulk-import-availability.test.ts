/**
 * SURFACE B's rate-limit invariant, made structural.
 *
 * ⚠ THE FIRST DESCRIBE IS THE ONE THAT MATTERS. Bulk Import runs N rows behind
 * Hotfix 26's concurrency-2 + 1000ms inter-row delay, tuned against Apple's
 * documented ~1 req/sec. Before SC7 the availability stage called
 * `setAvailabilityToAllTerritories` per row, which reaches
 * `getAllTerritoryIds` internally — so the catalogue lookup was INVOKED once
 * per row and remained a single Apple request only because the module-scope
 * 1h cache absorbed the repeats.
 *
 * That made a rate-limit guarantee depend on a cache TTL outliving the batch.
 * A cold process mid-run, or a batch that crosses the hour, would silently turn
 * into N territory reads on top of N availability POSTs — exactly the fan-out
 * Hotfix 25 and 26 exist to prevent.
 *
 * These tests pin the structural version: the catalogue is read ONCE, before
 * the row loop, and the rows receive it. The SC7 mutation-check moves the read
 * back inside the row and requires this file to go red.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  __resetTerritoryCacheForTests,
  getAllTerritoryIds,
  setAvailabilityTerritories,
} from "./availabilities";
import {
  allTerritoriesSelection,
  classifySelection,
  subsetSelection,
} from "./territory-selection";

vi.mock("./fetch", () => ({ iapFetch: vi.fn() }));
import { iapFetch } from "./fetch";
const mockedFetch = iapFetch as unknown as ReturnType<typeof vi.fn>;

const creds = { keyId: "k", issuerId: "i", privateKey: "p" } as never;
const CATALOGUE = ["USA", "VNM", "BRA", "KAZ"];

beforeEach(() => {
  mockedFetch.mockReset();
  __resetTerritoryCacheForTests();
});

/** Every `/v1/territories` GET the batch performed. */
const territoryReads = () =>
  mockedFetch.mock.calls.filter(
    (c) => typeof c[2] === "string" && c[2].includes("/v1/territories"),
  );

/** Every availability POST the batch performed. */
const availabilityWrites = () =>
  mockedFetch.mock.calls.filter(
    (c) => c[2] === "/v1/inAppPurchaseAvailabilities",
  );

// ═══════════════════════════════════════════════════════════════════════════
// 1 — ONE catalogue read per batch, N POSTs
// ═══════════════════════════════════════════════════════════════════════════
describe("a batch reads the catalogue once and writes once per row", () => {
  it("⚠ 12 rows ⇒ exactly 1 territory read and 12 availability POSTs", async () => {
    mockedFetch.mockImplementation(async (_c, _m, path: string) => {
      if (path.includes("/v1/territories")) {
        return { data: CATALOGUE.map((id) => ({ type: "territories", id })) };
      }
      return { data: { id: "avail-1" } };
    });

    // This is the shape the execute route now has: resolve ONCE…
    const catalogue = await getAllTerritoryIds(creds);
    const selection = allTerritoriesSelection(catalogue);

    // …then the row loop only writes.
    for (let i = 0; i < 12; i++) {
      await setAvailabilityTerritories(creds, `iap-${i}`, selection);
    }

    // If the read migrates back inside the loop this becomes 12 (or 1 plus
    // however many survive the cache), and the guarantee is gone.
    expect(territoryReads()).toHaveLength(1);
    expect(availabilityWrites()).toHaveLength(12);
  });

  it("⚠ the write path never reads territories itself when given a selection", async () => {
    // `setAvailabilityTerritories` takes the ids it is handed. If it ever
    // resolved a catalogue internally, per-row reads would reappear invisibly.
    mockedFetch.mockResolvedValue({ data: { id: "avail-1" } });

    await setAvailabilityTerritories(
      creds,
      "iap-1",
      subsetSelection(["USA", "VNM"]),
    );

    expect(territoryReads()).toHaveLength(0);
    expect(availabilityWrites()).toHaveLength(1);
  });

  it("the catalogue read survives a cold cache exactly once", async () => {
    mockedFetch.mockImplementation(async (_c, _m, path: string) => {
      if (path.includes("/v1/territories")) {
        return { data: CATALOGUE.map((id) => ({ type: "territories", id })) };
      }
      return { data: { id: "a" } };
    });

    __resetTerritoryCacheForTests();
    await getAllTerritoryIds(creds);
    await getAllTerritoryIds(creds); // second batch, warm cache

    expect(territoryReads()).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 — one selection, applied to every row, verbatim
// ═══════════════════════════════════════════════════════════════════════════
describe("the batch's one selection reaches every row unchanged", () => {
  it("every row receives byte-identical territories", async () => {
    mockedFetch.mockResolvedValue({ data: { id: "avail-1" } });
    const selection = subsetSelection(["VNM", "USA"]);

    for (const id of ["iap-1", "iap-2", "iap-3"]) {
      await setAvailabilityTerritories(creds, id, selection);
    }

    const bodies = availabilityWrites().map((c) => c[3]);
    expect(bodies).toHaveLength(3);
    for (const body of bodies) {
      // Order preserved — no sort anywhere on the path.
      expect(body.data.relationships.availableTerritories.data).toEqual([
        { type: "territories", id: "VNM" },
        { type: "territories", id: "USA" },
      ]);
    }
  });

  it("⚠ ALL and all-ticked-by-hand send DIFFERENT bodies (KB §4.13)", async () => {
    mockedFetch.mockResolvedValue({ data: { id: "avail-1" } });

    await setAvailabilityTerritories(
      creds,
      "iap-1",
      allTerritoriesSelection(CATALOGUE),
    );
    await setAvailabilityTerritories(creds, "iap-2", subsetSelection(CATALOGUE));

    const [asAll, byHand] = availabilityWrites().map((c) => c[3]);
    expect(asAll.data.attributes.availableInNewTerritories).toBe(true);
    expect(byHand.data.attributes.availableInNewTerritories).toBe(false);
    expect(asAll.data.relationships.availableTerritories.data).toEqual(
      byHand.data.relationships.availableTerritories.data,
    );
    expect(asAll).not.toEqual(byHand);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 — the audit action type follows what was SENT (SC2)
// ═══════════════════════════════════════════════════════════════════════════
describe("action type is derived from the selection, not the surface", () => {
  it("classifies all four shapes the way the route records them", () => {
    expect(classifySelection(allTerritoriesSelection(CATALOGUE), CATALOGUE)).toBe(
      "ALL",
    );
    // Same ids, flag off ⇒ NOT "ALL", so the row cannot claim SET_ALL.
    expect(classifySelection(subsetSelection(CATALOGUE), CATALOGUE)).toBe(
      "ALL_FROZEN",
    );
    expect(classifySelection(subsetSelection(["USA"]), CATALOGUE)).toBe("SUBSET");
    expect(
      classifySelection(
        { territoryIds: [], availableInNewTerritories: false },
        CATALOGUE,
      ),
    ).toBe("NONE");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 — STRUCTURAL: the read stays out of the row loop
// ═══════════════════════════════════════════════════════════════════════════
describe("STRUCTURAL — getAllTerritoryIds is not reachable from the row body", () => {
  const routePath = join(
    __dirname,
    "..",
    "..",
    "..",
    "app/api/iap-management/apps/[appId]/bulk-import/execute/route.ts",
  );

  /** P15 — strip comments; this file and the route both discuss the rule. */
  const stripComments = (src: string) =>
    src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

  it("SELF-CHECK: the route file is readable and mentions the helper once", () => {
    const src = stripComments(readFileSync(routePath, "utf8"));
    expect(src.length).toBeGreaterThan(1000);
    // Import + the single call. If this count changes, the assertion below is
    // measuring something other than what it thinks.
    const hits = src.match(/getAllTerritoryIds/g) ?? [];
    expect(hits).toHaveLength(2);
  });

  it("⚠ there is EXACTLY ONE call, and it sits before the row loop", () => {
    const src = stripComments(readFileSync(routePath, "utf8"));

    // ⚠ COUNT FIRST. An earlier version of this test used indexOf alone, and
    // the SC7 mutation-check proved it too weak: adding a SECOND call inside
    // the row left the first one's position unchanged, so the assertion still
    // passed and only the self-check noticed. A per-row read is exactly the
    // regression this guard exists to catch, so it must fail here.
    const calls = src.match(/await getAllTerritoryIds\(/g) ?? [];
    expect(calls).toHaveLength(1);

    const callIdx = src.indexOf("await getAllTerritoryIds(");
    // ⚠ ANCHORED ON WHICHEVER BOUNDED-CONCURRENCY PRIMITIVE THE ROUTE USES.
    // This read `indexOf("await withConcurrency(")` until C2 swapped the row
    // loop to `runStoppablePool` (to gain a rate-limit stop latch). The
    // invariant being guarded never changed — the territory catalogue is
    // resolved ONCE, before any row dispatches — but the assertion had
    // hard-coded the loop's NAME, so a rename read as a violation. Matching
    // either primitive keeps the guard pointed at the rule instead of at the
    // spelling; if a future refactor introduces a third, this fails loudly
    // (loopIdx === -1) rather than silently passing.
    const loopIdx = [
      "await runStoppablePool<",
      "await withConcurrency(",
    ]
      .map((needle) => src.indexOf(needle))
      .filter((i) => i > -1)
      .sort((a, b) => a - b)[0] ?? -1;
    const rowFnIdx = src.indexOf("async function orchestrateOne");

    expect(callIdx).toBeGreaterThan(-1);
    expect(loopIdx).toBeGreaterThan(-1);
    // Resolved before the loop dispatches…
    expect(callIdx).toBeLessThan(loopIdx);
    // …and lexically outside the per-row function entirely.
    expect(callIdx).toBeLessThan(rowFnIdx);
  });

  it("⚠ the row body does not reach the legacy all-territories helper either", () => {
    // `setAvailabilityToAllTerritories` resolves the catalogue internally, so
    // calling it per row reintroduces exactly what SC7 removed.
    const src = stripComments(readFileSync(routePath, "utf8"));
    expect(src).not.toContain("setAvailabilityToAllTerritories");
    expect(src).toContain("setAvailabilityTerritories(");
  });
});
