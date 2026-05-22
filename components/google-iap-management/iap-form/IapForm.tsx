"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Save,
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Plus,
  Trash2,
} from "lucide-react";

import { GoogleLocaleSidebar } from "./GoogleLocaleSidebar";
import { UpdateChangesPreviewModal } from "./UpdateChangesPreviewModal";
import {
  PricingSourceSelector,
  type PricingSource,
} from "./PricingSourceSelector";
import {
  COMMON_REGIONS,
  COMMON_CURRENCIES,
  defaultCurrencyForRegion,
} from "@/lib/google-iap-management/regions";
import { decimalToMicros } from "@/lib/google-iap-management/google/price-conversion";
import {
  getCurrencyDecimals,
  validateDecimalForCurrency,
} from "@/lib/google-iap-management/google/currency-precision";
import {
  computeIapDiff,
  type IapStateSnapshot,
} from "@/lib/google-iap-management/orchestration/iap-diff";
import {
  DEFAULT_LOCALE,
  type AppDefaults,
  type FormListing,
  type IapFormInitial,
  type RegionOverrideRow,
} from "@/lib/google-iap-management/form-state";

type Mode =
  | { kind: "create" }
  | { kind: "edit"; initial: IapFormInitial };

interface Props {
  packageName: string;
  appId: string;
  appDefaults: AppDefaults | null;
  mode?: Mode;
}

function validateDecimal(input: string, currency?: string): string | null {
  if (!input.trim()) return null;
  // Hotfix 5: when a currency is known, run the currency-aware
  // validation first (catches VND/JPY/KRW fractions before they're
  // sent and rejected by Google).
  if (currency) {
    const currencyErr = validateDecimalForCurrency(input, currency);
    if (currencyErr) return currencyErr;
  }
  try {
    decimalToMicros(input);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : "Invalid price";
  }
}

function buildBeforeSnapshot(initial: IapFormInitial): IapStateSnapshot {
  const listings: IapStateSnapshot["listings"] = {};
  for (const [locale, l] of Object.entries(initial.listings)) {
    if (!l.title.trim() && !l.description.trim()) continue;
    listings[locale] = {
      title: l.title.trim(),
      description: l.description.trim(),
    };
  }
  const prices: IapStateSnapshot["prices"] = {};
  for (const r of initial.regionOverrides) {
    if (!r.priceDecimal.trim()) continue;
    try {
      prices[r.region] = {
        currency: r.currency.trim().toUpperCase(),
        priceMicros: decimalToMicros(r.priceDecimal),
      };
    } catch {
      /* skip invalid initial — should never happen */
    }
  }
  return {
    attributes: {
      purchaseType: initial.purchaseType,
      status: initial.status,
      defaultLanguage: initial.defaultLanguage,
      baseCurrency: initial.baseCurrency.trim().toUpperCase(),
      basePriceMicros: (() => {
        try {
          return decimalToMicros(initial.basePriceDecimal);
        } catch {
          return "0";
        }
      })(),
    },
    listings,
    prices,
  };
}

function buildAfterSnapshot(state: {
  purchaseType: "managed" | "consumable";
  status: "active" | "inactive";
  defaultLanguage: string;
  listings: Record<string, FormListing>;
  baseCurrency: string;
  basePriceDecimal: string;
  regionOverrides: RegionOverrideRow[];
}): IapStateSnapshot {
  const listings: IapStateSnapshot["listings"] = {};
  for (const [locale, l] of Object.entries(state.listings)) {
    if (!l.title.trim() && !l.description.trim()) continue;
    listings[locale] = {
      title: l.title.trim(),
      description: l.description.trim(),
    };
  }
  const prices: IapStateSnapshot["prices"] = {};
  for (const r of state.regionOverrides) {
    if (!r.priceDecimal.trim()) continue;
    try {
      prices[r.region] = {
        currency: r.currency.trim().toUpperCase(),
        priceMicros: decimalToMicros(r.priceDecimal),
      };
    } catch {
      /* validation surface elsewhere */
    }
  }
  return {
    attributes: {
      purchaseType: state.purchaseType,
      status: state.status,
      defaultLanguage: state.defaultLanguage,
      baseCurrency: state.baseCurrency.trim().toUpperCase(),
      basePriceMicros: (() => {
        try {
          return decimalToMicros(state.basePriceDecimal);
        } catch {
          return "0";
        }
      })(),
    },
    listings,
    prices,
  };
}

export function IapForm({
  packageName,
  appId,
  appDefaults,
  mode = { kind: "create" },
}: Props) {
  const router = useRouter();
  const isEdit = mode.kind === "edit";
  const initial = mode.kind === "edit" ? mode.initial : null;

  // Hotfix 4: Create-mode pre-fills are driven by the app's configured
  // defaults (currency + language). Edit-mode keeps the IAP's own values
  // (already populated upstream by iapDetailToInitial, which also
  // considers appDefaults as a fallback for null cache fields).
  const createDefaultLocale = appDefaults?.language ?? DEFAULT_LOCALE;
  const createDefaultCurrency = appDefaults?.currency ?? "USD";

  // Identification
  const [sku, setSku] = useState(initial?.sku ?? "");
  const [purchaseType, setPurchaseType] = useState<"managed" | "consumable">(
    initial?.purchaseType ?? "managed",
  );
  const [status, setStatus] = useState<"active" | "inactive">(
    initial?.status ?? "active",
  );

  // Listings (multi-locale)
  const [listings, setListings] = useState<Record<string, FormListing>>(
    initial?.listings ?? {
      [createDefaultLocale]: { title: "", description: "" },
    },
  );
  const [activeLocale, setActiveLocale] = useState(
    initial?.defaultLanguage ?? createDefaultLocale,
  );

  // Pricing
  const [baseCurrency, setBaseCurrency] = useState(
    initial?.baseCurrency ?? createDefaultCurrency,
  );
  const [basePriceDecimal, setBasePriceDecimal] = useState(
    initial?.basePriceDecimal ?? "",
  );
  const [pricingSource, setPricingSource] = useState<PricingSource>("google_default");
  const [tierIdentifier, setTierIdentifier] = useState<string>("");
  const [regionsOpen, setRegionsOpen] = useState(
    (initial?.regionOverrides.length ?? 0) > 0,
  );
  const [regionOverrides, setRegionOverrides] = useState<RegionOverrideRow[]>(
    initial?.regionOverrides ?? [],
  );

  // Submit
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [showDiff, setShowDiff] = useState(false);

  const defaultLanguage = initial?.defaultLanguage ?? createDefaultLocale;
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

    const defaultListing = listings[defaultLanguage];
    if (!defaultListing?.title.trim())
      errors.defaultTitle = `Title is required for the default locale (${defaultLanguage}).`;

    if (!basePriceDecimal.trim()) {
      errors.basePrice = "Base price is required.";
    } else {
      const decErr = validateDecimal(basePriceDecimal, baseCurrency);
      if (decErr) errors.basePrice = decErr;
    }

    for (let i = 0; i < regionOverrides.length; i += 1) {
      const r = regionOverrides[i];
      if (r.priceDecimal.trim()) {
        const e = validateDecimal(r.priceDecimal, r.currency);
        if (e) errors[`override_${i}`] = e;
      }
    }

    if (pricingSource !== "google_default" && !tierIdentifier.trim()) {
      errors.tier = "Pick a tier from the pricing template above.";
    }

    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }

  const diff = useMemo(() => {
    if (!initial) return null;
    const before = buildBeforeSnapshot(initial);
    const after = buildAfterSnapshot({
      purchaseType,
      status,
      defaultLanguage,
      listings,
      baseCurrency,
      basePriceDecimal,
      regionOverrides,
    });
    return computeIapDiff(before, after);
  }, [
    initial,
    purchaseType,
    status,
    defaultLanguage,
    listings,
    baseCurrency,
    basePriceDecimal,
    regionOverrides,
  ]);

  function handleSubmitClick() {
    setFormError(null);
    if (!validate()) {
      setFormError("Please fix the errors above before submitting.");
      return;
    }
    if (isEdit) {
      if (!diff?.hasChanges) {
        setFormError("No changes to submit.");
        return;
      }
      setShowDiff(true);
      return;
    }
    void submitCreate();
  }

  function buildBody() {
    return {
      sku: sku.trim(),
      purchaseType,
      status,
      defaultLanguage,
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
      pricingSource,
      tierIdentifier:
        pricingSource === "google_default" ? null : tierIdentifier.trim() || null,
    };
  }

  async function submitCreate() {
    setSubmitting(true);
    try {
      const res = await fetch(
        `/api/google-iap-management/apps/${encodeURIComponent(packageName)}/iaps`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(buildBody()),
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
      // Hotfix 12: Manager reported silent redirect on create. Toast
      // confirms the action so the redirect feels intentional, not a
      // lost submission. SKU echoed back so multiple creates in a row
      // are visually distinct.
      toast.success(
        `IAP "${body.sku ?? sku}" created on Google Play.`,
      );
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

  async function submitUpdate() {
    setSubmitting(true);
    try {
      const res = await fetch(
        `/api/google-iap-management/apps/${encodeURIComponent(packageName)}/iaps/${encodeURIComponent(sku.trim())}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            purchaseType,
            status,
            defaultLanguage,
            listings: buildBody().listings,
            baseCurrency,
            basePriceDecimal,
            regionOverrides: buildBody().regionOverrides,
          }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as {
        sku?: string;
        error?: string;
      };
      if (!res.ok) {
        setFormError(body.error ?? `Update failed (HTTP ${res.status}).`);
        return;
      }
      // Hotfix 12: same UX as create — confirm before redirect.
      toast.success(`IAP "${sku.trim()}" updated on Google Play.`);
      setShowDiff(false);
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
      {/* App defaults banner (Hotfix 4) */}
      {appDefaults && (appDefaults.currency || appDefaults.language) && (
        <div className="text-xs text-emerald-900 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
          <span className="font-semibold">App defaults:</span>{" "}
          {appDefaults.currency && (
            <span>
              currency{" "}
              <code className="px-1 bg-white border border-emerald-200 rounded font-mono">
                {appDefaults.currency}
              </code>
            </span>
          )}
          {appDefaults.currency && appDefaults.language && " · "}
          {appDefaults.language && (
            <span>
              default locale{" "}
              <code className="px-1 bg-white border border-emerald-200 rounded font-mono">
                {appDefaults.language}
              </code>
            </span>
          )}
          <span className="ml-1 text-emerald-700">
            — Google enforces these per app; mismatches will be rejected.
          </span>
        </div>
      )}
      {!appDefaults?.currency && !appDefaults?.language && !isEdit && (
        <div className="text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          App defaults not cached yet. Click <strong>Refresh from Google</strong> on the
          app detail page to capture this app&apos;s configured currency and locale,
          otherwise the form falls back to USD / en-US.
        </div>
      )}

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
              disabled={isEdit}
              className={`w-full rounded-lg border px-3 py-2 text-sm font-mono text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition ${
                isEdit ? "bg-slate-50 cursor-not-allowed text-slate-500" : ""
              } ${fieldErrors.sku ? "border-red-400" : "border-slate-300"}`}
            />
            {isEdit && (
              <p className="text-[11px] text-slate-400">
                SKU is immutable — Google Play does not allow renaming.
              </p>
            )}
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
            Multi-locale (Q-GIAP.J). Default: {defaultLanguage}.
          </p>
        </div>
        <div className="flex gap-4">
          <GoogleLocaleSidebar
            listings={listings}
            activeLocale={activeLocale}
            defaultLocale={defaultLanguage}
            appDefaultLocale={appDefaults?.language ?? null}
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
                Title{activeLocale === defaultLanguage ? " *" : ""}
              </label>
              <input
                type="text"
                value={currentListing.title}
                onChange={(e) => updateListing("title", e.target.value)}
                placeholder="Small Gem Pack"
                maxLength={55}
                className={`w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition ${
                  activeLocale === defaultLanguage && fieldErrors.defaultTitle
                    ? "border-red-400"
                    : "border-slate-300"
                }`}
              />
              <p className="text-[11px] text-slate-400">
                {currentListing.title.length}/55
              </p>
              {activeLocale === defaultLanguage && fieldErrors.defaultTitle && (
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
          <PricingSourceSelector
            value={pricingSource}
            onChange={(s) => {
              setPricingSource(s);
              if (s === "google_default") setTierIdentifier("");
            }}
            appId={appId}
            tierValue={tierIdentifier}
            onTierChange={setTierIdentifier}
          />
          {pricingSource !== "google_default" && (
            <p className="mt-2 text-[11px] text-slate-500">
              Picked tier&apos;s region prices will replace any manual overrides
              below before submitting.
            </p>
          )}
          {fieldErrors.tier && (
            <p className="mt-1 text-xs text-red-500">{fieldErrors.tier}</p>
          )}
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
              inputMode={getCurrencyDecimals(baseCurrency) === 0 ? "numeric" : "decimal"}
              value={basePriceDecimal}
              onChange={(e) => setBasePriceDecimal(e.target.value)}
              placeholder={getCurrencyDecimals(baseCurrency) === 0 ? "23000" : "1.99"}
              className={`w-full rounded-lg border px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition ${
                fieldErrors.basePrice ? "border-red-400" : "border-slate-300"
              }`}
            />
            <p className="text-[11px] text-slate-400">
              {getCurrencyDecimals(baseCurrency) === 0
                ? `${baseCurrency.toUpperCase()} only accepts whole numbers (no fractional values).`
                : `${baseCurrency.toUpperCase()} supports up to ${getCurrencyDecimals(baseCurrency)} decimal place${getCurrencyDecimals(baseCurrency) === 1 ? "" : "s"}.`}
            </p>
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

      {formError && (
        <div className="flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
          <span>{formError}</span>
        </div>
      )}

      <div className="flex justify-end">
        <button
          onClick={handleSubmitClick}
          disabled={submitting}
          className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg transition disabled:opacity-50"
        >
          <Save className="h-4 w-4" />
          {submitting
            ? isEdit
              ? "Reviewing…"
              : "Creating…"
            : isEdit
              ? "Review changes"
              : "Create on Google Play"}
        </button>
      </div>

      {showDiff && diff && (
        <UpdateChangesPreviewModal
          diff={diff}
          submitting={submitting}
          submitError={formError}
          onCancel={() => {
            if (submitting) return;
            setShowDiff(false);
            setFormError(null);
          }}
          onConfirm={() => void submitUpdate()}
        />
      )}
    </div>
  );
}
