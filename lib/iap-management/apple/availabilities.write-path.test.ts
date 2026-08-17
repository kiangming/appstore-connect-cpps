/**
 * Two guards over the single availability write path.
 *
 *  1. BEHAVIOURAL — "All countries or regions" and "all N ticked by hand"
 *     must produce DIFFERENT request bodies (KB §4.13). This is the
 *     phantom-field correction made structural: the flag is not derivable
 *     from the list, so nothing may derive it.
 *
 *  2. STRUCTURAL — no emitter may POST /v1/inAppPurchaseAvailabilities
 *     directly. There are four call sites (bulk Set Availabilities, Bulk
 *     Import, single Create on Apple, individual Edit) and this is exactly
 *     the twin-path shape P1 exists to stop: patch three, forget the
 *     fourth. The scan carries a self-check so it cannot pass vacuously.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import {
  __resetTerritoryCacheForTests,
  setAvailabilityRemoveFromSales,
  setAvailabilityTerritories,
  setAvailabilityToAllTerritories,
} from "./availabilities";
import { allTerritoriesSelection, subsetSelection } from "./territory-selection";

vi.mock("./fetch", () => ({ iapFetch: vi.fn() }));
import { iapFetch } from "./fetch";
const mockedFetch = iapFetch as unknown as ReturnType<typeof vi.fn>;

const fakeCreds = {
  keyId: "k",
  issuerId: "i",
  privateKey: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
} as never;

const CATALOGUE = ["USA", "VNM", "JPN"];

beforeEach(() => {
  mockedFetch.mockReset();
  __resetTerritoryCacheForTests();
});

/** The body the mocked transport actually received. */
function sentBody(callIndex = 0) {
  return mockedFetch.mock.calls[callIndex][3];
}

// ═══════════════════════════════════════════════════════════════════════════
// 1 — BEHAVIOURAL
// ═══════════════════════════════════════════════════════════════════════════
describe("All vs N-ticked-by-hand produce different request bodies", () => {
  it("differs on availableInNewTerritories with an identical id list", async () => {
    mockedFetch.mockResolvedValue({ data: { id: "avail-1" } });

    await setAvailabilityTerritories(
      fakeCreds,
      "iap-1",
      allTerritoriesSelection(CATALOGUE),
    );
    await setAvailabilityTerritories(
      fakeCreds,
      "iap-1",
      subsetSelection(CATALOGUE), // every territory, ticked by hand
    );

    const all = sentBody(0);
    const byHand = sentBody(1);

    expect(all.data.attributes.availableInNewTerritories).toBe(true);
    expect(byHand.data.attributes.availableInNewTerritories).toBe(false);

    // Same territories…
    expect(all.data.relationships.availableTerritories.data).toEqual(
      byHand.data.relationships.availableTerritories.data,
    );
    // …different request. If this ever passes, the distinction is gone.
    expect(all).not.toEqual(byHand);
  });

  it("sends territory ids verbatim, in caller order, as JSON:API refs", async () => {
    mockedFetch.mockResolvedValue({ data: { id: "avail-1" } });
    const odd = ["us-A", "  VNM", "ZZZ_9"];

    await setAvailabilityTerritories(fakeCreds, "iap-1", subsetSelection(odd));

    expect(sentBody().data.relationships.availableTerritories.data).toEqual([
      { type: "territories", id: "us-A" },
      { type: "territories", id: "  VNM" },
      { type: "territories", id: "ZZZ_9" },
    ]);
  });

  it("POSTs to the availability collection with the IAP relationship", async () => {
    mockedFetch.mockResolvedValue({ data: { id: "avail-1" } });
    await setAvailabilityTerritories(
      fakeCreds,
      "iap-99",
      subsetSelection(["USA"]),
    );

    const [creds, method, path] = mockedFetch.mock.calls[0];
    expect(creds).toBe(fakeCreds);
    expect(method).toBe("POST");
    expect(path).toBe("/v1/inAppPurchaseAvailabilities");
    expect(sentBody().data.relationships.inAppPurchase.data).toEqual({
      type: "inAppPurchases",
      id: "iap-99",
    });
  });
});

describe("the two legacy helpers are thin callers, unchanged on the wire", () => {
  it("setAvailabilityToAllTerritories → full catalogue + flag true", async () => {
    mockedFetch
      .mockResolvedValueOnce({
        data: CATALOGUE.map((id) => ({ type: "territories", id })),
      })
      .mockResolvedValueOnce({ data: { id: "avail-1" } });

    await setAvailabilityToAllTerritories(fakeCreds, "iap-1");

    const body = sentBody(1);
    expect(body.data.attributes.availableInNewTerritories).toBe(true);
    expect(body.data.relationships.availableTerritories.data).toEqual(
      CATALOGUE.map((id) => ({ type: "territories", id })),
    );
  });

  it("setAvailabilityRemoveFromSales → empty list + flag false", async () => {
    mockedFetch.mockResolvedValue({ data: { id: "avail-1" } });

    await setAvailabilityRemoveFromSales(fakeCreds, "iap-1");

    const body = sentBody();
    expect(body.data.attributes.availableInNewTerritories).toBe(false);
    expect(body.data.relationships.availableTerritories.data).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 — STRUCTURAL
// ═══════════════════════════════════════════════════════════════════════════
const REPO_ROOT = join(__dirname, "..", "..", "..");
const SCAN_ROOTS = [
  "lib/iap-management",
  "app/api/iap-management",
  "app/(dashboard)/iap-management",
  "components/iap-management",
];

/** The one file allowed to name the endpoint in an emitting position. */
const CHOKE_POINT = "lib/iap-management/apple/availabilities.ts";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** P15 — strip comments so this file's own prose (and availabilities.ts's
 *  header, which quotes the endpoint) cannot satisfy or trip the scan. */
function stripComments(src: string): string {
  return src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * ⚠ Built fresh per call, never shared. A `/g` regex reused across
 * `.test()` calls carries `lastIndex` between files and starts returning
 * false — which would make this guard pass vacuously, the exact failure
 * mode the self-checks exist to catch.
 */
const endpointLiteral = () => /"\/v1\/inAppPurchaseAvailabilities"/g;
const hasEndpointLiteral = (src: string) =>
  /"\/v1\/inAppPurchaseAvailabilities"/.test(src);

function sourceFiles(): string[] {
  return SCAN_ROOTS.flatMap((root) => {
    const abs = join(REPO_ROOT, root);
    try {
      return walk(abs);
    } catch {
      return [];
    }
  });
}

describe("single write path — no emitter bypasses setAvailabilityTerritories", () => {
  const files = sourceFiles();

  it("SELF-CHECK: the scan finds source files and the choke point itself", () => {
    // Without this, a broken walk() would report zero violations forever.
    expect(files.length).toBeGreaterThan(50);
    const chokeAbs = join(REPO_ROOT, CHOKE_POINT);
    expect(files).toContain(chokeAbs);
    const body = stripComments(readFileSync(chokeAbs, "utf8"));
    expect(body.match(endpointLiteral())?.length).toBe(1);
  });

  it("the endpoint literal appears in exactly one file", () => {
    const offenders = files
      .filter((f) => hasEndpointLiteral(stripComments(readFileSync(f, "utf8"))))
      .map((f) => relative(REPO_ROOT, f));

    expect(offenders).toEqual([CHOKE_POINT]);
  });

  it("every other module reaches Apple through an exported helper", () => {
    const chokeAbs = join(REPO_ROOT, CHOKE_POINT);
    const callers = files
      .filter((f) => f !== chokeAbs)
      .filter((f) => /setAvailability[A-Za-z]*\(/.test(stripComments(readFileSync(f, "utf8"))))
      .map((f) => relative(REPO_ROOT, f));

    // SELF-CHECK: the four known emitters must be among them, so a regex
    // that stops matching fails loudly instead of finding "no callers".
    expect(callers).toEqual(
      expect.arrayContaining([
        "lib/iap-management/orchestrators/bulk-availability.ts",
        "lib/iap-management/apple/update-orchestration.ts",
        "app/api/iap-management/apps/[appId]/bulk-import/execute/route.ts",
        "app/api/iap-management/apps/[appId]/iaps/[iapId]/create-on-apple/route.ts",
      ]),
    );
  });
});
