/**
 * Step 2.7 of `probe-export-price-sources.mjs` — "has Apple's territory list
 * drifted from `apple-territories.snapshot.ts`?" — as a PURE function, so it
 * can be tested without Apple.
 *
 * ⚠ CODES **AND** CURRENCIES. Until PA2.3 the snapshot's currency was only
 * displayed, so comparing codes was enough. Since PA2.3 it is a GATE: "Export
 * for editing" refuses a territory stored in another currency, and the
 * import refuses a header that is not Apple's currency — both from this
 * snapshot. If Apple re-bills a territory (BGR moved BGN → EUR in Jan 2026)
 * and the snapshot is not refreshed, both gates insist on the OLD currency.
 * A code-only diff would still print "IN SYNC" — this one does not.
 *
 * @param {string} snapshotSrc the source text of apple-territories.snapshot.ts
 * @param {ReadonlyArray<{ id: string; attributes?: { currency?: string } }>} live
 *   the `data` of Apple's `GET /v1/territories?limit=200`
 */
export function territorySnapshotDrift(snapshotSrc, live) {
  // ⚠ MATCHES `code: "XXX"`, NOT ANY 3-LETTER STRING — every entry also has
  // a currency, three uppercase letters in quotes; a bare /"[A-Z]{3}"/ would
  // fold USD and EUR into the territory list.
  const codes = [...new Set([...snapshotSrc.matchAll(/code: "([A-Z]{3})"/g)].map((m) => m[1]))];
  const snapshotCurrency = new Map(
    [...snapshotSrc.matchAll(/code: "([A-Z]{3})", currency: "([A-Z]{3})"/g)].map((m) => [m[1], m[2]]),
  );
  const liveCodes = [...new Set(live.map((t) => t.id))];
  const liveCurrency = new Map(live.map((t) => [t.id, t.attributes?.currency ?? ""]));
  const added = liveCodes.filter((c) => !codes.includes(c)).sort();
  const removed = codes.filter((c) => !liveCodes.includes(c)).sort();
  const currencyChanged = liveCodes
    .filter((c) => snapshotCurrency.has(c) && snapshotCurrency.get(c) !== liveCurrency.get(c))
    .sort()
    .map((c) => ({ code: c, snapshot: /** @type {string} */ (snapshotCurrency.get(c)), live: liveCurrency.get(c) ?? "" }));
  // ⚠ COUNT (KB §4.20 point 3): every code must have been read WITH its
  // currency, or the currency comparison silently covered fewer entries.
  const unreadCurrencies = codes.filter((c) => !snapshotCurrency.has(c));
  return {
    snapshotCount: codes.length,
    liveCount: liveCodes.length,
    added,
    removed,
    currencyChanged,
    unreadCurrencies,
    inSync: added.length === 0 && removed.length === 0 && currencyChanged.length === 0 && unreadCurrencies.length === 0,
  };
}
