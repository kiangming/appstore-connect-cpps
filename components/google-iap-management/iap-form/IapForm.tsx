"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Save,
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Plus,
  Trash2,
} from "lucide-react";

import {
  GoogleLocaleSidebar,
  type FormListing,
} from "./GoogleLocaleSidebar";
import {
  COMMON_REGIONS,
  COMMON_CURRENCIES,
  defaultCurrencyForRegion,
} from "@/lib/google-iap-management/regions";
import { decimalToMicros } from "@/lib/google-iap-management/google/price-conversion";

interface Props {
  packageName: string;
}

interface RegionOverrideRow {
  region: string;
  currency: string;
  priceDecimal: string;
}

const DEFAULT_LOCALE = "en-US";

function validateDecimal(input: string): string | null {
  if (!input.trim()) return null;
  try {
    decimalToMicros(input);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : "Invalid price";
  }
}

export function IapForm({ packageName }: Props) {
  const router = useRouter();

  // Identification
  const [sku, setSku] = useState("");
  const [purchaseType, setPurchaseType] = useState<"managed" | "consumable">(
    "managed",
  );
  const [status, setStatus] = useState<"active" | "inactive">("active");

  // Listings (multi-locale)
  const [listings, setListings] = useState<Record<string, FormListing>>({
    [DEFAULT_LOCALE]: { title: "", description: "" },
  });
  const [activeLocale, setActiveLocale] = useState(DEFAULT_LOCALE);

  // Pricing
  const [baseCurrency, setBaseCurrency] = useState("USD");
  const [basePriceDecimal, setBasePriceDecimal] = useState("");
  const [pricingSource] = useState<"google_default">("google_default");
  const [regionsOpen, setRegionsOpen] = useState(false);
  const [regionOverrides, setRegionOverrides] = useState<RegionOverrideRow[]>(
    [],
  );

  // Submit
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const currentListing = listings[activeLocale] ?? { title: "", description: "" };

  function updateListing(field: keyof FormListing, value: string) {
    setListings((prev) => ({
      ...prev,
      [activeLocale]: { ...currentListing, [field]: value },
    }));
  }

  function addRegionOverride() {
    setRegionOverrides((prev) => {
      const used = new Set(prev.map((r) => r.region));
      const next = COMMON_REGIONS.find((r) => !used.has(r.code));
      if (!next) return prev;
      return [
        ...prev,
        {
          region: next.code,
          currency: next.currency,
          priceDecimal: "",
        },
      ];
    });
  }

  function updateOverride(idx: number, updates: Partial<RegionOverrideRow>) {
    setRegionOverrides((prev) =>
      prev.map((r, i) => {
        if (i !== idx) return r;
        const merged = { ...r, ...updates };
        // If region changed, snap currency to that region's default.
        if (updates.region && updates.region !== r.region) {
          merged.currency = defaultCurrencyForRegion(updates.region);
        }
        return merged;
      }),
    );
  }

  function removeOverride(idx: number) {
    setRegionOverrides((prev) => prev.filter((_, i) => i !== idx));
  }

  function validate(): boolean {
    const errors: Record<string, string> = {};
    if (!sku.trim()) errors.sku = "SKU is required.";
    else if (!/^[a-z0-9_.-]+$/i.test(sku.trim()))
      errors.sku =
        "SKU may only contain letters, numbers, underscores, dots, and dashes.";

    const defaultListing = listings[DEFAULT_LOCALE];
    if (!defaultListing?.title.trim())
      errors.defaultTitle = `Title is required for the default locale (${DEFAULT_LOCALE}).`;

    if (!basePriceDecimal.trim()) {
      errors.basePrice = "Base price is required.";
    } else {
      const decErr = validateDecimal(basePriceDecimal);
      if (decErr) errors.basePrice = decErr;
    }

    for (let i = 0; i < regionOverrides.length; i += 1) {
      const r = regionOverrides[i];
      if (r.priceDecimal.trim()) {
        const e = validateDecimal(r.priceDecimal);
        if (e) errors[`override_${i}`] = e;
      }
    }

    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }

  async function handleSubmit() {
    setFormError(null);
    if (!validate()) {
      setFormError("Please fix the errors above before submitting.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(
        `/api/google-iap-management/apps/${encodeURIComponent(packageName)}/iaps`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sku: sku.trim(),
            purchaseType,
            status,
            defaultLanguage: DEFAULT_LOCALE,
            listings: Object.entries(listings)
              .filter(([, l]) => l.title.trim().length > 0)
              .map(([locale, l]) => ({
                locale,
                title: l.title,
                description: l.description,
              })),
            baseCurrency,
            basePriceDecimal,
            regionOverrides: regionOverrides
              .filter((r) => r.priceDecimal.trim().length > 0)
              .map((r) => ({
                region: r.region,
                currency: r.currency,
                priceDecimal: r.priceDecimal,
              })),
          }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as {
        sku?: string;
        error?: string;
      };
      if (!res.ok) {
        setFormError(body.error ?? `Create failed (HTTP ${res.status}).`);
        return;
      }
      router.push(
        `/google-iap-management/apps/${encodeURIComponent(packageName)}`,
      );
      router.refresh();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Network error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Identification */}
      <section className="bg-white border border-slate-200 rounded-xl p-6">
        <h2 className="text-base font-semibold text-slate-900 mb-4">
          Identification
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-slate-700">
              SKU *
            </label>
            <input
              type="text"
              value={sku}
              onChange={(e) => setSku(e.target.value)}
              placeholder="com.example.gem_pack_small"
              className={`w-full rounded-lg border px-3 py-2 text-sm font-mono text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition ${
                fieldErrors.sku ? "border-red-400" : "border-slate-300"
              }`}
            />
            {fieldErrors.sku && (
              <p className="text-xs text-red-500">{fieldErrors.sku}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-slate-700">
              Purchase type
            </label>
            <div className="flex items-center gap-3 pt-1">
              {(["managed", "consumable"] as const).map((opt) => (
                <label key={opt} className="flex items-center gap-1.5 text-sm cursor-pointer">
                  <input
                    type="radio"
                    name="purchaseType"
                    value={opt}
                    checked={purchaseType === opt}
                    onChange={() => setPurchaseType(opt)}
                    className="text-emerald-600 focus:ring-emerald-500"
                  />
                  <span className="capitalize">{opt}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-slate-700">
              Status
            </label>
            <div className="flex items-center gap-3 pt-1">
              {(["active", "inactive"] as const).map((opt) => (
                <label key={opt} className="flex items-center gap-1.5 text-sm cursor-pointer">
                  <input
                    type="radio"
                    name="status"
                    value={opt}
                    checked={status === opt}
                    onChange={() => setStatus(opt)}
                    className="text-emerald-600 focus:ring-emerald-500"
                  />
                  <span className="capitalize">{opt}</span>
                </label>
              ))}
            </div>
            <p className="text-[11px] text-slate-400">
              Active = visible to users. Q-GIAP.I default.
            </p>
          </div>
        </div>
      </section>

      {/* Listings */}
      <section className="bg-white border border-slate-200 rounded-xl p-6">
        <div className="flex items-baseline justify-between mb-4">
          <h2 className="text-base font-semibold text-slate-900">Listings</h2>
          <p className="text-xs text-slate-400">
            Multi-locale (Q-GIAP.J). Default: {DEFAULT_LOCALE}.
          </p>
        </div>
        <div className="flex gap-4">
          <GoogleLocaleSidebar
            listings={listings}
            activeLocale={activeLocale}
            defaultLocale={DEFAULT_LOCALE}
            onSelect={(loc) => {
              setActiveLocale(loc);
              if (!listings[loc]) {
                setListings((p) => ({ ...p, [loc]: { title: "", description: "" } }));
              }
            }}
          />
          <div className="flex-1 space-y-3">
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-slate-700">
                Title{activeLocale === DEFAULT_LOCALE ? " *" : ""}
              </label>
              <input
                type="text"
                value={currentListing.title}
                onChange={(e) => updateListing("title", e.target.value)}
                placeholder="Small Gem Pack"
                maxLength={55}
                className={`w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition ${
                  activeLocale === DEFAULT_LOCALE && fieldErrors.defaultTitle
                    ? "border-red-400"
                    : "border-slate-300"
                }`}
              />
              <p className="text-[11px] text-slate-400">
                {currentListing.title.length}/55
              </p>
              {activeLocale === DEFAULT_LOCALE && fieldErrors.defaultTitle && (
                <p className="text-xs text-red-500">{fieldErrors.defaultTitle}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-slate-700">
                Description
              </label>
              <textarea
                rows={4}
                value={currentListing.description}
                onChange={(e) => updateListing("description", e.target.value)}
                placeholder="200 gems to spend in-game."
                maxLength={200}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition resize-none"
              />
              <p className="text-[11px] text-slate-400">
                {currentListing.description.length}/200
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section className="bg-white border border-slate-200 rounded-xl p-6">
        <h2 className="text-base font-semibold text-slate-900 mb-4">Pricing</h2>

        <div className="mb-4">
          <p className="text-xs text-slate-500 mb-2">Pricing source (Q-GIAP.D)</p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            <label className="flex items-start gap-2 p-3 rounded-lg border border-emerald-300 bg-emerald-50 cursor-pointer">
              <input
                type="radio"
                checked={pricingSource === "google_default"}
                readOnly
                className="mt-0.5 text-emerald-600"
              />
              <div>
                <p className="text-sm font-medium text-emerald-900">Google default</p>
                <p className="text-[11px] text-emerald-700">
                  Base price + sparse manual region overrides.
                </p>
              </div>
            </label>
            <label className="flex items-start gap-2 p-3 rounded-lg border border-slate-200 bg-slate-50 cursor-not-allowed opacity-60">
              <input type="radio" disabled className="mt-0.5" />
              <div>
                <p className="text-sm font-medium text-slate-600">Default Template</p>
                <p className="text-[11px] text-slate-500">Available in g1.k.</p>
              </div>
            </label>
            <label className="flex items-start gap-2 p-3 rounded-lg border border-slate-200 bg-slate-50 cursor-not-allowed opacity-60">
              <input type="radio" disabled className="mt-0.5" />
              <div>
                <p className="text-sm font-medium text-slate-600">App-specific</p>
                <p className="text-[11px] text-slate-500">Available in g1.k.</p>
              </div>
            </label>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-slate-700">
              Base price *{" "}
              <span className="font-normal text-xs text-slate-400">
                (Q-GIAP.F decimal)
              </span>
            </label>
            <input
              type="text"
              inputMode="decimal"
              value={basePriceDecimal}
              onChange={(e) => setBasePriceDecimal(e.target.value)}
              placeholder="1.99"
              className={`w-full rounded-lg border px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition ${
                fieldErrors.basePrice ? "border-red-400" : "border-slate-300"
              }`}
            />
            {fieldErrors.basePrice && (
              <p className="text-xs text-red-500">{fieldErrors.basePrice}</p>
            )}
          </div>
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-slate-700">
              Base currency
            </label>
            <select
              value={baseCurrency}
              onChange={(e) => setBaseCurrency(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition"
            >
              {COMMON_CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <button
            type="button"
            onClick={() => setRegionsOpen((v) => !v)}
            className="flex items-center gap-1.5 text-sm font-medium text-emerald-700 hover:text-emerald-800 transition"
          >
            {regionsOpen ? (
              <ChevronUp className="h-4 w-4" />
            ) : (
              <ChevronDown className="h-4 w-4" />
            )}
            Region overrides ({regionOverrides.length})
          </button>
          {regionsOpen && (
            <div className="mt-3 space-y-2">
              {regionOverrides.length === 0 && (
                <p className="text-xs text-slate-400 italic">
                  No overrides yet. Google auto-equalizes the base price into
                  every other region if you don&apos;t add any.
                </p>
              )}
              {regionOverrides.map((r, i) => (
                <div
                  key={i}
                  className="grid grid-cols-12 gap-2 items-start bg-slate-50 border border-slate-200 rounded-lg p-2"
                >
                  <select
                    value={r.region}
                    onChange={(e) => updateOverride(i, { region: e.target.value })}
                    className="col-span-4 rounded border border-slate-300 px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition"
                  >
                    {COMMON_REGIONS.map((opt) => (
                      <option key={opt.code} value={opt.code}>
                        {opt.code} — {opt.name}
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={r.priceDecimal}
                    onChange={(e) => updateOverride(i, { priceDecimal: e.target.value })}
                    placeholder="1.99"
                    className={`col-span-4 rounded border px-2 py-1.5 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition ${
                      fieldErrors[`override_${i}`] ? "border-red-400" : "border-slate-300"
                    }`}
                  />
                  <input
                    type="text"
                    value={r.currency}
                    onChange={(e) => updateOverride(i, { currency: e.target.value.toUpperCase() })}
                    maxLength={3}
                    className="col-span-3 rounded border border-slate-300 px-2 py-1.5 text-xs font-mono uppercase focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition"
                  />
                  <button
                    type="button"
                    onClick={() => removeOverride(i)}
                    className="col-span-1 flex items-center justify-center text-slate-400 hover:text-red-600 hover:bg-red-50 rounded p-1 transition"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                  {fieldErrors[`override_${i}`] && (
                    <p className="col-span-12 text-xs text-red-500">
                      {fieldErrors[`override_${i}`]}
                    </p>
                  )}
                </div>
              ))}
              {regionOverrides.length < COMMON_REGIONS.length && (
                <button
                  type="button"
                  onClick={addRegionOverride}
                  className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-emerald-700 border border-emerald-200 hover:bg-emerald-50 rounded transition"
                >
                  <Plus className="h-3 w-3" />
                  Add region
                </button>
              )}
            </div>
          )}
        </div>
      </section>

      {/* Form errors + submit */}
      {formError && (
        <div className="flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
          <span>{formError}</span>
        </div>
      )}

      <div className="flex justify-end">
        <button
          onClick={handleSubmit}
          disabled={submitting}
          className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg transition disabled:opacity-50"
        >
          <Save className="h-4 w-4" />
          {submitting ? "Creating…" : "Create on Google Play"}
        </button>
      </div>
    </div>
  );
}
