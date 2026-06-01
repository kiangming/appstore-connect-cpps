"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Upload,
  FileSpreadsheet,
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  ChevronLeft,
  X,
} from "lucide-react";

import { PreviewTable } from "./PreviewTable";
import { PricingSourceSelector } from "@/components/google-iap-management/iap-form/PricingSourceSelector";
import { validateDecimalForCurrency } from "@/lib/google-iap-management/google/currency-precision";

export type PricingSource = "google_default" | "default_template" | "app_template";
export type RowDecision = "overwrite" | "skip" | "create";

export interface PreviewListing {
  locale: string;
  title: string;
  description: string;
}

export interface PreviewRegionOverride {
  region: string;
  currency: string;
  priceDecimal: string;
}

/** Hotfix 19: candidate-tier descriptor returned by the Preview API per
 *  row. Matches `TierCandidate` in `queries/templates.ts`. */
export interface PreviewTierCandidate {
  identifier: string;
  templateId: string;
  regionCount: number;
  vnCurrency: string | null;
  vnPriceMicros: string | null;
  vnPriceDecimal: string | null;
}

/** Cycle 43 — cross-currency resolution outcome surfaced by the Preview
 *  API per row. Drives:
 *   - whether the precision gate skips this row (raw price not sent)
 *   - the Resolved column display
 *   - the per-row refusal indicator banner */
export type PreviewResolution =
  | { kind: "same_currency" }
  | {
      kind: "cross_currency_resolved";
      anchorUsdMicros: string;
      chosenTier: string;
      appCurrencyPrice: {
        currency: string;
        priceMicros: string;
        priceDecimal: string;
      };
    }
  | { kind: "cross_currency_needs_choice"; anchorUsdMicros: string }
  | {
      kind: "cross_currency_refused";
      anchorUsdMicros: string | null;
      reason: string;
      refusalKind:
        | "google_default"
        | "template_miss"
        | "missing_entries"
        | "no_app_currency_entry";
    };

export interface PreviewRow {
  rowNumber: number;
  sku: string;
  baseCurrency: string;
  basePriceDecimal: string;
  regionOverrides: PreviewRegionOverride[];
  listings: PreviewListing[];
  exists: boolean;
  decision: RowDecision;
  // Hotfix 19 — server-rendered candidate metadata.
  tierCandidates: PreviewTierCandidate[];
  defaultTierSelection: string | null;
  tierMatchedBy: "sku" | "currency_price" | "none";
  /** Cycle 43 — cross-currency resolution outcome. Defaults to
   *  `same_currency` when the server didn't populate it (legacy
   *  response shape backward-compat). */
  resolution?: PreviewResolution;
  /** Cycle 43 — parser provenance of the baseCurrency. "explicit" for
   *  "Price (XXX)" headers (drives header-first cross-currency
   *  detection); "inferred" for generic "Price"/"Default Price"/"Base
   *  Price" (drives value-based fallback). Optional for legacy preview
   *  responses; the orchestrator defaults to "inferred" when absent. */
  priceHeaderSource?: "explicit" | "inferred";
}

interface ExecuteResult {
  rowsTotal: number;
  rowsCreated: number;
  rowsOverwritten: number;
  rowsSkipped: number;
  rowsFailed: number;
  /** Cycle 43 — per-row cross-currency fail-soft refusals. */
  rowsRefused?: number;
  refusedRows?: Array<{
    sku: string;
    rowNumber: number;
    reason: string;
    kind: string;
  }>;
  durationMs: number;
}

interface Props {
  packageName: string;
  appId: string;
  appDisplayName: string | null;
  /** App-level Google Play defaults (Hotfix 4). Shown as a wizard banner
   *  and threaded into the execute payload so the orchestrator can stamp
   *  the row's baseCurrency to match Google's per-app enforcement. */
  appDefaultCurrency: string | null;
  appDefaultLanguage: string | null;
}

type Step = "pricing" | "upload" | "preview" | "execute" | "done";

export function BulkImportWizard({
  packageName,
  appId,
  appDisplayName,
  appDefaultCurrency,
  appDefaultLanguage,
}: Props) {
  const router = useRouter();
  const [step, setStep] = useState<Step>("pricing");

  // Step 1: pricing source
  const [pricingSource, setPricingSource] = useState<PricingSource>("google_default");

  // Step 2: file upload
  const [file, setFile] = useState<File | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  // Step 3: preview
  const [previewRows, setPreviewRows] = useState<PreviewRow[]>([]);
  const [previewWarnings, setPreviewWarnings] = useState<string[]>([]);
  // Hotfix 19: per-row Manager tier selection. Keyed by rowNumber so
  // the orchestrator's execute payload can map back. Pre-filled from the
  // Preview API's `defaultTierSelection` (Q5.B primary tier).
  const [tierSelections, setTierSelections] = useState<Record<number, string>>(
    {},
  );

  // Step 4: execute
  const [executing, setExecuting] = useState(false);
  const [executeError, setExecuteError] = useState<string | null>(null);
  const [executeResult, setExecuteResult] = useState<ExecuteResult | null>(null);

  const counts = useMemo(() => {
    const total = previewRows.length;
    const existing = previewRows.filter((r) => r.exists).length;
    const pending = previewRows.filter(
      (r) => r.exists && r.decision === "create",
    ).length;
    const willOverwrite = previewRows.filter((r) => r.decision === "overwrite").length;
    const willSkip = previewRows.filter((r) => r.decision === "skip").length;
    const willCreate = previewRows.filter((r) => !r.exists && r.decision === "create").length;
    return { total, existing, pending, willOverwrite, willSkip, willCreate };
  }, [previewRows]);

  // Hotfix 28 — pre-flight precision validation per-row currency.
  //
  // Pre-Hotfix-14 the legacy inappproducts.batchUpdate enforced
  // defaultPrice.currency === app.defaultCurrency, so the wizard
  // validated every row against `appDefaultCurrency`. Hotfix 14 Phase 3
  // migrated to Google's Monetization API which accepts per-region
  // pricing — the orchestrator now stamps defaultPrice.currency from
  // each row's `baseCurrency` (resolved by the parser from the column
  // header, e.g. "Price (USD)" → USD). This pre-flight check was left
  // on the old app-wide assumption, which blocked USD-priced rows in
  // VND-default apps (Hotfix 28 production symptom). Now validates
  // each row against its own column-resolved currency to match the
  // orchestrator path. Skip rows are excluded — they're not sent.
  const precisionViolations = useMemo(
    () => computePrecisionViolations(previewRows),
    [previewRows],
  );

  // Hotfix 19: derive disambiguation status for the banner + button counter.
  //   - ambiguous: rows whose template lookup found >1 candidate tiers
  //   - pending:   ambiguous rows where Manager cleared the selection (edge case)
  //   - changed:   ambiguous rows where Manager picked a non-default tier
  //   - atDefault: ambiguous rows still on the pre-selected primary tier
  const tierStatus = useMemo(() => {
    let ambiguous = 0;
    let pending = 0;
    let changed = 0;
    let atDefault = 0;
    for (const row of previewRows) {
      if (row.decision === "skip") continue;
      if (row.tierCandidates.length <= 1) continue;
      ambiguous += 1;
      const selection = tierSelections[row.rowNumber];
      if (!selection) {
        pending += 1;
        continue;
      }
      if (
        row.defaultTierSelection &&
        selection === row.defaultTierSelection
      ) {
        atDefault += 1;
      } else {
        changed += 1;
      }
    }
    return { ambiguous, pending, changed, atDefault };
  }, [previewRows, tierSelections]);

  async function handleUploadAndPreview() {
    if (!file) return;
    setUploadError(null);
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      // Hotfix 19: thread pricingSource so the API can look up
      // candidate tiers per row server-side.
      form.append("pricingSource", pricingSource);
      const res = await fetch(
        `/api/google-iap-management/apps/${encodeURIComponent(packageName)}/bulk-import/preview`,
        { method: "POST", body: form },
      );
      const body = (await res.json().catch(() => ({}))) as {
        rows?: Array<Omit<PreviewRow, "decision">>;
        warnings?: string[];
        errors?: string[];
        error?: string;
      };
      if (!res.ok) {
        if (body.errors && body.errors.length > 0) {
          setUploadError(body.errors.join(" · "));
        } else {
          setUploadError(body.error ?? `Preview failed (HTTP ${res.status}).`);
        }
        return;
      }
      const rows: PreviewRow[] = (body.rows ?? []).map((r) => ({
        ...r,
        // Defensive defaults — older clients may not carry these fields.
        tierCandidates: r.tierCandidates ?? [],
        defaultTierSelection: r.defaultTierSelection ?? null,
        tierMatchedBy: r.tierMatchedBy ?? "none",
        decision: r.exists ? "create" : "create",
      }));
      // Hotfix 19: seed tierSelections — every row with candidates
      // starts on its primary tier (Q5.B). Manager can change via dropdown.
      const seedSelections: Record<number, string> = {};
      for (const r of rows) {
        if (r.tierCandidates.length >= 1) {
          const pick = r.defaultTierSelection ?? r.tierCandidates[0].identifier;
          if (pick) seedSelections[r.rowNumber] = pick;
        }
      }
      setPreviewRows(rows);
      setPreviewWarnings(body.warnings ?? []);
      setTierSelections(seedSelections);
      setStep("preview");
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  function setRowTierSelection(rowNumber: number, identifier: string) {
    setTierSelections((prev) => {
      const next = { ...prev };
      if (identifier === "") {
        delete next[rowNumber];
      } else {
        next[rowNumber] = identifier;
      }
      return next;
    });
  }

  function setAllExisting(decision: "overwrite" | "skip") {
    setPreviewRows((prev) =>
      prev.map((r) => (r.exists ? { ...r, decision } : r)),
    );
  }

  function setRowDecision(rowNumber: number, decision: "overwrite" | "skip") {
    setPreviewRows((prev) =>
      prev.map((r) => (r.rowNumber === rowNumber ? { ...r, decision } : r)),
    );
  }

  async function handleExecute() {
    setExecuteError(null);
    setExecuting(true);
    setStep("execute");
    try {
      const res = await fetch(
        `/api/google-iap-management/apps/${encodeURIComponent(packageName)}/bulk-import/execute`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            pricingSource,
            sourceFilename: file?.name ?? null,
            rows: previewRows.map((r) => ({
              rowNumber: r.rowNumber,
              sku: r.sku,
              // Cycle 43 (2026-06-01): send the parser-resolved
              // baseCurrency verbatim. Pre-Cycle-43 the wizard stomped
              // this to appDefaultCurrency (Hotfix 4) so the legacy
              // batchUpdate endpoint's "defaultPrice.currency == app
              // currency" check would pass; Hotfix 14 migrated to the
              // Monetization API which accepts per-row currency, and
              // Cycle 43's orchestrator cross-currency pre-pass now
              // honours the parser's explicit "Price (XXX)" declaration
              // (header-first trigger) — the stomp obscured this and
              // forced the value-based fallback even on explicit
              // headers, which silently mishandled integer cross-
              // currency values like "25 USD" → "25 VND".
              baseCurrency: r.baseCurrency,
              basePriceDecimal: r.basePriceDecimal,
              regionOverrides: r.regionOverrides,
              listings: r.listings,
              decision: r.decision,
              // Cycle 43 — forward parser header provenance so the
              // orchestrator's pre-pass can choose explicit_header vs
              // value_based trigger correctly. Default "inferred" when
              // a stale preview response lacks the field.
              priceHeaderSource: r.priceHeaderSource ?? "inferred",
              // Hotfix 19: explicit tier selection (null when no
              // template lookup applied). Orchestrator honours it
              // verbatim — no silent fallback. The companion fields
              // let the audit log distinguish:
              //   - single_match           (1 candidate, no choice)
              //   - default_accepted       (>1 candidates, primary kept)
              //   - manager_explicit       (>1 candidates, override)
              //   - no_candidates_auto_bootstrap (0 candidates)
              chosenTierIdentifier:
                tierSelections[r.rowNumber] ?? null,
              defaultTierIdentifier: r.defaultTierSelection,
              tierCandidateCount: r.tierCandidates.length,
            })),
          }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as ExecuteResult & {
        error?: string;
      };
      if (!res.ok) {
        setExecuteError(body.error ?? `Execute failed (HTTP ${res.status}).`);
        setStep("preview");
        return;
      }
      setExecuteResult(body);
      setStep("done");
    } catch (err) {
      setExecuteError(err instanceof Error ? err.message : "Network error");
      setStep("preview");
    } finally {
      setExecuting(false);
    }
  }

  // Hotfix 19: Push button is gated on every ambiguous row having a
  // selection (Manager either accepted the pre-selected primary tier or
  // explicitly picked another). `tierStatus.pending > 0` only happens
  // when Manager clears a dropdown back to "— Select a tier —".
  const canContinueFromPreview =
    counts.pending === 0 &&
    previewRows.length > 0 &&
    precisionViolations.length === 0 &&
    tierStatus.pending === 0;

  return (
    <div className="space-y-4">
      <StepHeader step={step} />

      {/* App defaults banner (Hotfix 4) */}
      {(appDefaultCurrency || appDefaultLanguage) && (
        <div className="text-xs text-emerald-900 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
          <span className="font-semibold">
            Importing to {appDisplayName ?? packageName}:
          </span>{" "}
          {appDefaultCurrency && (
            <>
              rows will be sent with currency{" "}
              <code className="px-1 bg-white border border-emerald-200 rounded font-mono">
                {appDefaultCurrency}
              </code>{" "}
            </>
          )}
          {appDefaultLanguage && (
            <>
              · default locale{" "}
              <code className="px-1 bg-white border border-emerald-200 rounded font-mono">
                {appDefaultLanguage}
              </code>
            </>
          )}
          {appDefaultCurrency && (
            <span className="block mt-1 text-emerald-700">
              The Excel column header reads &quot;Price (USD)&quot; but the
              numeric values are interpreted in the app&apos;s configured
              currency — Google enforces app-wide consistency.
            </span>
          )}
        </div>
      )}
      {!appDefaultCurrency && !appDefaultLanguage && (
        <div className="text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          App defaults not cached. Run <strong>Refresh from Google</strong> on
          the app detail page first — otherwise rows will be sent as USD and
          Google will reject them if the app is configured for any other
          currency.
        </div>
      )}

      {/* Step 1: Pricing source */}
      {step === "pricing" && (
        <section className="bg-white border border-slate-200 rounded-xl p-6">
          <h2 className="text-base font-semibold text-slate-900 mb-1">
            Pricing source
          </h2>
          <p className="text-xs text-slate-500 mb-4">
            Q-GIAP.E batch-level. Applied to every row in this import. For
            template modes, each row&apos;s SKU is matched to a template tier
            identifier; rows without a matching tier fall back to the
            row&apos;s inline USD + GT Price.
          </p>
          <PricingSourceSelector
            value={pricingSource}
            onChange={setPricingSource}
            appId={appId}
            tierValue=""
            onTierChange={() => undefined}
            hideTierPicker
          />
          <div className="mt-6 flex justify-end">
            <button
              onClick={() => setStep("upload")}
              className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg transition"
            >
              Continue
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </section>
      )}

      {/* Step 2: Upload */}
      {step === "upload" && (
        <section className="bg-white border border-slate-200 rounded-xl p-6">
          <h2 className="text-base font-semibold text-slate-900 mb-1">
            Upload Excel file
          </h2>
          <p className="text-xs text-slate-500 mb-4">
            Use the Manager template:{" "}
            <code className="bg-slate-50 border border-slate-200 px-1.5 py-0.5 rounded font-mono text-[11px]">
              template-item-iap-google.xlsx
            </code>
          </p>

          <label
            htmlFor="bulk-upload-file"
            className="flex flex-col items-center gap-2 border-2 border-dashed border-slate-300 rounded-lg p-8 cursor-pointer hover:border-emerald-400 hover:bg-emerald-50/30 transition"
          >
            <Upload className="h-8 w-8 text-slate-400" strokeWidth={1.5} />
            {file ? (
              <div className="flex items-center gap-2">
                <FileSpreadsheet className="h-4 w-4 text-emerald-600" />
                <span className="text-sm font-medium text-slate-700">
                  {file.name}
                </span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    setFile(null);
                  }}
                  className="text-slate-400 hover:text-red-600 transition"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : (
              <>
                <p className="text-sm font-medium text-slate-700">
                  Click to select or drag in .xlsx
                </p>
                <p className="text-[11px] text-slate-400">
                  Max 5 MB
                </p>
              </>
            )}
            <input
              id="bulk-upload-file"
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="hidden"
            />
          </label>

          {uploadError && (
            <div className="mt-3 flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
              <span>{uploadError}</span>
            </div>
          )}

          <div className="mt-6 flex justify-between">
            <button
              onClick={() => setStep("pricing")}
              className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-lg transition"
            >
              <ChevronLeft className="h-4 w-4" />
              Back
            </button>
            <button
              onClick={handleUploadAndPreview}
              disabled={!file || uploading}
              className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg transition disabled:opacity-50"
            >
              {uploading ? "Parsing…" : "Preview"}
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </section>
      )}

      {/* Step 3: Preview */}
      {step === "preview" && (
        <section className="space-y-3">
          {/* Hotfix 19 — disambiguation banner (Q4.D). */}
          {tierStatus.ambiguous > 0 && (
            <TierBanner status={tierStatus} />
          )}

          <div className="bg-white border border-slate-200 rounded-xl p-4 flex items-center justify-between gap-3">
            <div className="flex items-center gap-4 text-xs text-slate-600">
              <span>
                Total: <strong className="text-slate-900">{counts.total}</strong>
              </span>
              <span>
                New:{" "}
                <strong className="text-emerald-700">{counts.willCreate}</strong>
              </span>
              <span>
                Existing: <strong className="text-amber-700">{counts.existing}</strong>
              </span>
              {counts.pending > 0 && (
                <span className="text-red-600">
                  Pending decisions: <strong>{counts.pending}</strong>
                </span>
              )}
              {tierStatus.ambiguous > 0 && (
                <span
                  className={
                    tierStatus.pending > 0
                      ? "ml-auto inline-flex items-center gap-1 text-amber-700"
                      : "ml-auto inline-flex items-center gap-1 text-blue-700"
                  }
                >
                  {tierStatus.pending > 0
                    ? `${tierStatus.pending} need${tierStatus.pending === 1 ? "s" : ""} selection`
                    : `${tierStatus.ambiguous} ambiguous · ${tierStatus.changed} changed`}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {counts.existing > 0 && (
                <>
                  <button
                    onClick={() => setAllExisting("overwrite")}
                    className="px-2 py-1 text-[11px] font-medium text-amber-700 border border-amber-200 hover:bg-amber-50 rounded transition"
                  >
                    Set all to Overwrite
                  </button>
                  <button
                    onClick={() => setAllExisting("skip")}
                    className="px-2 py-1 text-[11px] font-medium text-slate-700 border border-slate-200 hover:bg-slate-50 rounded transition"
                  >
                    Set all to Skip
                  </button>
                </>
              )}
            </div>
          </div>

          {previewWarnings.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
              <p className="text-xs font-medium text-amber-900 mb-1">
                Parse warnings ({previewWarnings.length})
              </p>
              <ul className="space-y-0.5 text-[11px] text-amber-800 max-h-32 overflow-y-auto">
                {previewWarnings.map((w, i) => (
                  <li key={i}>· {w}</li>
                ))}
              </ul>
            </div>
          )}

          {precisionViolations.length > 0 && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3">
              <p className="text-xs font-medium text-red-900 mb-1">
                {precisionViolations.length} row(s) violate their column
                currency&apos;s precision — Google will reject these. Fix the
                Excel file and re-upload, or remove the affected rows.
              </p>
              <ul className="space-y-0.5 text-[11px] text-red-800 max-h-32 overflow-y-auto">
                {precisionViolations.slice(0, 20).map((v) => (
                  <li key={v.rowNumber}>
                    · Row {v.rowNumber} ({v.sku}): {v.error}
                  </li>
                ))}
                {precisionViolations.length > 20 && (
                  <li className="italic text-red-700">
                    …and {precisionViolations.length - 20} more.
                  </li>
                )}
              </ul>
            </div>
          )}

          {executeError && (
            <div className="flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
              <span>{executeError}</span>
            </div>
          )}

          <PreviewTable
            rows={previewRows}
            onRowDecisionChange={setRowDecision}
            tierSelections={tierSelections}
            onTierSelectionChange={setRowTierSelection}
          />

          <div className="flex justify-between pt-2">
            <button
              onClick={() => setStep("upload")}
              className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-lg transition"
            >
              <ChevronLeft className="h-4 w-4" />
              Back
            </button>
            <button
              onClick={handleExecute}
              disabled={!canContinueFromPreview || executing}
              title={
                precisionViolations.length > 0
                  ? `${precisionViolations.length} row(s) violate per-row currency precision`
                  : tierStatus.pending > 0
                    ? `${tierStatus.pending} item${tierStatus.pending === 1 ? "" : "s"} need${tierStatus.pending === 1 ? "s" : ""} tier selection`
                    : !canContinueFromPreview
                      ? "Resolve all existing-SKU decisions first"
                      : ""
              }
              className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg transition disabled:opacity-50"
            >
              {tierStatus.pending > 0
                ? `Push to Google Play (${tierStatus.pending} item${tierStatus.pending === 1 ? "" : "s"} need${tierStatus.pending === 1 ? "s" : ""} selection)`
                : "Push to Google Play"}
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </section>
      )}

      {/* Step 4: Execute (transient) */}
      {step === "execute" && (
        <section className="bg-white border border-slate-200 rounded-xl p-10 text-center">
          <div className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-emerald-100 mb-3">
            <svg
              className="animate-spin h-5 w-5 text-emerald-600"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
              />
            </svg>
          </div>
          <p className="text-sm font-medium text-slate-900">
            Pushing to Google Play…
          </p>
          <p className="text-xs text-slate-500 mt-1">
            Single batchUpdate call · this may take several seconds.
          </p>
        </section>
      )}

      {/* Step 5: Done */}
      {step === "done" && executeResult && (
        <section className="bg-white border border-emerald-200 rounded-xl p-6">
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0 w-10 h-10 rounded-full bg-emerald-100 flex items-center justify-center">
              <CheckCircle2 className="h-5 w-5 text-emerald-600" />
            </div>
            <div className="flex-1">
              <h2 className="text-base font-semibold text-slate-900 mb-1">
                Bulk import complete
              </h2>
              <p className="text-xs text-slate-500 mb-3">
                {appDisplayName ?? packageName} · {executeResult.durationMs}ms
              </p>
              <div className="grid grid-cols-5 gap-2">
                <Stat label="Created" value={executeResult.rowsCreated} tone="emerald" />
                <Stat
                  label="Overwritten"
                  value={executeResult.rowsOverwritten}
                  tone="amber"
                />
                <Stat label="Skipped" value={executeResult.rowsSkipped} tone="slate" />
                <Stat label="Failed" value={executeResult.rowsFailed} tone="red" />
                {/* Cycle 43 — per-row cross-currency fail-soft refusals.
                    Distinct from "Failed" (Google-side errors): refused rows
                    were rejected by our pre-pass (unresolvable cross-currency)
                    and never sent to Google. */}
                <Stat
                  label="Refused"
                  value={executeResult.rowsRefused ?? 0}
                  tone="red"
                />
              </div>
              {executeResult.refusedRows && executeResult.refusedRows.length > 0 && (
                <div className="mt-3 bg-red-50 border border-red-200 rounded-lg p-3">
                  <p className="text-xs font-medium text-red-900 mb-1">
                    {executeResult.refusedRows.length} row(s) refused (per-row
                    fail-soft — not sent to Google):
                  </p>
                  <ul className="space-y-0.5 text-[11px] text-red-800 max-h-40 overflow-y-auto">
                    {executeResult.refusedRows.slice(0, 20).map((r) => (
                      <li key={`${r.rowNumber}-${r.sku}`}>
                        · Row {r.rowNumber} ({r.sku}): {r.reason}
                      </li>
                    ))}
                    {executeResult.refusedRows.length > 20 && (
                      <li className="italic text-red-700">
                        …and {executeResult.refusedRows.length - 20} more.
                      </li>
                    )}
                  </ul>
                </div>
              )}
              <div className="mt-6 flex gap-2">
                <button
                  onClick={() => {
                    router.push(
                      `/google-iap-management/apps/${encodeURIComponent(packageName)}`,
                    );
                    router.refresh();
                  }}
                  className="px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg transition"
                >
                  Back to IAPs
                </button>
                <button
                  onClick={() => {
                    setStep("pricing");
                    setFile(null);
                    setPreviewRows([]);
                    setPreviewWarnings([]);
                    setExecuteResult(null);
                  }}
                  className="px-3 py-2 text-sm font-medium text-slate-700 border border-slate-200 hover:bg-slate-50 rounded-lg transition"
                >
                  Import another
                </button>
              </div>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

/** Hotfix 28 — pure helper extracted from the wizard's
 *  `precisionViolations` memo so unit tests can pin per-row currency
 *  validation behaviour without rendering the whole wizard.
 *
 *  Validates each non-skipped row's `basePriceDecimal` against its own
 *  parser-resolved `baseCurrency`. The parser's currency comes from
 *  the column header ("Price (USD)" → USD) and falls back to
 *  appDefaultCurrency only for generic "Price" / "Default Price" /
 *  "Base Price" headers (excel-parser.ts:resolvePriceColumn). The
 *  caller's responsibility is to give us `previewRows` with
 *  `baseCurrency` already populated.
 *
 *  Skip-decision rows are excluded — they're not sent to Google so
 *  their numeric shape doesn't matter. */
export function computePrecisionViolations(
  previewRows: ReadonlyArray<PreviewRow>,
): Array<{ rowNumber: number; sku: string; error: string }> {
  const violations: Array<{ rowNumber: number; sku: string; error: string }> = [];
  for (const row of previewRows) {
    if (row.decision === "skip") continue;
    if (!row.baseCurrency) continue;
    // Cycle 43: cross-currency rows do NOT send the raw basePriceDecimal —
    // they either resolve via template (push uses the resolved app-currency
    // amount, not the raw USD anchor), need a chooser pick, or get refused
    // (per-row fail-soft, also doesn't send raw). In all three cases the
    // precision check doesn't apply because the raw value never reaches
    // Google. Only same-currency rows are precision-gated.
    const resolutionKind = row.resolution?.kind ?? "same_currency";
    if (resolutionKind !== "same_currency") continue;
    const err = validateDecimalForCurrency(row.basePriceDecimal, row.baseCurrency);
    if (err) {
      violations.push({ rowNumber: row.rowNumber, sku: row.sku, error: err });
    }
  }
  return violations;
}

function StepHeader({ step }: { step: Step }) {
  const steps: Array<{ key: Step; label: string }> = [
    { key: "pricing", label: "1. Pricing source" },
    { key: "upload", label: "2. Upload" },
    { key: "preview", label: "3. Preview" },
    { key: "done", label: "4. Done" },
  ];
  const activeIdx = (() => {
    if (step === "execute") return 3; // showing busy / about-to-finish
    return steps.findIndex((s) => s.key === step);
  })();
  return (
    <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
      {steps.map((s, i) => (
        <span
          key={s.key}
          className={
            i === activeIdx
              ? "px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 font-medium"
              : i < activeIdx
                ? "text-slate-400 line-through"
                : ""
          }
        >
          {s.label}
        </span>
      ))}
    </div>
  );
}

/** Hotfix 19 — disambiguation banner (Q4.D).
 *
 *  Two visual states:
 *    - pending > 0  → amber ⚠ "N items need tier selection"
 *    - pending == 0 → blue  ℹ "N ambiguous items pre-selected — review or change"
 *                            (or "...— X changed by you, Y at default" when overridden)
 *  Renders only when status.ambiguous > 0 — no banner in the zero-ambiguity case. */
function TierBanner({
  status,
}: {
  status: { ambiguous: number; pending: number; changed: number; atDefault: number };
}) {
  if (status.pending > 0) {
    return (
      <div className="bg-amber-50 border border-amber-300 rounded-xl p-4">
        <div className="flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-amber-600 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-sm font-semibold text-amber-900">
              {status.pending} item{status.pending === 1 ? "" : "s"} need{status.pending === 1 ? "s" : ""} tier selection.
            </p>
            <p className="text-xs text-amber-800 mt-1">
              Pick a tier for the highlighted row{status.pending === 1 ? "" : "s"} below before pushing.
            </p>
          </div>
        </div>
      </div>
    );
  }
  const headline =
    status.changed > 0
      ? `${status.ambiguous} ambiguous items — ${status.changed} changed by you, ${status.atDefault} at default.`
      : `${status.ambiguous} ambiguous item${status.ambiguous === 1 ? "" : "s"} pre-selected — review or change as needed.`;
  return (
    <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
      <div className="flex items-start gap-3">
        <svg
          className="h-5 w-5 text-blue-600 flex-shrink-0 mt-0.5"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
        <div className="flex-1">
          <p className="text-sm font-semibold text-blue-900">{headline}</p>
          <p className="text-xs text-blue-800 mt-1">
            Rows priced the same as multiple template tiers — pick the tier whose regional prices you
            want applied. The tool no longer auto-picks silently.
          </p>
        </div>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "emerald" | "amber" | "slate" | "red";
}) {
  const cls =
    tone === "emerald"
      ? "bg-emerald-50 text-emerald-800 border-emerald-200"
      : tone === "amber"
        ? "bg-amber-50 text-amber-800 border-amber-200"
        : tone === "red"
          ? "bg-red-50 text-red-800 border-red-200"
          : "bg-slate-50 text-slate-700 border-slate-200";
  return (
    <div className={`rounded-lg border p-2 ${cls}`}>
      <p className="text-2xl font-semibold tabular-nums">{value}</p>
      <p className="text-[10px] font-medium uppercase tracking-wide mt-0.5">
        {label}
      </p>
    </div>
  );
}
