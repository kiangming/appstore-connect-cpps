/**
 * READ-ONLY Apple probe — "why does the export file have only N territories?"
 *
 * ⚠ LIVES IN THE REPO ON PURPOSE. A measurement that decides a design has to
 * be repeatable by whoever asks the question next; a probe kept in a scratch
 * directory dies with the session and the next person re-derives it from
 * scratch (the D1 script did exactly that).
 *
 * ⚠ READ-ONLY. Six GETs, no POST/PATCH/DELETE anywhere in this file. It
 * prints COUNTS and FIELD NAMES only — never a key, a token or a JWT.
 *
 * The six requests, and what each one settles:
 *   1. /v1/apps/{app}/inAppPurchasesV2?filter[productId]=…  → the item's Apple id
 *   2. /v2/inAppPurchases/{id}/iapPriceSchedule?include=…   → stage1_rel_count
 *   3. /v1/…/{sid}/manualPrices?limit=200 (paginated)       → stage2_total
 *   4. /v1/…/{sid}/automaticPrices?limit=200 (paginated)    → automatic_total
 *   5. (part of 4) the SHAPE of one automaticPrices entry   → is customerPrice
 *                                                             inline, or is
 *                                                             there an N+1?
 *   6. /v1/territories?limit=200                            → does Apple return
 *                                                             a territory NAME?
 *
 * Reading the three counts side by side:
 *   stage1 == stage2                → no truncation; the column count is the
 *                                     item's REAL manual-price count
 *   stage1 <  stage2                → Apple truncated the V2 relationship
 *                                     (KB §4.1) and Stage 2 rescued it
 *   automatic_total > 0             → territories priced by Apple's
 *                                     auto-equalization, which the export does
 *                                     not read today
 *
 * Answers the three numbers that settle the export-territory question:
 *   stage1_rel_count · stage2_total · automatic_total
 * plus the SHAPE of one automaticPrices entry (2.5) and whether Apple
 * returns a territory NAME (2.6).
 *
 * Run from the repo root on a machine that HAS working ASC credentials:
 *
 *   ASC_KEY_ID=… ASC_ISSUER_ID=… ASC_PRIVATE_KEY="$(cat AuthKey_XXX.p8)" \
 *     node probe-export-prices.mjs
 *
 * ⚠ It prints counts and field NAMES only — never a key, never a token.
 */
import { readFileSync } from "node:fs";
import { createHmac, createSign } from "node:crypto";

const APP_ID = "6738648909";
const PRODUCT_ID = "com.vnggames.aoiaf.0.99";

const KEY_ID = process.env.ASC_KEY_ID;
const ISSUER_ID = process.env.ASC_ISSUER_ID;
const PRIVATE_KEY = process.env.ASC_PRIVATE_KEY;
if (!KEY_ID || !ISSUER_ID || !PRIVATE_KEY) {
  console.error("Missing ASC_KEY_ID / ASC_ISSUER_ID / ASC_PRIVATE_KEY.");
  process.exit(1);
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function token() {
  const header = b64({ alg: "ES256", kid: KEY_ID, typ: "JWT" });
  const now = Math.floor(Date.now() / 1000);
  const payload = b64({
    iss: ISSUER_ID,
    iat: now,
    exp: now + 900,
    aud: "appstoreconnect-v1",
  });
  const signer = createSign("SHA256");
  signer.update(`${header}.${payload}`);
  const der = signer.sign(PRIVATE_KEY);
  // DER → JOSE (r||s, 32 bytes each)
  let off = 2, out = Buffer.alloc(64);
  for (const half of [0, 32]) {
    off += 1;
    const len = der[off++];
    let start = off, take = len;
    if (take > 32) { start += take - 32; take = 32; }
    der.copy(out, half + (32 - take), start, start + take);
    off += len;
  }
  return `${header}.${payload}.${out.toString("base64url")}`;
}

let calls = 0;
async function get(path) {
  calls++;
  const r = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
    headers: { Authorization: `Bearer ${token()}` },
  });
  if (!r.ok) throw new Error(`${r.status} ${path} :: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// ── locate the item ───────────────────────────────────────────────────────
const list = await get(
  `/v1/apps/${APP_ID}/inAppPurchasesV2?filter[productId]=${PRODUCT_ID}&limit=1`,
);
const iapId = list.data?.[0]?.id;
if (!iapId) { console.error("IAP not found"); process.exit(1); }
console.log(`item ${PRODUCT_ID} → apple id ${iapId}`);

// ── 2.1 stage 1 ───────────────────────────────────────────────────────────
const s1 = await get(
  `/v2/inAppPurchases/${iapId}/iapPriceSchedule?include=baseTerritory,manualPrices&limit[manualPrices]=50`,
);
const scheduleId = s1.data.id;
const relCount = s1.data.relationships?.manualPrices?.data?.length ?? 0;
const relTotal = s1.data.relationships?.manualPrices?.meta?.paging?.total;
console.log(`2.1 stage1_rel_count = ${relCount}   (meta.paging.total = ${relTotal ?? "absent"})`);

// ── 2.2 stage 2, paginated ────────────────────────────────────────────────
async function pageAll(sub) {
  const rows = [], included = [];
  let path = `/v1/inAppPurchasePriceSchedules/${scheduleId}/${sub}?include=inAppPurchasePricePoint,territory&limit=200`;
  let total;
  while (path) {
    const p = await get(path);
    rows.push(...(p.data ?? []));
    included.push(...(p.included ?? []));
    total = p.meta?.paging?.total ?? total;
    const next = p.links?.next;
    path = next ? new URL(next).pathname + new URL(next).search : null;
  }
  return { rows, included, total };
}
const manual = await pageAll("manualPrices");
console.log(`2.2 stage2_total       = ${manual.rows.length}   (meta.paging.total = ${manual.total ?? "absent"})`);

// ── 2.3 automaticPrices ───────────────────────────────────────────────────
const auto = await pageAll("automaticPrices");
console.log(`2.3 automatic_total    = ${auto.rows.length}   (meta.paging.total = ${auto.total ?? "absent"})`);

// ── 2.4 the verdict ───────────────────────────────────────────────────────
console.log(`\n2.4  ${relCount} · ${manual.rows.length} · ${auto.rows.length}`);
console.log(
  relCount === manual.rows.length
    ? "     stage1 == stage2 ⇒ NO truncation. The 10 columns are the real manual count."
    : `     ⚠ stage1 (${relCount}) != stage2 (${manual.rows.length}) ⇒ Stage 1 WAS truncated.`,
);
console.log(`     manual + automatic = ${manual.rows.length + auto.rows.length} territories priced in total`);

// ── 2.5 SHAPE of one automatic entry — the cost decision ──────────────────
const a0 = auto.rows[0];
if (a0) {
  const ppId = a0.relationships?.inAppPurchasePricePoint?.data?.id;
  const pp = auto.included.find((r) => r.type === "inAppPurchasePricePoints" && r.id === ppId);
  const terrId = a0.relationships?.territory?.data?.id;
  const terr = auto.included.find((r) => r.type === "territories" && r.id === terrId);
  console.log("\n2.5 one automaticPrices entry:");
  console.log("    price.attributes      :", Object.keys(a0.attributes ?? {}));
  console.log("    price.relationships   :", Object.keys(a0.relationships ?? {}));
  console.log("    pricePoint INLINE?    :", pp ? `YES → ${Object.keys(pp.attributes ?? {})}` : "NO — would need a second call (N+1)");
  console.log("    customerPrice         :", pp?.attributes?.customerPrice ?? "(absent)");
  console.log("    territory INLINE?     :", terr ? `YES → ${Object.keys(terr.attributes ?? {})}` : "NO");
  console.log("    ⚠ `manual` attribute  :", "manual" in (a0.attributes ?? {}) ? `PRESENT = ${a0.attributes.manual}` : "ABSENT (spec lists it; behaviour differs)");
}

// ── 2.5b the MANUAL side of the same attribute ────────────────────────────
// The first run dumped an automatic entry only. `manual` is the source of
// truth for cell shading, so BOTH endpoints must be checked: if /manualPrices
// rows do not all carry manual=true, then the attribute and the endpoint
// disagree and the code's cross-check warning will fire in production.
const withFlag = manual.rows.filter((r) => "manual" in (r.attributes ?? {}));
const sayingTrue = manual.rows.filter((r) => r.attributes?.manual === true);
console.log("\n2.5b manualPrices entries:");
console.log("    carrying `manual`   :", `${withFlag.length}/${manual.rows.length}`);
console.log("    manual === true     :", `${sayingTrue.length}/${manual.rows.length}`);
console.log(
  "    verdict             :",
  sayingTrue.length === manual.rows.length
    ? "consistent — endpoint and attribute agree"
    : "⚠ MISMATCH — the attribute wins; the code logs this and keeps reading it",
);

// ── 2.6 does Apple return a territory NAME? ───────────────────────────────
const terrs = await get("/v1/territories?limit=200");
console.log("\n2.6 /v1/territories:");
console.log("    count               :", terrs.data.length);
console.log("    attributes on entry :", Object.keys(terrs.data[0]?.attributes ?? {}));
console.log("    → territory NAME    :", "name" in (terrs.data[0]?.attributes ?? {}) ? "PRESENT" : "ABSENT — must come from the internal catalog");
console.log("    Apple codes         :", terrs.data.map((t) => t.id).join(" "));

// ── 2.6b G1 — the CURRENCY per territory, emitted paste-ready ──────────────
//
// ⚠ WHY THIS PRINTS SOURCE AND NOT A TABLE. The picker renders
// `{code} · {currency}` for every territory, so the snapshot has to carry the
// currency, and the only authority for "what currency does Apple bill this
// market in" is Apple. Deriving it from an ISO-4217 table would be a guess
// dressed as data — several Apple territories bill in a currency that is not
// their country's own (the Caribbean and the overseas territories especially).
//
// ⚠ AND IT IS EMITTED AS TYPESCRIPT ON PURPOSE. The last transcription error
// in this arc (a fixture built in alpha-2 where Apple speaks alpha-3) cost a
// debugging round and looked correct the whole time. Copy-pasting a block
// that is already the literal the file needs removes the step where a human
// re-types 175 rows.
console.log("\n2.6b currency per territory — PASTE-READY, copy between the markers:");
console.log("// ---8<--- APPLE_TERRITORIES begin (measured " + new Date().toISOString().slice(0, 10) + ") ---8<---");
{
  const rows = terrs.data
    .map((t) => ({ code: t.id, currency: t.attributes?.currency ?? "" }))
    .sort((a, b) => a.code.localeCompare(b.code));
  const missing = rows.filter((r) => !r.currency);
  for (let i = 0; i < rows.length; i += 4) {
    console.log(
      "  " +
        rows
          .slice(i, i + 4)
          .map((r) => `{ code: "${r.code}", currency: "${r.currency}" },`)
          .join(" "),
    );
  }
  console.log("// ---8<--- APPLE_TERRITORIES end · " + rows.length + " entries ---8<---");
  if (missing.length > 0) {
    console.log(
      "    ⚠ " + missing.length + " territory/territories returned NO currency: " +
        missing.map((r) => r.code).join(" ") +
        " — do NOT invent one; report it.",
    );
  } else {
    console.log("    ✓ all " + rows.length + " entries carry a currency.");
  }
}

// ── 2.7 DETECTOR (a) — has Apple's list drifted from our snapshot? ─────────
//
// ⚠ THE REASON THIS STEP EXISTS. `apple-territories.snapshot.ts` decides how
// many columns an "all countries" export has. It is a photograph taken
// 2026-08-27 and nothing in the app refreshes it. The runtime detector
// (`unknownAppleTerritories`) catches ADDITIONS automatically but is blind to
// REMOVALS by construction — a territory Apple dropped simply stops appearing.
// Comparing whole lists is the only way to see both, and this is the only
// place with a live list to compare against.
const snapshotSrc = readFileSync(
  new URL("../lib/iap-management/apple/apple-territories.snapshot.ts", import.meta.url),
  "utf8",
);
// ⚠ MATCHES `code: "XXX"`, NOT ANY 3-LETTER STRING. G1b gave every entry a
// currency, which is also three uppercase letters in quotes — a bare
// /"[A-Z]{3}"/ would fold USD and EUR into the territory list and report
// phantom drift on every run. The narrower pattern is the whole guard.
const snapshot = [
  ...new Set(
    [...snapshotSrc.matchAll(/code: "([A-Z]{3})"/g)].map((m) => m[1]),
  ),
];
const live = [...new Set(terrs.data.map((t) => t.id))];
const added = live.filter((c) => !snapshot.includes(c)).sort();
const removed = snapshot.filter((c) => !live.includes(c)).sort();
console.log("\n2.7 snapshot drift (apple-territories.snapshot.ts):");
console.log("    snapshot count      :", snapshot.length);
console.log("    live count          :", live.length);
if (added.length === 0 && removed.length === 0) {
  console.log("    → IN SYNC. No edit needed.");
} else {
  console.log("    ⚠ DRIFTED — edit the snapshot, then re-run the pinned tests.");
  console.log("    ADDED by Apple      :", added.join(" ") || "(none)");
  console.log("    REMOVED by Apple    :", removed.join(" ") || "(none)");
  console.log(
    "    ⚠ An ADDED territory has no column on an 'all countries' export until",
  );
  console.log("      the snapshot is updated. A REMOVED one exports as an empty `—`.");
}

console.log(`\nApple GETs used: ${calls}`);
