"use client";

import { useState } from "react";
import type {
  AccountTemplateSummary,
  AppTemplateSummary,
  TemplateOverview,
} from "@/lib/iap-management/queries/templates";
import type { AccountOption } from "./DefaultTemplateTab";
import { SettingsTabs } from "@/components/iap-management/settings/SettingsTabs";
import { DefaultTemplateTab } from "./DefaultTemplateTab";
import { PerAppTemplateTab } from "./PerAppTemplateTab";

interface Props {
  defaultOverview: TemplateOverview;
  appsWithTemplates: AppTemplateSummary[];
  /** C-D: mọi account đang tồn tại (mẫu số của badge). */
  accounts: AccountOption[];
  /** C-D: account nào đã có template (tử số của badge). */
  accountSummaries: AccountTemplateSummary[];
  selectedAccountId: string;
  /** Hotfix 11: role-aware rendering. Non-admin sees Default tab in
   *  read-only mode (upload/remove hidden) but the Per-App tab is full
   *  edit. The Per-App tab uses currentUserEmail to gate the
   *  "replacing someone else's template" confirm modal. */
  isAdmin: boolean;
  currentUserEmail: string;
}

type Tab = "default" | "per-app";

export function PricingTiersClient({
  defaultOverview,
  appsWithTemplates,
  accounts,
  accountSummaries,
  selectedAccountId,
  isAdmin,
  currentUserEmail,
}: Props) {
  const [tab, setTab] = useState<Tab>("default");

  // D2 — badge đếm "account CÓ template / account ĐANG TỒN TẠI".
  //
  // ⚠ Mẫu số là `accounts.length` (account đang tồn tại), KHÔNG phải số
  //   template. Account thứ 7 thêm sau migration phải làm badge thành 6/7 —
  //   nếu mẫu số lấy từ accountSummaries đã lọc, badge sẽ mãi là 6/6 và
  //   giấu đi đúng thứ nó sinh ra để hiện.
  //
  // Vì sao không đếm số ô như trước: badge nằm ở dải ĐIỀU HƯỚNG, nên con số
  // đúng ở đó là con số cần biết TRƯỚC khi click. Số ô đã có sẵn ở thẻ
  // "Populated entries" bên trong. Và badge tab bên cạnh đang đếm template —
  // hai badge cạnh nhau đếm hai loại khác nhau là một bẫy đọc.
  const accountsWithTemplate = accountSummaries.filter(
    (s) => s.template !== null,
  ).length;

  return (
    <div className="p-8 max-w-6xl mx-auto">
      {/* Route-level tabs, ABOVE the title. The `<h1>` below separates them
          from this page's OWN tabs further down — see SettingsTabs' footer
          note on why the two rows must stay visually distinct. */}
      <SettingsTabs />

      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
          Pricing Templates
        </h1>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
          Mỗi ASC account có Default Template riêng, áp dụng cho mọi app của
          account đó. Template theo app ghi đè Default của account. Territory
          nào không có trong template thì Apple tự auto-equalize.
        </p>
      </div>

      <div className="border-b border-slate-200 dark:border-slate-800 mb-6">
        <nav className="flex gap-6" aria-label="Pricing templates tabs">
          <TabButton
            label="Default Template"
            count={`${accountsWithTemplate} / ${accounts.length} account`}
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
        <DefaultTemplateTab
          overview={defaultOverview}
          readOnly={!isAdmin}
          accounts={accounts}
          summaries={accountSummaries}
          selectedAccountId={selectedAccountId}
          currentUserEmail={currentUserEmail}
        />
      ) : (
        <PerAppTemplateTab
          appsWithTemplates={appsWithTemplates}
          currentUserEmail={currentUserEmail}
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
  count: number | string;
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
