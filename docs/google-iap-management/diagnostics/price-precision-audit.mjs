/**
 * READ-ONLY price-precision audit. See price-precision-audit.md for how to
 * read the output and — importantly — what NOT to do with the result.
 *
 * Question: how many cached IAPs carry at least one region whose
 * price_micros is NOT a multiple of that currency's smallest unit, such
 * that seeding the Edit form (safeMicrosToDecimal → microsToDecimal(m,2))
 * produces a value the form's OWN validator rejects — blocking every
 * submit for that item.
 *
 * Replicates verbatim:
 *   - microsToDecimal(micros, 2)        price-conversion.ts:96-130
 *   - getCurrencyDecimals(currency)     currency-precision.ts:74-81
 *   - validateDecimalForCurrency(d, c)  currency-precision.ts:92-114
 */
import fs from "node:fs";
import { createRequire } from "node:module";
const REPO = process.env.REPO_ROOT ?? process.cwd();
const require = createRequire(`${REPO}/package.json`);
const { createClient } = require("@supabase/supabase-js");

// ── env ──────────────────────────────────────────────────────────────
const env = {};
for (const line of fs.readFileSync(`${REPO}/.env.local`, "utf8").split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const url = env.SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SERVICE_KEY;
if (!url || !key) throw new Error("missing supabase creds");

const db = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
  db: { schema: "google_iap_mgmt" },
});

// ── verbatim replicas ────────────────────────────────────────────────
const CURRENCY_DECIMALS = {
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, IDR: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0,
  LAK: 0, PYG: 0, RWF: 0, UGX: 0, UYI: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0,
  XPF: 0, HUF: 0, TWD: 0,
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
  CLF: 4, UYW: 4,
};
const getCurrencyDecimals = (c) => {
  if (!c) return 2;
  const n = c.trim().toUpperCase();
  if (n === "") return 2;
  return Object.prototype.hasOwnProperty.call(CURRENCY_DECIMALS, n)
    ? CURRENCY_DECIMALS[n] : 2;
};
const MICROS_PER_UNIT = 1000000n;
function microsToDecimal(micros, displayDecimals = 2) {
  const t = String(micros).trim();
  if (!/^\d+$/.test(t)) return null;
  const value = BigInt(t);
  const whole = value / MICROS_PER_UNIT;
  const remainder = value % MICROS_PER_UNIT;
  const fracFull = remainder.toString().padStart(6, "0");
  if (displayDecimals === 0) return whole.toString();
  const fracDisplay = fracFull.slice(0, displayDecimals);
  const fracRest = fracFull.slice(displayDecimals).replace(/0+$/, "");
  const frac = fracRest ? fracDisplay + fracRest : fracDisplay;
  return `${whole}.${frac}`;
}
function validateDecimalForCurrency(decimal, currency) {
  const t = decimal.trim();
  if (t === "") return null;
  if (!/^\d+(\.\d*)?$/.test(t)) return `not a number ("${decimal}")`;
  const dot = t.indexOf(".");
  const fracLen = dot === -1 ? 0 : t.slice(dot + 1).replace(/0+$/, "").length;
  const allowed = getCurrencyDecimals(currency);
  if (fracLen > allowed) {
    const n = currency.trim().toUpperCase();
    return allowed === 0
      ? `${n} only accepts whole numbers (got "${decimal}").`
      : `${n} supports at most ${allowed} decimal place${allowed === 1 ? "" : "s"} (got "${decimal}" with ${fracLen}).`;
  }
  return null;
}

// ── page through iap_prices ──────────────────────────────────────────
const PAGE = 1000;
let from = 0;
const offenders = []; // { iap_id, region, currency, micros, decimal, err }
const perIap = new Map();
let totalRows = 0;

for (;;) {
  const { data, error } = await db
    .from("iap_prices")
    .select("iap_id, region_code, currency, price_micros")
    .range(from, from + PAGE - 1);
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) break;
  totalRows += data.length;
  for (const r of data) {
    const dec = microsToDecimal(r.price_micros, 2);
    if (dec === null) continue;
    const err = validateDecimalForCurrency(dec, r.currency);
    if (err) {
      offenders.push({ ...r, decimal: dec, err });
      perIap.set(r.iap_id, (perIap.get(r.iap_id) ?? 0) + 1);
    }
  }
  if (data.length < PAGE) break;
  from += PAGE;
}

// ── also: how many IAP rows exist at all, and base-price offenders ───
const { count: iapCount } = await db
  .from("iaps")
  .select("id", { count: "exact", head: true });

const baseOffenders = [];
let bfrom = 0;
for (;;) {
  const { data, error } = await db
    .from("iaps")
    .select("id, sku, app_id, default_currency, default_price_micros")
    .range(bfrom, bfrom + PAGE - 1);
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) break;
  for (const r of data) {
    if (!r.default_price_micros || !r.default_currency) continue;
    const dec = microsToDecimal(r.default_price_micros, 2);
    if (dec === null) continue;
    const err = validateDecimalForCurrency(dec, r.default_currency);
    if (err) baseOffenders.push({ ...r, decimal: dec, err });
  }
  if (data.length < PAGE) break;
  bfrom += PAGE;
}

// ── enrich top offenders with sku ────────────────────────────────────
const topIapIds = [...perIap.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 10)
  .map(([id]) => id);
let skuById = new Map();
if (topIapIds.length > 0) {
  const { data } = await db
    .from("iaps")
    .select("id, sku, app_id")
    .in("id", topIapIds);
  skuById = new Map((data ?? []).map((r) => [r.id, r]));
}

const out = [];
out.push("=== SCOPE: sub-minor-unit cached prices (Google IAP) ===");
out.push(`iap_prices rows scanned : ${totalRows}`);
out.push(`iaps rows total         : ${iapCount ?? "?"}`);
out.push("");
out.push(`OFFENDING price rows    : ${offenders.length}`);
out.push(`OFFENDING items (iaps)  : ${perIap.size}`);
out.push(`OFFENDING base prices   : ${baseOffenders.length}`);
out.push("");
out.push("--- TOP 10 ITEMS BY OFFENDING REGION COUNT ---");
for (const id of topIapIds) {
  const meta = skuById.get(id);
  const rows = offenders.filter((o) => o.iap_id === id).slice(0, 4);
  out.push(
    `iap=${meta?.sku ?? id} (app_id=${meta?.app_id ?? "?"}) offending_regions=${perIap.get(id)}`,
  );
  for (const r of rows) {
    out.push(
      `    ${r.region_code} ${r.currency} micros=${r.price_micros} → "${r.decimal}"  ✗ ${r.err}`,
    );
  }
}
out.push("");
out.push("--- CURRENCY BREAKDOWN OF OFFENDING ROWS ---");
const byCur = new Map();
for (const o of offenders) byCur.set(o.currency, (byCur.get(o.currency) ?? 0) + 1);
for (const [c, n] of [...byCur.entries()].sort((a, b) => b[1] - a[1])) {
  out.push(`    ${c} (allowed ${getCurrencyDecimals(c)} dp): ${n} rows`);
}
out.push("");
out.push("--- BASE-PRICE OFFENDERS (blocks submit via errors.basePrice) ---");
for (const b of baseOffenders.slice(0, 10)) {
  out.push(`    ${b.sku} ${b.default_currency} micros=${b.default_price_micros} → "${b.decimal}"  ✗ ${b.err}`);
}

const text = out.join("\n");
console.log(text);

