"use client";

import { useState } from "react";

import type {
  AccountTemplateSummary,
  AppTemplateSummary,
  TemplateOverview,
} from "@/lib/google-iap-management/queries/templates";
import type { AccountOption } from "./DefaultTemplateTab";
import { GoogleDefaultReferenceTab } from "./GoogleDefaultReferenceTab";
import { DefaultTemplateTab } from "./DefaultTemplateTab";
import { PerAppTemplateTab } from "./PerAppTemplateTab";

interface Props {
  defaultOverview: TemplateOverview;
  appTemplates: AppTemplateSummary[];
  cachedApps: Array<{ id: string; package_name: string; display_name: string | null }>;
  /** E1 — MỌI account đang tồn tại, kể cả account chưa có template. */
  accounts: AccountOption[];
  /** E2 — tử số của badge lấy từ đây; mẫu số lấy từ `accounts`. */
  accountSummaries: AccountTemplateSummary[];
  selectedAccountId: string;
  canEditDefault: boolean;
}

type Tab = "google" | "default" | "per-app";

export function PricingTemplatesClient({
  defaultOverview,
  appTemplates,
  cachedApps,
  accounts,
  accountSummaries,
  selectedAccountId,
  canEditDefault,
}: Props) {
  const [tab, setTab] = useState<Tab>("default");

  // ── E2 — BADGE "account CÓ template / account ĐANG TỒN TẠI" ──────────
  //
  // TỬ SỐ  = số account có `template != null` trong accountSummaries.
  // MẪU SỐ = `accounts.length`, tức số account ĐANG TỒN TẠI.
  //
  // ⚠ MẪU SỐ KHÔNG ĐƯỢC LẤY TỪ `accountSummaries` ĐÃ LỌC. Thêm account
  //   thứ 7 sau migration thì badge phải thành 6/7 — nó là lời nhắc còn
  //   một account chưa cấu hình. Nếu mẫu số đếm trên danh sách đã lọc,
  //   badge sẽ mãi là 6/6 và cái thiếu đó không bao giờ lộ ra.
  //   Test ghim đúng ca này: 7 account / 6 có template → 6/7.
  const configuredCount = accountSummaries.filter(
    (s) => s.template !== null,
  ).length;
  const totalAccounts = accounts.length;

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
            countLabel={`${configuredCount} / ${totalAccounts} account`}
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
      {tab === "default" && (
        <DefaultTemplateTab
          overview={defaultOverview}
          accounts={accounts}
          summaries={accountSummaries}
          selectedAccountId={selectedAccountId}
          readOnly={!canEditDefault}
        />
      )}
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
  countLabel,
  active,
  onClick,
}: {
  label: string;
  count?: number;
  /** E2 — badge dạng chữ ("6 / 7 account"). Ưu tiên hơn `count`. */
  countLabel?: string;
  active: boolean;
  onClick: () => void;
}) {
  const badge = countLabel ?? (count !== undefined ? String(count) : undefined);
  return (
    <button
      onClick={onClick}
      className={`relative pb-3 pt-1 text-sm font-medium transition ${
        active ? "text-emerald-700" : "text-slate-500 hover:text-slate-700"
      }`}
    >
      <span>{label}</span>
      {badge !== undefined && (
        <span
          data-testid="tab-badge"
          className={`ml-2 inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] ${
            active
              ? "bg-emerald-100 text-emerald-800"
              : "bg-slate-100 text-slate-500"
          }`}
        >
          {badge}
        </span>
      )}
      {active && (
        <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-emerald-600" />
      )}
    </button>
  );
}
