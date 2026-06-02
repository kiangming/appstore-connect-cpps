/**
 * Apple IAP price-point id encode/decode/derive (Cycle 44 — bulk price-point
 * batch cache).
 *
 * Apple's `inAppPurchasePricePoints` id is NOT an opaque random token — it is
 * a deterministic encoding of `{ s, t, p }`:
 *
 *   s = the IAP id (the `{id}` in /v2/inAppPurchases/{id}/pricePoints)
 *   t = territory code (USA, COL, …)
 *   p = Apple price-tier index ("10001", "10010", …)
 *
 * Wire format (verified byte-for-byte against the real Apple capture in
 * docs/iap-management/sample_flow_create_price.md):
 *
 *   id = base64_standard_UNPADDED( JSON({"s":<s>,"t":<t>,"p":<p>}) )
 *
 * Key order is s,t,p; no whitespace; all three values are strings; the
 * trailing base64 `=` padding is stripped (Apple emits unpadded).
 *
 * Because only `s` is IAP-specific and the (territory, customerPrice) → tier
 * mapping is Apple's global catalog (identical across IAPs), the id for ANY
 * IAP can be DERIVED from a price point fetched for one IAP by substituting
 * `s`. Callers MUST guard derivation with `pricePointIdRoundTrips` on real
 * Apple data first (see batch-price-point-catalog.ts) — never ship a derived
 * id whose encoding hasn't been verified against an Apple-returned id, since
 * Apple documents the id as opaque and could change the scheme.
 */

export interface DecodedPricePointId {
  s: string;
  t: string;
  p: string;
}

/**
 * Decode an Apple price-point id to `{ s, t, p }`. Returns null when the id
 * is not the exact 3-key string-valued shape we know how to reconstruct —
 * the caller then falls back to a per-item fetch rather than guessing.
 */
export function decodePricePointId(id: string): DecodedPricePointId | null {
  try {
    const json = Buffer.from(id, "base64").toString("utf8");
    const obj: unknown = JSON.parse(json);
    if (
      obj !== null &&
      typeof obj === "object" &&
      Object.keys(obj as Record<string, unknown>).length === 3
    ) {
      const o = obj as Record<string, unknown>;
      if (
        typeof o.s === "string" &&
        typeof o.t === "string" &&
        typeof o.p === "string"
      ) {
        return { s: o.s, t: o.t, p: o.p };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Encode `{ s, t, p }` back into Apple's id form: standard base64, padding
 * stripped. Mirrors Apple's exact serialization (proven in price-point-id.test).
 */
export function encodePricePointId(decoded: DecodedPricePointId): string {
  const json = JSON.stringify({ s: decoded.s, t: decoded.t, p: decoded.p });
  return Buffer.from(json, "utf8").toString("base64").replace(/=+$/, "");
}

/**
 * Safety guard: true iff `encode(decode(id)) === id`. A pass proves Apple's
 * id is the canonical `{s,t,p}` standard-unpadded-base64 form this module
 * reproduces, which makes derivation for OTHER IAPs (only `s` differs)
 * byte-exact. A fail means Apple's encoding diverged — callers must NOT
 * derive and should fall back to a per-IAP fetch.
 */
export function pricePointIdRoundTrips(id: string): boolean {
  const decoded = decodePricePointId(id);
  if (!decoded) return false;
  return encodePricePointId(decoded) === id;
}

/**
 * Derive the price-point id for `targetIapId` from an id that belongs to a
 * different IAP (same territory + price tier). Returns null when the source
 * id isn't the expected `{s,t,p}` shape — caller falls back to a per-item
 * fetch. Substitutes ONLY `s`; `t` and `p` come from Apple's global catalog
 * and are identical across IAPs.
 */
export function derivePricePointId(
  originalId: string,
  targetIapId: string,
): string | null {
  const decoded = decodePricePointId(originalId);
  if (!decoded) return null;
  return encodePricePointId({ s: targetIapId, t: decoded.t, p: decoded.p });
}
