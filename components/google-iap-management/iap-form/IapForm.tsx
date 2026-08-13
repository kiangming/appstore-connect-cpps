"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
import { UnifiedPricingTable } from "./UnifiedPricingTable";
import {
  PricingSourceSelector,
  type PricingSource,
} from "./PricingSourceSelector";
import { buildIapSaveBody } from "@/lib/google-iap-management/iap-save-body";
import {
  COMMON_CURRENCIES,
  defaultCurrencyForRegion,
} from "@/lib/google-iap-management/regions";
import { getAllRegions } from "@/lib/google-iap-management/region-name";
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
import {
  applyManagerEdit,
  applyRederivedPrices,
  partitionOverrideValidation,
  pickBaseFromDerived,
  reseedOverrides,
  type DerivedRegionPrice,
  type ReseedConflict,
} from "@/lib/google-iap-management/override-merge";

/** Debounce on the base-price input before asking Google to reconvert the
 *  catalogue. One `convertRegionPrices` call per settled edit, not per
 *  keystroke. */
const REDERIVE_DEBOUNCE_MS = 500;

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
  // `null` until the availability check resolves — see PricingSourceSelector.
  // Submit is gated on this being non-null so nothing is created under a
  // source the user never chose.
  const [pricingSource, setPricingSource] = useState<PricingSource | null>(null);
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

  // ── SC2 state ────────────────────────────────────────────────────────
  // Dirty flags at field-group granularity. Region rows carry their own
  // per-row `dirty`; these cover everything else the form seeds from
  // `initial`. All of it exists for one reason: when a fresh `initial`
  // arrives mid-edit we must be able to tell the Manager's work from a
  // preloaded echo, per group, and re-seed only the echoes.
  const [baseDirty, setBaseDirty] = useState(false);
  const [listingsDirty, setListingsDirty] = useState(false);
  const [attrsDirty, setAttrsDirty] = useState(false);
  /** The `initial` snapshot the state currently reflects. */
  const seededFrom = useRef<IapFormInitial | null>(initial);
  const [conflicts, setConflicts] = useState<ReseedConflict[]>([]);
  const [rederiving, setRederiving] = useState(false);
  const [rederiveError, setRederiveError] = useState<string | null>(null);
  const rederiveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * A recalculation the Manager must confirm first, because it would discard
   * hand-typed rows. Held here rather than run-then-report: overwriting work
   * and apologising afterwards is not a warning.
   */
  const [pendingRederive, setPendingRederive] = useState<{
    run: () => Promise<void>;
    dirtyCount: number;
    trigger: "base price" | "tier";
  } | null>(null);
  /** Mirror of regionOverrides, readable from the debounce timer without
   *  re-arming it on every keystroke. */
  const overridesRef = useRef(regionOverrides);
  useEffect(() => {
    overridesRef.current = regionOverrides;
  }, [regionOverrides]);

  useEffect(
    () => () => {
      if (rederiveTimer.current) clearTimeout(rederiveTimer.current);
    },
    [],
  );

  const defaultLanguage = initial?.defaultLanguage ?? createDefaultLocale;
  const currentListing = listings[activeLocale] ?? { title: "", description: "" };

  /**
   * SC2 — RE-SEED WHEN A FRESH `initial` ARRIVES MID-EDIT.
   *
   * `initial` is a live prop, but every useState above seeds from it exactly
   * once and the page renders <IapForm> with no key. `router.refresh()` —
   * which "Sync from Google" fires deliberately (UnifiedPricingTable.tsx:
   * 129-131, whose comment states this exact intent) — reconciles a NEW
   * `initial` into the SURVIVING instance. Without this effect the diff then
   * compares fresh server truth (before) against stale client state (after),
   * INVERTED: the review modal proposes writing the pre-sync prices back over
   * Google's current ones, and confirming it reverts real prices.
   *
   * Semantics (i): re-seed what the Manager has not touched, keep what they
   * have, and never silently pick a side when both moved — that surfaces as a
   * conflict for them to resolve.
   */
  useEffect(() => {
    const prev = seededFrom.current;
    if (!initial || !prev || prev === initial) return;
    seededFrom.current = initial;

    const { rows, conflicts: found } = reseedOverrides({
      current: regionOverrides,
      serverBefore: prev.regionOverrides,
      serverAfter: initial.regionOverrides,
    });
    setRegionOverrides(rows);
    setConflicts(found);

    if (!baseDirty) {
      setBasePriceDecimal(initial.basePriceDecimal);
      setBaseCurrency(initial.baseCurrency);
    }
    if (!listingsDirty) setListings(initial.listings);
    if (!attrsDirty) {
      setPurchaseType(initial.purchaseType);
      setStatus(initial.status);
    }
  }, [initial, regionOverrides, baseDirty, listingsDirty, attrsDirty]);

  function updateListing(field: keyof FormListing, value: string) {
    setListingsDirty(true);
    setListings((prev) => ({
      ...prev,
      [activeLocale]: { ...currentListing, [field]: value },
    }));
  }

  function addRegionOverride() {
    setRegionOverrides((prev) => {
      const used = new Set(prev.map((r) => r.region));
      const next = getAllRegions().find((r) => !used.has(r.code));
      if (!next) return prev;
      return [
        ...prev,
        {
          region: next.code,
          currency: defaultCurrencyForRegion(next.code),
          priceDecimal: "",
        },
      ];
    });
  }

  /** Every Manager edit to a row goes through here, and every one stamps the
   *  row dirty — that stamp is what protects it from a later re-derive. */
  function updateOverride(idx: number, updates: Partial<RegionOverrideRow>) {
    setRegionOverrides((prev) =>
      applyManagerEdit(prev, idx, updates, defaultCurrencyForRegion),
    );
  }

  function removeOverride(idx: number) {
    setRegionOverrides((prev) => prev.filter((_, i) => i !== idx));
  }

  /**
   * SC2 — resolve one re-seed conflict. A conflict means the Manager edited a
   * row AND the server value for that same row moved underneath them. The tool
   * refuses to pick for them; this applies whichever side they choose.
   *
   * Taking Google's value clears `dirty`: the Manager has just said "theirs is
   * right", so the row is no longer a hand-pinned one and a later re-derive
   * may move it again.
   */
  function resolveConflict(region: string, keep: "mine" | "theirs") {
    const conflict = conflicts.find((c) => c.region === region);
    setConflicts((prev) => prev.filter((c) => c.region !== region));
    if (!conflict || keep === "mine") return;
    setRegionOverrides((prev) =>
      prev.map((r) =>
        r.region === region
          ? {
              region,
              currency: conflict.theirs.currency,
              priceDecimal: conflict.theirs.priceDecimal,
              dirty: false,
            }
          : r,
      ),
    );
  }

  // Unified-table promote-to-override: an inherit/live-only row becomes an
  // explicit override for that exact region. Mirrors addRegionOverride's row
  // shape so the save payload is built identically; no-op if the region is
  // already present (the table keeps regions unique).
  function addOverrideForRegion(region: string, currency: string) {
    setRegionOverrides((prev) => {
      if (prev.some((r) => r.region === region)) return prev;
      return [
        ...prev,
        {
          region,
          currency: currency || defaultCurrencyForRegion(region),
          priceDecimal: "",
        },
      ];
    });
  }

  /* ── SC2: RE-DERIVE ────────────────────────────────────────────────────
   * In the v3 model a base price has no field of its own — the ONLY way to
   * express "the base moved" is to write every regional config. So changing
   * the base (or picking a tier) recomputes the catalogue here, replacing
   * every row the Manager has not pinned, and shows the result BEFORE save.
   * That is why the preview is not a nice-to-have: it IS the change.
   *
   * Values from the source are applied verbatim — no rounding, no
   * re-formatting. Whatever decimals Google or the template returns are what
   * the row carries and what gets sent.
   */
  async function fetchDerivedForBase(
    priceDecimal: string,
    currency: string,
  ): Promise<DerivedRegionPrice[] | null> {
    let micros: string;
    try {
      micros = decimalToMicros(priceDecimal, currency);
    } catch {
      // Invalid base price — the inline field error already says so. Don't
      // burn a Google call on it.
      return null;
    }
    const qs = new URLSearchParams({
      packageName,
      basePriceMicros: micros,
      baseCurrency: currency,
    });
    const res = await fetch(
      `/api/google-iap-management/regions/catalog?${qs.toString()}`,
    );
    const body = (await res.json().catch(() => ({}))) as {
      regions?: Array<{
        regionCode: string;
        currency: string;
        convertedDecimal?: string;
      }>;
      error?: string;
    };
    if (!res.ok) {
      throw new Error(body.error ?? `Couldn't reconvert prices (HTTP ${res.status}).`);
    }
    return (body.regions ?? [])
      .filter((r) => typeof r.convertedDecimal === "string")
      .map((r) => ({
        regionCode: r.regionCode,
        currency: r.currency,
        priceDecimal: r.convertedDecimal as string,
      }));
  }

  async function fetchDerivedForTier(
    tier: string,
    source: PricingSource,
  ): Promise<DerivedRegionPrice[] | null> {
    if (source === "google_default" || !tier.trim()) return null;
    const qs = new URLSearchParams({
      scope: source === "app_template" ? "APP" : "GLOBAL",
      appId,
      identifier: tier.trim(),
    });
    const res = await fetch(
      `/api/google-iap-management/pricing-templates/tier-entries?${qs.toString()}`,
    );
    const body = (await res.json().catch(() => ({}))) as {
      entries?: Array<{ regionCode: string; currency: string; priceDecimal: string }>;
      error?: string;
    };
    if (!res.ok) {
      throw new Error(body.error ?? `Couldn't load tier prices (HTTP ${res.status}).`);
    }
    return (body.entries ?? []).map((e) => ({
      regionCode: e.regionCode,
      currency: e.currency,
      priceDecimal: e.priceDecimal,
    }));
  }

  /**
   * Run a recalculation. THE RESET IS TOTAL — every row is replaced, hand-typed
   * ones included (SC2b: base and tier are recalculate-everything commands and
   * overwrite each other without limit). `setBase` is true for a tier, which
   * also moves the base price, since a tier is just a fast way to set it.
   */
  async function runRederive(
    load: () => Promise<DerivedRegionPrice[] | null>,
    setBase: boolean,
  ) {
    setRederiving(true);
    setRederiveError(null);
    try {
      const derived = await load();
      if (derived === null) return;
      if (derived.length === 0) {
        setRederiveError("No converted prices came back, so nothing was changed.");
        return;
      }
      setRegionOverrides((rows) => applyRederivedPrices(rows, derived));
      if (setBase) {
        const base = pickBaseFromDerived(derived, baseCurrency);
        if (base) {
          setBasePriceDecimal(base.priceDecimal);
          setBaseCurrency(base.currency);
          setBaseDirty(true);
        }
      }
    } catch (err) {
      setRederiveError(
        err instanceof Error ? err.message : "Couldn't reconvert prices.",
      );
    } finally {
      setRederiving(false);
    }
  }

  /**
   * Debounce a recalculation, and GATE IT ON A WARNING when hand-typed rows
   * would be lost.
   *
   * A total reset silently destroying five rows the Manager typed is not
   * acceptable, so the count is stated BEFORE anything is recomputed and the
   * Manager can cancel. With nothing hand-typed there is nothing to lose, so
   * it just runs. (Same principle as the Apple stale-data feature: a
   * destructive action asks first, it does not toast afterwards.)
   */
  function scheduleRederive(
    load: () => Promise<DerivedRegionPrice[] | null>,
    trigger: "base price" | "tier",
  ) {
    // Edit mode only: create mode has no preloaded catalogue to recompute,
    // and the server bootstraps the regions on submit.
    if (!isEdit) return;
    const setBase = trigger === "tier";
    if (rederiveTimer.current) clearTimeout(rederiveTimer.current);
    rederiveTimer.current = setTimeout(() => {
      const dirtyCount = overridesRef.current.filter((r) => r.dirty).length;
      if (dirtyCount > 0) {
        setPendingRederive({
          run: () => runRederive(load, setBase),
          dirtyCount,
          trigger,
        });
        return;
      }
      void runRederive(load, setBase);
    }, REDERIVE_DEBOUNCE_MS);
  }

  /** Per-row validation split by authorship (option B). A value the Manager
   *  typed blocks submit — they can fix it. A value Google authored only
   *  warns: blocking it strands the whole item over a row nobody touched,
   *  and "correcting" it would violate the no-transformation rule. */
  const overrideValidation = useMemo(
    () =>
      partitionOverrideValidation(regionOverrides, (priceDecimal, currency) =>
        validateDecimal(priceDecimal, currency),
      ),
    [regionOverrides],
  );

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

    // SC2 / option B — only rows the Manager actually typed can block submit.
    // Production has an item whose Google-authored TW price (TWD 6.30) the
    // tool's own currency table rejects; before this, that single untouched
    // row blocked EVERY edit to the item, including its title.
    for (const [idx, message] of Object.entries(overrideValidation.blocking)) {
      errors[`override_${idx}`] = message;
    }

    if (pricingSource === null) {
      // Availability hasn't resolved (or the check failed and no retry has
      // succeeded). Submitting now would write under a source nobody
      // picked — the exact failure the loading state exists to prevent.
      errors.tier = "Still checking which pricing templates are available…";
    } else if (pricingSource !== "google_default" && !tierIdentifier.trim()) {
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

  // Save payload is built by the shared pure builder (lib/iap-save-body) so the
  // unified-table UI reorganization cannot change what's written to Google/DB.
  function buildBody() {
    if (pricingSource === null) {
      // Unreachable: every caller runs validate() first, which fails on a
      // null source. Throwing beats a non-null assertion — if the ordering
      // ever changes, this is loud instead of writing a wrong source.
      throw new Error("Pricing source is not resolved yet.");
    }
    return buildIapSaveBody({
      sku,
      purchaseType,
      status,
      defaultLanguage,
      listings,
      baseCurrency,
      basePriceDecimal,
      regionOverrides,
      pricingSource,
      tierIdentifier,
    });
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
          /**
           * SC3 — SEND THE BODY WHOLE.
           *
           * This used to hand-roll the payload and pick two fields out of
           * buildBody(), silently dropping `pricingSource` and
           * `tierIdentifier`. The PATCH route has always had a branch that
           * resolves a tier's ~170 prices from those two fields
           * (route.ts:146-176) — with them never sent, that branch was
           * unreachable dead code, and the on-screen promise below the
           * pricing-source cards ("Picked tier's region prices will replace
           * any manual overrides") was true on create and FALSE on edit.
           *
           * The shared builder is the single definition of this payload
           * (iap-save-body.ts). Re-picking fields here is what let the two
           * drift apart in the first place, so don't: send what it builds.
           * `sku` is ignored by the route (it comes from the URL and is
           * immutable) and is harmless in the body.
           */
          body: JSON.stringify(buildBody()),
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
                    onChange={() => {
                      setPurchaseType(opt);
                      setAttrsDirty(true);
                    }}
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
                    onChange={() => {
                      setStatus(opt);
                      setAttrsDirty(true);
                    }}
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
              else if (tierIdentifier.trim()) {
                scheduleRederive(() => fetchDerivedForTier(tierIdentifier, s), "tier");
              }
            }}
            appId={appId}
            tierValue={tierIdentifier}
            onTierChange={(tier) => {
              setTierIdentifier(tier);
              if (pricingSource) {
                scheduleRederive(() => fetchDerivedForTier(tier, pricingSource), "tier");
              }
            }}
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
              onChange={(e) => {
                const next = e.target.value;
                setBasePriceDecimal(next);
                setBaseDirty(true);
                scheduleRederive(
                  () => fetchDerivedForBase(next, baseCurrency),
                  "base price",
                );
              }}
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
              onChange={(e) => {
                const next = e.target.value;
                setBaseCurrency(next);
                setBaseDirty(true);
                scheduleRederive(
                  () => fetchDerivedForBase(basePriceDecimal, next),
                  "base price",
                );
              }}
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

        {/* Create mode keeps the manual region-overrides editor. Edit mode
            (the item detail page) uses the unified per-country table below,
            which merges this editor with the live-vs-Google comparison. */}
        {!isEdit && (
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
                    {getAllRegions().map((opt) => (
                      <option key={opt.code} value={opt.code}>
                        {opt.name}
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
              {regionOverrides.length < getAllRegions().length && (
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
        )}
      </section>

      {/* Zone B — unified per-country table (edit + live-vs-Google compare).
          Edit mode only: needs an existing SKU to fetch live Google prices.
          Edits the SAME regionOverrides state the save payload reads. */}
      {isEdit && (
        <UnifiedPricingTable
          packageName={packageName}
          sku={initial?.sku ?? sku}
          regionOverrides={regionOverrides}
          baseCurrency={baseCurrency}
          basePriceDecimal={basePriceDecimal}
          fieldErrors={fieldErrors}
          fieldWarnings={overrideValidation.warnings}
          conflicts={conflicts}
          onResolveConflict={resolveConflict}
          rederiving={rederiving}
          rederiveError={rederiveError}
          onUpdateOverride={updateOverride}
          onRemoveOverride={removeOverride}
          onAddOverrideForRegion={addOverrideForRegion}
        />
      )}

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

      {/* SC2b — WARN BEFORE A DESTRUCTIVE RESET, never after.
          Recalculating from a tier or a new base price replaces EVERY row,
          including ones the Manager typed by hand. Losing that work silently
          is not acceptable, so the count is stated up front with a way out. */}
      {pendingRederive && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl">
            <h2 className="text-base font-semibold text-slate-900">
              Recalculate every country price?
            </h2>
            <p className="mt-2 text-sm text-slate-600">
              Changing the {pendingRederive.trigger} recalculates all country
              prices from it. That will overwrite{" "}
              <strong className="font-semibold text-slate-900">
                {pendingRederive.dirtyCount} price
                {pendingRederive.dirtyCount === 1 ? "" : "s"} you typed by hand
              </strong>
              .
            </p>
            <p className="mt-1.5 text-xs text-slate-500">
              Cancel keeps your prices exactly as they are; nothing is sent to
              Google either way.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingRederive(null)}
                className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-100"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  const pending = pendingRederive;
                  setPendingRederive(null);
                  void pending.run();
                }}
                className="rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-emerald-700"
              >
                Recalculate
              </button>
            </div>
          </div>
        </div>
      )}

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
