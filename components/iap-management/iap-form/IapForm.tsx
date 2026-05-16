"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Save, Send, Trash2, Loader2 } from "lucide-react";
import { LocaleSidebar } from "./LocaleSidebar";
import { LocaleEditor } from "./LocaleEditor";
import { SubmitChecklist } from "./SubmitChecklist";
import { ScreenshotUpload } from "./ScreenshotUpload";
import {
  validateIapFormGrouped,
  type IapFormState,
  type FormLocalization,
} from "@/lib/iap-management/validation";
import type { InAppPurchaseType } from "@/types/iap-management/apple";
import type { PriceTierRow } from "@/lib/iap-management/queries/price-tiers";

export interface IapFormProps {
  /** "create" = NEW route; "edit" = existing draft/synced IAP. */
  mode: "create" | "edit";
  /** Apple app ID (numeric) — required for the create POST URL. */
  appAppleId: string;
  /** Internal iap_mgmt.iaps.id when editing; null when creating. */
  iapId: string | null;
  /** True when apple_iap_id is populated → editing a synced IAP. */
  syncedToApple: boolean;
  /** Prefill values; empty form for create mode. */
  initial: IapFormState;
  /** Tier rows from iap_mgmt.price_tiers cache. */
  tiers: PriceTierRow[];
}

const TYPES: { value: InAppPurchaseType; label: string }[] = [
  { value: "CONSUMABLE", label: "Consumable" },
  { value: "NON_CONSUMABLE", label: "Non-Consumable" },
  { value: "NON_RENEWING_SUBSCRIPTION", label: "Non-Renewing Subscription" },
];

const DEFAULT_LOCALE = "en-US";

export function IapForm({
  mode,
  appAppleId,
  iapId,
  syncedToApple,
  initial,
  tiers,
}: IapFormProps) {
  const router = useRouter();
  const [form, setForm] = useState<IapFormState>(initial);
  const [screenshotFile, setScreenshotFile] = useState<File | null>(null);
  const [activeLocale, setActiveLocale] = useState<string>(DEFAULT_LOCALE);
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [, startTransition] = useTransition();

  const checklist = useMemo(() => validateIapFormGrouped(form), [form]);

  function patchForm(updates: Partial<IapFormState>) {
    setForm((prev) => ({ ...prev, ...updates }));
  }

  function patchLocale(next: FormLocalization) {
    setForm((prev) => ({
      ...prev,
      localizations: { ...prev.localizations, [next.locale]: next },
    }));
  }

  function handleScreenshotStaged(file: File) {
    setScreenshotFile(file);
    patchForm({ screenshot_filename: file.name });
  }

  function handleScreenshotRemove() {
    setScreenshotFile(null);
    patchForm({ screenshot_filename: null });
  }

  function saveBody() {
    return {
      form: {
        reference_name: form.reference_name.trim(),
        product_id: form.product_id.trim(),
        type: form.type || "CONSUMABLE",
        tier_id: form.tier_id,
        localizations: form.localizations,
        screenshot_filename: form.screenshot_filename,
      },
    };
  }

  async function handleSaveDraft() {
    setSaving(true);
    try {
      if (mode === "create") {
        const res = await fetch(
          `/api/iap-management/apps/${appAppleId}/iaps`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(saveBody()),
          },
        );
        const data = (await res.json()) as { id: string } | { error: string };
        if (!res.ok) {
          toast.error("error" in data ? data.error : `Save failed (${res.status})`);
          return;
        }
        if ("id" in data) {
          toast.success("Draft saved");
          router.push(
            `/iap-management/apps/${appAppleId}/iaps/${data.id}`,
          );
        }
      } else if (iapId) {
        const res = await fetch(`/api/iap-management/iaps/${iapId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            reference_name: form.reference_name.trim(),
            tier_id: form.tier_id,
            localizations: form.localizations,
          }),
        });
        const data = (await res.json()) as
          | { ok: boolean }
          | { error: string };
        if (!res.ok) {
          toast.error("error" in data ? data.error : `Save failed (${res.status})`);
          return;
        }
        toast.success("Draft saved");
        startTransition(() => router.refresh());
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Network error");
    } finally {
      setSaving(false);
    }
  }

  async function handleCreateOnApple() {
    if (!iapId) return;
    if (!checklist.createReady) {
      toast.error("Complete Group A prerequisites first.");
      return;
    }
    setCreating(true);
    try {
      const body = new FormData();
      body.append("form", JSON.stringify(saveBody().form));
      if (screenshotFile) {
        body.append("screenshot", screenshotFile);
      }
      const res = await fetch(
        `/api/iap-management/apps/${appAppleId}/iaps/${iapId}/create-on-apple`,
        { method: "POST", body },
      );
      const data = (await res.json()) as
        | {
            ok: boolean;
            apple_iap_id: string;
            state: string;
            failed_locales: string[];
            screenshot_uploaded: boolean;
            screenshot_error?: string;
            price_schedule_set?: boolean;
            price_schedule_note?:
              | "set"
              | "skipped-no-tier"
              | "skipped-no-usd-price"
              | "skipped-no-match"
              | "failed-lookup"
              | "failed-set";
            price_schedule_error?: string;
            price_usd?: number;
          }
        | { error: string };

      if (!res.ok) {
        toast.error("error" in data ? data.error : `Create failed (${res.status})`);
        return;
      }
      if ("ok" in data) {
        const parts: string[] = [`State: ${data.state}`];
        if (data.failed_locales.length > 0) {
          parts.push(`${data.failed_locales.length} locale(s) failed`);
        }
        if (screenshotFile && !data.screenshot_uploaded) {
          parts.push("screenshot upload failed");
        }
        const pricingFailed =
          data.price_schedule_note === "skipped-no-usd-price" ||
          data.price_schedule_note === "skipped-no-match" ||
          data.price_schedule_note === "failed-lookup" ||
          data.price_schedule_note === "failed-set";
        if (data.price_schedule_set && typeof data.price_usd === "number") {
          parts.push(`price set ($${data.price_usd.toFixed(2)})`);
        } else if (data.price_schedule_set) {
          parts.push("price set");
        } else if (pricingFailed) {
          const reason =
            data.price_schedule_note === "skipped-no-usd-price"
              ? "tier not in USA/USD cache — re-import pricing tiers"
              : data.price_schedule_note === "skipped-no-match"
                ? "USD price didn't match any Apple price point"
                : "Apple rejected the price schedule";
          parts.push(`price not set (${reason}) — check App Store Connect`);
        }
        const allClean =
          data.failed_locales.length === 0 &&
          (!screenshotFile || data.screenshot_uploaded) &&
          !pricingFailed;
        if (allClean) {
          toast.success(`Created on Apple · ${parts.join(" · ")}`);
        } else {
          toast.warning(`Created on Apple with warnings · ${parts.join(" · ")}`);
        }
        router.push(`/iap-management/apps/${appAppleId}`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Network error");
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete() {
    if (!iapId) return;
    if (!confirm("Delete this draft IAP? This cannot be undone.")) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/iap-management/iaps/${iapId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        toast.error(data.error ?? `Delete failed (${res.status})`);
        return;
      }
      toast.success("Draft deleted");
      router.push(`/iap-management/apps/${appAppleId}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Network error");
    } finally {
      setDeleting(false);
    }
  }

  const productIdLocked = mode === "edit";
  const typeLocked = mode === "edit";
  const canCreate = mode === "edit" && !syncedToApple;

  return (
    <div className="grid grid-cols-[1fr_320px] gap-6">
      {/* Main column */}
      <div className="space-y-6 min-w-0">
        {/* Basic Information */}
        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-4 pb-2 border-b border-slate-100 dark:border-slate-800">
            Basic Information
          </h2>
          <div className="grid grid-cols-2 gap-4 mb-4">
            <FieldText
              label="Reference Name *"
              value={form.reference_name}
              onChange={(v) => patchForm({ reference_name: v })}
              placeholder="Diamond Pack Small"
              help="Internal name (max 64 chars)"
              maxLength={64}
            />
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                Product ID *{productIdLocked && " (locked)"}
              </label>
              <input
                type="text"
                value={form.product_id}
                onChange={(e) => patchForm({ product_id: e.target.value })}
                placeholder="com.vng.app.product1"
                disabled={productIdLocked}
                className={`w-full rounded-md border px-3 py-2 text-sm font-mono text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#0071E3] focus:border-transparent transition ${
                  productIdLocked
                    ? "border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/30 cursor-not-allowed text-slate-500 dark:text-slate-500"
                    : "border-slate-300"
                }`}
              />
              <p className="text-[11px] text-slate-400 dark:text-slate-500">
                {productIdLocked
                  ? "Immutable after creation"
                  : "Alphanumeric + . _ -  · Cannot be changed later"}
              </p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4 mb-4">
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                Type *{typeLocked && " (locked)"}
              </label>
              <select
                value={form.type}
                onChange={(e) =>
                  patchForm({ type: e.target.value as IapFormState["type"] })
                }
                disabled={typeLocked}
                className={`w-full rounded-md border px-3 py-2 text-sm transition ${
                  typeLocked
                    ? "border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/30 cursor-not-allowed text-slate-500 dark:text-slate-500"
                    : "border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-[#0071E3] focus:border-transparent"
                }`}
              >
                <option value="">— Select type —</option>
                {TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
              <p className="text-[11px] text-slate-400 dark:text-slate-500">
                Auto-renewable subscriptions are managed separately (Q1 lock).
              </p>
            </div>
            <FieldText
              label="Review Note (optional)"
              value={""}
              onChange={() => {}}
              placeholder="Reviewer guidance (out of scope for v1)"
              help="Notes shown to Apple reviewers — managed in IAP detail editor."
              disabled
            />
          </div>
        </section>

        {/* Pricing */}
        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-4 pb-2 border-b border-slate-100 dark:border-slate-800">
            Pricing
          </h2>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                Base Territory *
              </label>
              <select
                value="USA"
                disabled
                className="w-full rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-500 cursor-not-allowed"
              >
                <option>United States (USD)</option>
              </select>
              <p className="text-[11px] text-slate-400 dark:text-slate-500">
                USA / USD only in v1 — multi-base in a follow-up.
              </p>
            </div>
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                Price Tier *
              </label>
              <select
                value={form.tier_id ?? ""}
                onChange={(e) =>
                  patchForm({ tier_id: e.target.value || null })
                }
                className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0071E3] focus:border-transparent transition"
              >
                <option value="">— Select tier —</option>
                {tiers.map((t) => (
                  <option key={t.tier_id} value={t.tier_id}>
                    {t.tier_name}
                    {t.usd_price !== null && t.usd_price > 0
                      ? ` — $${t.usd_price.toFixed(2)}`
                      : t.usd_price === 0
                        ? " — Free"
                        : ""}
                    {t.is_alternate ? " · Alt" : ""}
                  </option>
                ))}
              </select>
              {form.tier_id && (() => {
                const selected = tiers.find((t) => t.tier_id === form.tier_id);
                if (!selected) return null;
                return (
                  <p className="text-[11px] text-emerald-700 dark:text-emerald-400 font-medium">
                    Selected: {selected.tier_name}
                    {selected.usd_price !== null && selected.usd_price > 0
                      ? ` · base USD $${selected.usd_price.toFixed(2)}`
                      : selected.usd_price === 0
                        ? " · Free Tier"
                        : ""}
                  </p>
                );
              })()}
              <p className="text-[11px] text-slate-400 dark:text-slate-500 dark:text-slate-500">
                Apple auto-calculates territory prices from the base tier.
                {tiers.length === 0 && (
                  <>
                    {" "}No tiers cached yet — import via{" "}
                    <a
                      href="/iap-management/settings/pricing-tiers"
                      className="text-[#0071E3] hover:underline"
                    >
                      Settings → Pricing Tiers
                    </a>
                    .
                  </>
                )}
              </p>
            </div>
          </div>
        </section>

        {/* Localizations */}
        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-4 pb-2 border-b border-slate-100 dark:border-slate-800">
            Localizations
          </h2>
          <div className="flex gap-4">
            <LocaleSidebar
              localizations={form.localizations}
              activeLocale={activeLocale}
              onSelect={setActiveLocale}
            />
            <LocaleEditor
              locale={activeLocale}
              value={form.localizations[activeLocale]}
              onChange={patchLocale}
            />
          </div>
        </section>

        {/* Review Screenshot */}
        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-4 pb-2 border-b border-slate-100 dark:border-slate-800">
            Review Screenshot
          </h2>
          <ScreenshotUpload
            filename={form.screenshot_filename}
            syncedToApple={syncedToApple}
            onFileStaged={handleScreenshotStaged}
            onRemove={handleScreenshotRemove}
          />
        </section>
      </div>

      {/* Sidebar column: checklist + actions */}
      <aside className="space-y-4 sticky top-6 self-start">
        <SubmitChecklist state={checklist} />

        <div className="space-y-2">
          <button
            type="button"
            onClick={handleSaveDraft}
            disabled={saving || creating}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 rounded-lg transition disabled:opacity-50"
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            {saving ? "Saving…" : "Save as Draft"}
          </button>

          {canCreate && (
            <button
              type="button"
              onClick={handleCreateOnApple}
              disabled={!checklist.createReady || creating || saving}
              className="w-full flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium bg-[#0071E3] hover:bg-[#0077ED] text-white rounded-lg transition disabled:opacity-40 disabled:cursor-not-allowed"
              title={
                checklist.createReady
                  ? "Push to Apple Connect (Submit for Review is a separate action on the IAP list page)"
                  : "Complete Group A first"
              }
            >
              {creating ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              {creating ? "Creating…" : "Create on Apple"}
            </button>
          )}

          {mode === "edit" && (
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleting || saving || creating || syncedToApple}
              className="w-full flex items-center justify-center gap-2 px-4 py-2 text-xs font-medium text-red-600 hover:bg-red-50 rounded-lg transition disabled:opacity-50"
              title={
                syncedToApple
                  ? "Synced IAPs cannot be deleted from this tool — manage via Apple Connect."
                  : "Delete this local draft."
              }
            >
              {deleting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
              Delete draft
            </button>
          )}
        </div>

        {canCreate && !checklist.createReady && (
          <p className="text-[11px] text-slate-500 dark:text-slate-400 px-2">
            Create unlocks when all Group A items are green. Screenshot is
            optional at create — Apple flips to MISSING_METADATA without it.
          </p>
        )}
        {syncedToApple && (
          <p className="text-[11px] text-slate-500 dark:text-slate-400 px-2">
            This IAP is on Apple. Submit for Review lives on the IAP list page
            (multi-select → Submit Selected).
          </p>
        )}
      </aside>
    </div>
  );
}

function FieldText({
  label,
  value,
  onChange,
  placeholder,
  help,
  maxLength,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  help?: string;
  maxLength?: number;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        maxLength={maxLength}
        className={`w-full rounded-md border px-3 py-2 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#0071E3] focus:border-transparent transition ${
          disabled
            ? "border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/30 cursor-not-allowed text-slate-500 dark:text-slate-500"
            : "border-slate-300"
        }`}
      />
      {help && <p className="text-[11px] text-slate-400 dark:text-slate-500">{help}</p>}
    </div>
  );
}
