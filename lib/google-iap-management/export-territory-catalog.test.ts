/**
 * X4 — the country list the Google export dialog offers, and the pin that
 * stops R2 from happening a second time.
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  GOOGLE_TERRITORY_CATALOG,
  GOOGLE_TERRITORY_CODES,
} from "./export-territory-catalog";
import {
  PLAY_REGIONS,
  PLAY_REGIONS_VERSION,
  PLAY_REGIONS_MEASURED_AT,
  checkRegionsVersion,
} from "./google/play-regions.snapshot";
import { GOOGLE_REGIONS_173 } from "./__fixtures__/google-regions-173";
import { regionNameFromCode } from "./region-name";

describe("the snapshot is the measured set, and says so", () => {
  it("holds exactly 173 pairs, no duplicate codes", () => {
    expect(PLAY_REGIONS).toHaveLength(173);
    expect(new Set(PLAY_REGIONS.map((r) => r.code)).size).toBe(173);
  });

  it("matches the independently-measured 173 exactly, both directions", () => {
    expect([...PLAY_REGIONS.map((r) => r.code)].sort()).toEqual(
      [...GOOGLE_REGIONS_173].sort(),
    );
  });

  it("every code is alpha-2 and every currency is alpha-3", () => {
    for (const r of PLAY_REGIONS) {
      expect(r.code, r.code).toMatch(/^[A-Z]{2}$/);
      expect(r.currency, r.code).toMatch(/^[A-Z]{3}$/);
    }
  });

  it("⚠ carries its own provenance — version and measurement date", () => {
    // A snapshot that cannot say WHEN and FROM WHAT it was taken cannot be
    // audited, only trusted. The version is what makes every row checkable.
    expect(PLAY_REGIONS_VERSION).toBe("2025/03");
    expect(PLAY_REGIONS_MEASURED_AT).toBe("2026-09-01");
  });

  it("⚠ the file states the refresh command, not just the numbers", () => {
    const src = readFileSync(
      join(__dirname, "google", "play-regions.snapshot.ts"),
      "utf8",
    );
    expect(src).toContain("/api/google-iap-management/regions/catalog");
    expect(src).toContain("convertRegionPrices");
    // And the cross-check that justifies trusting the currencies.
    expect(src).toMatch(/MATCH 100 PERCENT/);
  });
});

describe("⚠ the snapshot cannot be hand-edited one row at a time", () => {
  /**
   * ⚠ THIS BLOCK EXISTS BECAUSE A MUTATION DID NOT GO RED. X4's mutation pass
   * changed VN from VND to USD in the snapshot, left `regionsVersion` alone,
   * and the whole suite stayed green — precisely the edit the snapshot's own
   * docblock forbids ("NEVER EDIT ONE FIELD ALONE"). Adjudicated as a test
   * with no teeth rather than a mutation at the wrong layer: every currency
   * assertion elsewhere reads the snapshot on BOTH sides, so it is
   * self-consistent by construction and can never disagree with itself.
   *
   * The fingerprint is the tooth. It covers every `code:currency` pair, so any
   * hand-edit fails here — and updating it is a visible line in a review,
   * which is the moment to ask whether the version and the measurement date
   * moved too.
   */
  const FINGERPRINT = "571b3c77245a9585";

  function fingerprint(): string {
    const src = readFileSync(
      join(__dirname, "google", "play-regions.snapshot.ts"),
      "utf8",
    );
    const pairs = [...src.matchAll(/\{ code: "([A-Z]{2})", currency: "([A-Z]{3})" \}/g)]
      .map((m) => `${m[1]}:${m[2]}`)
      .sort();
    expect(pairs).toHaveLength(173);
    return createHash("sha256").update(pairs.join("|")).digest("hex").slice(0, 16);
  }

  it("the 173 code:currency pairs hash to the pinned fingerprint", () => {
    // ⚠ IF THIS FAILS, DO NOT JUST PASTE THE NEW HASH. The snapshot changed.
    // Either it was re-measured — in which case `PLAY_REGIONS_VERSION` and
    // `PLAY_REGIONS_MEASURED_AT` must move in the SAME commit, and the tests
    // below check that — or somebody edited a row by hand, which is the thing
    // the file says never to do.
    expect(fingerprint()).toBe(FINGERPRINT);
  });

  it("the fingerprint is pinned beside the version it describes", () => {
    // A fingerprint that outlives its version says nothing. These three move
    // together or the snapshot is lying about its provenance.
    expect(PLAY_REGIONS_VERSION).toBe("2025/03");
    expect(PLAY_REGIONS_MEASURED_AT).toBe("2026-09-01");
    expect(FINGERPRINT).toHaveLength(16);
  });

  it("⚠ a few high-traffic currencies, spelled out — a hash names nothing", () => {
    // The fingerprint catches ANY change but reports none of them. These say
    // out loud what the important rows are, so a failure is readable.
    // ⚠ AR IS HERE ON PURPOSE: Google bills Argentina in USD, while the tool's
    // old `COMMON_REGIONS` said ARS — the one measured currency mismatch in
    // that 30-entry list (`[GOOGLE-common-regions-usd-default]`).
    const byCode = new Map(PLAY_REGIONS.map((r) => [r.code, r.currency]));
    expect(byCode.get("VN")).toBe("VND");
    expect(byCode.get("US")).toBe("USD");
    expect(byCode.get("DE")).toBe("EUR");
    expect(byCode.get("JP")).toBe("JPY");
    expect(byCode.get("AR")).toBe("USD");
    expect(byCode.get("CI")).toBe("XOF");
    expect(byCode.get("TR")).toBe("TRY");
  });
});

describe("⚠ drift detection uses Google's OWN version string", () => {
  it("same version → no drift", () => {
    expect(checkRegionsVersion("2025/03")).toEqual({
      pinned: "2025/03",
      live: "2025/03",
      drifted: false,
    });
  });

  it("a different version → drift, with both values named", () => {
    const r = checkRegionsVersion("2026/01");
    expect(r.drifted).toBe(true);
    expect(r.pinned).toBe("2025/03");
    expect(r.live).toBe("2026/01");
  });

  it("⚠ a MISSING version is NOT drift", () => {
    // `regionsVersion` is `string | null` in the helper's result type because
    // the field can be absent. Calling that "drifted" would cry wolf whenever
    // the SDK shape wobbles, and an alarm nobody believes is how a real drift
    // gets ignored.
    for (const v of [null, undefined, "", "   "]) {
      const r = checkRegionsVersion(v);
      expect(r.drifted, JSON.stringify(v)).toBe(false);
      expect(r.live, JSON.stringify(v)).toBeNull();
    }
  });

  it("⚠ one string comparison — deliberately NOT Apple's code-by-code sweep", () => {
    // Google states its catalog version; Apple has to diff its snapshot entry
    // by entry to discover the same thing. Pinning the cheap path so nobody
    // "improves" it into the expensive one.
    const src = readFileSync(
      join(__dirname, "google", "play-regions.snapshot.ts"),
      "utf8",
    );
    expect(src).toMatch(/Do NOT port\s*\n?\s*\*?\s*Apple's code-by-code sweep/);
  });
});

describe("the catalog the dialog receives", () => {
  it("is the 173 — not the Apple module's 183", () => {
    expect(GOOGLE_TERRITORY_CATALOG).toHaveLength(173);
    expect(GOOGLE_TERRITORY_CODES).toHaveLength(173);
  });

  it("⚠ contains the 15 markets the borrowed catalog could never tick", () => {
    // The commercial half of R2. RU is the one that matters most.
    for (const code of "AW BM BY CF ER GI KY LY RU SO TC VA VG YE ZW".split(" ")) {
      expect(GOOGLE_TERRITORY_CODES, code).toContain(code);
    }
  });

  it("⚠ contains NONE of the 25 markets Google does not sell in", () => {
    // The other half: entries that could be ticked and produce a column
    // nobody asked for.
    for (const code of "AD AF BB BI BN BT CN ET GQ GY KI LS ME MG MH MR MW NR PW ST SZ TL TV VC XK".split(" ")) {
      expect(GOOGLE_TERRITORY_CODES, code).not.toContain(code);
    }
  });

  it("names every market with the Play Console label, not an ISO fallback", () => {
    for (const t of GOOGLE_TERRITORY_CATALOG) {
      expect(t.name, t.code).toBe(regionNameFromCode(t.code));
      expect(t.name, t.code).not.toBe(t.code);
    }
  });

  it("carries the measured currency for every market", () => {
    const byCode = new Map(PLAY_REGIONS.map((r) => [r.code, r.currency]));
    for (const t of GOOGLE_TERRITORY_CATALOG) {
      expect(t.currency, t.code).toBe(byCode.get(t.code));
    }
  });
});

describe("⚠ grouping — five buckets, from the Google module's own table", () => {
  it("every entry lands in one of the five, and none is left unbucketed", () => {
    const seen = new Set(GOOGLE_TERRITORY_CATALOG.map((t) => t.region));
    expect([...seen].sort()).toEqual(
      ["Africa", "Americas", "Asia", "Europe", "Oceania"].sort(),
    );
  });

  it('⚠ "Middle East" is absent on purpose — the dialog skips empty buckets', () => {
    // Apple's picker has six groups; this one has the five the Google module
    // already uses for its pricing-matrix filter (Manager decision Q2.D,
    // 2026-05-23). The shared dialog renders only non-empty buckets, so this
    // needs no change there — and using Apple's buckets would mean importing
    // Apple's per-country data to decide where a Google market is shown, which
    // is the dependency X4 exists to remove.
    expect(GOOGLE_TERRITORY_CATALOG.some((t) => t.region === "Middle East")).toBe(false);
  });

  it("entries are grouped, and alphabetical by name inside each group", () => {
    const order = ["Asia", "Europe", "Americas", "Africa", "Oceania"];
    const idx = GOOGLE_TERRITORY_CATALOG.map((t) => order.indexOf(t.region));
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
    for (const bucket of order) {
      const names = GOOGLE_TERRITORY_CATALOG.filter((t) => t.region === bucket).map(
        (t) => t.name,
      );
      expect(names, bucket).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    }
  });

  it("the unbucketed fallback is unreachable today — every code has a continent", () => {
    // Pinned so the fallback's existence is a deliberate safety net rather
    // than a silent dumping ground somebody stopped noticing.
    const asia = GOOGLE_TERRITORY_CATALOG.filter((t) => t.region === "Asia");
    expect(asia).toHaveLength(42);
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * ⚠ THE R2 PIN — the single most important assertion in this arc.
 * ──────────────────────────────────────────────────────────────────────── */

describe("⚠ the Google caller MUST pass `catalog` — this is how R2 shipped", () => {
  const clientSrc = readFileSync(
    join(
      __dirname,
      "..",
      "..",
      "components",
      "google-iap-management",
      "iap-list",
      "IapListClient.tsx",
    ),
    "utf8",
  );

  it("`<ExportOptionsDialog>` is rendered WITH a catalog prop", () => {
    // ⚠ THE MUTATION THIS EXISTS FOR: deleting this one prop. The shared
    // dialog defaults `catalog` to `TERRITORY_CATALOG` — 183 hand-typed
    // entries in the APPLE module — so omitting it is not a smaller call, it
    // silently swaps the country list for another store's. That is exactly how
    // the bug shipped: three props, no catalog, and every grep for the Apple
    // constant in the Google tree came back clean (KB P34).
    const open = clientSrc.indexOf("<ExportOptionsDialog");
    expect(open).toBeGreaterThan(-1);
    const close = clientSrc.indexOf("/>", open);
    const jsx = clientSrc.slice(open, close);
    expect(jsx).toMatch(/catalog=\{GOOGLE_TERRITORY_CATALOG\}/);
  });

  it("and it imports the GOOGLE catalog, never the Apple one", () => {
    expect(clientSrc).toMatch(
      /import \{ GOOGLE_TERRITORY_CATALOG \} from "@\/lib\/google-iap-management\/export-territory-catalog";/,
    );
    // ⚠ THIS ASSERTS ON IMPORT STATEMENTS, NOT ON THE WHOLE FILE, and both
    // narrowings were forced by a false failure:
    //   · a bare /TERRITORY_CATALOG/ also matches inside
    //     `GOOGLE_TERRITORY_CATALOG`;
    //   · even with a lookbehind it matches the file's own ⚠ comment, which
    //     names the Apple constant precisely in order to warn about it.
    // A guard that fails on a correct file teaches people to delete the guard.
    const imports = [...clientSrc.matchAll(/^import[\s\S]*?from\s+"[^"]+";$/gm)].map(
      (m) => m[0],
    );
    const appleCatalogImport = imports.filter(
      (i) => /(?<!GOOGLE_)TERRITORY_CATALOG/.test(i) || /lib\/iap-management\/territory-catalog/.test(i),
    );
    expect(appleCatalogImport, appleCatalogImport.join(" | ")).toEqual([]);
  });

  it("⚠ the catalog module takes only a TYPE from the Apple module", () => {
    // A type carries no territories. The DATA is what R2 was about, and a
    // value import from `lib/iap-management` here would re-open it.
    const src = readFileSync(join(__dirname, "export-territory-catalog.ts"), "utf8");
    const appleImports = [...src.matchAll(/^import (type )?.*from "@\/lib\/iap-management.*$/gm)];
    expect(appleImports.length).toBe(1);
    expect(appleImports[0][1], "the Apple import must be `import type`").toBe("type ");
  });
});
