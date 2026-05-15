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
  validateIapFormState,
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
  const [activeLocale, setActiveLocale] = useState<string>(DEFAULT_LOCALE);
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [, startTransition] = useTransition();

  const checklist = useMemo(() => validateIapFormState(form), [form]);

  function patchForm(updates: Partial<IapFormState>) {
    setForm((prev) => ({ ...prev, ...updates }));
  }

  function patchLocale(next: FormLocalization) {
    setForm((prev) => ({
      ...prev,
      localizations: { ...prev.localizations, [next.locale]: next },
    }));
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

  async function handleSubmit() {
    if (!iapId) return;
    if (!checklist.allPassed) {
      toast.error("Submit checklist incomplete");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(
        `/api/iap-management/iaps/${iapId}/submit`,
        { method: "POST" },
      );
      const data = (await res.json()) as
        | { ok: boolean; apple_iap_id: string; partial?: boolean; failed_locales?: string[] }
        | { error: string };

      if (!res.ok) {
        toast.error("error" in data ? data.error : `Submit failed (${res.status})`);
        return;
      }
      if ("ok" in data) {
        if (data.partial && data.failed_locales && data.failed_locales.length > 0) {
          toast.warning(
            `Submitted; ${data.failed_locales.length} locale(s) failed: ${data.failed_locales.join(", ")}`,
          );
        } else {
          toast.success("Submitted to Apple Review");
        }
        startTransition(() => router.refresh());
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Network error");
    } finally {
      setSubmitting(false);
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

  return (
    <div className="grid grid-cols-[1fr_320px] gap-6">
      {/* Main column */}
      <div className="space-y-6 min-w-0">
        {/* Basic Information */}
        <section className="bg-white border border-slate-200 rounded-xl p-6">
          <h2 className="text-sm font-semibold text-slate-900 mb-4 pb-2 border-b border-slate-100">
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
              <label className="block text-xs font-medium text-slate-700">
                Product ID *{productIdLocked && " (locked)"}
              </label>
              <input
                type="text"
                value={form.product_id}
                onChange={(e) => patchForm({ product_id: e.target.value })}
                placeholder="com.vng.app.product1"
                disabled={productIdLocked}
                className={`w-full rounded-md border px-3 py-2 text-sm font-mono text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#0071E3] focus:border-transparent transition ${
                  productIdLocked
                    ? "border-slate-200 bg-slate-50 cursor-not-allowed text-slate-500"
                    : "border-slate-300"
                }`}
              />
              <p className="text-[11px] text-slate-400">
                {productIdLocked
                  ? "Immutable after creation"
                  : "Alphanumeric + . _ -  · Cannot be changed later"}
              </p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4 mb-4">
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-slate-700">
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
                    ? "border-slate-200 bg-slate-50 cursor-not-allowed text-slate-500"
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
              <p className="text-[11px] text-slate-400">
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
        <section className="bg-white border border-slate-200 rounded-xl p-6">
          <h2 className="text-sm font-semibold text-slate-900 mb-4 pb-2 border-b border-slate-100">
            Pricing
          </h2>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-slate-700">
                Base Territory *
              </label>
              <select
                value="USA"
                disabled
                className="w-full rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-500 cursor-not-allowed"
              >
                <option>United States (USD)</option>
              </select>
              <p className="text-[11px] text-slate-400">
                USA / USD only in v1 — multi-base in a follow-up.
              </p>
            </div>
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-slate-700">
                Price Tier *
              </label>
              <select
                value={form.tier_id ?? ""}
                onChange={(e) =>
                  patchForm({ tier_id: e.target.value || null })
                }
                className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0071E3] focus:border-transparent transition"
              >
                <option value="">— Select tier —</option>
                {tiers.map((t) => (
                  <option key={t.tier_id} value={t.tier_id}>
                    {t.tier_name} {t.is_alternate ? "· Alt" : ""}
                  </option>
                ))}
              </select>
              <p className="text-[11px] text-slate-400">
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
        <section className="bg-white border border-slate-200 rounded-xl p-6">
          <h2 className="text-sm font-semibold text-slate-900 mb-4 pb-2 border-b border-slate-100">
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
        <section className="bg-white border border-slate-200 rounded-xl p-6">
          <h2 className="text-sm font-semibold text-slate-900 mb-4 pb-2 border-b border-slate-100">
            Review Screenshot
          </h2>
          <ScreenshotUpload
            filename={form.screenshot_filename}
            iapPersisted={mode === "edit" && iapId !== null}
            uploadEndpoint={
              iapId
                ? `/api/iap-management/iaps/${iapId}/screenshot`
                : ""
            }
            onUploaded={(filename) =>
              patchForm({ screenshot_filename: filename })
            }
            onRemove={() => patchForm({ screenshot_filename: null })}
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
            disabled={saving || submitting}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg transition disabled:opacity-50"
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            {saving ? "Saving…" : "Save as Draft"}
          </button>

          {mode === "edit" && (
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!checklist.allPassed || submitting || saving}
              className="w-full flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium bg-[#0071E3] hover:bg-[#0077ED] text-white rounded-lg transition disabled:opacity-40 disabled:cursor-not-allowed"
              title={
                checklist.allPassed
                  ? "Push to Apple Review"
                  : "Complete the checklist first"
              }
            >
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              {submitting
                ? "Submitting…"
                : syncedToApple
                  ? "Re-submit to Apple"
                  : "Submit to Apple"}
            </button>
          )}

          {mode === "edit" && (
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleting || saving || submitting}
              className="w-full flex items-center justify-center gap-2 px-4 py-2 text-xs font-medium text-red-600 hover:bg-red-50 rounded-lg transition disabled:opacity-50"
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

        {!checklist.allPassed && mode === "edit" && (
          <p className="text-[11px] text-slate-500 px-2">
            Submit unlocks when all checklist items are green.
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
      <label className="block text-xs font-medium text-slate-700">{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        maxLength={maxLength}
        className={`w-full rounded-md border px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#0071E3] focus:border-transparent transition ${
          disabled
            ? "border-slate-200 bg-slate-50 cursor-not-allowed text-slate-500"
            : "border-slate-300"
        }`}
      />
      {help && <p className="text-[11px] text-slate-400">{help}</p>}
    </div>
  );
}
