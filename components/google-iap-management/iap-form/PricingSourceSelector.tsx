"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

export type PricingSource = "google_default" | "default_template" | "app_template";

interface Props {
  /** Currently active source. */
  value: PricingSource;
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

const INITIAL: Availability = {
  defaultExists: false,
  appExists: false,
  defaultTiers: [],
  appTiers: [],
};

export function PricingSourceSelector({
  value,
  onChange,
  appId,
  tierValue,
  onTierChange,
  hideTierPicker = false,
}: Props) {
  const [availability, setAvailability] = useState<Availability>(INITIAL);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const res = await fetch(
          `/api/google-iap-management/pricing-templates/availability?appId=${encodeURIComponent(appId)}`,
        );
        if (!res.ok) return;
        const body = (await res.json()) as Availability;
        if (!cancelled) setAvailability(body);
      } catch {
        /* leave as INITIAL */
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [appId]);

  // If Manager switches away from a template they can no longer use, snap
  // back to google_default. Keeps invariants tight without bothering them.
  useEffect(() => {
    if (value === "default_template" && !availability.defaultExists && !loading) {
      onChange("google_default");
    }
    if (value === "app_template" && !availability.appExists && !loading) {
      onChange("google_default");
    }
  }, [value, availability, loading, onChange]);

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
        {loading && <Loader2 className="h-3 w-3 text-slate-400 animate-spin" />}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
        <SourceCard
          checked={value === "google_default"}
          onChange={() => onChange("google_default")}
          title="Google default"
          description="Base price + sparse manual region overrides + Google's auto-equalisation."
          enabled
        />
        <SourceCard
          checked={value === "default_template"}
          onChange={() => onChange("default_template")}
          title="Default Template"
          description={
            availability.defaultExists
              ? "Apply the global pricing template's regions."
              : "No global pricing template uploaded yet."
          }
          enabled={availability.defaultExists}
        />
        <SourceCard
          checked={value === "app_template"}
          onChange={() => onChange("app_template")}
          title="App-specific Template"
          description={
            availability.appExists
              ? "Apply this app's pricing template's regions."
              : "No per-app pricing template for this app."
          }
          enabled={availability.appExists}
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
}: {
  checked: boolean;
  onChange: () => void;
  title: string;
  description: string;
  enabled: boolean;
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
      <div>
        <p
          className={`text-sm font-medium ${
            enabled ? "text-slate-900" : "text-slate-600"
          }`}
        >
          {title}
        </p>
        <p className="text-[11px] text-slate-500 mt-0.5">{description}</p>
      </div>
    </label>
  );
}
