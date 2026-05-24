"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useDropzone } from "react-dropzone";
import { toast } from "sonner";
import {
  Upload,
  FileSpreadsheet,
  CheckCircle,
  AlertCircle,
  XCircle,
  Loader2,
  ArrowRight,
  ArrowLeft,
  Play,
  Info,
  RefreshCw,
} from "lucide-react";
import { parseIapItemsXlsx } from "@/lib/iap-management/parsers/iap-items";
import type { ParsedIapItem, IapItemsParseResult } from "@/lib/iap-management/parsers/iap-items";
import {
  matchScreenshotToProductId,
  type ScreenshotMatchResult,
} from "@/lib/iap-management/parsers/screenshot-matcher";
import {
  resolveConflicts,
  enrichWithTiers,
  type ConflictMode,
  type ConflictDecision,
  type ResolveResult,
} from "@/lib/iap-management/bulk-import/conflict-resolution";
import { computeWillSubmitCount } from "@/lib/iap-management/bulk-import/will-submit";
import {
  bulkImportToastSeverity,
  hasNonRenewingSub,
} from "@/lib/iap-management/bulk-import/result-hints";
import {
  formatTierWithPrice,
  type UsdTierEntry,
} from "@/lib/iap-management/queries/price-tiers";
import {
  PricingSourceSelector,
  defaultPricingSource,
} from "@/components/iap-management/iap-form/PricingSourceSelector";
import type { PricingSourceKind } from "@/lib/iap-management/validation";

interface Props {
  appId: string;
  appName: string;
  existingProductIds: string[];
  usdTiers: UsdTierEntry[];
  /** IAP.p1.g: Manager-uploaded global Default Template availability. */
  defaultTemplateAvailable?: boolean;
  /** IAP.p1.g: this app has its own pricing template. */
  appTemplateAvailable?: boolean;
  defaultTemplateEntryCount?: number;
  appTemplateEntryCount?: number;
}

type Step = 1 | 2 | 3 | 4;

interface ScreenshotEntry {
  file: File;
  match: ScreenshotMatchResult;
}

interface RateLimitCounters {
  rate429_count: number;
  retry_attempts: number;
  backoff_total_ms: number;
  longest_backoff_ms: number;
}

interface ExecuteResult {
  batch_id: string;
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  results: Array<{
    product_id: string;
    status: "SUCCESS" | "ERROR" | "SKIPPED";
    disposition: string;
    apple_iap_id?: string;
    error?: string;
    stage?: string;
    failed_locales?: string[];
    screenshot_uploaded?: boolean;
    /** IAP.o.8a — OVERWRITE-only outcome for the screenshot path. */
    screenshot_note?:
      | "replaced"
      | "uploaded-new"
      | "no-file"
      | "delete-locked"
      | "failed";
    /** IAP.o.9a + IAP.o.10a — pricing schedule outcome (CREATE always,
     *  OVERWRITE only when resolved tier differs from cached). */
    price_schedule_set?: boolean;
    pricing_outcome?:
      | "set"
      | "partial-template-fail"
      | "skipped-no-tier"
      | "skipped-no-usd-price"
      | "skipped-no-match"
      | "skipped-not-ready"
      | "failed-lookup"
      | "failed-set"
      | "failed-exception";
    pricing_error?: string;
    submitted?: boolean;
    /** Hotfix 26 — per-row 429 telemetry attached by the route. Absent
     *  on rows that never touched Apple (SKIP / validation ERROR). */
    rate_limit?: RateLimitCounters;
  }>;
  /** Hotfix 26 — batch-level 429 telemetry roll-up. */
  rate_limit_total?: RateLimitCounters & { rows_throttled: number };
}

export function BulkImportWizard({
  appId,
  appName,
  existingProductIds,
  usdTiers,
  defaultTemplateAvailable = false,
  appTemplateAvailable = false,
  defaultTemplateEntryCount,
  appTemplateEntryCount,
}: Props) {
  const router = useRouter();
  const [step, setStep] = useState<Step>(1);
  // IAP.p1.g: batch-level pricing source (Q-E). Initialised to the most
  // specific available source per Q-D and applied to every CREATE/OVERWRITE
  // row in the execute call.
  const [pricingSource, setPricingSource] = useState<PricingSourceKind>(() =>
    defaultPricingSource(defaultTemplateAvailable, appTemplateAvailable),
  );
  const [excelFile, setExcelFile] = useState<File | null>(null);
  const [parsed, setParsed] = useState<IapItemsParseResult | null>(null);
  const [screenshots, setScreenshots] = useState<ScreenshotEntry[]>([]);
  const [conflictMode, setConflictMode] = useState<ConflictMode>("OVERWRITE");
  const [overrides, setOverrides] = useState<Record<string, ConflictMode>>({});
  /** Per-productId tier override (Manager IAP.o.5 Issue C). Wins over the
   *  auto-resolved tier from enrichWithTiers; surfaces to /execute as
   *  `tier_overrides` so the server applies the same picked tier. */
  const [tierOverrides, setTierOverrides] = useState<Record<string, string>>({});
  const [submitOnCreate, setSubmitOnCreate] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [result, setResult] = useState<ExecuteResult | null>(null);

  const existingSet = useMemo(
    () => new Set(existingProductIds),
    [existingProductIds],
  );

  const resolved: ResolveResult | null = useMemo(() => {
    if (!parsed) return null;
    const conflicts = resolveConflicts({
      parsed: parsed.items,
      existing_product_ids: existingSet,
      default_mode: conflictMode,
      overrides,
    });
    return enrichWithTiers(conflicts, usdTiers);
  }, [parsed, existingSet, conflictMode, overrides, usdTiers]);

  const typeColumnPopulated = useMemo(() => {
    if (!parsed) return { fromColumn: 0, defaulted: 0 };
    let fromColumn = 0;
    let defaulted = 0;
    for (const it of parsed.items) {
      if (it.type_source === "COLUMN") fromColumn++;
      else defaulted++;
    }
    return { fromColumn, defaulted };
  }, [parsed]);

  function toggleOverride(productId: string) {
    setOverrides((prev) => {
      const next = { ...prev };
      const current =
        next[productId] ?? conflictMode;
      next[productId] = current === "OVERWRITE" ? "SKIP" : "OVERWRITE";
      return next;
    });
  }

  async function handleExecute() {
    if (!excelFile || !resolved) return;
    setExecuting(true);
    try {
      const fd = new FormData();
      fd.append("excel", excelFile);
      for (const entry of screenshots) {
        fd.append(`screenshot:${entry.file.name}`, entry.file);
      }
      fd.append(
        "config",
        JSON.stringify({
          default_mode: conflictMode,
          overrides,
          tier_overrides: tierOverrides,
          submit_on_create: submitOnCreate,
          pricing_source: pricingSource,
        }),
      );

      const res = await fetch(
        `/api/iap-management/apps/${appId}/bulk-import/execute`,
        { method: "POST", body: fd },
      );
      const data = (await res.json()) as ExecuteResult | { error: string };
      if (!res.ok) {
        toast.error("error" in data ? data.error : `Execute failed (${res.status})`);
        return;
      }
      if ("succeeded" in data) {
        setResult(data);
        setStep(4);
        const msg = `${data.succeeded} created · ${data.skipped} skipped · ${data.failed} failed`;
        // IAP.o.7c — failed rows now escalate to error toast (previously
        // .warning, which Manager missed during MV30). Success path
        // unchanged when no rows failed.
        if (bulkImportToastSeverity(data) === "success") toast.success(msg);
        else toast.error(msg);
        router.refresh();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Network error");
    } finally {
      setExecuting(false);
    }
  }

  const tiersEmpty = usdTiers.length === 0;

  return (
    <div className="space-y-6">
      {tiersEmpty && (
        <div
          role="alert"
          className="rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 px-4 py-3 text-sm text-amber-900 dark:text-amber-200"
        >
          <p className="font-medium">No pricing tiers cached.</p>
          <p className="text-xs mt-0.5">
            Tier resolution requires the price-tier cache populated first.
            Bulk-import rows will downgrade to <span className="font-mono">ERROR</span>{" "}
            until tiers are imported via{" "}
            <a
              href="/iap-management/settings/pricing-tiers"
              className="underline hover:text-amber-700 dark:hover:text-amber-100"
            >
              Settings → Pricing Tiers
            </a>
            .
          </p>
        </div>
      )}

      <Stepper step={step} />

      {step === 1 && (
        <Step1Excel
          file={excelFile}
          parsed={parsed}
          typeColumnPopulated={typeColumnPopulated}
          onParsed={(file, parseResult) => {
            setExcelFile(file);
            setParsed(parseResult);
          }}
          onClear={() => {
            setExcelFile(null);
            setParsed(null);
          }}
        />
      )}

      {step === 2 && parsed && (
        <Step2Screenshots
          parsedItems={parsed.items}
          screenshots={screenshots}
          onAdd={(files) => {
            const candidateIds = parsed.items.map((i) => i.product_id);
            const next: ScreenshotEntry[] = files.map((file) => ({
              file,
              match: matchScreenshotToProductId(file.name, candidateIds),
            }));
            setScreenshots((prev) => {
              const seen = new Set(prev.map((p) => p.file.name));
              const dedup = next.filter((n) => !seen.has(n.file.name));
              return [...prev, ...dedup];
            });
          }}
          onRemove={(filename) =>
            setScreenshots((prev) => prev.filter((p) => p.file.name !== filename))
          }
        />
      )}

      {step === 3 && resolved && parsed && (
        <Step3Preview
          decisions={resolved.decisions}
          counts={resolved.counts}
          conflictMode={conflictMode}
          onConflictModeChange={setConflictMode}
          onToggleOverride={toggleOverride}
          overrides={overrides}
          existingSet={existingSet}
          screenshots={screenshots}
          submitOnCreate={submitOnCreate}
          onSubmitOnCreateChange={setSubmitOnCreate}
          parsedSkippedLocales={parsed.skipped_locales}
          usdTiers={usdTiers}
          tierOverrides={tierOverrides}
          pricingSource={pricingSource}
          onPricingSourceChange={setPricingSource}
          defaultTemplateAvailable={defaultTemplateAvailable}
          appTemplateAvailable={appTemplateAvailable}
          defaultTemplateEntryCount={defaultTemplateEntryCount}
          appTemplateEntryCount={appTemplateEntryCount}
          onTierOverride={(productId, tier_id) =>
            setTierOverrides((prev) => ({ ...prev, [productId]: tier_id }))
          }
        />
      )}

      {step === 4 && result && (
        <Step4Result
          result={result}
          appId={appId}
          appName={appName}
          batchHasNrs={parsed ? hasNonRenewingSub(parsed.items) : false}
          pricingSource={pricingSource}
        />
      )}

      {/* Navigation */}
      <div className="flex items-center justify-between pt-2">
        <button
          type="button"
          onClick={() => setStep((s) => (s > 1 ? ((s - 1) as Step) : s))}
          disabled={step === 1 || step === 4 || executing}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-slate-500 hover:text-slate-700 disabled:opacity-40 transition"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </button>

        {step < 3 && (
          <button
            type="button"
            onClick={() => setStep((s) => ((s + 1) as Step))}
            disabled={(step === 1 && !parsed) || executing}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-[#0071E3] hover:bg-[#0077ED] text-white rounded-lg transition disabled:opacity-40"
          >
            Next
            <ArrowRight className="h-4 w-4" />
          </button>
        )}

        {step === 3 && (
          <button
            type="button"
            onClick={handleExecute}
            disabled={executing || !resolved || resolved.counts.create + resolved.counts.overwrite === 0}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-[#0071E3] hover:bg-[#0077ED] text-white rounded-lg transition disabled:opacity-40"
          >
            {executing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Play className="h-4 w-4" />
            )}
            {executing
              ? "Importing…"
              : `Execute (${(resolved?.counts.create ?? 0) + (resolved?.counts.overwrite ?? 0)} IAPs)`}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Stepper ────────────────────────────────────────────────────────────────

function Stepper({ step }: { step: Step }) {
  const labels = ["Excel", "Screenshots", "Preview", "Result"];
  return (
    <div className="flex items-center gap-2">
      {labels.map((label, idx) => {
        const n = (idx + 1) as Step;
        const active = step === n;
        const done = step > n;
        return (
          <div key={label} className="flex items-center gap-2">
            <div
              className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold transition ${
                done
                  ? "bg-emerald-500 text-white"
                  : active
                    ? "bg-[#0071E3] text-white"
                    : "bg-slate-200 text-slate-500"
              }`}
            >
              {done ? "✓" : n}
            </div>
            <span
              className={`text-xs ${active ? "font-medium text-slate-900" : "text-slate-500"}`}
            >
              {label}
            </span>
            {n < 4 && (
              <span className="h-px w-8 bg-slate-200 ml-1" aria-hidden />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Step 1: Excel ──────────────────────────────────────────────────────────

function Step1Excel({
  file,
  parsed,
  typeColumnPopulated,
  onParsed,
  onClear,
}: {
  file: File | null;
  parsed: IapItemsParseResult | null;
  typeColumnPopulated: { fromColumn: number; defaulted: number };
  onParsed: (file: File, result: IapItemsParseResult) => void;
  onClear: () => void;
}) {
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    accept: {
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
    },
    multiple: false,
    onDrop: async (accepted) => {
      const f = accepted[0];
      if (!f) return;
      setParsing(true);
      setError(null);
      try {
        const result = await parseIapItemsXlsx(f);
        onParsed(f, result);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Parse failed");
      } finally {
        setParsing(false);
      }
    },
  });

  return (
    <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6">
      <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-1">
        Step 1 — Upload Excel template
      </h2>
      <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
        Drop the Manager-provided item-iap-template.xlsx. Headers validated
        strictly (Q-IAP.5).
      </p>

      {!parsed && (
        <div
          {...getRootProps()}
          className={`rounded-lg border-2 border-dashed p-10 text-center cursor-pointer transition ${
            isDragActive
              ? "border-[#0071E3] bg-blue-50"
              : parsing
                ? "border-slate-300 bg-slate-50 cursor-wait"
                : "border-slate-300 hover:border-slate-400 bg-slate-50"
          }`}
        >
          <input {...getInputProps()} />
          {parsing ? (
            <Loader2 className="mx-auto h-7 w-7 text-[#0071E3] mb-2 animate-spin" />
          ) : (
            <FileSpreadsheet className="mx-auto h-7 w-7 text-slate-400 mb-2" />
          )}
          <p className="text-sm font-medium text-slate-700">
            {parsing
              ? "Parsing…"
              : isDragActive
                ? "Drop the .xlsx here"
                : "Drag & drop or click to select an .xlsx"}
          </p>
          <p className="text-[11px] text-slate-400 mt-1">
            Strict header validation per IAP.e parsers.
          </p>
        </div>
      )}

      {parsed && file && (
        <div className="border border-emerald-200 bg-emerald-50 rounded-lg p-4">
          <div className="flex items-center gap-3 mb-2">
            <CheckCircle className="h-5 w-5 text-emerald-600" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-emerald-800 truncate">
                {file.name}
              </p>
              <p className="text-[11px] text-emerald-700">
                {parsed.items.length} IAPs · {parsed.locale_pair_count} locale pairs detected
              </p>
            </div>
            <button
              type="button"
              onClick={onClear}
              className="text-[11px] text-emerald-700 hover:underline"
            >
              Replace
            </button>
          </div>
          <p className="mt-1 text-[11px] text-emerald-700">
            Type source: <strong>{typeColumnPopulated.fromColumn}</strong> from
            column, <strong>{typeColumnPopulated.defaulted}</strong> defaulted
            to Consumable.
          </p>
          {parsed.warnings.length > 0 && (
            <div className="mt-2 text-[11px] text-amber-700">
              {parsed.warnings.length} parse warning(s) — open with caution.
            </div>
          )}
        </div>
      )}

      {error && (
        <p className="mt-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
          {error}
        </p>
      )}
    </section>
  );
}

// ─── Step 2: Screenshots ────────────────────────────────────────────────────

function Step2Screenshots({
  parsedItems,
  screenshots,
  onAdd,
  onRemove,
}: {
  parsedItems: ParsedIapItem[];
  screenshots: ScreenshotEntry[];
  onAdd: (files: File[]) => void;
  onRemove: (filename: string) => void;
}) {
  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    accept: { "image/png": [".png"], "image/jpeg": [".jpg", ".jpeg"] },
    multiple: true,
    onDrop: onAdd,
  });

  const matchedProductIds = new Set(
    screenshots
      .filter((s) => s.match.kind === "matched")
      .map((s) =>
        s.match.kind === "matched" ? s.match.productId : "",
      ),
  );
  const unmatchedFiles = screenshots.filter((s) => s.match.kind !== "matched");
  const productsWithoutScreenshot = parsedItems
    .map((i) => i.product_id)
    .filter((id) => !matchedProductIds.has(id));

  return (
    <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6">
      <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-1">
        Step 2 — Upload review screenshots
      </h2>
      <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
        Multi-file drop. Filenames auto-match to productId — both literal and
        dots-as-underscores forms accepted (Q-IAP convention C).
      </p>

      <div
        {...getRootProps()}
        className={`rounded-lg border-2 border-dashed p-8 text-center cursor-pointer transition mb-4 ${
          isDragActive
            ? "border-[#0071E3] bg-blue-50"
            : "border-slate-300 hover:border-slate-400 bg-slate-50"
        }`}
      >
        <input {...getInputProps()} />
        <Upload className="mx-auto h-7 w-7 text-slate-400 mb-2" />
        <p className="text-sm font-medium text-slate-700">
          {isDragActive
            ? "Drop screenshots here"
            : "Drag & drop screenshots or click to select"}
        </p>
        <p className="text-[11px] text-slate-400 mt-1">
          PNG/JPEG · multi-file
        </p>
      </div>

      <div className="grid grid-cols-3 gap-4 text-xs">
        <Tally label="Matched" value={matchedProductIds.size} color="emerald" />
        <Tally
          label="Unmatched"
          value={unmatchedFiles.length}
          color="amber"
        />
        <Tally
          label="Missing"
          value={productsWithoutScreenshot.length}
          color="slate"
        />
      </div>

      {screenshots.length > 0 && (
        <div className="mt-4 max-h-72 overflow-y-auto border border-slate-200 rounded-lg">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-800 sticky top-0">
              <tr className="text-left text-[10px] uppercase text-slate-500 dark:text-slate-400 tracking-wide">
                <th className="px-3 py-2">Filename</th>
                <th className="px-3 py-2">Matched ProductId</th>
                <th className="px-3 py-2 w-20">Method</th>
                <th className="px-3 py-2 w-10"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {screenshots.map((s) => (
                <tr key={s.file.name} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                  <td className="px-3 py-2 font-mono text-[11px] truncate max-w-[260px]">
                    {s.file.name}
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px] text-slate-700">
                    {s.match.kind === "matched"
                      ? s.match.productId
                      : s.match.kind === "ambiguous"
                        ? `Ambiguous (${s.match.candidates.length})`
                        : "—"}
                  </td>
                  <td className="px-3 py-2 text-[10px] text-slate-500">
                    {s.match.kind === "matched" ? s.match.method : s.match.kind}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => onRemove(s.file.name)}
                      className="text-slate-400 hover:text-red-500 transition"
                      aria-label="Remove"
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Tally({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: "emerald" | "amber" | "slate";
}) {
  const colorClass =
    color === "emerald"
      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
      : color === "amber"
        ? "border-amber-200 bg-amber-50 text-amber-700"
        : "border-slate-200 bg-slate-50 text-slate-500";
  return (
    <div className={`border rounded-lg p-3 ${colorClass}`}>
      <p className="text-[10px] uppercase tracking-wide opacity-80">{label}</p>
      <p className="text-lg font-semibold mt-0.5">{value}</p>
    </div>
  );
}

// ─── Step 3: Preview ────────────────────────────────────────────────────────

function Step3Preview({
  decisions,
  counts,
  conflictMode,
  onConflictModeChange,
  onToggleOverride,
  overrides,
  existingSet,
  screenshots,
  submitOnCreate,
  onSubmitOnCreateChange,
  parsedSkippedLocales,
  usdTiers,
  tierOverrides,
  onTierOverride,
  pricingSource,
  onPricingSourceChange,
  defaultTemplateAvailable,
  appTemplateAvailable,
  defaultTemplateEntryCount,
  appTemplateEntryCount,
}: {
  decisions: ConflictDecision[];
  counts: ResolveResult["counts"];
  conflictMode: ConflictMode;
  onConflictModeChange: (m: ConflictMode) => void;
  onToggleOverride: (productId: string) => void;
  overrides: Record<string, ConflictMode>;
  existingSet: Set<string>;
  screenshots: ScreenshotEntry[];
  submitOnCreate: boolean;
  onSubmitOnCreateChange: (v: boolean) => void;
  parsedSkippedLocales: string[];
  usdTiers: UsdTierEntry[];
  tierOverrides: Record<string, string>;
  onTierOverride: (productId: string, tier_id: string) => void;
  pricingSource: PricingSourceKind;
  onPricingSourceChange: (next: PricingSourceKind) => void;
  defaultTemplateAvailable: boolean;
  appTemplateAvailable: boolean;
  defaultTemplateEntryCount?: number;
  appTemplateEntryCount?: number;
}) {
  const matchedProductIds = new Set(
    screenshots
      .filter((s) => s.match.kind === "matched")
      .map((s) => (s.match.kind === "matched" ? s.match.productId : "")),
  );
  const willSubmitCount = computeWillSubmitCount(
    decisions,
    matchedProductIds,
    submitOnCreate,
  );
  return (
    <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6">
      <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-1">
        Step 3 — Preview &amp; conflict resolution
      </h2>
      <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
        Toggle per-row to override the global conflict policy. Validation
        errors are excluded and cannot be retried — fix the source data.
      </p>

      {/* Counts */}
      <div className="grid grid-cols-4 gap-3 mb-4 text-xs">
        <Tally label="Create" value={counts.create} color="emerald" />
        <Tally label="Overwrite" value={counts.overwrite} color="amber" />
        <Tally label="Skip" value={counts.skip} color="slate" />
        <Tally label="Error" value={counts.error} color="amber" />
      </div>

      {/* Outcome bifurcation — only show when the Create bucket is non-empty
          so unrelated bulk-only flows (e.g. all-overwrite) don't see noise. */}
      {counts.create > 0 && (
        <div className="grid grid-cols-2 gap-3 mb-4 text-xs">
          <Tally
            label="Will create only"
            value={counts.create - willSubmitCount}
            color="slate"
          />
          <Tally
            label="Will create + submit"
            value={willSubmitCount}
            color="emerald"
          />
        </div>
      )}

      {/* Global toggles */}
      <div className="flex items-center gap-6 mb-4">
        <div className="flex items-center gap-2">
          <label className="text-xs font-medium text-slate-700">
            Conflict policy:
          </label>
          <select
            value={conflictMode}
            onChange={(e) =>
              onConflictModeChange(e.target.value as ConflictMode)
            }
            className="rounded-md border border-slate-200 px-2 py-1 text-xs"
          >
            <option value="OVERWRITE">Overwrite</option>
            <option value="SKIP">Skip</option>
          </select>
        </div>
        <label className="flex items-center gap-2 text-xs text-slate-700">
          <input
            type="checkbox"
            checked={submitOnCreate}
            onChange={(e) => onSubmitOnCreateChange(e.target.checked)}
          />
          Submit to Apple Review after create
        </label>
      </div>

      {/* IAP.p1.g: batch-level pricing source (Q-E applies to every row) */}
      <div className="mb-4">
        <PricingSourceSelector
          value={pricingSource}
          onChange={onPricingSourceChange}
          defaultTemplateAvailable={defaultTemplateAvailable}
          appTemplateAvailable={appTemplateAvailable}
          defaultTemplateEntryCount={defaultTemplateEntryCount}
          appTemplateEntryCount={appTemplateEntryCount}
        />
      </div>

      {parsedSkippedLocales.length > 0 && (
        <p className="text-[11px] text-amber-700 mb-3">
          Unrecognised locale columns skipped: {parsedSkippedLocales.join(", ")}
        </p>
      )}

      <div className="border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden max-h-[420px] overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-800 sticky top-0">
            <tr className="text-left text-[10px] uppercase text-slate-500 dark:text-slate-400 tracking-wide">
              <th className="px-3 py-2">Product ID</th>
              <th className="px-3 py-2">Reference Name</th>
              <th className="px-3 py-2 w-32">Type</th>
              <th className="px-3 py-2 w-24">Tier</th>
              <th className="px-3 py-2 w-14">Loc</th>
              <th className="px-3 py-2 w-14">Scr</th>
              <th className="px-3 py-2 w-24">Disposition</th>
              <th className="px-3 py-2 w-20">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {decisions.map((d) => {
              const localesFilled = d.source.localizations.length;
              const screenshotPresent = matchedProductIds.has(d.product_id);
              const isConflict = existingSet.has(d.product_id);
              const overridden = overrides[d.product_id];
              return (
                <tr key={d.product_id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                  <td className="px-3 py-2 font-mono text-[11px] text-slate-700">
                    {d.product_id}
                  </td>
                  <td className="px-3 py-2 truncate max-w-[200px]">
                    {d.source.reference_name}
                  </td>
                  <td className="px-3 py-2 text-[11px]">
                    <span className="text-slate-700">
                      {d.source.type.replace(/_/g, " ").toLowerCase()}
                    </span>
                    <span
                      className={`ml-1.5 text-[9px] px-1 py-0.5 rounded ${
                        d.source.type_source === "COLUMN"
                          ? "bg-blue-50 text-blue-700"
                          : "bg-slate-100 text-slate-500"
                      }`}
                    >
                      {d.source.type_source.toLowerCase()}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-[11px]">
                    <TierCell
                      productId={d.product_id}
                      priceUsd={d.source.price_usd}
                      autoTierId={d.resolved_tier_id ?? null}
                      overrideTierId={tierOverrides[d.product_id]}
                      usdTiers={usdTiers}
                      onChange={(t) => onTierOverride(d.product_id, t)}
                    />
                  </td>
                  <td className="px-3 py-2 text-center">{localesFilled}</td>
                  <td className="px-3 py-2 text-center">
                    {screenshotPresent ? (
                      <CheckCircle className="h-3.5 w-3.5 text-emerald-600 inline" />
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <DispositionBadge disposition={d.disposition} />
                  </td>
                  <td className="px-3 py-2">
                    {isConflict && d.disposition !== "ERROR" ? (
                      <button
                        type="button"
                        onClick={() => onToggleOverride(d.product_id)}
                        className="text-[11px] text-[#0071E3] hover:underline"
                      >
                        {overridden ?? conflictMode}
                      </button>
                    ) : (
                      <span className="text-[10px] text-slate-300">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * Per-row tier cell (Manager IAP.o.5 Issue C). Shows the auto-resolved tier
 * with its USD price ("Tier 1 ($0.99)") and, when 2+ tiers share the same
 * USD price (theoretical e.g. TIER_5 vs ALT_5 both at $4.99), surfaces a
 * dropdown so Manager can pick the intended tier. Override persists into
 * `tier_overrides` config sent to /execute.
 */
function TierCell({
  priceUsd,
  autoTierId,
  overrideTierId,
  usdTiers,
  onChange,
}: {
  productId: string;
  priceUsd: number;
  autoTierId: string | null;
  overrideTierId: string | undefined;
  usdTiers: UsdTierEntry[];
  onChange: (tier_id: string) => void;
}) {
  // Candidates = all tiers matching the row's price.
  const candidates = useMemo(() => {
    if (priceUsd === 0) {
      return usdTiers.filter((t) => t.tier_id === "FREE");
    }
    return usdTiers.filter((t) => t.customer_price === priceUsd);
  }, [priceUsd, usdTiers]);

  const selected = overrideTierId ?? autoTierId;
  const ambiguous = candidates.length > 1;

  if (!selected) {
    return <span className="text-amber-600 dark:text-amber-400">—</span>;
  }

  if (!ambiguous) {
    return (
      <span className="font-mono text-slate-700 dark:text-slate-300">
        {formatTierWithPrice(selected, priceUsd)}
      </span>
    );
  }

  return (
    <select
      value={selected}
      onChange={(e) => onChange(e.target.value)}
      className={`w-full text-[11px] font-mono rounded border px-1.5 py-0.5 transition ${
        overrideTierId
          ? "border-[#0071E3] bg-blue-50 dark:bg-blue-950/40 text-[#0071E3]"
          : "border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 text-amber-900 dark:text-amber-200"
      }`}
      title={`Same USD price matches ${candidates.length} tiers — pick one`}
    >
      {candidates.map((c) => (
        <option key={c.tier_id} value={c.tier_id}>
          {formatTierWithPrice(c.tier_id, c.customer_price)}
        </option>
      ))}
    </select>
  );
}

function DispositionBadge({ disposition }: { disposition: string }) {
  const colors: Record<string, string> = {
    CREATE: "bg-emerald-50 text-emerald-700 border-emerald-200",
    OVERWRITE: "bg-amber-50 text-amber-700 border-amber-200",
    SKIP: "bg-slate-100 text-slate-600 border-slate-200",
    ERROR: "bg-red-50 text-red-700 border-red-200",
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border ${colors[disposition] ?? colors.SKIP}`}
    >
      {disposition.toLowerCase()}
    </span>
  );
}

// ─── Step 4: Result ─────────────────────────────────────────────────────────

function Step4Result({
  result,
  appId,
  appName,
  batchHasNrs,
  pricingSource,
}: {
  result: ExecuteResult;
  appId: string;
  appName: string;
  batchHasNrs: boolean;
  pricingSource: PricingSourceKind;
}) {
  // IAP.o.7c — auto-scroll to the first ERROR row when the batch had any
  // failures. Manager MV30 surfaced that warning toasts + small "Failed"
  // tally counters are easy to miss; the table is 420px scrollable so
  // failures past the fold went unnoticed. Scroll-into-view of the first
  // failure row + the escalated error toast together make failures
  // unmissable.
  const firstErrorRef = useRef<HTMLTableRowElement | null>(null);
  useEffect(() => {
    if (result.failed > 0 && firstErrorRef.current) {
      firstErrorRef.current.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [result.failed]);

  const [refreshing, setRefreshing] = useState(false);
  async function handleRefresh() {
    setRefreshing(true);
    try {
      const res = await fetch(
        `/api/iap-management/apps/${appId}/iaps/sync-states`,
        { method: "POST" },
      );
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        toast.error(data.error ?? `Refresh failed (${res.status})`);
        return;
      }
      const data = (await res.json()) as {
        synced_count: number;
        inserted_count?: number;
        updated_count?: number;
        errors: string[];
      };
      const parts: string[] = [];
      if (data.inserted_count && data.inserted_count > 0) {
        parts.push(`${data.inserted_count} discovered`);
      }
      if (data.updated_count && data.updated_count > 0) {
        parts.push(`${data.updated_count} state changed`);
      }
      const summary =
        parts.length > 0 ? parts.join(" · ") : `${data.synced_count} refreshed`;
      if (data.errors && data.errors.length > 0) {
        toast.warning(`${summary} · ${data.errors.length} error(s).`);
      } else {
        toast.success(summary);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Network error");
    } finally {
      setRefreshing(false);
    }
  }

  let firstErrorSeen = false;

  return (
    <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-1">
            Step 4 — Result
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Batch{" "}
            <span className="font-mono text-slate-700">{result.batch_id}</span>{" "}
            completed. Audit rows written to{" "}
            <span className="font-mono">iap_mgmt.actions_log</span>.
          </p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
            Pricing source applied:{" "}
            <span className="font-mono text-slate-700 dark:text-slate-300">
              {pricingSource === "APPLE"
                ? "Apple base"
                : pricingSource === "DEFAULT_TEMPLATE"
                  ? "Default template"
                  : "App-specific template"}
            </span>
          </p>
        </div>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={refreshing}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg transition disabled:opacity-50 flex-shrink-0"
          title="Re-fetch state from Apple to verify ground truth"
        >
          {refreshing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          Refresh from Apple
        </button>
      </div>

      {batchHasNrs && result.succeeded > 0 && (
        <div
          role="note"
          className="mb-4 flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900"
        >
          <Info className="h-4 w-4 flex-shrink-0 mt-0.5" />
          <p>
            <span className="font-medium">NON_RENEWING_SUBSCRIPTION items</span>{" "}
            appear in Apple Connect&apos;s{" "}
            <span className="font-medium">Subscriptions</span> tab, not the{" "}
            <span className="font-medium">In-App Purchases</span> tab. If
            successful rows look missing in App Store Connect, check both tabs.
          </p>
        </div>
      )}

      <div className="grid grid-cols-3 gap-3 mb-4">
        <Tally label="Succeeded" value={result.succeeded} color="emerald" />
        <Tally label="Skipped" value={result.skipped} color="slate" />
        <Tally label="Failed" value={result.failed} color="amber" />
      </div>

      {/* Hotfix 26 — Apple rate-limit chip. Renders only when Apple
          actually throttled this batch; suppressed for clean runs so
          the summary stays tight. */}
      {result.rate_limit_total &&
        result.rate_limit_total.rate429_count > 0 && (
          <div className="mb-4 rounded-lg border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/20 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
            <p className="font-medium">
              Apple ASC throttled this batch — every row recovered via
              exponential backoff.
            </p>
            <p className="text-[11px] mt-0.5 text-amber-700 dark:text-amber-300/80">
              {result.rate_limit_total.rows_throttled} of {result.total} rows
              hit 429 · {result.rate_limit_total.rate429_count} retries total
              · {Math.round(result.rate_limit_total.backoff_total_ms / 1000)}s
              cumulative backoff · longest{" "}
              {Math.round(result.rate_limit_total.longest_backoff_ms / 1000)}s.
            </p>
          </div>
        )}

      <div className="border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden max-h-[420px] overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-800 sticky top-0">
            <tr className="text-left text-[10px] uppercase text-slate-500 dark:text-slate-400 tracking-wide">
              <th className="px-3 py-2">Product ID</th>
              <th className="px-3 py-2 w-24">Status</th>
              <th className="px-3 py-2 w-24">Disposition</th>
              <th className="px-3 py-2 w-32">Outcome</th>
              <th className="px-3 py-2 w-28">Price</th>
              <th className="px-3 py-2">Notes</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {result.results.map((r) => {
              const isError = r.status === "ERROR";
              const attachRef = isError && !firstErrorSeen;
              if (attachRef) firstErrorSeen = true;
              return (
                <tr
                  key={r.product_id}
                  ref={attachRef ? firstErrorRef : undefined}
                  className="hover:bg-slate-50 dark:hover:bg-slate-800/50"
                >
                  <td className="px-3 py-2 font-mono text-[11px] text-slate-700">
                    {r.product_id}
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="px-3 py-2 text-[11px] text-slate-600">
                    {r.disposition.toLowerCase()}
                  </td>
                  <td className="px-3 py-2">
                    <OutcomeBadge result={r} />
                  </td>
                  <td className="px-3 py-2">
                    <PriceBadge result={r} />
                  </td>
                  <td className="px-3 py-2 text-[11px] text-slate-500">
                    {r.error
                      ? `${r.stage ?? ""}: ${r.error.slice(0, 120)}`
                      : r.failed_locales && r.failed_locales.length > 0
                        ? `Failed locales: ${r.failed_locales.join(", ")}`
                        : r.screenshot_note === "delete-locked"
                          ? "Apple wouldn't let us swap the screenshot — IAP is in review or approved. Swap manually in App Store Connect."
                          : r.screenshot_note === "failed"
                            ? "Screenshot upload failed — check the file and re-run the import row."
                            : r.apple_iap_id
                              ? `apple_iap_id ${r.apple_iap_id.slice(0, 12)}…`
                              : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex justify-end">
        <a
          href={`/iap-management/apps/${appId}`}
          className="px-4 py-2 text-sm font-medium bg-[#0071E3] hover:bg-[#0077ED] text-white rounded-lg transition"
        >
          Back to {appName || "app"} IAPs
        </a>
      </div>
    </section>
  );
}

function OutcomeBadge({
  result,
}: {
  result: ExecuteResult["results"][number];
}) {
  if (result.status !== "SUCCESS") {
    return <span className="text-[10px] text-slate-300">—</span>;
  }
  // For overwrite path: no submission, but localizations replaced.
  if (result.disposition === "OVERWRITE") {
    // IAP.o.8a — Manager MV30 Issue 1: silent screenshot deferral was the
    // critical loss. The badge now suffixes the screenshot outcome so the
    // happy and locked/failed paths can't be mistaken for each other.
    const note = result.screenshot_note;
    let suffix = "";
    let cls = "bg-amber-50 text-amber-700 border-amber-200";
    if (note === "replaced" || note === "uploaded-new") {
      suffix = " · screenshot updated";
      cls = "bg-emerald-50 text-emerald-700 border-emerald-200";
    } else if (note === "delete-locked") {
      suffix = " · screenshot locked";
      cls = "bg-orange-50 text-orange-700 border-orange-200";
    } else if (note === "failed") {
      suffix = " · screenshot failed";
      cls = "bg-red-50 text-red-700 border-red-200";
    }
    return (
      <span
        className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border ${cls}`}
      >
        Overwritten{suffix}
      </span>
    );
  }
  // Create path: bifurcate by submitted state.
  if (result.submitted) {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border bg-emerald-50 text-emerald-700 border-emerald-200">
        Created + submitted
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border bg-slate-100 text-slate-600 border-slate-200">
      Created only
    </span>
  );
}

/**
 * IAP.o.9a — surfaces the pricing schedule outcome per row. The OVERWRITE
 * path may have `pricing_outcome` absent (cached tier matched, no re-apply
 * needed) — we render a neutral "Unchanged" pill so Manager isn't left
 * guessing whether pricing was attempted.
 */
function PriceBadge({
  result,
}: {
  result: ExecuteResult["results"][number];
}) {
  if (result.status !== "SUCCESS") {
    return <span className="text-[10px] text-slate-300">—</span>;
  }
  const outcome = result.pricing_outcome;
  if (!outcome) {
    return (
      <span
        className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border bg-slate-50 text-slate-500 border-slate-200"
        title="Local tier matches Apple — no re-apply needed."
      >
        Unchanged
      </span>
    );
  }
  if (outcome === "set") {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border bg-emerald-50 text-emerald-700 border-emerald-200">
        Price set
      </span>
    );
  }
  if (outcome === "skipped-no-tier") {
    return (
      <span
        className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border bg-slate-100 text-slate-600 border-slate-200"
        title="Row had no resolved tier — Apple defaults apply."
      >
        No tier
      </span>
    );
  }
  // IAP.o.11a Q-F: pricing failures escalate to red error severity. Before,
  // "No USD" and "No match" rendered amber (warning); Manager surfaced these
  // as easy-to-miss in Step 4 results, which was the v4 silent-symptom.
  if (outcome === "skipped-no-usd-price") {
    return (
      <span
        className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border bg-red-50 text-red-700 border-red-200"
        title="Tier isn't in the local USA/USD cache. Re-import pricing tiers from Settings, or set the price manually in App Store Connect."
      >
        No USD
      </span>
    );
  }
  if (outcome === "skipped-no-match") {
    return (
      <span
        className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border bg-red-50 text-red-700 border-red-200"
        title="Local USD price didn't match any Apple price point — set manually in App Store Connect."
      >
        No match
      </span>
    );
  }
  if (outcome === "skipped-not-ready") {
    return (
      <span
        className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border bg-red-50 text-red-700 border-red-200"
        title="Apple IAP wasn't ready for pricing within the poll window — set manually in App Store Connect."
      >
        Not ready
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border bg-red-50 text-red-700 border-red-200"
      title={result.pricing_error ?? "Apple rejected the price schedule."}
    >
      Price failed
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { cls: string; icon: typeof CheckCircle }> = {
    SUCCESS: {
      cls: "bg-emerald-50 text-emerald-700 border-emerald-200",
      icon: CheckCircle,
    },
    SKIPPED: {
      cls: "bg-slate-100 text-slate-600 border-slate-200",
      icon: AlertCircle,
    },
    ERROR: {
      cls: "bg-red-50 text-red-700 border-red-200",
      icon: XCircle,
    },
  };
  const conf = map[status] ?? map.SKIPPED;
  const Icon = conf.icon;
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border ${conf.cls}`}
    >
      <Icon className="h-3 w-3" />
      {status.toLowerCase()}
    </span>
  );
}

