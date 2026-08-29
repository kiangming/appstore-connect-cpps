import { requireIapSession } from "@/lib/iap-management/auth";
import { getActiveAccount } from "@/lib/get-active-account";
import { findAllAccountsPublic } from "@/lib/asc-account-repository";
import {
  getTemplateOverview,
  listAccountTemplateSummaries,
  listAppsWithTemplates,
} from "@/lib/iap-management/queries/templates";
import { PricingTiersClient } from "./PricingTiersClient";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams?: { account?: string };
}

export default async function PricingTiersPage({ searchParams }: PageProps) {
  // Hotfix 11: page is member-accessible; the Default Template tab renders
  // read-only for non-admins (S1.B). Default mutation routes still enforce
  // admin role server-side (POST /pricing-templates scope=GLOBAL + DELETE on
  // GLOBAL templates).
  const session = await requireIapSession();
  const isAdmin = session.user.role === "admin";
  const currentUserEmail = session.user.email ?? "unknown";

  // IAP.p1.j Issue 3: the "Upload for an app" dropdown moved to a live
  // client-side fetch against the active ASC account
  // (/api/iap-management/asc-apps), so the page no longer needs to
  // pre-list local apps. appsWithTemplates is still served from the DB
  // because the table also captures upload metadata + per-template
  // entry counts that aren't exposed by Apple's app catalog.
  // C-D: tab Default có thanh chọn account riêng, độc lập với
  // AccountSwitcher ở TopNav. Account đang xem đến từ ?account=<id>; mặc
  // định là account đang active.
  //
  // ⚠ Giá trị từ URL PHẢI được đối chiếu với danh sách account thật trước
  //   khi dùng. Nó là soft-ref sang schema khác nên không FK nào chặn, và
  //   một ?account=<gõ bừa> sẽ lặng lẽ hiện "chưa có template" cho một
  //   account không tồn tại — đúng kiểu màn hình khiến người ta đi upload
  //   nhầm chỗ.
  const [creds, accounts] = await Promise.all([
    getActiveAccount(),
    findAllAccountsPublic(),
  ]);
  const requested = searchParams?.account;
  const selectedAccountId =
    requested && accounts.some((a) => a.id === requested) ? requested : creds.id;

  const [defaultOverview, appsWithTemplates, accountSummaries] = await Promise.all([
    getTemplateOverview({ kind: "ACCOUNT", account_id: selectedAccountId }),
    listAppsWithTemplates(),
    listAccountTemplateSummaries(accounts.map((a) => a.id)),
  ]);

  return (
    <PricingTiersClient
      defaultOverview={defaultOverview}
      appsWithTemplates={appsWithTemplates}
      accounts={accounts.map((a) => ({ id: a.id, name: a.name }))}
      accountSummaries={accountSummaries}
      selectedAccountId={selectedAccountId}
      isAdmin={isAdmin}
      currentUserEmail={currentUserEmail}
    />
  );
}
