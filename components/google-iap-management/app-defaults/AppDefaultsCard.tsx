"use client";

/**
 * D9 [arc-google-missing-purchase-options] — the app's currency and default
 * language, with WHERE each value came from. A value the tool guessed (before
 * 2026-10-16) is shown with a one-click Confirm so nobody has to retype it.
 * Not tied to bulk import's gate (C2.1); bulk import still READS the currency
 * for pricing until the H4 fix ships.
 *
 * Every save sends the app id and the value + source this card SHOWED; the
 * route refuses (409) when either changed since the page loaded — a switched
 * account or another admin's declaration is never silently overwritten.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, AlertTriangle, Pencil } from "lucide-react";

import {
  APP_DEFAULT_DECLARED,
  APP_DEFAULT_GUESSED,
  DECLARABLE_CURRENCIES,
  type AppDefaultField,
  type AppDefaultsState,
  type AppDefaultValue,
} from "@/lib/google-iap-management/app-defaults";
import { GOOGLE_LOCALE_OPTIONS } from "@/lib/google-iap-management/parsers/template-spec";

const LABEL: Record<AppDefaultField, string> = {
  currency: "Currency",
  language: "Default language",
};

export function AppDefaultsCard({
  appId,
  packageName,
  initialDefaults,
  readError,
  canEdit,
}: {
  appId: string;
  packageName: string;
  initialDefaults: AppDefaultsState | null;
  readError: string | null;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [defaults, setDefaults] = useState<AppDefaultsState | null>(initialDefaults);
  const [notice, setNotice] = useState<string | null>(null);

  if (readError || !defaults) {
    return (
      <section
        id="app-defaults"
        data-testid="app-defaults-card"
        className="mb-4 text-xs text-red-900 bg-red-50 border border-red-200 rounded-xl px-4 py-3"
      >
        <span className="font-semibold">Could not read this app&apos;s currency / language.</span>{" "}
        {readError ?? "Unknown error."} This does not decide whether bulk import runs.
      </section>
    );
  }

  return (
    <section
      id="app-defaults"
      data-testid="app-defaults-card"
      className="mb-4 bg-white border border-slate-200 rounded-xl px-4 py-3"
    >
      <h2 className="text-sm font-semibold text-slate-900">App currency &amp; language</h2>
      <p className="text-xs text-slate-500 mb-2">
        What the tool records for this app, and whether a Manager declared it or the tool guessed
        it. Not a condition for bulk import. Today bulk import still reads the currency for a
        column headed just &quot;Price&quot;, for rows whose file currency differs, and for custom
        prices — the file&apos;s own currency is meant to become the only source. Google Play does
        not expose an app-wide currency, so the tool no longer guesses one.
      </p>
      <div className="divide-y divide-slate-100">
        {(["currency", "language"] as const).map((field) => (
          <DefaultRow
            key={field}
            field={field}
            appId={appId}
            packageName={packageName}
            current={defaults[field]}
            canEdit={canEdit}
            onSaved={(next) => {
              if (next) {
                setDefaults(next);
                setNotice(null);
              } else {
                // Saved, but the re-read failed: say so instead of showing a
                // stale "guessed" row or a false "save failed" (P5).
                setNotice("Saved as declared. Reload the page to see the current values.");
              }
              router.refresh();
            }}
          />
        ))}
      </div>
      {notice && (
        <p data-testid="app-defaults-notice" className="mt-2 text-xs text-emerald-800">
          {notice}
        </p>
      )}
      {!canEdit && (
        <p className="mt-2 text-xs text-slate-500">Only an admin can declare these values.</p>
      )}
    </section>
  );
}

function DefaultRow({
  field,
  appId,
  packageName,
  current,
  canEdit,
  onSaved,
}: {
  field: AppDefaultField;
  appId: string;
  packageName: string;
  current: AppDefaultValue;
  canEdit: boolean;
  /** null = saved, but the server could not re-read the values. */
  onSaved: (next: AppDefaultsState | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>(current.value ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(value: string) {
    setError(null);
    setSaving(true);
    try {
      const res = await fetch(
        `/api/google-iap-management/apps/${encodeURIComponent(packageName)}/defaults`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            field,
            value,
            appId,
            expected: { value: current.value, source: current.source },
          }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        defaults?: AppDefaultsState | null;
      };
      if (!res.ok || body.ok !== true) {
        setError(body.error ?? `Save failed (HTTP ${res.status}).`);
        return;
      }
      setEditing(false);
      onSaved(body.defaults ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  const status =
    current.source === APP_DEFAULT_DECLARED && current.value
      ? "declared"
      : current.source === APP_DEFAULT_GUESSED && current.value
        ? "unconfirmed"
        : "unset";

  return (
    <div className="py-2" data-testid={`app-default-${field}`} data-status={status}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="w-36 text-slate-600">{LABEL[field]}</span>
        <code className="px-1.5 py-0.5 rounded bg-slate-50 border border-slate-200 font-mono text-xs">
          {current.value || "—"}
        </code>
        {status === "declared" && (
          <span className="inline-flex items-center gap-1 text-xs text-emerald-700">
            <CheckCircle2 className="h-3.5 w-3.5" /> Declared
          </span>
        )}
        {status === "unconfirmed" && (
          <span className="inline-flex items-center gap-1 text-xs text-amber-800">
            <AlertTriangle className="h-3.5 w-3.5" /> Guessed by the tool — not confirmed
          </span>
        )}
        {status === "unset" && (
          <span className="inline-flex items-center gap-1 text-xs text-red-700">
            <AlertTriangle className="h-3.5 w-3.5" /> Not set
          </span>
        )}
        {canEdit && !editing && (
          <span className="ml-auto flex gap-2">
            {status === "unconfirmed" && current.value && (
              <button
                type="button"
                disabled={saving}
                onClick={() => submit(current.value as string)}
                className="rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
              >
                {saving ? "Saving…" : `Confirm ${current.value}`}
              </button>
            )}
            <button
              type="button"
              disabled={saving}
              onClick={() => {
                setDraft(current.value ?? "");
                setEditing(true);
              }}
              className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
            >
              <Pencil className="h-3 w-3" /> {status === "unset" ? "Set" : "Edit"}
            </button>
          </span>
        )}
      </div>
      {canEdit && editing && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select
            aria-label={`${LABEL[field]} value`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="rounded-md border border-slate-300 px-2 py-1 text-xs"
          >
            <option value="">Choose…</option>
            {field === "currency"
              ? DECLARABLE_CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))
              : GOOGLE_LOCALE_OPTIONS.map((o) => (
                  <option key={o.code} value={o.code}>
                    {o.code} — {o.name}
                  </option>
                ))}
          </select>
          <button
            type="button"
            disabled={saving || draft === ""}
            onClick={() => submit(draft)}
            className="rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
          >
            {saving ? "Saving…" : "Save as declared"}
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => setEditing(false)}
            className="rounded-md px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-100"
          >
            Cancel
          </button>
        </div>
      )}
      {error && <p className="mt-1 text-xs text-red-700">{error}</p>}
    </div>
  );
}
