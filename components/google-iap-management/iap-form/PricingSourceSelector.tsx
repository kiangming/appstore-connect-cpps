"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";

import {
  PRICING_SOURCE_LABELS,
  type PricingSourceValue,
} from "@/lib/google-iap-management/pricing-source-labels";

/** Persisted value union — see pricing-source-labels.ts. The stored strings
 *  are a DB + audit + wire contract; only the display labels changed in
 *  Phase 1. */
export type PricingSource = PricingSourceValue;

interface Props {
  /** Active source, or `null` while availability is still unknown.
   *
   *  `null` is not "none selected by the user" — it is "the tool does not
   *  yet know which sources exist". Before this, the selector defaulted to
   *  google_default on mount because the other two need an async check,
   *  which read to Managers as "the templates are broken" and let people
   *  proceed on a source they never chose. Callers must gate their forward
   *  action (Continue / Create) on a non-null value. */
  value: PricingSource | null;
  onChange: (source: PricingSource) => void;
  /** Cached app UUID. Required to fetch app-template availability. */
  appId: string;
  /** Tier identifier selected when value === default_template or app_template. */
  tierValue: string;
  onTierChange: (tier: string) => void;
  /** When true, the selector hides the tier picker — used by Bulk Import
   *  where the lookup is per-row at execute time, not picked manually. */
  hideTierPicker?: boolean;
}

interface Availability {
  defaultExists: boolean;
  appExists: boolean;
  defaultTiers: string[];
  appTiers: string[];
}

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; availability: Availability };

const EMPTY: Availability = {
  defaultExists: false,
  appExists: false,
  defaultTiers: [],
  appTiers: [],
};

/**
 * Priority order for the automatic selection once availability is known:
 * the most specific template wins, then the global one, then Google's
 * conversion (which needs no template and is therefore always available).
 */
function pickByPriority(a: Availability): PricingSource {
  if (a.appExists) return "app_template";
  if (a.defaultExists) return "default_template";
  return "google_default";
}

export function PricingSourceSelector({
  value,
  onChange,
  appId,
  tierValue,
  onTierChange,
  hideTierPicker = false,
}: Props) {
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      setLoad({ kind: "loading" });
      try {
        const res = await fetch(
          `/api/google-iap-management/pricing-templates/availability?appId=${encodeURIComponent(appId)}`,
        );
        const body = (await res.json().catch(() => ({}))) as Availability & {
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok) {
          // Previously this `return`ed with availability left at all-false,
          // which is indistinguishable from "no templates exist" — the tool
          // stating an answer it does not have. An error is now its own
          // state, with a retry.
          setLoad({
            kind: "error",
            message: body.error ?? `Couldn't check templates (HTTP ${res.status}).`,
          });
          return;
        }
        setLoad({ kind: "ready", availability: body });
      } catch (err) {
        if (!cancelled) {
          setLoad({
            kind: "error",
            message: err instanceof Error ? err.message : "Network error.",
          });
        }
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [appId, reloadNonce]);

  /**
   * ONE post-resolution writer of `value`, deliberately.
   *
   * This merges what used to be a separate snap-back effect (which forced
   * google_default whenever the selected template turned out not to exist).
   * Two effects writing the same state is how a selection visibly jumps:
   * auto-select would set app_template and snap-back could immediately
   * overwrite it on the next render. Now a single effect runs once per
   * availability result and decides the whole answer:
   *
   *   - nothing chosen yet  → auto-select by priority (A3)
   *   - chosen but no longer available → re-pick by priority, NOT a
   *     hardcoded google_default; if a Default Template exists, falling all
   *     the way back to Google Conversion would be a worse answer than the
   *     one the priority rule gives.
   *
   * `settledFor` guards against re-running for the same result, so a parent
   * re-render can never re-drive the selection.
   */
  const settledFor = useRef<string | null>(null);
  useEffect(() => {
    if (load.kind === "loading") return;

    const a = load.kind === "ready" ? load.availability : EMPTY;
    const key = `${appId}:${load.kind}:${a.appExists}:${a.defaultExists}`;

    const stillValid =
      value === "google_default" ||
      (value === "app_template" && a.appExists) ||
      (value === "default_template" && a.defaultExists);

    if (value !== null && stillValid) {
      settledFor.current = key;
      return;
    }
    if (settledFor.current === key && value !== null) return;
    settledFor.current = key;
    // On an error we know nothing about templates, so the only source we
    // can honestly offer is the one that needs none (A4).
    onChange(load.kind === "error" ? "google_default" : pickByPriority(a));
  }, [load, value, onChange, appId]);

  const availability = load.kind === "ready" ? load.availability : EMPTY;
  const loading = load.kind === "loading";
  // On error, Google Conversion stays usable — it requires no template, so
  // a failed check must not strand the user with three dead cards (A4).
  const defaultEnabled = load.kind === "ready" && availability.defaultExists;
  const appEnabled = load.kind === "ready" && availability.appExists;
  const googleEnabled = load.kind !== "loading";

  const activeTiers =
    value === "app_template"
      ? availability.appTiers
      : value === "default_template"
        ? availability.defaultTiers
        : [];

  return (
    <div>
      <div className="flex items-center gap-1.5 mb-2">
        <p className="text-xs text-slate-500">Pricing source (Q-GIAP.D)</p>
        {loading && (
          <span className="inline-flex items-center gap-1 text-[11px] text-slate-400">
            <Loader2 className="h-3 w-3 animate-spin" />
            Checking which pricing templates are available…
          </span>
        )}
      </div>

      {load.kind === "error" && (
        <div
          role="alert"
          className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2"
        >
          <AlertTriangle className="h-4 w-4 flex-shrink-0 text-amber-600" />
          <span className="text-[11px] text-amber-900">
            Couldn&apos;t check pricing templates: {load.message} You can still
            use {PRICING_SOURCE_LABELS.google_default}, which needs no template.
          </span>
          <button
            type="button"
            onClick={() => setReloadNonce((n) => n + 1)}
            className="rounded border border-amber-300 px-2 py-0.5 text-[11px] font-medium text-amber-800 transition hover:bg-amber-100"
          >
            Retry
          </button>
        </div>
      )}

      {/* Phase 1 render order: templates first, Google Conversion last.
          RENDER ORDER ONLY — the TS union, the routes' VALID_PRICING_SOURCES
          arrays and the DB CHECK constraint are all membership checks and
          are deliberately left in their original order. */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
        <SourceCard
          checked={value === "default_template"}
          onChange={() => onChange("default_template")}
          title={PRICING_SOURCE_LABELS.default_template}
          description={
            loading
              ? "Checking…"
              : defaultEnabled
                ? "Apply the global pricing template's regions."
                : "No default template uploaded — add one in Settings → Pricing Templates."
          }
          enabled={defaultEnabled}
          loading={loading}
        />
        <SourceCard
          checked={value === "app_template"}
          onChange={() => onChange("app_template")}
          title={PRICING_SOURCE_LABELS.app_template}
          description={
            loading
              ? "Checking…"
              : appEnabled
                ? "Apply this app's pricing template's regions."
                : "No template for this app — add one in Settings → Pricing Templates."
          }
          enabled={appEnabled}
          loading={loading}
        />
        <SourceCard
          checked={value === "google_default"}
          onChange={() => onChange("google_default")}
          title={PRICING_SOURCE_LABELS.google_default}
          description={
            loading
              ? "Checking…"
              : "Google's automatic price conversion of the base price into every country, plus any manual region override."
          }
          enabled={googleEnabled}
          loading={loading}
        />
      </div>

      {!hideTierPicker &&
        (value === "default_template" || value === "app_template") && (
          <div className="mt-3 flex items-center gap-2">
            <label className="text-xs font-medium text-slate-600">
              Tier
            </label>
            <select
              value={tierValue}
              onChange={(e) => onTierChange(e.target.value)}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition"
            >
              <option value="">— Pick a tier —</option>
              {activeTiers.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <span className="text-[11px] text-slate-400">
              {activeTiers.length} available
            </span>
          </div>
        )}
    </div>
  );
}

function SourceCard({
  checked,
  onChange,
  title,
  description,
  enabled,
  loading = false,
}: {
  checked: boolean;
  onChange: () => void;
  title: string;
  description: string;
  enabled: boolean;
  loading?: boolean;
}) {
  return (
    <label
      className={`flex items-start gap-2 p-3 rounded-lg border transition ${
        enabled
          ? checked
            ? "border-emerald-300 bg-emerald-50 cursor-pointer"
            : "border-slate-200 bg-white hover:bg-slate-50 cursor-pointer"
          : "border-slate-200 bg-slate-50 cursor-not-allowed opacity-60"
      }`}
    >
      <input
        type="radio"
        name="pricing-source"
        disabled={!enabled}
        checked={enabled && checked}
        onChange={onChange}
        className="mt-0.5 text-emerald-600 focus:ring-emerald-500"
      />
      <div className="min-w-0">
        <p
          className={`text-sm font-medium ${
            enabled ? "text-slate-900" : "text-slate-600"
          }`}
        >
          {title}
        </p>
        {loading ? (
          /* Skeleton rather than the real description: the copy differs by
             availability, and rendering the available-case wording while
             still checking would state an answer we don't have. */
          <span className="mt-1.5 block h-2 w-3/4 animate-pulse rounded bg-slate-200" />
        ) : (
          <p className="text-[11px] text-slate-500 mt-0.5">{description}</p>
        )}
      </div>
    </label>
  );
}
