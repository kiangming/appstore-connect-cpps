"use client";

import { Info } from "lucide-react";

import { PRICING_SOURCE_LABELS } from "@/lib/google-iap-management/pricing-source-labels";

export function GoogleDefaultReferenceTab() {
  return (
    <div className="space-y-4">
      <section className="bg-emerald-50/40 border border-emerald-200 rounded-xl p-6">
        <div className="flex items-start gap-3">
          <Info className="h-5 w-5 text-emerald-600 flex-shrink-0 mt-0.5" />
          <div>
            <h2 className="text-base font-semibold text-emerald-900 mb-1">
              How Google&apos;s default pricing works
            </h2>
            <p className="text-sm text-emerald-800/90">
              When you publish an in-app product with only a base price (no
              per-region overrides), Google Play auto-converts the base price
              into every other supported region using its own daily exchange
              rates and per-region pricing rules.
            </p>
          </div>
        </div>
      </section>

      <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-3">
        <h3 className="text-sm font-semibold text-slate-900">
          Pricing source modes (Q-GIAP.D)
        </h3>
        {/* Glosses the three pricing-source MODES, so the names + order here
            follow the selector cards (Phase 1 rename/reorder). The TAB name
            "Google Default Reference" is a different concept — this
            read-only benchmark matrix — and is deliberately unchanged. */}
        <ul className="space-y-2 text-sm text-slate-700">
          <li className="flex gap-2">
            <span className="font-semibold text-emerald-700 flex-shrink-0">
              {PRICING_SOURCE_LABELS.default_template}:
            </span>
            <span>
              Apply a global pricing table (per-tier, per-region prices) at
              create/import time. Used when every app under your portfolio
              should share the same priced tiers.
            </span>
          </li>
          <li className="flex gap-2">
            <span className="font-semibold text-emerald-700 flex-shrink-0">
              {PRICING_SOURCE_LABELS.app_template}:
            </span>
            <span>
              Same shape as the Default Template but scoped to a single app.
              When present, takes precedence over the Default Template for
              that app.
            </span>
          </li>
          <li className="flex gap-2">
            <span className="font-semibold text-emerald-700 flex-shrink-0">
              {PRICING_SOURCE_LABELS.google_default}:
            </span>
            <span>
              Use the row&apos;s base price and let Google convert it into
              every other country. Optional manual region overrides
              (template column GT Price/Currency, or per-IAP form input)
              win over the conversion.
            </span>
          </li>
        </ul>
      </section>

      <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-2">
        <h3 className="text-sm font-semibold text-slate-900">
          Resolution order at IAP create / import
        </h3>
        <ol className="space-y-1 text-sm text-slate-700 list-decimal ml-5">
          <li>
            If the row picks{" "}
            <code className="px-1 bg-slate-100 rounded text-xs">
              {PRICING_SOURCE_LABELS.app_template}
            </code>{" "}
            and one exists → use it.
          </li>
          <li>
            Else if{" "}
            <code className="px-1 bg-slate-100 rounded text-xs">
              {PRICING_SOURCE_LABELS.default_template}
            </code>{" "}
            is selected and one exists → use it.
          </li>
          <li>
            Else →{" "}
            <code className="px-1 bg-slate-100 rounded text-xs">
              {PRICING_SOURCE_LABELS.google_default}
            </code>
            : base price + manual region overrides, converted by Google into
            every other country.
          </li>
        </ol>
      </section>
    </div>
  );
}
