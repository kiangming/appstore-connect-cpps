export const dynamic = "force-dynamic";

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { ArrowLeft } from "lucide-react";

import { authOptions } from "@/lib/auth";
import { listAccounts } from "@/lib/google-iap-management/repository/google-accounts";
import { getAppByPackage } from "@/lib/google-iap-management/repository/apps";
import { readActiveAccountId } from "@/lib/google-iap-management/active-account";
import { IapForm } from "@/components/google-iap-management/iap-form/IapForm";

export default async function NewIapPage({
  params,
}: {
  params: { packageName: string };
}) {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/login");

  const packageName = decodeURIComponent(params.packageName);
  const accounts = await listAccounts().catch(() => []);
  if (accounts.length === 0) redirect("/google-iap-management");

  const cookieActiveId = readActiveAccountId();
  const fallbackId =
    accounts.find((a) => a.status === "verified")?.id ?? accounts[0].id;
  const activeAccountId =
    cookieActiveId && accounts.some((a) => a.id === cookieActiveId)
      ? cookieActiveId
      : fallbackId;

  const app = await getAppByPackage(activeAccountId, packageName);
  if (!app) notFound();

  return (
    <div className="p-8 max-w-5xl">
      <Link
        href={`/google-iap-management/apps/${encodeURIComponent(packageName)}`}
        className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 transition mb-3"
      >
        <ArrowLeft className="h-3 w-3" />
        Back to {app.display_name ?? packageName}
      </Link>
      <h1 className="text-2xl font-semibold text-slate-900 mb-1">
        New IAP
      </h1>
      <p className="text-sm text-slate-500 mb-6">
        Create an in-app product for{" "}
        <span className="font-mono text-emerald-700">{packageName}</span>.
      </p>
      <IapForm
        packageName={packageName}
        appId={app.id}
        appDefaults={{
          currency: app.default_currency,
          language: app.default_language,
        }}
      />
    </div>
  );
}
