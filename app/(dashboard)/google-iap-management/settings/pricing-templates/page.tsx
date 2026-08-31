export const dynamic = "force-dynamic";

import Link from "next/link";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { ArrowLeft } from "lucide-react";

import { authOptions } from "@/lib/auth";
import { listAccounts } from "@/lib/google-iap-management/repository/google-accounts";
import { listAppsForAccount } from "@/lib/google-iap-management/repository/apps";
import { readActiveAccountId } from "@/lib/google-iap-management/active-account";
import {
  getAccountTemplateOverview,
  listAccountTemplateSummaries,
  listAppTemplates,
} from "@/lib/google-iap-management/queries/templates";
import { PricingTemplatesClient } from "@/components/google-iap-management/pricing-templates/PricingTemplatesClient";

export default async function PricingTemplatesPage({
  searchParams,
}: {
  searchParams?: { account?: string };
}) {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/login");

  const accounts = await listAccounts().catch(() => []);
  if (accounts.length === 0) redirect("/google-iap-management");

  const cookieActiveId = readActiveAccountId();
  const fallbackId =
    accounts.find((a) => a.status === "verified")?.id ?? accounts[0].id;
  const activeAccountId =
    cookieActiveId && accounts.some((a) => a.id === cookieActiveId)
      ? cookieActiveId
      : fallbackId;

  // ── G1e/E1 — ACCOUNT ĐANG XEM ≠ ACCOUNT ĐANG ACTIVE ───────────────────
  //
  // Chip chọn account ghi lựa chọn vào QUERY STRING `?account=`, KHÔNG ghi
  // vào cookie active account. Đó là quyết định của Manager, và nó có lý
  // do vận hành: Manager cần liếc Default của account khác mà không làm
  // xê dịch account mà mọi màn khác của module đang bám theo.
  //
  // ⚠ Vì thế `selectedAccountId` là thứ mọi truy vấn của TAB NÀY phải
  //   dùng, còn `activeAccountId` chỉ là giá trị mặc định khi chưa chọn.
  //   Lẫn hai biến này là đọc/ghi đè template của account Manager đang
  //   KHÔNG nhìn.
  const requested = searchParams?.account;
  const selectedAccountId =
    requested && accounts.some((a) => a.id === requested)
      ? requested
      : activeAccountId;

  const [defaultOverview, appTemplates, cachedApps, accountSummaries] =
    await Promise.all([
      getAccountTemplateOverview(selectedAccountId),
      listAppTemplates(selectedAccountId),
      listAppsForAccount(selectedAccountId),
      listAccountTemplateSummaries(accounts.map((a) => a.id)),
    ]);

  return (
    <div className="p-8 max-w-6xl">
      <Link
        href="/google-iap-management"
        className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 transition mb-3"
      >
        <ArrowLeft className="h-3 w-3" />
        Google IAP Management
      </Link>
      <h1 className="text-2xl font-semibold text-slate-900 mb-1">
        Pricing Templates
      </h1>
      <p className="text-sm text-slate-500 mb-6 max-w-prose">
        Mỗi Google Console account có Default Template riêng, áp dụng cho mọi app của account đó; per-app template ghi đè lên
        Default for specific apps. Google&apos;s auto-equalisation fills in
        regions that no template covers.
      </p>
      <PricingTemplatesClient
        defaultOverview={defaultOverview}
        appTemplates={appTemplates}
        cachedApps={cachedApps.map((a) => ({
          id: a.id,
          package_name: a.package_name,
          display_name: a.display_name,
        }))}
        accounts={accounts.map((a) => ({ id: a.id, name: a.display_name }))}
        accountSummaries={accountSummaries}
        selectedAccountId={selectedAccountId}
        /* E7 — gate admin đã chặn ở SERVER (G1c). Cờ này chỉ để UI khỏi
           mời người dùng bấm vào một nút chắc chắn bị 403. Nó KHÔNG phải
           lớp bảo vệ: bỏ cờ đi thì route vẫn từ chối. */
        canEditDefault={session.user?.role === "admin"}
      />
    </div>
  );
}
