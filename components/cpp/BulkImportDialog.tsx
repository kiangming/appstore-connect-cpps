"use client";

import { useState, useRef } from "react";
import {
  X,
  FolderOpen,
  Loader2,
  CheckCircle2,
  XCircle,
  ChevronRight,
  Upload,
  AlertTriangle,
} from "lucide-react";
import type {
  AppCustomProductPageLocalization,
  ScreenshotDisplayType,
  PreviewType,
  AppScreenshotSet,
  AppPreviewSet,
  AscApiResponse,
} from "@/types/asc";
import { parseFolderStructure } from "@/lib/parseFolderStructure";

// ── Defaults ────────────────────────────────────────────────────────────────
const DEFAULT_IPHONE_SCREENSHOT: ScreenshotDisplayType = "APP_IPHONE_65";
const DEFAULT_IPAD_SCREENSHOT: ScreenshotDisplayType = "APP_IPAD_PRO_3GEN_129";
const DEFAULT_IPHONE_PREVIEW: PreviewType = "IPHONE_65";
const DEFAULT_IPAD_PREVIEW: PreviewType = "IPAD_PRO_3GEN_129";

const LOCALE_REGEX = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/;

// ── Types ────────────────────────────────────────────────────────────────────
type LocaleStatus = "ready" | "new-locale" | "not-in-app" | "skip";
type Step = "drop" | "validating" | "preview" | "uploading" | "done";

interface ImportPlan {
  locale: string;
  status: LocaleStatus;
  promoText: string | null;
  screenshotFiles: { iphone: File[]; ipad: File[] };
  previewFiles: { iphone: File[]; ipad: File[] };
  localizationId: string | null;
  excluded: boolean;
}

interface LocaleProgress {
  locale: string;
  status: "pending" | "running" | "done" | "error";
  currentFile: string | null;
  error: string | null;
}

// ── Status badge ─────────────────────────────────────────────────────────────
const STATUS_CONFIG: Record<LocaleStatus, { label: string; className: string }> = {
  ready: { label: "Ready", className: "bg-green-50 text-green-700 border-green-200" },
  "new-locale": { label: "New locale", className: "bg-blue-50 text-blue-700 border-blue-200" },
  "not-in-app": { label: "Not supported by app", className: "bg-amber-50 text-amber-700 border-amber-200" },
  skip: { label: "Skip", className: "bg-slate-100 text-slate-500 border-slate-200" },
};

function StatusBadge({ status }: { status: LocaleStatus }) {
  const cfg = STATUS_CONFIG[status];
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium border ${cfg.className}`}>
      {cfg.label}
    </span>
  );
}

// ── Retry helper ─────────────────────────────────────────────────────────────
async function fetchWithRetry(fn: () => Promise<Response>): Promise<Response> {
  const res = await fn();
  if (!res.ok && res.status >= 500) {
    await new Promise((r) => setTimeout(r, 1000));
    return fn();
  }
  return res;
}

// ── Props ─────────────────────────────────────────────────────────────────────
interface Props {
  appId: string;
  cppId: string;
  versionId: string;
  existingLocalizations: AppCustomProductPageLocalization[];
  onClose: () => void;
  onComplete: () => void;
}

// ── Main component ────────────────────────────────────────────────────────────
export function BulkImportDialog({
  appId,
  cppId,
  versionId,
  existingLocalizations,
  onClose,
  onComplete,
}: Props) {
  const [step, setStep] = useState<Step>("drop");
  const [plans, setPlans] = useState<ImportPlan[]>([]);
  const [progress, setProgress] = useState<LocaleProgress[]>([]);
  const [dragging, setDragging] = useState(false);
  const [expandedLocales, setExpandedLocales] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);

  const localeIndex = new Map(
    existingLocalizations.map((l) => [l.attributes.locale.toLowerCase(), l])
  );

  // ── Parse & validate ──────────────────────────────────────────────────────
  async function processFiles(files: FileList | File[]) {
    setStep("validating");
    const fileArr = Array.from(files);
    const parsed = parseFolderStructure(fileArr);

    // Fetch app-level locales to detect "not-in-app" status
    let appLocales = new Set<string>();
    let appLocalesFetched = false;
    try {
      const res = await fetch(`/api/asc/apps/${appId}/app-info-localizations`);
      if (res.ok) {
        const json = (await res.json()) as { locales: string[] };
        appLocales = new Set(json.locales.map((l) => l.toLowerCase()));
        appLocalesFetched = true;
      }
    } catch {
      // If fetch fails, fall back to "new-locale" — don't block the import
    }

    const importPlans: ImportPlan[] = await Promise.all(
      parsed.map(async (data) => {
        // Read promo text
        let promoText: string | null = null;
        if (data.promoTextFile) {
          try {
            const raw = await data.promoTextFile.text();
            promoText = raw.trim() || null;
          } catch {
            promoText = null;
          }
        }

        const localeKey = data.locale.toLowerCase();
        const existing = localeIndex.get(localeKey);

        const hasContent =
          promoText !== null ||
          data.screenshotFiles.iphone.length > 0 ||
          data.screenshotFiles.ipad.length > 0 ||
          data.previewFiles.iphone.length > 0 ||
          data.previewFiles.ipad.length > 0;

        let status: LocaleStatus;
        if (!LOCALE_REGEX.test(data.locale) || !hasContent) {
          status = "skip";
        } else if (existing) {
          status = "ready";
        } else if (appLocalesFetched && !appLocales.has(localeKey)) {
          // Valid code but not yet in the app's store page localizations
          status = "not-in-app";
        } else {
          // In app but not yet in this CPP
          status = "new-locale";
        }

        return {
          locale: data.locale,
          status,
          promoText,
          screenshotFiles: data.screenshotFiles,
          previewFiles: data.previewFiles,
          localizationId: existing?.id ?? null,
          excluded: status === "skip",
        };
      })
    );

    setPlans(importPlans);
    setStep("preview");
  }

  // ── Drop zone handlers ────────────────────────────────────────────────────
  function handleDragOver(e: React.DragEvent) { e.preventDefault(); setDragging(true); }
  function handleDragLeave() { setDragging(false); }
  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length > 0) processFiles(e.dataTransfer.files);
  }
  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files && e.target.files.length > 0) processFiles(e.target.files);
  }

  function toggleExpand(locale: string) {
    setExpandedLocales((prev) => {
      const next = new Set(prev);
      if (next.has(locale)) next.delete(locale); else next.add(locale);
      return next;
    });
  }

  function toggleExclude(locale: string) {
    setPlans((prev) => prev.map((p) => p.locale === locale ? { ...p, excluded: !p.excluded } : p));
  }

  // ── Upload orchestration ──────────────────────────────────────────────────
  async function startUpload() {
    const active = plans.filter((p) => !p.excluded && p.status !== "skip");
    if (active.length === 0) return;

    setProgress(active.map((p) => ({ locale: p.locale, status: "pending", currentFile: null, error: null })));
    setStep("uploading");

    // Detect CPP-wide device types from an existing localization so new locales
    // use the same screenshot/preview types instead of the hardcoded defaults.
    let cppIphoneSS: ScreenshotDisplayType = DEFAULT_IPHONE_SCREENSHOT;
    let cppIpadSS: ScreenshotDisplayType = DEFAULT_IPAD_SCREENSHOT;
    let cppIphonePV: PreviewType = DEFAULT_IPHONE_PREVIEW;
    let cppIpadPV: PreviewType = DEFAULT_IPAD_PREVIEW;
    const readyPlan = active.find((p) => p.status === "ready" && p.localizationId);
    if (readyPlan?.localizationId) {
      try {
        const [sRes, pRes] = await Promise.all([
          fetch(`/api/asc/screenshot-sets?localizationId=${readyPlan.localizationId}`),
          fetch(`/api/asc/preview-sets?localizationId=${readyPlan.localizationId}`),
        ]);
        if (sRes.ok) {
          const d = (await sRes.json()) as AscApiResponse<AppScreenshotSet[]>;
          for (const set of d.data ?? []) {
            const t = set.attributes.screenshotDisplayType;
            if (t.startsWith("APP_IPHONE")) cppIphoneSS = t;
            if (t.startsWith("APP_IPAD")) cppIpadSS = t;
          }
        }
        if (pRes.ok) {
          const d = (await pRes.json()) as AscApiResponse<AppPreviewSet[]>;
          for (const set of d.data ?? []) {
            const t = set.attributes.previewType;
            if (t.startsWith("IPHONE")) cppIphonePV = t;
            if (t.startsWith("IPAD")) cppIpadPV = t;
          }
        }
      } catch { /* keep hardcoded defaults */ }
    }

    const deviceDefaults = { cppIphoneSS, cppIpadSS, cppIphonePV, cppIpadPV };

    for (const plan of active) {
      setProgress((prev) => prev.map((p) => p.locale === plan.locale ? { ...p, status: "running" } : p));
      try {
        await uploadLocale(plan, deviceDefaults, (file) => {
          setProgress((prev) => prev.map((p) => p.locale === plan.locale ? { ...p, currentFile: file } : p));
        });
        setProgress((prev) => prev.map((p) => p.locale === plan.locale ? { ...p, status: "done", currentFile: null } : p));
      } catch (err) {
        const error = err instanceof Error ? err.message : "Upload failed";
        setProgress((prev) => prev.map((p) => p.locale === plan.locale ? { ...p, status: "error", currentFile: null, error } : p));
      }
    }
    setStep("done");
  }

  // ── Per-locale upload logic ───────────────────────────────────────────────
  async function uploadLocale(
    plan: ImportPlan,
    deviceDefaults: { cppIphoneSS: ScreenshotDisplayType; cppIpadSS: ScreenshotDisplayType; cppIphonePV: PreviewType; cppIpadPV: PreviewType },
    onFile: (name: string) => void
  ) {
    let localizationId = plan.localizationId;

    // Step 0 (not-in-app): add locale to the app's store page first
    if (plan.status === "not-in-app") {
      const res = await fetchWithRetry(() =>
        fetch(`/api/asc/apps/${appId}/app-info-localizations`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ locale: plan.locale }),
        })
      );
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? `Failed to add locale ${plan.locale} to the app`);
      }
    }

    // Step 1: Create or update CPP localization
    if (!localizationId) {
      const res = await fetchWithRetry(() =>
        fetch(`/api/asc/cpps/${cppId}/localizations`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            versionId,
            locale: plan.locale,
            promotionalText: plan.promoText ?? undefined,
          }),
        })
      );
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? `Failed to create localization for ${plan.locale}`);
      }
      const created = (await res.json()) as { data?: { id: string } };
      localizationId = created.data?.id ?? null;
      if (!localizationId) throw new Error("No localization ID returned");
    } else if (plan.promoText !== null) {
      await fetchWithRetry(() =>
        fetch(`/api/asc/localizations/${localizationId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ promotionalText: plan.promoText }),
        })
      );
    }

    // Step 2: Fetch existing sets to resolve device types
    const ssCache = new Map<ScreenshotDisplayType, string>();
    const pvCache = new Map<PreviewType, string>();
    // Use CPP-wide detected types as defaults (overridden if this locale already has sets)
    let iphoneSS: ScreenshotDisplayType = deviceDefaults.cppIphoneSS;
    let ipadSS: ScreenshotDisplayType = deviceDefaults.cppIpadSS;
    let iphonePV: PreviewType = deviceDefaults.cppIphonePV;
    let ipadPV: PreviewType = deviceDefaults.cppIpadPV;

    try {
      const [sRes, pRes] = await Promise.all([
        fetch(`/api/asc/screenshot-sets?localizationId=${localizationId}`),
        fetch(`/api/asc/preview-sets?localizationId=${localizationId}`),
      ]);
      if (sRes.ok) {
        const d = (await sRes.json()) as AscApiResponse<AppScreenshotSet[]>;
        for (const set of d.data ?? []) {
          const t = set.attributes.screenshotDisplayType;
          ssCache.set(t, set.id);
          if (t.startsWith("APP_IPHONE")) iphoneSS = t;
          if (t.startsWith("APP_IPAD")) ipadSS = t;
        }
      }
      if (pRes.ok) {
        const d = (await pRes.json()) as AscApiResponse<AppPreviewSet[]>;
        for (const set of d.data ?? []) {
          const t = set.attributes.previewType;
          pvCache.set(t, set.id);
          if (t.startsWith("IPHONE")) iphonePV = t;
          if (t.startsWith("IPAD")) ipadPV = t;
        }
      }
    } catch { /* use defaults */ }

    async function getOrCreateSS(type: ScreenshotDisplayType): Promise<string> {
      if (ssCache.has(type)) return ssCache.get(type)!;
      const res = await fetchWithRetry(() =>
        fetch("/api/asc/screenshot-sets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ localizationId, screenshotDisplayType: type }),
        })
      );
      if (!res.ok) {
        if (res.status === 409) {
          const r2 = await fetch(`/api/asc/screenshot-sets?localizationId=${localizationId}`);
          if (r2.ok) {
            const d = (await r2.json()) as { data?: AppScreenshotSet[] };
            const found = d.data?.find((s) => s.attributes.screenshotDisplayType === type);
            if (found) { ssCache.set(type, found.id); return found.id; }
          }
        }
        throw new Error(`Failed to get screenshot set for ${type}`);
      }
      const d = (await res.json()) as { data: AppScreenshotSet };
      ssCache.set(type, d.data.id);
      return d.data.id;
    }

    async function getOrCreatePV(type: PreviewType): Promise<string> {
      if (pvCache.has(type)) return pvCache.get(type)!;
      const res = await fetchWithRetry(() =>
        fetch("/api/asc/preview-sets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ localizationId, previewType: type }),
        })
      );
      if (!res.ok) {
        if (res.status === 409) {
          const r2 = await fetch(`/api/asc/preview-sets?localizationId=${localizationId}`);
          if (r2.ok) {
            const d = (await r2.json()) as { data?: AppPreviewSet[] };
            const found = d.data?.find((s) => s.attributes.previewType === type);
            if (found) { pvCache.set(type, found.id); return found.id; }
          }
        }
        throw new Error(`Failed to get preview set for ${type}`);
      }
      const d = (await res.json()) as { data: AppPreviewSet };
      pvCache.set(type, d.data.id);
      return d.data.id;
    }

    // Step 3: Upload screenshots
    for (const [files, type] of [
      [plan.screenshotFiles.iphone, iphoneSS],
      [plan.screenshotFiles.ipad, ipadSS],
    ] as [File[], ScreenshotDisplayType][]) {
      if (files.length === 0) continue;
      const setId = await getOrCreateSS(type);
      for (const file of files) {
        onFile(file.name);
        const fd = new FormData();
        fd.append("screenshotSetId", setId);
        fd.append("file", file);
        const res = await fetchWithRetry(() => fetch("/api/asc/upload", { method: "POST", body: fd }));
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(err.error ?? `Failed to upload ${file.name}`);
        }
      }
    }

    // Step 4: Upload previews
    for (const [files, type] of [
      [plan.previewFiles.iphone, iphonePV],
      [plan.previewFiles.ipad, ipadPV],
    ] as [File[], PreviewType][]) {
      if (files.length === 0) continue;
      const setId = await getOrCreatePV(type);
      for (const file of files) {
        onFile(file.name);
        const fd = new FormData();
        fd.append("previewSetId", setId);
        fd.append("file", file);
        const res = await fetchWithRetry(() => fetch("/api/asc/upload-preview", { method: "POST", body: fd }));
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(err.error ?? `Failed to upload ${file.name}`);
        }
      }
    }
  }

  // ── Derived ───────────────────────────────────────────────────────────────
  const activePlanCount = plans.filter((p) => !p.excluded && p.status !== "skip").length;
  const notInAppCount = plans.filter((p) => !p.excluded && p.status === "not-in-app").length;
  const doneCount = progress.filter((p) => p.status === "done").length;
  const errorCount = progress.filter((p) => p.status === "error").length;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <>
      <div
        className="fixed inset-0 bg-black/40 z-50"
        onClick={step === "drop" || step === "preview" ? onClose : undefined}
      />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-6 pointer-events-none">
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col pointer-events-auto">

          {/* Header */}
          <div className="flex items-center justify-between px-6 py-5 border-b border-slate-100 flex-shrink-0">
            <div>
              <h2 className="text-base font-semibold text-slate-900">Bulk Import Assets</h2>
              <p className="text-xs text-slate-400 mt-0.5">
                {step === "drop" && "Drop a folder with locale subfolders to import all assets at once"}
                {step === "validating" && "Parsing folder structure…"}
                {step === "preview" && `${plans.length} locale${plans.length !== 1 ? "s" : ""} found — review before importing`}
                {step === "uploading" && "Uploading assets…"}
                {step === "done" && `Done — ${doneCount} succeeded${errorCount > 0 ? `, ${errorCount} failed` : ""}`}
              </p>
            </div>
            {(step === "drop" || step === "preview" || step === "done") && (
              <button
                onClick={step === "done" ? () => { onComplete(); onClose(); } : onClose}
                className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            )}
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto">

            {/* Drop step */}
            {step === "drop" && (
              <div className="p-8">
                <div
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                  className={`rounded-2xl border-2 border-dashed p-12 flex flex-col items-center gap-4 transition-colors ${
                    dragging ? "border-[#0071E3] bg-blue-50" : "border-slate-200 hover:border-slate-300"
                  }`}
                >
                  <div className="h-14 w-14 rounded-2xl bg-slate-100 flex items-center justify-center">
                    <FolderOpen className="h-7 w-7 text-slate-400" />
                  </div>
                  <div className="text-center">
                    <p className="text-sm font-medium text-slate-700">Drop your CPP assets folder here</p>
                    <p className="text-xs text-slate-400 mt-1">
                      Folder must contain locale subfolders (e.g.{" "}
                      <code className="font-mono bg-slate-100 px-1 rounded">en-US/</code>,{" "}
                      <code className="font-mono bg-slate-100 px-1 rounded">vi/</code>)
                    </p>
                  </div>
                  <button
                    onClick={() => inputRef.current?.click()}
                    className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-[#0071E3] border border-[#0071E3] rounded-lg hover:bg-blue-50 transition"
                  >
                    <FolderOpen className="h-4 w-4" />
                    Browse folder…
                  </button>
                </div>

                <div className="mt-6 rounded-xl border border-slate-100 bg-slate-50 p-4">
                  <p className="text-xs font-semibold text-slate-500 mb-2">Expected folder structure</p>
                  <pre className="text-xs text-slate-500 leading-relaxed font-mono whitespace-pre">{`your-folder/
├── en-US/
│   ├── promo.txt
│   ├── screenshots/
│   │   ├── iphone/   ← PNG files
│   │   └── ipad/     ← PNG files
│   └── previews/
│       ├── iphone/   ← MP4 files
│       └── ipad/     ← MP4 files
└── vi/
    ├── promo.txt
    └── screenshots/
        └── iphone/`}</pre>
                </div>

                <input
                  ref={inputRef}
                  type="file"
                  // @ts-expect-error webkitdirectory is non-standard
                  webkitdirectory=""
                  multiple
                  className="hidden"
                  onChange={handleInputChange}
                />
              </div>
            )}

            {/* Validating step */}
            {step === "validating" && (
              <div className="flex flex-col items-center justify-center py-20 gap-3">
                <Loader2 className="h-6 w-6 text-[#0071E3] animate-spin" />
                <p className="text-sm text-slate-500">Parsing folder structure…</p>
              </div>
            )}

            {/* Preview step */}
            {step === "preview" && (
              <div className="divide-y divide-slate-100">
                {notInAppCount > 0 && (
                  <div className="mx-5 mt-4 mb-1 flex items-start gap-2.5 rounded-xl bg-amber-50 border border-amber-200 px-4 py-3">
                    <AlertTriangle className="h-4 w-4 text-amber-600 flex-shrink-0 mt-0.5" />
                    <p className="text-xs text-amber-700">
                      <span className="font-semibold">
                        {notInAppCount} locale{notInAppCount !== 1 ? "s" : ""}
                      </span>{" "}
                      have locale codes not supported by this app yet. They will be added to the app&apos;s store
                      page localizations first, then imported into this CPP.
                    </p>
                  </div>
                )}

                {plans.length === 0 ? (
                  <div className="p-8 text-center text-sm text-slate-400">
                    No valid locale folders found.
                  </div>
                ) : (
                  plans.map((plan) => {
                    const expanded = expandedLocales.has(plan.locale);
                    const totalScreenshots =
                      plan.screenshotFiles.iphone.length + plan.screenshotFiles.ipad.length;
                    const totalPreviews =
                      plan.previewFiles.iphone.length + plan.previewFiles.ipad.length;

                    return (
                      <div key={plan.locale} className={plan.excluded ? "opacity-50" : ""}>
                        <div className="flex items-center gap-3 px-5 py-3.5">
                          <button onClick={() => toggleExpand(plan.locale)} className="flex-shrink-0 text-slate-400">
                            <ChevronRight className={`h-4 w-4 transition-transform ${expanded ? "rotate-90" : ""}`} />
                          </button>
                          <span className="font-mono text-sm font-medium text-slate-800 w-20 flex-shrink-0">
                            {plan.locale}
                          </span>
                          <StatusBadge status={plan.status} />
                          <div className="flex-1 flex items-center gap-3 text-xs text-slate-400 ml-2">
                            {plan.promoText && (
                              <span className="truncate max-w-[160px]" title={plan.promoText}>
                                &ldquo;{plan.promoText.slice(0, 40)}{plan.promoText.length > 40 ? "…" : ""}&rdquo;
                              </span>
                            )}
                            {totalScreenshots > 0 && (
                              <span>{totalScreenshots} screenshot{totalScreenshots !== 1 ? "s" : ""}</span>
                            )}
                            {totalPreviews > 0 && (
                              <span>{totalPreviews} preview{totalPreviews !== 1 ? "s" : ""}</span>
                            )}
                          </div>
                          {plan.status !== "skip" && (
                            <button
                              onClick={() => toggleExclude(plan.locale)}
                              className="text-xs text-slate-400 hover:text-slate-600 transition flex-shrink-0"
                            >
                              {plan.excluded ? "Include" : "Remove"}
                            </button>
                          )}
                        </div>

                        {expanded && (
                          <div className="px-12 pb-4 space-y-3">
                            {plan.promoText && (
                              <div>
                                <p className="text-xs font-medium text-slate-400 mb-1">Promotional text</p>
                                <p className="text-xs text-slate-600 bg-slate-50 rounded-lg p-2.5 whitespace-pre-wrap">
                                  {plan.promoText}
                                </p>
                              </div>
                            )}
                            {totalScreenshots > 0 && (
                              <div>
                                <p className="text-xs font-medium text-slate-400 mb-1">Screenshots</p>
                                <div className="space-y-1">
                                  {plan.screenshotFiles.iphone.length > 0 && (
                                    <p className="text-xs text-slate-500">
                                      iPhone: {plan.screenshotFiles.iphone.map((f) => f.name).join(", ")}
                                    </p>
                                  )}
                                  {plan.screenshotFiles.ipad.length > 0 && (
                                    <p className="text-xs text-slate-500">
                                      iPad: {plan.screenshotFiles.ipad.map((f) => f.name).join(", ")}
                                    </p>
                                  )}
                                </div>
                              </div>
                            )}
                            {totalPreviews > 0 && (
                              <div>
                                <p className="text-xs font-medium text-slate-400 mb-1">App Previews</p>
                                <div className="space-y-1">
                                  {plan.previewFiles.iphone.length > 0 && (
                                    <p className="text-xs text-slate-500">
                                      iPhone: {plan.previewFiles.iphone.map((f) => f.name).join(", ")}
                                    </p>
                                  )}
                                  {plan.previewFiles.ipad.length > 0 && (
                                    <p className="text-xs text-slate-500">
                                      iPad: {plan.previewFiles.ipad.map((f) => f.name).join(", ")}
                                    </p>
                                  )}
                                </div>
                              </div>
                            )}
                            {plan.status === "new-locale" && (
                              <p className="text-xs text-blue-600 bg-blue-50 rounded-lg p-2 flex items-center gap-1.5">
                                <AlertTriangle className="h-3 w-3 flex-shrink-0" />
                                This locale will be added to the CPP automatically.
                              </p>
                            )}
                            {plan.status === "not-in-app" && (
                              <p className="text-xs text-amber-700 bg-amber-50 rounded-lg p-2 flex items-center gap-1.5">
                                <AlertTriangle className="h-3 w-3 flex-shrink-0" />
                                This locale code is not in the app&apos;s supported localizations — it will be added to the app&apos;s store page automatically before importing.
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            )}

            {/* Uploading / done step */}
            {(step === "uploading" || step === "done") && (
              <div className="divide-y divide-slate-100">
                {progress.map((p) => (
                  <div key={p.locale} className="flex items-center gap-4 px-6 py-4">
                    <div className="flex-shrink-0">
                      {p.status === "pending" && <div className="h-5 w-5 rounded-full border-2 border-slate-200" />}
                      {p.status === "running" && <Loader2 className="h-5 w-5 text-[#0071E3] animate-spin" />}
                      {p.status === "done" && <CheckCircle2 className="h-5 w-5 text-green-500" />}
                      {p.status === "error" && <XCircle className="h-5 w-5 text-red-500" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-slate-800 font-mono">{p.locale}</p>
                      {p.currentFile && (
                        <p className="text-xs text-slate-400 truncate">Uploading {p.currentFile}…</p>
                      )}
                      {p.status === "done" && !p.currentFile && (
                        <p className="text-xs text-green-600">Completed</p>
                      )}
                      {p.error && (
                        <p className="text-xs text-red-600 break-words">{p.error}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Footer */}
          {(step === "preview" || step === "done") && (
            <div className="flex items-center justify-between px-6 py-4 border-t border-slate-100 flex-shrink-0">
              {step === "preview" && (
                <>
                  <button
                    onClick={onClose}
                    className="px-4 py-2 text-sm font-medium text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 transition"
                  >
                    Cancel
                  </button>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-slate-400">
                      {activePlanCount} locale{activePlanCount !== 1 ? "s" : ""} to import
                      {notInAppCount > 0 && (
                        <span className="text-amber-600 ml-1">
                          ({notInAppCount} will be added to app first)
                        </span>
                      )}
                    </span>
                    <button
                      onClick={startUpload}
                      disabled={activePlanCount === 0}
                      className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-[#0071E3] hover:bg-[#0077ED] rounded-lg transition disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <Upload className="h-4 w-4" />
                      Import All
                    </button>
                  </div>
                </>
              )}
              {step === "done" && (
                <>
                  <div className="text-sm text-slate-600">
                    {doneCount > 0 && (
                      <span className="text-green-600 font-medium">
                        {doneCount} locale{doneCount !== 1 ? "s" : ""} imported
                      </span>
                    )}
                    {doneCount > 0 && errorCount > 0 && <span className="mx-2">·</span>}
                    {errorCount > 0 && (
                      <span className="text-red-600 font-medium">{errorCount} failed</span>
                    )}
                  </div>
                  <button
                    onClick={() => { onComplete(); onClose(); }}
                    className="px-4 py-2 text-sm font-medium text-white bg-[#0071E3] hover:bg-[#0077ED] rounded-lg transition"
                  >
                    Done
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
