"use client";

import { useState } from "react";
import type {
  AppOption,
  AppTemplateSummary,
  TemplateOverview,
} from "@/lib/iap-management/queries/templates";
import { DefaultTemplateTab } from "./DefaultTemplateTab";
import { PerAppTemplateTab } from "./PerAppTemplateTab";

interface Props {
  defaultOverview: TemplateOverview;
  appsWithTemplates: AppTemplateSummary[];
  activeApps: AppOption[];
}

type Tab = "default" | "per-app";

export function PricingTiersClient({
  defaultOverview,
  appsWithTemplates,
  activeApps,
}: Props) {
  const [tab, setTab] = useState<Tab>("default");

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
          Pricing Templates
        </h1>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
          Default Template applies to every app; per-app templates override
          the Default for specific apps. Apple&apos;s auto-equalization fills
          in territories that no template covers.
        </p>
      </div>

      <div className="border-b border-slate-200 dark:border-slate-800 mb-6">
        <nav className="flex gap-6" aria-label="Pricing templates tabs">
          <TabButton
            label="Default Template"
            count={defaultOverview.populated_entry_count}
            active={tab === "default"}
            onClick={() => setTab("default")}
          />
          <TabButton
            label="Per-App Templates"
            count={appsWithTemplates.length}
            active={tab === "per-app"}
            onClick={() => setTab("per-app")}
          />
        </nav>
      </div>

      {tab === "default" ? (
        <DefaultTemplateTab overview={defaultOverview} />
      ) : (
        <PerAppTemplateTab
          appsWithTemplates={appsWithTemplates}
          activeApps={activeApps}
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
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`relative pb-3 pt-1 text-sm font-medium transition ${
        active
          ? "text-[#0071E3]"
          : "text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
      }`}
    >
      <span>{label}</span>
      <span
        className={`ml-2 inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] ${
          active
            ? "bg-[#0071E3]/10 text-[#0071E3]"
            : "bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400"
        }`}
      >
        {count}
      </span>
      {active && (
        <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#0071E3]" />
      )}
    </button>
  );
}
