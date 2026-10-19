/**
 * H4.4 — pins docs/google-iap-management/queries/audit-template-entries-h4.sql
 * (the read-only check the Manager runs on prod BEFORE the H4 push) to the code
 * whose effect it predicts:
 *   - it is READ-ONLY (only WITH / SELECT);
 *   - its embedded `decimals` table IS CURRENCY_DECIMALS_OVERRIDES, and its
 *     `billed` table IS PLAY_REGIONS — every copy of each;
 *   - its "H4 refuses this entry" rule (not a number / 0 / not a multiple of
 *     10^(6-decimals)) says exactly what storedRegionPriceOf says.
 * A drift in any of these and the Manager would be told the wrong rows.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { CURRENCY_DECIMALS_OVERRIDES, getCurrencyDecimals } from "./google/currency-precision";
import { PLAY_REGIONS } from "./google/play-regions.snapshot";
import { storedRegionPriceOf } from "./orchestration/file-price";

const SQL = readFileSync(join(__dirname, "../../docs/google-iap-management/queries/audit-template-entries-h4.sql"), "utf8");
const CODE = SQL.replace(/--.*$/gm, "");

function valuesBlocks(name: string): string[] {
  const re = new RegExp(`${name}\\([a-z_, ]+\\) AS \\(VALUES([\\s\\S]*?)\\n\\)`, "g");
  return [...CODE.matchAll(re)].map((m) => m[1]);
}

describe("audit-template-entries-h4.sql", () => {
  it("is READ-ONLY: no write or DDL statement outside comments", () => {
    // String literals removed first ('DO' is the Dominican Republic's code).
    expect(CODE.replace(/'[^']*'/g, "''")).not.toMatch(
      /\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|GRANT|REVOKE|COPY|MERGE|INTO|DO|EXECUTE|CALL|SET|LOCK|VACUUM|REFRESH|NOTIFY)\b/i,
    );
    expect(CODE.match(/\bSELECT\b/g)?.length ?? 0).toBeGreaterThan(4);
  });

  it("every `decimals` copy IS CURRENCY_DECIMALS_OVERRIDES (currencies absent = 2, as getCurrencyDecimals)", () => {
    const blocks = valuesBlocks("decimals");
    expect(blocks).toHaveLength(3);
    const expected = Object.entries(CURRENCY_DECIMALS_OVERRIDES).sort();
    const PAIR = /\(\s*'([A-Z]{3})'\s*,\s*(\d+)\s*\)/g;
    for (const b of blocks) {
      const got = [...b.matchAll(PAIR)].map((m) => [m[1], Number(m[2])]).sort();
      expect(got).toEqual(expected);
      // Nothing else in the block: every value is a recognised pair.
      expect(b.replace(PAIR, "").replace(/[\s,]/g, "")).toBe("");
    }
  });

  it("every `billed` copy IS PLAY_REGIONS (173 pairs)", () => {
    const blocks = valuesBlocks("billed");
    expect(blocks).toHaveLength(3);
    const expected = PLAY_REGIONS.map((r) => [r.code, r.currency]).sort();
    const PAIR = /\(\s*'([A-Z]{2})'\s*,\s*'([A-Z]{3})'\s*\)/g;
    for (const b of blocks) {
      const got = [...b.matchAll(PAIR)].map((m) => [m[1], m[2]]).sort();
      expect(got).toEqual(expected);
      expect(b.replace(PAIR, "").replace(/[\s,]/g, "")).toBe("");
    }
  });

  it("its refusal rule = storedRegionPriceOf, on a spread of entries", () => {
    // The SQL rule, transcribed: not ^[0-9]+$ ⇒ refused; = 0 ⇒ refused;
    // micros mod 10^(6 - decimals) <> 0 ⇒ refused.
    // EVERY copy of each rule (Q1, Q2 and Q3 each carry one) — a drift in
    // one query would tell the Manager the wrong rows.
    expect(CODE.match(/en\.price_micros !~ '\^\[0-9\]\+\$'/g)).toHaveLength(3);
    expect(CODE.match(/en\.price_micros::numeric = \d+/g)).toEqual([
      "en.price_micros::numeric = 0",
      "en.price_micros::numeric = 0",
      "en.price_micros::numeric = 0",
    ]);
    expect(CODE.match(/mod\(en\.price_micros::numeric, power\(10, [^)]*\)::numeric\) <> 0/g)).toEqual(
      Array(3).fill("mod(en.price_micros::numeric, power(10, 6 - en.decimals)::numeric) <> 0"),
    );
    // Q3's "prices a valid file row can match" is the exact complement.
    expect(CODE.match(/mod\(e\.price_micros::numeric, power\(10, [^)]*\)::numeric\) = 0/g)).toEqual([
      "mod(e.price_micros::numeric, power(10, 6 - e.decimals)::numeric) = 0",
    ]);
    const sqlRefuses = (currency: string, micros: string) => {
      if (!/^[0-9]+$/.test(micros)) return true;
      if (BigInt(micros) === BigInt(0)) return true;
      const d = getCurrencyDecimals(currency);
      return BigInt(micros) % BigInt(10) ** BigInt(6 - d) !== BigInt(0);
    };
    const currencies = [...Object.keys(CURRENCY_DECIMALS_OVERRIDES), "USD", "EUR", "BRL", "XYZ"];
    const micros = ["0", "1", "990000", "999000", "1000000", "30500000", "30000000", "26000000000", "3141000", "3140000", "12", "abc", "-5", "000"];
    const diffs: string[] = [];
    for (const c of currencies) {
      for (const m of micros) {
        const code = !storedRegionPriceOf({ currency: c, priceMicros: m }).ok;
        if (code !== sqlRefuses(c, m)) diffs.push(`${c} ${m}: code refuses=${code}, sql refuses=${sqlRefuses(c, m)}`);
      }
    }
    expect(diffs).toEqual([]);
  });

  it("everything OUTSIDE the generated tables is pinned: an edit to a query, a join, a scope column or a reading is a deliberate change (update the hash with it)", () => {
    // The VALUES blocks are checked against the code above; the rest of the
    // file — the queries and the KỲ VỌNG / CÁCH ĐỌC the Manager acts on — is
    // pinned by hash, so no drift in one query's CASE, WHERE or JOIN can pass
    // unnoticed.
    const skeleton = SQL.replace(/AS \(VALUES[\s\S]*?\n\)/g, "AS (VALUES …)");
    expect(createHash("md5").update(skeleton).digest("hex")).toBe("91507b54c0b3247bd2e1c7a08ce941e1");
    // Only the live tables (never the M-1 *_backup_global copies).
    expect(CODE).not.toMatch(/_backup_global/);
    expect(CODE.match(/google_iap_mgmt\.pricing_template_entries\b/g)?.length).toBe(4);
  });
});
