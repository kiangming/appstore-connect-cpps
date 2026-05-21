"use client";

import { useState } from "react";

import type {
  AppTemplateSummary,
  TemplateOverview,
} from "@/lib/google-iap-management/queries/templates";
import { GoogleDefaultReferenceTab } from "./GoogleDefaultReferenceTab";
import { DefaultTemplateTab } from "./DefaultTemplateTab";
import { PerAppTemplateTab } from "./PerAppTemplateTab";

interface Props {
  defaultOverview: TemplateOverview;
  appTemplates: AppTemplateSummary[];
  cachedApps: Array<{ id: string; package_name: string; display_name: string | null }>;
}

type Tab = "google" | "default" | "per-app";

export function PricingTemplatesClient({
  defaultOverview,
  appTemplates,
  cachedApps,
}: Props) {
  const [tab, setTab] = useState<Tab>("default");

  return (
    <div>
      <div className="border-b border-slate-200 mb-6">
        <nav className="flex gap-6" aria-label="Pricing templates tabs">
          <TabButton
            label="Google Default Reference"
            active={tab === "google"}
            onClick={() => setTab("google")}
          />
          <TabButton
            label="Default Template"
            count={defaultOverview.template ? defaultOverview.entryCount : 0}
            active={tab === "default"}
            onClick={() => setTab("default")}
          />
          <TabButton
            label="Per-App Templates"
            count={appTemplates.length}
            active={tab === "per-app"}
            onClick={() => setTab("per-app")}
          />
        </nav>
      </div>

      {tab === "google" && <GoogleDefaultReferenceTab />}
      {tab === "default" && <DefaultTemplateTab overview={defaultOverview} />}
      {tab === "per-app" && (
        <PerAppTemplateTab
          appTemplates={appTemplates}
          cachedApps={cachedApps}
        />
      )}
    </div>
  );
}

function TabButton({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`relative pb-3 pt-1 text-sm font-medium transition ${
        active ? "text-emerald-700" : "text-slate-500 hover:text-slate-700"
      }`}
    >
      <span>{label}</span>
      {count !== undefined && (
        <span
          className={`ml-2 inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] ${
            active
              ? "bg-emerald-100 text-emerald-800"
              : "bg-slate-100 text-slate-500"
          }`}
        >
          {count}
        </span>
      )}
      {active && (
        <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-emerald-600" />
      )}
    </button>
  );
}
