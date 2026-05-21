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

export interface PreviewRow {
  rowNumber: number;
  sku: string;
  baseCurrency: string;
  basePriceDecimal: string;
  regionOverrides: PreviewRegionOverride[];
  listings: PreviewListing[];
  exists: boolean;
  decision: RowDecision;
}

interface ExecuteResult {
  rowsTotal: number;
  rowsCreated: number;
  rowsOverwritten: number;
  rowsSkipped: number;
  rowsFailed: number;
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

  async function handleUploadAndPreview() {
    if (!file) return;
    setUploadError(null);
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
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
        decision: r.exists ? "create" : "create",
      }));
      setPreviewRows(rows);
      setPreviewWarnings(body.warnings ?? []);
      setStep("preview");
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
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
              // Hotfix 4: stamp the app's configured currency. Excel
              // template column is named "Price (USD)" but the numeric
              // value is interpreted in the app's currency (Google
              // enforces app-wide consistency).
              baseCurrency: appDefaultCurrency ?? r.baseCurrency,
              basePriceDecimal: r.basePriceDecimal,
              regionOverrides: r.regionOverrides,
              listings: r.listings,
              decision: r.decision,
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

  const canContinueFromPreview = counts.pending === 0 && previewRows.length > 0;

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

          {executeError && (
            <div className="flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
              <span>{executeError}</span>
            </div>
          )}

          <PreviewTable rows={previewRows} onRowDecisionChange={setRowDecision} />

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
                !canContinueFromPreview
                  ? "Resolve all existing-SKU decisions first"
                  : ""
              }
              className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg transition disabled:opacity-50"
            >
              Push to Google Play
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
              <div className="grid grid-cols-4 gap-2">
                <Stat label="Created" value={executeResult.rowsCreated} tone="emerald" />
                <Stat
                  label="Overwritten"
                  value={executeResult.rowsOverwritten}
                  tone="amber"
                />
                <Stat label="Skipped" value={executeResult.rowsSkipped} tone="slate" />
                <Stat label="Failed" value={executeResult.rowsFailed} tone="red" />
              </div>
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
