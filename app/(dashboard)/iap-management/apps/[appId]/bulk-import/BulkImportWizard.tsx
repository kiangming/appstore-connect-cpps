"use client";

import { useMemo, useState } from "react";
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
} from "lucide-react";
import { parseIapItemsXlsx } from "@/lib/iap-management/parsers/iap-items";
import type { ParsedIapItem, IapItemsParseResult } from "@/lib/iap-management/parsers/iap-items";
import {
  matchScreenshotToProductId,
  type ScreenshotMatchResult,
} from "@/lib/iap-management/parsers/screenshot-matcher";
import {
  resolveConflicts,
  type ConflictMode,
  type ConflictDecision,
  type ResolveResult,
} from "@/lib/iap-management/bulk-import/conflict-resolution";

interface Props {
  appId: string;
  appName: string;
  existingProductIds: string[];
}

type Step = 1 | 2 | 3 | 4;

interface ScreenshotEntry {
  file: File;
  match: ScreenshotMatchResult;
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
    submitted?: boolean;
  }>;
}

export function BulkImportWizard({
  appId,
  appName,
  existingProductIds,
}: Props) {
  const router = useRouter();
  const [step, setStep] = useState<Step>(1);
  const [excelFile, setExcelFile] = useState<File | null>(null);
  const [parsed, setParsed] = useState<IapItemsParseResult | null>(null);
  const [screenshots, setScreenshots] = useState<ScreenshotEntry[]>([]);
  const [conflictMode, setConflictMode] = useState<ConflictMode>("OVERWRITE");
  const [overrides, setOverrides] = useState<Record<string, ConflictMode>>({});
  const [submitOnCreate, setSubmitOnCreate] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [result, setResult] = useState<ExecuteResult | null>(null);

  const existingSet = useMemo(
    () => new Set(existingProductIds),
    [existingProductIds],
  );

  const resolved: ResolveResult | null = useMemo(() => {
    if (!parsed) return null;
    return resolveConflicts({
      parsed: parsed.items,
      existing_product_ids: existingSet,
      default_mode: conflictMode,
      overrides,
    });
  }, [parsed, existingSet, conflictMode, overrides]);

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
          submit_on_create: submitOnCreate,
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
        if (data.failed === 0) toast.success(msg);
        else toast.warning(msg);
        router.refresh();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Network error");
    } finally {
      setExecuting(false);
    }
  }

  return (
    <div className="space-y-6">
      <Stepper step={step} />

      {step === 1 && (
        <Step1Excel
          file={excelFile}
          parsed={parsed}
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
        />
      )}

      {step === 4 && result && (
        <Step4Result result={result} appId={appId} appName={appName} />
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
  onParsed,
  onClear,
}: {
  file: File | null;
  parsed: IapItemsParseResult | null;
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
    <section className="bg-white border border-slate-200 rounded-xl p-6">
      <h2 className="text-sm font-semibold text-slate-900 mb-1">
        Step 1 — Upload Excel template
      </h2>
      <p className="text-xs text-slate-500 mb-4">
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
    <section className="bg-white border border-slate-200 rounded-xl p-6">
      <h2 className="text-sm font-semibold text-slate-900 mb-1">
        Step 2 — Upload review screenshots
      </h2>
      <p className="text-xs text-slate-500 mb-4">
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
            <thead className="bg-slate-50 border-b border-slate-200 sticky top-0">
              <tr className="text-left text-[10px] uppercase text-slate-500 tracking-wide">
                <th className="px-3 py-2">Filename</th>
                <th className="px-3 py-2">Matched ProductId</th>
                <th className="px-3 py-2 w-20">Method</th>
                <th className="px-3 py-2 w-10"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {screenshots.map((s) => (
                <tr key={s.file.name} className="hover:bg-slate-50">
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
}) {
  const matchedProductIds = new Set(
    screenshots
      .filter((s) => s.match.kind === "matched")
      .map((s) => (s.match.kind === "matched" ? s.match.productId : "")),
  );
  return (
    <section className="bg-white border border-slate-200 rounded-xl p-6">
      <h2 className="text-sm font-semibold text-slate-900 mb-1">
        Step 3 — Preview &amp; conflict resolution
      </h2>
      <p className="text-xs text-slate-500 mb-4">
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

      {parsedSkippedLocales.length > 0 && (
        <p className="text-[11px] text-amber-700 mb-3">
          Unrecognised locale columns skipped: {parsedSkippedLocales.join(", ")}
        </p>
      )}

      <div className="border border-slate-200 rounded-lg overflow-hidden max-h-[420px] overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 border-b border-slate-200 sticky top-0">
            <tr className="text-left text-[10px] uppercase text-slate-500 tracking-wide">
              <th className="px-3 py-2">Product ID</th>
              <th className="px-3 py-2">Reference Name</th>
              <th className="px-3 py-2 w-16">Locales</th>
              <th className="px-3 py-2 w-16">Screenshot</th>
              <th className="px-3 py-2 w-28">Disposition</th>
              <th className="px-3 py-2 w-24">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {decisions.map((d) => {
              const localesFilled = d.source.localizations.length;
              const screenshotPresent = matchedProductIds.has(d.product_id);
              const isConflict = existingSet.has(d.product_id);
              const overridden = overrides[d.product_id];
              return (
                <tr key={d.product_id} className="hover:bg-slate-50">
                  <td className="px-3 py-2 font-mono text-[11px] text-slate-700">
                    {d.product_id}
                  </td>
                  <td className="px-3 py-2 truncate max-w-[200px]">
                    {d.source.reference_name}
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
}: {
  result: ExecuteResult;
  appId: string;
  appName: string;
}) {
  return (
    <section className="bg-white border border-slate-200 rounded-xl p-6">
      <h2 className="text-sm font-semibold text-slate-900 mb-1">
        Step 4 — Result
      </h2>
      <p className="text-xs text-slate-500 mb-4">
        Batch{" "}
        <span className="font-mono text-slate-700">{result.batch_id}</span>{" "}
        completed. Audit rows written to{" "}
        <span className="font-mono">iap_mgmt.actions_log</span>.
      </p>

      <div className="grid grid-cols-3 gap-3 mb-4">
        <Tally label="Succeeded" value={result.succeeded} color="emerald" />
        <Tally label="Skipped" value={result.skipped} color="slate" />
        <Tally label="Failed" value={result.failed} color="amber" />
      </div>

      <div className="border border-slate-200 rounded-lg overflow-hidden max-h-[420px] overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 border-b border-slate-200 sticky top-0">
            <tr className="text-left text-[10px] uppercase text-slate-500 tracking-wide">
              <th className="px-3 py-2">Product ID</th>
              <th className="px-3 py-2 w-24">Status</th>
              <th className="px-3 py-2 w-24">Disposition</th>
              <th className="px-3 py-2">Notes</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {result.results.map((r) => (
              <tr key={r.product_id} className="hover:bg-slate-50">
                <td className="px-3 py-2 font-mono text-[11px] text-slate-700">
                  {r.product_id}
                </td>
                <td className="px-3 py-2">
                  <StatusBadge status={r.status} />
                </td>
                <td className="px-3 py-2 text-[11px] text-slate-600">
                  {r.disposition.toLowerCase()}
                </td>
                <td className="px-3 py-2 text-[11px] text-slate-500">
                  {r.error
                    ? `${r.stage ?? ""}: ${r.error.slice(0, 120)}`
                    : r.failed_locales && r.failed_locales.length > 0
                      ? `Failed locales: ${r.failed_locales.join(", ")}`
                      : r.submitted
                        ? "Submitted for review"
                        : r.apple_iap_id
                          ? `apple_iap_id ${r.apple_iap_id.slice(0, 12)}…`
                          : "—"}
                </td>
              </tr>
            ))}
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

