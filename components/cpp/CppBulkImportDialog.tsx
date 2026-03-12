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
  AppCustomProductPage,
  AppScreenshotSet,
  AppPreviewSet,
  AscApiResponse,
  ScreenshotDisplayType,
  PreviewType,
} from "@/types/asc";
import { parseCppFolderStructure } from "@/lib/parseCppFolderStructure";
import { localeNameFromCode } from "@/lib/locale-utils";

// ── Defaults ──────────────────────────────────────────────────────────────────
const DEFAULT_IPHONE_SCREENSHOT: ScreenshotDisplayType = "APP_IPHONE_65";
const DEFAULT_IPAD_SCREENSHOT: ScreenshotDisplayType = "APP_IPAD_PRO_3GEN_129";
const DEFAULT_IPHONE_PREVIEW: PreviewType = "IPHONE_65";
const DEFAULT_IPAD_PREVIEW: PreviewType = "IPAD_PRO_3GEN_129";

const LOCALE_REGEX = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/;

// ── Types ─────────────────────────────────────────────────────────────────────
type CppImportStatus = "new" | "existing" | "skip";
type LocaleStatus = "ready" | "new-locale" | "not-in-app" | "skip";
type Step = "drop" | "validating" | "preview" | "uploading" | "done";

interface LocaleCppImportPlan {
  locale: string;
  status: LocaleStatus;
  promoText: string | null;
  screenshotFiles: { iphone: File[]; ipad: File[] };
  previewFiles: { iphone: File[]; ipad: File[] };
  localizationId: string | null;
  excluded: boolean;
}

interface CppImportPlan {
  name: string;
  status: CppImportStatus;
  primaryLocale: string;
  primaryLocaleSource: "file" | "fallback";
  existingCppId: string | null;
  deepLink: string | null;
  locales: LocaleCppImportPlan[];
  excluded: boolean;
}

interface LocaleProgress {
  locale: string;
  status: "pending" | "running" | "done" | "error";
  currentFile: string | null;
  error: string | null;
}

interface CppProgress {
  name: string;
  status: "pending" | "running" | "done" | "error";
  error: string | null;
  locales: LocaleProgress[];
}

type DeviceDefaults = {
  cppIphoneSS: ScreenshotDisplayType;
  cppIpadSS: ScreenshotDisplayType;
  cppIphonePV: PreviewType;
  cppIpadPV: PreviewType;
};

// ── Status configs ────────────────────────────────────────────────────────────
const CPP_STATUS_CONFIG: Record<CppImportStatus, { label: string; className: string }> = {
  new: { label: "New CPP", className: "bg-blue-50 text-blue-700 border-blue-200" },
  existing: { label: "Existing", className: "bg-green-50 text-green-700 border-green-200" },
  skip: { label: "Skip", className: "bg-slate-100 text-slate-500 border-slate-200" },
};

const LOCALE_STATUS_CONFIG: Record<LocaleStatus, { label: string; className: string }> = {
  ready: { label: "Ready", className: "bg-green-50 text-green-700 border-green-200" },
  "new-locale": { label: "New locale", className: "bg-blue-50 text-blue-700 border-blue-200" },
  "not-in-app": { label: "Not supported by app", className: "bg-amber-50 text-amber-700 border-amber-200" },
  skip: { label: "Skip", className: "bg-slate-100 text-slate-500 border-slate-200" },
};

function StatusBadge({ label, className }: { label: string; className: string }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium border ${className}`}>
      {label}
    </span>
  );
}

// ── Retry helper with exponential backoff (handles 429 + 5xx) ─────────────────
async function fetchWithBackoff(
  fn: () => Promise<Response>,
  maxRetries = 3
): Promise<Response> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const res = await fn();
    if (res.status === 429) {
      // Rate limit: exponential backoff 2s, 4s, 8s
      await new Promise((r) => setTimeout(r, Math.pow(2, attempt + 1) * 1000));
      continue;
    }
    if (res.status >= 500 && attempt < maxRetries - 1) {
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    return res;
  }
  return fn();
}

// ── Props ─────────────────────────────────────────────────────────────────────
interface Props {
  appId: string;
  existingCpps: AppCustomProductPage[];
  onClose: () => void;
  onComplete: () => void;
}

// ── Main component ─────────────────────────────────────────────────────────────
export function CppBulkImportDialog({ appId, existingCpps, onClose, onComplete }: Props) {
  const [step, setStep] = useState<Step>("drop");
  const [plans, setPlans] = useState<CppImportPlan[]>([]);
  const [cppProgress, setCppProgress] = useState<CppProgress[]>([]);
  const [dragging, setDragging] = useState(false);
  const [expandedCpps, setExpandedCpps] = useState<Set<string>>(new Set());
  const [expandedLocales, setExpandedLocales] = useState<Set<string>>(new Set()); // "cppName::locale"
  const inputRef = useRef<HTMLInputElement>(null);

  // ── Progress helpers ────────────────────────────────────────────────────────
  function updateCppProgress(name: string, updates: Partial<CppProgress>) {
    setCppProgress((prev) =>
      prev.map((p) => (p.name === name ? { ...p, ...updates } : p))
    );
  }

  function updateLocaleProgress(
    cppName: string,
    locale: string,
    updates: Partial<LocaleProgress>
  ) {
    setCppProgress((prev) =>
      prev.map((p) =>
        p.name === cppName
          ? {
              ...p,
              locales: p.locales.map((l) =>
                l.locale === locale ? { ...l, ...updates } : l
              ),
            }
          : p
      )
    );
  }

  // ── Parse & Validate ────────────────────────────────────────────────────────
  async function processFiles(files: FileList | File[]) {
    setStep("validating");
    const fileArr = Array.from(files);
    const { primaryLocaleFile, cpps: parsedCpps } = parseCppFolderStructure(fileArr);

    // Read root-level primary-locale.txt once — shared for ALL new CPPs
    let rootPrimaryLocale = "";
    if (primaryLocaleFile) {
      try {
        const text = (await primaryLocaleFile.text()).trim();
        if (LOCALE_REGEX.test(text)) {
          rootPrimaryLocale = text;
        }
      } catch {
        // ignore read error
      }
    }

    // Fetch app-level locales once for all CPPs
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
      // fallback: "new-locale" for all — don't block
    }

    // Build existing CPP name index (case-insensitive)
    const existingIndex = new Map(
      existingCpps.map((cpp) => [cpp.attributes.name.toLowerCase().trim(), cpp])
    );

    const importPlans: CppImportPlan[] = await Promise.all(
      parsedCpps.map(async (cppData) => {
        // ── Resolve primary locale ──────────────────────────────────────────
        // Use root-level primary-locale.txt (shared for all CPPs). If absent,
        // prefer a locale already in the app to avoid 409 on CPP creation.
        let primaryLocale = rootPrimaryLocale;
        let primaryLocaleSource: "file" | "fallback" = rootPrimaryLocale ? "file" : "fallback";

        if (!primaryLocale) {
          // Fallback: prefer a locale already in the app (avoids 409 when creating CPP
          // with a locale that isn't yet supported by the app). If no in-app locale found,
          // fall back to the first alphabetical locale.
          const inAppLocale =
            appLocalesFetched && appLocales.size > 0
              ? cppData.locales.find((l) => appLocales.has(l.locale.toLowerCase()))
              : undefined;
          primaryLocale = inAppLocale?.locale ?? cppData.locales[0]?.locale ?? "en-US";
        }

        // ── Match existing CPP ──────────────────────────────────────────────
        const existingCpp = existingIndex.get(cppData.cppName.toLowerCase().trim());
        const cppStatus: CppImportStatus = existingCpp ? "existing" : "new";
        const existingCppId = existingCpp?.id ?? null;

        // If existing, fetch its current localizations to get localizationId per locale
        let existingLocaleMap = new Map<string, string>(); // locale → localizationId
        if (existingCppId) {
          try {
            const res = await fetch(`/api/asc/cpps/${existingCppId}`);
            if (res.ok) {
              const data = (await res.json()) as {
                versions?: Array<{
                  localizations?: Array<{ localization: { id: string; attributes: { locale: string } } }>;
                }>;
              };
              const locs = data.versions?.[0]?.localizations ?? [];
              for (const { localization } of locs) {
                existingLocaleMap.set(
                  localization.attributes.locale.toLowerCase(),
                  localization.id
                );
              }
            }
          } catch {
            // keep empty map
          }
        }

        // ── Build locale plans ──────────────────────────────────────────────
        const localePlans: LocaleCppImportPlan[] = await Promise.all(
          cppData.locales.map(async (localeData) => {
            let promoText: string | null = null;
            if (localeData.promoTextFile) {
              try {
                const raw = await localeData.promoTextFile.text();
                promoText = raw.trim() || null;
              } catch {
                promoText = null;
              }
            }

            const localeKey = localeData.locale.toLowerCase();
            const localizationId = existingLocaleMap.get(localeKey) ?? null;

            const hasContent =
              promoText !== null ||
              localeData.screenshotFiles.iphone.length > 0 ||
              localeData.screenshotFiles.ipad.length > 0 ||
              localeData.previewFiles.iphone.length > 0 ||
              localeData.previewFiles.ipad.length > 0;

            let localeStatus: LocaleStatus;
            if (!LOCALE_REGEX.test(localeData.locale) || !hasContent) {
              localeStatus = "skip";
            } else if (localizationId) {
              localeStatus = "ready";
            } else if (appLocalesFetched && !appLocales.has(localeKey)) {
              localeStatus = "not-in-app";
            } else {
              localeStatus = "new-locale";
            }

            return {
              locale: localeData.locale,
              status: localeStatus,
              promoText,
              screenshotFiles: localeData.screenshotFiles,
              previewFiles: localeData.previewFiles,
              localizationId,
              excluded: localeStatus === "skip",
            };
          })
        );

        // Read deeplink.txt
        let deepLink: string | null = null;
        if (cppData.deepLinkFile) {
          try {
            const raw = (await cppData.deepLinkFile.text()).trim();
            deepLink = raw || null;
          } catch {
            deepLink = null;
          }
        }

        // Skip CPP if no locales or all locales are skip
        const hasActiveLocales = localePlans.some((l) => l.status !== "skip");
        const finalCppStatus: CppImportStatus =
          localePlans.length === 0 || !hasActiveLocales ? "skip" : cppStatus;

        return {
          name: cppData.cppName,
          status: finalCppStatus,
          primaryLocale,
          primaryLocaleSource,
          existingCppId,
          deepLink,
          locales: localePlans,
          excluded: finalCppStatus === "skip",
        };
      })
    );

    setPlans(importPlans);
    setStep("preview");
  }

  // ── Per-locale upload (mirrors BulkImportDialog.uploadLocale) ───────────────
  async function uploadLocale(
    plan: LocaleCppImportPlan,
    cppId: string,
    versionId: string,
    deviceDefaults: DeviceDefaults,
    onFile: (name: string) => void
  ) {
    let localizationId = plan.localizationId;

    // Step 0 (not-in-app): add locale to app's store page first
    if (plan.status === "not-in-app") {
      const res = await fetchWithBackoff(() =>
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
      const res = await fetchWithBackoff(() =>
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
      await fetchWithBackoff(() =>
        fetch(`/api/asc/localizations/${localizationId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ promotionalText: plan.promoText }),
        })
      );
    }

    // Step 2: Fetch existing sets to resolve device types for this locale
    const ssCache = new Map<ScreenshotDisplayType, string>();
    const pvCache = new Map<PreviewType, string>();
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
    } catch {
      /* use defaults */
    }

    async function getOrCreateSS(type: ScreenshotDisplayType): Promise<string> {
      if (ssCache.has(type)) return ssCache.get(type)!;
      const res = await fetchWithBackoff(() =>
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
      const res = await fetchWithBackoff(() =>
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
        const res = await fetchWithBackoff(() =>
          fetch("/api/asc/upload", { method: "POST", body: fd })
        );
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
        const res = await fetchWithBackoff(() =>
          fetch("/api/asc/upload-preview", { method: "POST", body: fd })
        );
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(err.error ?? `Failed to upload ${file.name}`);
        }
      }
    }
  }

  // ── Per-CPP upload ──────────────────────────────────────────────────────────
  async function uploadCpp(plan: CppImportPlan) {
    updateCppProgress(plan.name, { status: "running" });

    try {
      // Step 1: Create or find CPP
      let cppId = plan.existingCppId;
      if (plan.status === "new") {
        // If the primary locale is marked "not-in-app", add it to the app BEFORE creating
        // the CPP. The compound document creation requires the locale to already be in the
        // app's supported locales, and uploadLocale's step 0 runs too late for the primary.
        const primaryLocalePlan = plan.locales.find(
          (l) => l.locale.toLowerCase() === plan.primaryLocale.toLowerCase()
        );
        if (primaryLocalePlan?.status === "not-in-app") {
          const addRes = await fetchWithBackoff(() =>
            fetch(`/api/asc/apps/${appId}/app-info-localizations`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ locale: plan.primaryLocale }),
            })
          );
          if (!addRes.ok) {
            const err = (await addRes.json().catch(() => ({}))) as { error?: string };
            throw new Error(err.error ?? `Failed to add locale ${plan.primaryLocale} to the app`);
          }
        }

        const res = await fetchWithBackoff(() =>
          fetch("/api/asc/cpps", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              appId,
              name: plan.name,
              locale: plan.primaryLocale,
            }),
          })
        );
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(err.error ?? `Failed to create CPP "${plan.name}"`);
        }
        const created = (await res.json()) as { data?: { id: string } };
        cppId = created.data?.id ?? null;
        if (!cppId) throw new Error("No CPP ID returned");
      }

      if (!cppId) throw new Error("CPP ID is missing");

      // Step 2: Fetch CPP details → versionId + server-side localizationId map
      const cppRes = await fetchWithBackoff(() => fetch(`/api/asc/cpps/${cppId}`));
      if (!cppRes.ok) throw new Error(`Failed to fetch CPP details for "${plan.name}"`);
      const cppData = (await cppRes.json()) as {
        versions?: Array<{
          version: { id: string };
          localizations?: Array<{
            localization: { id: string; attributes: { locale: string } };
          }>;
        }>;
      };

      const versionId = cppData.versions?.[0]?.version?.id;
      if (!versionId) throw new Error(`No version ID found for CPP "${plan.name}"`);

      // Step 2b: Update deep link if provided
      if (plan.deepLink) {
        await fetchWithBackoff(() =>
          fetch(`/api/asc/versions/${versionId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ deepLink: plan.deepLink }),
          })
        );
      }

      // Build updated localizationId map from server (covers locales created with CPP)
      const serverLocIds = new Map<string, string>();
      for (const { localization } of cppData.versions?.[0]?.localizations ?? []) {
        serverLocIds.set(localization.attributes.locale.toLowerCase(), localization.id);
      }

      // Step 3: Detect CPP-wide device types from first "ready" locale
      let cppIphoneSS: ScreenshotDisplayType = DEFAULT_IPHONE_SCREENSHOT;
      let cppIpadSS: ScreenshotDisplayType = DEFAULT_IPAD_SCREENSHOT;
      let cppIphonePV: PreviewType = DEFAULT_IPHONE_PREVIEW;
      let cppIpadPV: PreviewType = DEFAULT_IPAD_PREVIEW;

      const readyLocale = plan.locales.find(
        (l) => !l.excluded && l.status === "ready" && (l.localizationId ?? serverLocIds.get(l.locale.toLowerCase()))
      );
      const readyLocId =
        readyLocale?.localizationId ?? serverLocIds.get(readyLocale?.locale.toLowerCase() ?? "");

      if (readyLocId) {
        try {
          const [sRes, pRes] = await Promise.all([
            fetch(`/api/asc/screenshot-sets?localizationId=${readyLocId}`),
            fetch(`/api/asc/preview-sets?localizationId=${readyLocId}`),
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
        } catch {
          /* keep defaults */
        }
      }

      const deviceDefaults: DeviceDefaults = { cppIphoneSS, cppIpadSS, cppIphonePV, cppIpadPV };

      // Step 4: Upload each active locale (sequential within this CPP)
      const activeLocales = plan.locales.filter((l) => !l.excluded && l.status !== "skip");
      for (const locale of activeLocales) {
        updateLocaleProgress(plan.name, locale.locale, { status: "running" });
        try {
          // Merge server-side localizationId (may differ from parsed-phase value for new CPPs)
          const updatedLocale: LocaleCppImportPlan = {
            ...locale,
            localizationId:
              serverLocIds.get(locale.locale.toLowerCase()) ?? locale.localizationId,
          };
          await uploadLocale(updatedLocale, cppId, versionId, deviceDefaults, (file) => {
            updateLocaleProgress(plan.name, locale.locale, { currentFile: file });
          });
          updateLocaleProgress(plan.name, locale.locale, {
            status: "done",
            currentFile: null,
          });
        } catch (err) {
          const error = err instanceof Error ? err.message : "Upload failed";
          updateLocaleProgress(plan.name, locale.locale, {
            status: "error",
            currentFile: null,
            error,
          });
        }
      }

      updateCppProgress(plan.name, { status: "done" });
    } catch (err) {
      const error = err instanceof Error ? err.message : "Upload failed";
      updateCppProgress(plan.name, { status: "error", error });
    }
  }

  // ── Upload orchestration — worker pool, concurrency = 2 ────────────────────
  async function startUpload() {
    const active = plans.filter((p) => !p.excluded && p.status !== "skip");
    if (active.length === 0) return;

    // Init progress
    setCppProgress(
      active.map((p) => ({
        name: p.name,
        status: "pending",
        error: null,
        locales: p.locales
          .filter((l) => !l.excluded && l.status !== "skip")
          .map((l) => ({ locale: l.locale, status: "pending", currentFile: null, error: null })),
      }))
    );
    setStep("uploading");

    const queue = [...active];

    async function worker() {
      while (queue.length > 0) {
        const plan = queue.shift()!;
        await uploadCpp(plan);
      }
    }

    // Run 2 workers concurrently
    await Promise.all([worker(), worker()]);
    setStep("done");
  }

  // ── Drop zone ───────────────────────────────────────────────────────────────
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

  function toggleCpp(name: string) {
    setExpandedCpps((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }
  function toggleLocale(cppName: string, locale: string) {
    const key = `${cppName}::${locale}`;
    setExpandedLocales((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }
  function toggleExcludeCpp(name: string) {
    setPlans((prev) =>
      prev.map((p) => (p.name === name ? { ...p, excluded: !p.excluded } : p))
    );
  }
  function toggleExcludeLocale(cppName: string, locale: string) {
    setPlans((prev) =>
      prev.map((p) =>
        p.name === cppName
          ? { ...p, locales: p.locales.map((l) => l.locale === locale ? { ...l, excluded: !l.excluded } : l) }
          : p
      )
    );
  }

  // ── Derived ─────────────────────────────────────────────────────────────────
  const activeCppCount = plans.filter((p) => !p.excluded && p.status !== "skip").length;
  const notInAppLocaleCount = plans
    .filter((p) => !p.excluded)
    .flatMap((p) => p.locales)
    .filter((l) => !l.excluded && l.status === "not-in-app").length;
  const fallbackLocaleCount = plans.filter(
    (p) => !p.excluded && p.primaryLocaleSource === "fallback" && p.status !== "skip"
  ).length;
  const doneCount = cppProgress.filter((p) => p.status === "done").length;
  const errorCount = cppProgress.filter((p) => p.status === "error").length;

  // ── Render ──────────────────────────────────────────────────────────────────
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
              <h2 className="text-base font-semibold text-slate-900">CPP Bulk Import</h2>
              <p className="text-xs text-slate-400 mt-0.5">
                {step === "drop" && "Drop a folder containing CPP subfolders to create multiple CPPs at once"}
                {step === "validating" && "Parsing folder structure…"}
                {step === "preview" && `${plans.length} CPP${plans.length !== 1 ? "s" : ""} found — review before importing`}
                {step === "uploading" && "Uploading CPPs…"}
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

            {/* ── Drop step ─────────────────────────────────────────────────── */}
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
                    <p className="text-sm font-medium text-slate-700">Drop your CPPs root folder here</p>
                    <p className="text-xs text-slate-400 mt-1">
                      Each subfolder becomes a CPP (e.g.{" "}
                      <code className="font-mono bg-slate-100 px-1 rounded">Summer Campaign/</code>)
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
                  <pre className="text-xs text-slate-500 leading-relaxed font-mono whitespace-pre">{`my-cpps/
├── primary-locale.txt   ← "en-US" (shared for all CPPs)
├── Summer Campaign/
│   ├── en-US/
│   │   ├── promo.txt
│   │   ├── screenshots/iphone/
│   │   └── previews/iphone/
│   └── vi/
│       └── screenshots/iphone/
└── Holiday Sale/
    └── ja/
        └── screenshots/iphone/`}</pre>
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

            {/* ── Validating step ───────────────────────────────────────────── */}
            {step === "validating" && (
              <div className="flex flex-col items-center justify-center py-20 gap-3">
                <Loader2 className="h-6 w-6 text-[#0071E3] animate-spin" />
                <p className="text-sm text-slate-500">Parsing folder structure…</p>
              </div>
            )}

            {/* ── Preview step ──────────────────────────────────────────────── */}
            {step === "preview" && (
              <div className="divide-y divide-slate-100">
                {/* Banners */}
                {notInAppLocaleCount > 0 && (
                  <div className="mx-5 mt-4 mb-1 flex items-start gap-2.5 rounded-xl bg-amber-50 border border-amber-200 px-4 py-3">
                    <AlertTriangle className="h-4 w-4 text-amber-600 flex-shrink-0 mt-0.5" />
                    <p className="text-xs text-amber-700">
                      <span className="font-semibold">{notInAppLocaleCount} locale{notInAppLocaleCount !== 1 ? "s" : ""}</span>{" "}
                      across CPPs have codes not yet supported by this app. They will be added to the app&apos;s store page localizations first.
                    </p>
                  </div>
                )}
                {fallbackLocaleCount > 0 && (
                  <div className="mx-5 mt-3 mb-1 flex items-start gap-2.5 rounded-xl bg-yellow-50 border border-yellow-200 px-4 py-3">
                    <AlertTriangle className="h-4 w-4 text-yellow-600 flex-shrink-0 mt-0.5" />
                    <p className="text-xs text-yellow-700">
                      No <code className="font-mono bg-yellow-100 px-0.5 rounded">primary-locale.txt</code> found in root folder — using first supported locale as fallback for each new CPP.
                    </p>
                  </div>
                )}

                {plans.length === 0 ? (
                  <div className="p-8 text-center text-sm text-slate-400">
                    No valid CPP folders found.
                  </div>
                ) : (
                  plans.map((cppPlan) => {
                    const cppExpanded = expandedCpps.has(cppPlan.name);
                    const activeLocales = cppPlan.locales.filter((l) => l.status !== "skip");
                    const cfg = CPP_STATUS_CONFIG[cppPlan.status];

                    return (
                      <div key={cppPlan.name} className={cppPlan.excluded ? "opacity-50" : ""}>
                        {/* CPP row */}
                        <div className="flex items-center gap-3 px-5 py-3.5">
                          <button
                            onClick={() => toggleCpp(cppPlan.name)}
                            className="flex-shrink-0 text-slate-400"
                          >
                            <ChevronRight
                              className={`h-4 w-4 transition-transform ${cppExpanded ? "rotate-90" : ""}`}
                            />
                          </button>
                          <span className="text-sm font-semibold text-slate-800 flex-1 truncate">
                            {cppPlan.name}
                          </span>
                          <StatusBadge label={cfg.label} className={cfg.className} />
                          {cppPlan.primaryLocaleSource === "fallback" && cppPlan.status !== "skip" && (
                            <span className="text-xs text-yellow-600 flex-shrink-0">
                              ⚠ fallback locale
                            </span>
                          )}
                          <span className="text-xs text-slate-400 flex-shrink-0">
                            {activeLocales.length} locale{activeLocales.length !== 1 ? "s" : ""}
                          </span>
                          {cppPlan.status !== "skip" && (
                            <button
                              onClick={() => toggleExcludeCpp(cppPlan.name)}
                              className="text-xs text-slate-400 hover:text-slate-600 transition flex-shrink-0"
                            >
                              {cppPlan.excluded ? "Include" : "Remove"}
                            </button>
                          )}
                        </div>

                        {/* Expanded CPP → locale rows */}
                        {cppExpanded && (
                          <div className="pb-2">
                            {/* Primary locale info */}
                            <div className="px-12 pb-1.5 space-y-1">
                              <span className="text-xs text-slate-400">
                                primary: <code className="font-mono bg-slate-100 px-1 rounded">{cppPlan.primaryLocale}</code>
                                {cppPlan.primaryLocaleSource === "fallback" && (
                                  <span className="text-yellow-600 ml-1">(fallback)</span>
                                )}
                              </span>
                              {cppPlan.deepLink && (
                                <div className="flex items-center gap-1.5">
                                  <span className="text-xs text-slate-400">deep link:</span>
                                  <span className="text-xs font-mono text-slate-600 truncate max-w-[280px]" title={cppPlan.deepLink}>
                                    {cppPlan.deepLink}
                                  </span>
                                </div>
                              )}
                            </div>

                            {cppPlan.locales.map((localePlan) => {
                              const localeKey = `${cppPlan.name}::${localePlan.locale}`;
                              const localeExpanded = expandedLocales.has(localeKey);
                              const localeCfg = LOCALE_STATUS_CONFIG[localePlan.status];
                              const totalSS =
                                localePlan.screenshotFiles.iphone.length +
                                localePlan.screenshotFiles.ipad.length;
                              const totalPV =
                                localePlan.previewFiles.iphone.length +
                                localePlan.previewFiles.ipad.length;

                              return (
                                <div
                                  key={localePlan.locale}
                                  className={`${localePlan.excluded ? "opacity-50" : ""}`}
                                >
                                  {/* Locale row */}
                                  <div className="flex items-center gap-3 px-12 py-2">
                                    <button
                                      onClick={() => toggleLocale(cppPlan.name, localePlan.locale)}
                                      className="flex-shrink-0 text-slate-300"
                                    >
                                      <ChevronRight
                                        className={`h-3.5 w-3.5 transition-transform ${localeExpanded ? "rotate-90" : ""}`}
                                      />
                                    </button>
                                    <span className="text-xs font-medium text-slate-700 flex-shrink-0">
                                      {localeNameFromCode(localePlan.locale)}
                                    </span>
                                    <StatusBadge
                                      label={localeCfg.label}
                                      className={localeCfg.className}
                                    />
                                    <div className="flex-1 flex items-center gap-2 text-xs text-slate-400 ml-1">
                                      {localePlan.promoText && (
                                        <span className="truncate max-w-[120px]" title={localePlan.promoText}>
                                          &ldquo;{localePlan.promoText.slice(0, 30)}{localePlan.promoText.length > 30 ? "…" : ""}&rdquo;
                                        </span>
                                      )}
                                      {totalSS > 0 && <span>{totalSS} shot{totalSS !== 1 ? "s" : ""}</span>}
                                      {totalPV > 0 && <span>{totalPV} preview{totalPV !== 1 ? "s" : ""}</span>}
                                    </div>
                                    {localePlan.status !== "skip" && (
                                      <button
                                        onClick={() => toggleExcludeLocale(cppPlan.name, localePlan.locale)}
                                        className="text-xs text-slate-400 hover:text-slate-600 transition flex-shrink-0"
                                      >
                                        {localePlan.excluded ? "Include" : "Remove"}
                                      </button>
                                    )}
                                  </div>

                                  {/* Expanded locale details */}
                                  {localeExpanded && (
                                    <div className="px-20 pb-3 space-y-2">
                                      {localePlan.promoText && (
                                        <div>
                                          <p className="text-xs font-medium text-slate-400 mb-1">Promotional text</p>
                                          <p className="text-xs text-slate-600 bg-slate-50 rounded-lg p-2 whitespace-pre-wrap">
                                            {localePlan.promoText}
                                          </p>
                                        </div>
                                      )}
                                      {totalSS > 0 && (
                                        <div>
                                          <p className="text-xs font-medium text-slate-400 mb-1">Screenshots</p>
                                          {localePlan.screenshotFiles.iphone.length > 0 && (
                                            <p className="text-xs text-slate-500">
                                              iPhone: {localePlan.screenshotFiles.iphone.map((f) => f.name).join(", ")}
                                            </p>
                                          )}
                                          {localePlan.screenshotFiles.ipad.length > 0 && (
                                            <p className="text-xs text-slate-500">
                                              iPad: {localePlan.screenshotFiles.ipad.map((f) => f.name).join(", ")}
                                            </p>
                                          )}
                                        </div>
                                      )}
                                      {totalPV > 0 && (
                                        <div>
                                          <p className="text-xs font-medium text-slate-400 mb-1">App Previews</p>
                                          {localePlan.previewFiles.iphone.length > 0 && (
                                            <p className="text-xs text-slate-500">
                                              iPhone: {localePlan.previewFiles.iphone.map((f) => f.name).join(", ")}
                                            </p>
                                          )}
                                          {localePlan.previewFiles.ipad.length > 0 && (
                                            <p className="text-xs text-slate-500">
                                              iPad: {localePlan.previewFiles.ipad.map((f) => f.name).join(", ")}
                                            </p>
                                          )}
                                        </div>
                                      )}
                                      {localePlan.status === "not-in-app" && (
                                        <p className="text-xs text-amber-700 bg-amber-50 rounded-lg p-2 flex items-center gap-1.5">
                                          <AlertTriangle className="h-3 w-3 flex-shrink-0" />
                                          This locale will be added to the app&apos;s store page automatically before importing.
                                        </p>
                                      )}
                                      {localePlan.status === "new-locale" && (
                                        <p className="text-xs text-blue-600 bg-blue-50 rounded-lg p-2 flex items-center gap-1.5">
                                          <AlertTriangle className="h-3 w-3 flex-shrink-0" />
                                          This locale will be added to the CPP automatically.
                                        </p>
                                      )}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            )}

            {/* ── Uploading / Done step ─────────────────────────────────────── */}
            {(step === "uploading" || step === "done") && (
              <div className="divide-y divide-slate-100">
                {cppProgress.map((p) => (
                  <div key={p.name} className="px-6 py-4">
                    {/* CPP row */}
                    <div className="flex items-center gap-3">
                      <div className="flex-shrink-0">
                        {p.status === "pending" && (
                          <div className="h-5 w-5 rounded-full border-2 border-slate-200" />
                        )}
                        {p.status === "running" && (
                          <Loader2 className="h-5 w-5 text-[#0071E3] animate-spin" />
                        )}
                        {p.status === "done" && (
                          <CheckCircle2 className="h-5 w-5 text-green-500" />
                        )}
                        {p.status === "error" && (
                          <XCircle className="h-5 w-5 text-red-500" />
                        )}
                      </div>
                      <p className="text-sm font-semibold text-slate-800 flex-1 truncate">
                        {p.name}
                      </p>
                    </div>
                    {p.error && (
                      <p className="text-xs text-red-600 mt-1.5 ml-8 break-words">{p.error}</p>
                    )}

                    {/* Locale rows */}
                    {p.locales.length > 0 && (
                      <div className="mt-2 ml-8 space-y-1">
                        {p.locales.map((l) => (
                          <div key={l.locale} className="flex items-center gap-2">
                            <div className="flex-shrink-0">
                              {l.status === "pending" && (
                                <div className="h-3.5 w-3.5 rounded-full border border-slate-200" />
                              )}
                              {l.status === "running" && (
                                <Loader2 className="h-3.5 w-3.5 text-[#0071E3] animate-spin" />
                              )}
                              {l.status === "done" && (
                                <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
                              )}
                              {l.status === "error" && (
                                <XCircle className="h-3.5 w-3.5 text-red-500" />
                              )}
                            </div>
                            <span className="text-xs text-slate-600">{localeNameFromCode(l.locale)}</span>
                            {l.currentFile && (
                              <span className="text-xs text-slate-400 truncate">
                                — {l.currentFile}
                              </span>
                            )}
                            {l.error && (
                              <span className="text-xs text-red-600 truncate">{l.error}</span>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
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
                      {activeCppCount} CPP{activeCppCount !== 1 ? "s" : ""} to import
                      {notInAppLocaleCount > 0 && (
                        <span className="text-amber-600 ml-1">
                          ({notInAppLocaleCount} locale{notInAppLocaleCount !== 1 ? "s" : ""} will be added to app first)
                        </span>
                      )}
                    </span>
                    <button
                      onClick={startUpload}
                      disabled={activeCppCount === 0}
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
                        {doneCount} CPP{doneCount !== 1 ? "s" : ""} imported
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
