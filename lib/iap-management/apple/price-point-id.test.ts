/**
 * Cycle 44 — price-point id encode/decode/derive.
 *
 * The decisive correctness test: re-encoding a decoded id must reproduce
 * Apple's EXACT bytes, verified against the real captured response in
 * docs/iap-management/sample_flow_create_price.md. If this ever fails, the
 * batch catalog's runtime guard disables derivation and falls back — but
 * this test pins the happy path so a regression is caught at build time.
 */
import { describe, it, expect } from "vitest";
import {
  decodePricePointId,
  encodePricePointId,
  pricePointIdRoundTrips,
  derivePricePointId,
} from "./price-point-id";

// Real Apple-returned ids captured in docs/iap-management/sample_flow_create_price.md
// for IAP 6770029110. Each decodes to {s,t,p}.
const CAPTURED: Array<{ id: string; s: string; t: string; p: string }> = [
  { id: "eyJzIjoiNjc3MDAyOTExMCIsInQiOiJVU0EiLCJwIjoiMTAwMDEifQ", s: "6770029110", t: "USA", p: "10001" },
  { id: "eyJzIjoiNjc3MDAyOTExMCIsInQiOiJVU0EiLCJwIjoiMTAwMDIifQ", s: "6770029110", t: "USA", p: "10002" },
  { id: "eyJzIjoiNjc3MDAyOTExMCIsInQiOiJVU0EiLCJwIjoiMTAwMTAifQ", s: "6770029110", t: "USA", p: "10010" },
  { id: "eyJzIjoiNjc3MDAyOTExMCIsInQiOiJBRkciLCJwIjoiMTAwMTAifQ", s: "6770029110", t: "AFG", p: "10010" },
  { id: "eyJzIjoiNjc3MDAyOTExMCIsInQiOiJBR08iLCJwIjoiMTAwMTAifQ", s: "6770029110", t: "AGO", p: "10010" },
];

describe("decodePricePointId", () => {
  it("decodes Apple's captured ids to exact {s,t,p}", () => {
    for (const c of CAPTURED) {
      expect(decodePricePointId(c.id)).toEqual({ s: c.s, t: c.t, p: c.p });
    }
  });

  it("returns null for non-{s,t,p} shapes (extra/missing/non-string keys)", () => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64");
    expect(decodePricePointId(b64({ s: "1", t: "USA" }))).toBeNull(); // 2 keys
    expect(decodePricePointId(b64({ s: "1", t: "USA", p: "10", x: 1 }))).toBeNull(); // 4 keys
    expect(decodePricePointId(b64({ s: "1", t: "USA", p: 10 }))).toBeNull(); // p not string
    expect(decodePricePointId("@@not-base64@@")).toBeNull(); // garbage, no throw
    expect(decodePricePointId("")).toBeNull();
  });
});

describe("encodePricePointId — byte-equality with Apple (Condition 1)", () => {
  it("reproduces Apple's exact id bytes (standard base64, UNPADDED)", () => {
    for (const c of CAPTURED) {
      expect(encodePricePointId({ s: c.s, t: c.t, p: c.p })).toBe(c.id);
    }
  });

  it("emits no '=' padding", () => {
    const id = encodePricePointId({ s: "123", t: "USA", p: "10001" });
    expect(id.endsWith("=")).toBe(false);
  });
});

describe("pricePointIdRoundTrips — the runtime safety guard", () => {
  it("passes for every captured Apple id", () => {
    for (const c of CAPTURED) expect(pricePointIdRoundTrips(c.id)).toBe(true);
  });

  it("fails for an opaque id that is NOT the {s,t,p} encoding", () => {
    expect(pricePointIdRoundTrips("some-opaque-token-abc123")).toBe(false);
    // base64 of a different shape → decode fails → guard fails
    const other = Buffer.from(JSON.stringify({ a: 1, b: 2, c: 3 }), "utf8").toString("base64");
    expect(pricePointIdRoundTrips(other)).toBe(false);
  });
});

describe("derivePricePointId — cross-IAP derivation", () => {
  it("substitutes only s; t and p are unchanged; byte-equal to a real fetch for the target IAP", () => {
    const usa = CAPTURED[0]; // {6770029110, USA, 10001}
    const derived = derivePricePointId(usa.id, "9999999999");
    // byte-equal to what Apple would return for iap 9999999999 at (USA, 10001)
    expect(derived).toBe(encodePricePointId({ s: "9999999999", t: usa.t, p: usa.p }));
    expect(decodePricePointId(derived!)).toEqual({ s: "9999999999", t: "USA", p: "10001" });
  });

  it("deriving for the SAME iap is the identity (warm item is a no-op)", () => {
    const c = CAPTURED[3]; // AFG
    expect(derivePricePointId(c.id, c.s)).toBe(c.id);
  });

  it("returns null when the source id isn't the {s,t,p} shape", () => {
    expect(derivePricePointId("opaque-xyz", "123")).toBeNull();
  });
});
