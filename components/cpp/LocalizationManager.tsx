"use client";

import { useState } from "react";
import {
  ChevronRight,
  Plus,
  Upload,
  Loader2,
  X,
  FileImage,
  FileVideo,
  Smartphone,
  Tablet,
  FolderInput,
} from "lucide-react";
import { BulkImportDialog } from "@/components/cpp/BulkImportDialog";
import { localeNameFromCode, ALL_APPLE_LOCALES } from "@/lib/locale-utils";
import type {
  AppCustomProductPageLocalization,
  AppScreenshotSet,
  AppPreviewSet,
  AppScreenshot,
  AppPreview,
  AscApiResponse,
  ScreenshotDisplayType,
  PreviewType,
} from "@/types/asc";

const ALL_LOCALES = ALL_APPLE_LOCALES;

const SCREENSHOT_TYPES: { value: ScreenshotDisplayType; label: string }[] = [
  { value: "APP_IPHONE_67", label: 'iPhone 6.7"' },
  { value: "APP_IPHONE_65", label: 'iPhone 6.5"' },
  { value: "APP_IPHONE_61", label: 'iPhone 6.1"' },
  { value: "APP_IPHONE_55", label: 'iPhone 5.5"' },
  { value: "APP_IPHONE_47", label: 'iPhone 4.7"' },
  { value: "APP_IPAD_PRO_3GEN_129", label: 'iPad Pro 12.9" (3rd gen)' },
  { value: "APP_IPAD_PRO_3GEN_11", label: 'iPad Pro 11"' },
  { value: "APP_IPAD_PRO_129", label: 'iPad Pro 12.9"' },
  { value: "APP_IPAD_105", label: 'iPad 10.5"' },
];

const PREVIEW_TYPES: { value: PreviewType; label: string }[] = [
  { value: "IPHONE_67", label: 'iPhone 6.7" (14 Pro Max, 15, 16 series)' },
  { value: "IPHONE_65", label: 'iPhone 6.5" (11 Pro Max, XS Max)' },
  { value: "IPHONE_61", label: 'iPhone 6.1" (11, XR, 12–16 series)' },
  { value: "IPHONE_58", label: 'iPhone 5.8" (X, XS, 11 Pro)' },
  { value: "IPHONE_55", label: 'iPhone 5.5" (8 Plus, 7 Plus, 6s Plus)' },
  { value: "IPHONE_47", label: 'iPhone 4.7" (8, 7, 6s, SE 2nd gen)' },
  { value: "IPHONE_40", label: 'iPhone 4.0" (SE 1st gen, 5s)' },
  { value: "IPAD_PRO_3GEN_129", label: 'iPad Pro 12.9" (3rd gen+)' },
  { value: "IPAD_PRO_3GEN_11", label: 'iPad Pro 11" (1st gen+)' },
  { value: "IPAD_PRO_129", label: 'iPad Pro 12.9" (1st & 2nd gen)' },
  { value: "IPAD_105", label: 'iPad 10.5" (Air 3rd gen, Pro 10.5")' },
  { value: "IPAD_97", label: 'iPad 9.7" (Air 2nd gen and earlier)' },
];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function screenshotThumb(s: AppScreenshot): string | null {
  const t = s.attributes.imageAsset?.templateUrl;
  if (!t) return null;
  return t.replace("{w}", "80").replace("{h}", "160").replace("{f}", "png");
}

function previewThumb(p: AppPreview): string | null {
  const t = p.attributes.previewImage?.templateUrl;
  if (!t) return null;
  return t.replace("{w}", "80").replace("{h}", "160").replace("{f}", "png");
}

// ── Dropzone ──────────────────────────────────────────────────────────────────
interface DropzoneProps {
  accept: string;
  label: string;
  hint: string;
  disabled?: boolean;
  onStage: (files: File[]) => void;
}

function Dropzone({ accept, label, hint, disabled, onStage }: DropzoneProps) {
  const [dragging, setDragging] = useState(false);

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    setDragging(true);
  }
  function handleDragLeave() {
    setDragging(false);
  }
  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) onStage(files);
  }
  function handleClick() {
    if (disabled) return;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = true;
    input.onchange = (e) => {
      const files = Array.from((e.target as HTMLInputElement).files ?? []);
      if (files.length > 0) onStage(files);
    };
    input.click();
  }

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onClick={handleClick}
      className={`rounded-lg border-2 border-dashed p-3 text-center transition-colors ${
        disabled
          ? "border-slate-100 cursor-not-allowed opacity-50"
          : dragging
          ? "border-[#0071E3] bg-blue-50 cursor-copy"
          : "border-slate-200 hover:border-[#0071E3] cursor-pointer"
      }`}
    >
      <div className="flex flex-col items-center gap-0.5">
        <Upload className="h-3.5 w-3.5 text-slate-400" />
        <p className="text-xs text-slate-500">{label}</p>
        <p className="text-xs text-slate-400">{hint}</p>
      </div>
    </div>
  );
}

// ── Staged file list (no upload button — upload is shared at section level) ───
interface StagedFile {
  file: File;
  id: string;
}

interface StagedFilesProps {
  files: StagedFile[];
  icon: "image" | "video";
  uploading: boolean;
  onRemove: (id: string) => void;
}

function StagedFiles({ files, icon, uploading, onRemove }: StagedFilesProps) {
  if (files.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1">
      {files.map(({ file, id }) => (
        <li
          key={id}
          className="flex items-center gap-2 px-2.5 py-1.5 bg-white rounded-lg border border-slate-200 text-xs text-slate-700"
        >
          {icon === "image" ? (
            <FileImage className="h-3 w-3 text-slate-400 flex-shrink-0" />
          ) : (
            <FileVideo className="h-3 w-3 text-slate-400 flex-shrink-0" />
          )}
          <span className="flex-1 truncate">{file.name}</span>
          <span className="text-slate-400 flex-shrink-0">{formatBytes(file.size)}</span>
          {!uploading && (
            <button
              onClick={() => onRemove(id)}
              className="text-slate-300 hover:text-slate-500 transition flex-shrink-0"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

// ── Device tab bar ─────────────────────────────────────────────────────────────
interface DeviceTabsProps {
  active: "iphone" | "ipad";
  iphoneLabel: string | null;
  ipadLabel: string | null;
  onChange: (tab: "iphone" | "ipad") => void;
}

function DeviceTabs({ active, iphoneLabel, ipadLabel, onChange }: DeviceTabsProps) {
  return (
    <div className="flex gap-2 mb-4">
      <button
        onClick={() => onChange("iphone")}
        className={`flex items-center gap-2 px-4 py-2.5 rounded-xl border transition text-sm font-medium min-w-[130px] ${
          active === "iphone"
            ? "border-[#0071E3] bg-blue-50 text-[#0071E3]"
            : "border-slate-200 bg-white text-slate-500 hover:border-slate-300"
        }`}
      >
        <Smartphone className="h-4 w-4 flex-shrink-0" />
        <div className="text-left">
          <p className="text-xs font-semibold leading-tight">iPhone</p>
          {iphoneLabel && (
            <p className="text-xs leading-tight opacity-70">{iphoneLabel}</p>
          )}
        </div>
      </button>
      <button
        onClick={() => onChange("ipad")}
        className={`flex items-center gap-2 px-4 py-2.5 rounded-xl border transition text-sm font-medium min-w-[130px] ${
          active === "ipad"
            ? "border-[#0071E3] bg-blue-50 text-[#0071E3]"
            : "border-slate-200 bg-white text-slate-500 hover:border-slate-300"
        }`}
      >
        <Tablet className="h-4 w-4 flex-shrink-0" />
        <div className="text-left">
          <p className="text-xs font-semibold leading-tight">iPad</p>
          {ipadLabel && (
            <p className="text-xs leading-tight opacity-70">{ipadLabel}</p>
          )}
        </div>
      </button>
    </div>
  );
}

// ── LocalizationRow ────────────────────────────────────────────────────────────
interface LocalizationRowProps {
  localization: AppCustomProductPageLocalization;
  cppId: string;
}

function LocalizationRow({ localization, cppId }: LocalizationRowProps) {
  const [open, setOpen] = useState(false);

  // ── Promo text ──────────────────────────────────────────────────────────
  const [promoText, setPromoText] = useState(localization.attributes.promotionalText ?? "");
  const [editingPromo, setEditingPromo] = useState(false);
  const [savingPromo, setSavingPromo] = useState(false);
  const [promoMsg, setPromoMsg] = useState<string | null>(null);

  async function savePromoText() {
    setSavingPromo(true);
    setPromoMsg(null);
    try {
      const res = await fetch(`/api/asc/localizations/${localization.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ promotionalText: promoText }),
      });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error ?? "Save failed");
      }
      setEditingPromo(false);
      setPromoMsg("Saved");
      setTimeout(() => setPromoMsg(null), 3000);
    } catch (err) {
      setPromoMsg(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSavingPromo(false);
    }
  }

  // ── Device sets / assets ────────────────────────────────────────────────
  const [setsLoaded, setSetsLoaded] = useState(false);
  const [loadingSets, setLoadingSets] = useState(false);
  const [availableScreenshotTypes, setAvailableScreenshotTypes] = useState<
    { value: ScreenshotDisplayType; label: string }[]
  >([]);
  const [availablePreviewTypes, setAvailablePreviewTypes] = useState<
    { value: PreviewType; label: string }[]
  >([]);
  const [screenshotsByType, setScreenshotsByType] = useState<
    Partial<Record<ScreenshotDisplayType, AppScreenshot[]>>
  >({});
  const [previewsByType, setPreviewsByType] = useState<
    Partial<Record<PreviewType, AppPreview[]>>
  >({});
  const [screenshotSetCache, setScreenshotSetCache] = useState<
    Map<ScreenshotDisplayType, string>
  >(new Map());
  const [previewSetCache, setPreviewSetCache] = useState<Map<PreviewType, string>>(
    new Map()
  );

  // ── Tabs ────────────────────────────────────────────────────────────────
  const [screenshotTab, setScreenshotTab] = useState<"iphone" | "ipad">("iphone");
  const [previewTab, setPreviewTab] = useState<"iphone" | "ipad">("iphone");

  // ── Staged files per device type ────────────────────────────────────────
  const [stagedByScreenshotType, setStagedByScreenshotType] = useState<
    Partial<Record<ScreenshotDisplayType, StagedFile[]>>
  >({});
  const [stagedByPreviewType, setStagedByPreviewType] = useState<
    Partial<Record<PreviewType, StagedFile[]>>
  >({});

  // ── Upload state ────────────────────────────────────────────────────────
  const [uploadingScreenshots, setUploadingScreenshots] = useState(false);
  const [uploadingPreviews, setUploadingPreviews] = useState(false);
  const [screenshotUploadMsg, setScreenshotUploadMsg] = useState<string | null>(null);
  const [previewUploadMsg, setPreviewUploadMsg] = useState<string | null>(null);

  // ── Load device sets + existing assets ──────────────────────────────────
  async function loadDeviceSets() {
    setLoadingSets(true);
    try {
      const [sRes, pRes] = await Promise.all([
        fetch(`/api/asc/screenshot-sets?localizationId=${localization.id}`),
        fetch(`/api/asc/preview-sets?localizationId=${localization.id}`),
      ]);

      if (sRes.ok) {
        const sData = (await sRes.json()) as AscApiResponse<AppScreenshotSet[]>;
        const sets = sData.data ?? [];
        const allScreenshots = (sData.included ?? []).filter(
          (r) => r.type === "appScreenshots"
        ) as unknown as AppScreenshot[];

        const cache = new Map<ScreenshotDisplayType, string>();
        const byType: Partial<Record<ScreenshotDisplayType, AppScreenshot[]>> = {};

        sets.forEach((set) => {
          const type = set.attributes.screenshotDisplayType;
          cache.set(type, set.id);
          const rels = set.relationships as {
            appScreenshots?: { data?: Array<{ id: string }> };
          };
          const ids = rels?.appScreenshots?.data?.map((d) => d.id) ?? [];
          byType[type] = allScreenshots.filter((s) => ids.includes(s.id));
        });

        setScreenshotSetCache(cache);
        setScreenshotsByType(byType);
        const types = sets.map((s) => {
          const found = SCREENSHOT_TYPES.find(
            (t) => t.value === s.attributes.screenshotDisplayType
          );
          return (
            found ?? {
              value: s.attributes.screenshotDisplayType,
              label: s.attributes.screenshotDisplayType,
            }
          );
        });
        setAvailableScreenshotTypes(types);
      }

      if (pRes.ok) {
        const pData = (await pRes.json()) as AscApiResponse<AppPreviewSet[]>;
        const sets = pData.data ?? [];
        const allPreviews = (pData.included ?? []).filter(
          (r) => r.type === "appPreviews"
        ) as unknown as AppPreview[];

        const cache = new Map<PreviewType, string>();
        const byType: Partial<Record<PreviewType, AppPreview[]>> = {};

        sets.forEach((set) => {
          const type = set.attributes.previewType;
          cache.set(type, set.id);
          const rels = set.relationships as {
            appPreviews?: { data?: Array<{ id: string }> };
          };
          const ids = rels?.appPreviews?.data?.map((d) => d.id) ?? [];
          byType[type] = allPreviews.filter((p) => ids.includes(p.id));
        });

        setPreviewSetCache(cache);
        setPreviewsByType(byType);
        const types = sets.map((s) => {
          const found = PREVIEW_TYPES.find((t) => t.value === s.attributes.previewType);
          return (
            found ?? { value: s.attributes.previewType, label: s.attributes.previewType }
          );
        });
        setAvailablePreviewTypes(types);
      }
    } catch {
      // keep fallback
    } finally {
      setLoadingSets(false);
      setSetsLoaded(true);
    }
  }

  function toggleOpen() {
    const next = !open;
    setOpen(next);
    if (next && !setsLoaded) loadDeviceSets();
  }

  // ── Set ID helpers ──────────────────────────────────────────────────────
  async function getOrCreateScreenshotSet(type: ScreenshotDisplayType): Promise<string> {
    if (screenshotSetCache.has(type)) return screenshotSetCache.get(type)!;
    const res = await fetch("/api/asc/screenshot-sets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ localizationId: localization.id, screenshotDisplayType: type }),
    });
    if (!res.ok) {
      if (res.status === 409) {
        const setsRes = await fetch(
          `/api/asc/screenshot-sets?localizationId=${localization.id}`
        );
        if (setsRes.ok) {
          const d = (await setsRes.json()) as { data?: AppScreenshotSet[] };
          const existing = d.data?.find(
            (s) => s.attributes.screenshotDisplayType === type
          );
          if (existing) {
            setScreenshotSetCache((prev) => new Map(prev).set(type, existing.id));
            return existing.id;
          }
        }
      }
      const errData = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(errData.error ?? `Failed to get screenshot set (${res.status})`);
    }
    const data = (await res.json()) as { data: AppScreenshotSet };
    const setId = data.data.id;
    setScreenshotSetCache((prev) => new Map(prev).set(type, setId));
    return setId;
  }

  async function getOrCreatePreviewSet(type: PreviewType): Promise<string> {
    if (previewSetCache.has(type)) return previewSetCache.get(type)!;
    const res = await fetch("/api/asc/preview-sets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ localizationId: localization.id, previewType: type }),
    });
    if (!res.ok) {
      if (res.status === 409) {
        const setsRes = await fetch(
          `/api/asc/preview-sets?localizationId=${localization.id}`
        );
        if (setsRes.ok) {
          const d = (await setsRes.json()) as { data?: AppPreviewSet[] };
          const existing = d.data?.find((s) => s.attributes.previewType === type);
          if (existing) {
            setPreviewSetCache((prev) => new Map(prev).set(type, existing.id));
            return existing.id;
          }
        }
      }
      const errData = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(errData.error ?? `Failed to get preview set (${res.status})`);
    }
    const data = (await res.json()) as { data: AppPreviewSet };
    const setId = data.data.id;
    setPreviewSetCache((prev) => new Map(prev).set(type, setId));
    return setId;
  }

  // ── Staging ─────────────────────────────────────────────────────────────
  function stageScreenshots(type: ScreenshotDisplayType, files: File[]) {
    setStagedByScreenshotType((prev) => ({
      ...prev,
      [type]: [
        ...(prev[type] ?? []),
        ...files.map((f) => ({ file: f, id: `${f.name}-${Date.now()}-${Math.random()}` })),
      ],
    }));
  }

  function removeStagedScreenshot(type: ScreenshotDisplayType, id: string) {
    setStagedByScreenshotType((prev) => ({
      ...prev,
      [type]: (prev[type] ?? []).filter((f) => f.id !== id),
    }));
  }

  function stagePreviews(type: PreviewType, files: File[]) {
    setStagedByPreviewType((prev) => ({
      ...prev,
      [type]: [
        ...(prev[type] ?? []),
        ...files.map((f) => ({ file: f, id: `${f.name}-${Date.now()}-${Math.random()}` })),
      ],
    }));
  }

  function removeStagedPreview(type: PreviewType, id: string) {
    setStagedByPreviewType((prev) => ({
      ...prev,
      [type]: (prev[type] ?? []).filter((f) => f.id !== id),
    }));
  }

  // ── Upload all ──────────────────────────────────────────────────────────
  async function uploadAllScreenshots() {
    const entries = (
      Object.entries(stagedByScreenshotType) as [ScreenshotDisplayType, StagedFile[]][]
    ).filter(([, files]) => files.length > 0);
    if (!entries.length) return;
    setUploadingScreenshots(true);
    setScreenshotUploadMsg(null);
    let total = 0;
    try {
      for (const [type, files] of entries) {
        const setId = await getOrCreateScreenshotSet(type);
        for (const { file } of files) {
          const fd = new FormData();
          fd.append("screenshotSetId", setId);
          fd.append("file", file);
          const res = await fetch("/api/asc/upload", { method: "POST", body: fd });
          if (!res.ok)
            throw new Error(
              ((await res.json()) as { error?: string }).error ?? "Upload failed"
            );
          total++;
        }
      }
      setStagedByScreenshotType({});
      setScreenshotUploadMsg(
        `${total} screenshot${total !== 1 ? "s" : ""} uploaded successfully`
      );
      await loadDeviceSets();
      setTimeout(() => setScreenshotUploadMsg(null), 5000);
    } catch (err) {
      setScreenshotUploadMsg(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploadingScreenshots(false);
    }
  }

  async function uploadAllPreviews() {
    const entries = (
      Object.entries(stagedByPreviewType) as [PreviewType, StagedFile[]][]
    ).filter(([, files]) => files.length > 0);
    if (!entries.length) return;
    setUploadingPreviews(true);
    setPreviewUploadMsg(null);
    let total = 0;
    try {
      for (const [type, files] of entries) {
        const setId = await getOrCreatePreviewSet(type);
        for (const { file } of files) {
          const fd = new FormData();
          fd.append("previewSetId", setId);
          fd.append("file", file);
          const res = await fetch("/api/asc/upload-preview", {
            method: "POST",
            body: fd,
          });
          if (!res.ok)
            throw new Error(
              ((await res.json()) as { error?: string }).error ?? "Upload failed"
            );
          total++;
        }
      }
      setStagedByPreviewType({});
      setPreviewUploadMsg(
        `${total} preview${total !== 1 ? "s" : ""} uploaded successfully`
      );
      await loadDeviceSets();
      setTimeout(() => setPreviewUploadMsg(null), 5000);
    } catch (err) {
      setPreviewUploadMsg(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploadingPreviews(false);
    }
  }

  // ── Derived ─────────────────────────────────────────────────────────────
  const iphoneScreenshotTypes = availableScreenshotTypes.filter((t) =>
    t.value.includes("IPHONE")
  );
  const ipadScreenshotTypes = availableScreenshotTypes.filter((t) =>
    t.value.includes("IPAD")
  );
  const activeScreenshotTypes =
    screenshotTab === "iphone" ? iphoneScreenshotTypes : ipadScreenshotTypes;

  // Match preview type to the screenshot type of the same device category
  // ScreenshotDisplayType has "APP_" prefix; PreviewType does not (e.g. APP_IPHONE_65 → IPHONE_65)
  const matchedIphonePreview = iphoneScreenshotTypes[0]
    ? availablePreviewTypes.find(
        (t) => t.value === (iphoneScreenshotTypes[0].value.replace("APP_", "") as PreviewType)
      ) ?? null
    : null;
  const matchedIpadPreview = ipadScreenshotTypes[0]
    ? availablePreviewTypes.find(
        (t) => t.value === (ipadScreenshotTypes[0].value.replace("APP_", "") as PreviewType)
      ) ?? null
    : null;
  const activePreviewTypes =
    previewTab === "iphone"
      ? matchedIphonePreview ? [matchedIphonePreview] : []
      : matchedIpadPreview ? [matchedIpadPreview] : [];

  const totalStagedScreenshots = Object.values(stagedByScreenshotType).reduce(
    (acc, f) => acc + (f?.length ?? 0),
    0
  );
  const totalStagedPreviews = Object.values(stagedByPreviewType).reduce(
    (acc, f) => acc + (f?.length ?? 0),
    0
  );

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div className="border-b border-slate-100 last:border-b-0">
      <button
        onClick={toggleOpen}
        className="w-full flex items-center gap-3 px-5 py-4 text-left hover:bg-slate-50 transition-colors"
      >
        <ChevronRight
          className={`h-4 w-4 text-[#0071E3] flex-shrink-0 transition-transform duration-200 ${
            open ? "rotate-90" : ""
          }`}
        />
        <span className="font-semibold text-slate-900 text-sm flex-1">
          {localeNameFromCode(localization.attributes.locale)}
        </span>
        {localization.attributes.promotionalText && (
          <span className="text-xs text-slate-400 max-w-[200px] truncate hidden sm:block">
            {localization.attributes.promotionalText}
          </span>
        )}
        <span className="text-xs font-mono text-slate-300">{localization.id.slice(0, 8)}…</span>
      </button>

      {open && (
        <div className="px-5 pb-6 space-y-6 border-t border-slate-100 bg-slate-50/30">
          {/* Promotional Text */}
          <div className="pt-4">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                Promotional Text
              </p>
              {!editingPromo && (
                <button
                  onClick={() => setEditingPromo(true)}
                  className="text-xs text-[#0071E3] hover:underline"
                >
                  Edit
                </button>
              )}
            </div>
            {editingPromo ? (
              <div className="space-y-2">
                <textarea
                  value={promoText}
                  onChange={(e) => setPromoText(e.target.value)}
                  rows={4}
                  maxLength={170}
                  placeholder="Promotional text for this locale…"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#0071E3] focus:border-transparent resize-none bg-white"
                />
                <div className="flex items-center justify-between">
                  <span className="text-xs text-slate-400">{promoText.length}/170</span>
                  <div className="flex gap-2">
                    <button
                      onClick={() => {
                        setPromoText(localization.attributes.promotionalText ?? "");
                        setEditingPromo(false);
                        setPromoMsg(null);
                      }}
                      disabled={savingPromo}
                      className="px-3 py-1.5 text-xs font-medium text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 transition"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={savePromoText}
                      disabled={savingPromo}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-[#0071E3] hover:bg-[#0077ED] rounded-lg transition disabled:opacity-50"
                    >
                      {savingPromo ? (
                        <>
                          <Loader2 className="h-3 w-3 animate-spin" />
                          Saving…
                        </>
                      ) : (
                        "Save"
                      )}
                    </button>
                  </div>
                </div>
                {promoMsg && (
                  <p
                    className={`text-xs px-3 py-1.5 rounded-lg border ${
                      promoMsg === "Saved"
                        ? "bg-green-50 border-green-200 text-green-700"
                        : "bg-red-50 border-red-200 text-red-700"
                    }`}
                  >
                    {promoMsg}
                  </p>
                )}
              </div>
            ) : (
              <div>
                {promoText ? (
                  <p className="text-sm text-slate-700 whitespace-pre-wrap leading-relaxed">
                    {promoText}
                  </p>
                ) : (
                  <p className="text-xs text-slate-400 italic">
                    No promotional text — click Edit to add.
                  </p>
                )}
                {promoMsg === "Saved" && (
                  <p className="text-xs text-green-700 mt-1">Saved successfully</p>
                )}
              </div>
            )}
          </div>

          {/* ── Screenshots ───────────────────────────────────────────────── */}
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">
              Screenshots
            </p>

            {loadingSets ? (
              <div className="flex items-center gap-2 py-4">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-400" />
                <span className="text-xs text-slate-400">Loading device types…</span>
              </div>
            ) : (
              <>
                <DeviceTabs
                  active={screenshotTab}
                  iphoneLabel={iphoneScreenshotTypes[0]?.label ?? null}
                  ipadLabel={ipadScreenshotTypes[0]?.label ?? null}
                  onChange={setScreenshotTab}
                />

                {activeScreenshotTypes.length === 0 ? (() => {
                  const fallback = (screenshotTab === "iphone"
                    ? "APP_IPHONE_67"
                    : "APP_IPAD_PRO_3GEN_129") as ScreenshotDisplayType;
                  const staged = stagedByScreenshotType[fallback] ?? [];
                  return (
                    <div className="mb-4">
                      <div className="mb-3 p-4 bg-white rounded-xl border border-slate-100 text-center">
                        <FileImage className="h-6 w-6 text-slate-300 mx-auto mb-1" />
                        <p className="text-xs text-slate-400">
                          There&apos;s no screenshot of this device type.
                        </p>
                      </div>
                      <Dropzone
                        accept="image/png,image/jpeg"
                        label="Drop screenshots or click to browse"
                        hint="PNG or JPEG"
                        disabled={uploadingScreenshots}
                        onStage={(files) => stageScreenshots(fallback, files)}
                      />
                      <StagedFiles
                        files={staged}
                        icon="image"
                        uploading={uploadingScreenshots}
                        onRemove={(id) => removeStagedScreenshot(fallback, id)}
                      />
                    </div>
                  );
                })() : (
                  activeScreenshotTypes.map((t) => {
                    const existing = screenshotsByType[t.value] ?? [];
                    const staged = stagedByScreenshotType[t.value] ?? [];
                    return (
                      <div key={t.value} className="mb-4">
                        <p className="text-xs font-medium text-slate-500 mb-2">{t.label}</p>

                        {/* Existing assets */}
                        {existing.length > 0 ? (
                          <div className="mb-3 p-3 bg-white rounded-xl border border-slate-200">
                            <p className="text-xs text-slate-400 mb-2">
                              Current ({existing.length})
                            </p>
                            <div className="flex flex-wrap gap-2">
                              {existing.map((s) => {
                                const thumb = screenshotThumb(s);
                                return thumb ? (
                                  <img
                                    key={s.id}
                                    src={thumb}
                                    alt={s.attributes.fileName}
                                    className="h-20 rounded border border-slate-200 object-cover"
                                  />
                                ) : (
                                  <div
                                    key={s.id}
                                    className="h-20 w-10 rounded border border-slate-200 bg-slate-100 flex items-center justify-center"
                                  >
                                    <FileImage className="h-4 w-4 text-slate-400" />
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        ) : (
                          <div className="mb-3 p-3 bg-white rounded-xl border border-slate-100 text-center">
                            <p className="text-xs text-slate-400">No screenshots yet</p>
                          </div>
                        )}

                        {/* Upload dropzone */}
                        <Dropzone
                          accept="image/png,image/jpeg"
                          label="Drop screenshots or click to browse"
                          hint="PNG or JPEG"
                          disabled={uploadingScreenshots}
                          onStage={(files) => stageScreenshots(t.value, files)}
                        />
                        <StagedFiles
                          files={staged}
                          icon="image"
                          uploading={uploadingScreenshots}
                          onRemove={(id) => removeStagedScreenshot(t.value, id)}
                        />
                      </div>
                    );
                  })
                )}

                {/* Upload all button */}
                {totalStagedScreenshots > 0 && (
                  <button
                    onClick={uploadAllScreenshots}
                    disabled={uploadingScreenshots}
                    className="flex items-center gap-1.5 mt-2 px-4 py-2 text-xs font-medium text-white bg-[#0071E3] hover:bg-[#0077ED] rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {uploadingScreenshots ? (
                      <>
                        <Loader2 className="h-3 w-3 animate-spin" />
                        Uploading…
                      </>
                    ) : (
                      <>
                        <Upload className="h-3 w-3" />
                        Upload {totalStagedScreenshots} screenshot
                        {totalStagedScreenshots !== 1 ? "s" : ""}
                      </>
                    )}
                  </button>
                )}

                {screenshotUploadMsg && (
                  <p
                    className={`mt-2 text-xs px-3 py-1.5 rounded-lg border ${
                      screenshotUploadMsg.toLowerCase().includes("fail") ||
                      screenshotUploadMsg.toLowerCase().includes("error")
                        ? "bg-red-50 border-red-200 text-red-700"
                        : "bg-green-50 border-green-200 text-green-700"
                    }`}
                  >
                    {screenshotUploadMsg}
                  </p>
                )}
              </>
            )}
          </div>

          {/* ── App Previews ───────────────────────────────────────────────── */}
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">
              App Previews
            </p>

            {loadingSets ? (
              <div className="flex items-center gap-2 py-4">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-400" />
                <span className="text-xs text-slate-400">Loading device types…</span>
              </div>
            ) : (
              <>
                <DeviceTabs
                  active={previewTab}
                  iphoneLabel={matchedIphonePreview?.label ?? null}
                  ipadLabel={matchedIpadPreview?.label ?? null}
                  onChange={setPreviewTab}
                />

                {activePreviewTypes.length === 0 ? (() => {
                  const fallback = (previewTab === "iphone"
                    ? (matchedIphonePreview?.value ?? "IPHONE_67")
                    : (matchedIpadPreview?.value ?? "IPAD_PRO_3GEN_129")) as PreviewType;
                  const staged = stagedByPreviewType[fallback] ?? [];
                  return (
                    <div className="mb-4">
                      <div className="mb-3 p-4 bg-white rounded-xl border border-slate-100 text-center">
                        <FileVideo className="h-6 w-6 text-slate-300 mx-auto mb-1" />
                        <p className="text-xs text-slate-400">
                          There&apos;s no preview of this device type.
                        </p>
                      </div>
                      <Dropzone
                        accept="video/*"
                        label="Drop videos or click to browse"
                        hint="MOV or MP4"
                        disabled={uploadingPreviews}
                        onStage={(files) => stagePreviews(fallback, files)}
                      />
                      <StagedFiles
                        files={staged}
                        icon="video"
                        uploading={uploadingPreviews}
                        onRemove={(id) => removeStagedPreview(fallback, id)}
                      />
                    </div>
                  );
                })() : (
                  activePreviewTypes.map((t) => {
                    const existing = previewsByType[t.value] ?? [];
                    const staged = stagedByPreviewType[t.value] ?? [];
                    return (
                      <div key={t.value} className="mb-4">
                        <p className="text-xs font-medium text-slate-500 mb-2">{t.label}</p>

                        {/* Existing assets */}
                        {existing.length > 0 ? (
                          <div className="mb-3 p-3 bg-white rounded-xl border border-slate-200">
                            <p className="text-xs text-slate-400 mb-2">
                              Current ({existing.length})
                            </p>
                            <div className="flex flex-wrap gap-2">
                              {existing.map((p) => {
                                const thumb = previewThumb(p);
                                return thumb ? (
                                  <div key={p.id} className="relative">
                                    <img
                                      src={thumb}
                                      alt={p.attributes.fileName}
                                      className="h-20 rounded border border-slate-200 object-cover"
                                    />
                                    <div className="absolute inset-0 flex items-center justify-center">
                                      <div className="w-5 h-5 rounded-full bg-black/50 flex items-center justify-center">
                                        <div className="w-0 h-0 border-t-[4px] border-t-transparent border-l-[7px] border-l-white border-b-[4px] border-b-transparent ml-0.5" />
                                      </div>
                                    </div>
                                  </div>
                                ) : (
                                  <div
                                    key={p.id}
                                    className="h-20 w-10 rounded border border-slate-200 bg-slate-100 flex items-center justify-center"
                                  >
                                    <FileVideo className="h-4 w-4 text-slate-400" />
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        ) : (
                          <div className="mb-3 p-3 bg-white rounded-xl border border-slate-100 text-center">
                            <p className="text-xs text-slate-400">No previews yet</p>
                          </div>
                        )}

                        {/* Upload dropzone */}
                        <Dropzone
                          accept="video/*"
                          label="Drop videos or click to browse"
                          hint="MOV or MP4"
                          disabled={uploadingPreviews}
                          onStage={(files) => stagePreviews(t.value, files)}
                        />
                        <StagedFiles
                          files={staged}
                          icon="video"
                          uploading={uploadingPreviews}
                          onRemove={(id) => removeStagedPreview(t.value, id)}
                        />
                      </div>
                    );
                  })
                )}

                {/* Upload all button */}
                {totalStagedPreviews > 0 && (
                  <button
                    onClick={uploadAllPreviews}
                    disabled={uploadingPreviews}
                    className="flex items-center gap-1.5 mt-2 px-4 py-2 text-xs font-medium text-white bg-[#0071E3] hover:bg-[#0077ED] rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {uploadingPreviews ? (
                      <>
                        <Loader2 className="h-3 w-3 animate-spin" />
                        Uploading…
                      </>
                    ) : (
                      <>
                        <Upload className="h-3 w-3" />
                        Upload {totalStagedPreviews} preview
                        {totalStagedPreviews !== 1 ? "s" : ""}
                      </>
                    )}
                  </button>
                )}

                {previewUploadMsg && (
                  <p
                    className={`mt-2 text-xs px-3 py-1.5 rounded-lg border ${
                      previewUploadMsg.toLowerCase().includes("fail") ||
                      previewUploadMsg.toLowerCase().includes("error")
                        ? "bg-red-50 border-red-200 text-red-700"
                        : "bg-green-50 border-green-200 text-green-700"
                    }`}
                  >
                    {previewUploadMsg}
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────
interface Props {
  cppId: string;
  versionId: string;
  initialLocalizations: AppCustomProductPageLocalization[];
  appId: string;
}

export function LocalizationManager({ cppId, versionId, initialLocalizations, appId }: Props) {
  const [localizations, setLocalizations] = useState(initialLocalizations);
  const [showAddForm, setShowAddForm] = useState(false);
  const [showBulkImport, setShowBulkImport] = useState(false);
  const [newLocale, setNewLocale] = useState("");
  const [newPromoText, setNewPromoText] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const usedLocales = new Set(localizations.map((l) => l.attributes.locale));
  const availableLocales = ALL_LOCALES.filter((l) => !usedLocales.has(l.value));

  function openAddForm() {
    setShowAddForm(true);
    setNewLocale(availableLocales[0]?.value ?? "");
    setAddError(null);
  }

  function closeAddForm() {
    setShowAddForm(false);
    setNewLocale("");
    setNewPromoText("");
    setAddError(null);
  }

  async function handleAddLocalization() {
    if (!newLocale) return;
    setAdding(true);
    setAddError(null);
    try {
      const res = await fetch(`/api/asc/cpps/${cppId}/localizations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          versionId,
          locale: newLocale,
          promotionalText: newPromoText || undefined,
        }),
      });
      const data = (await res.json()) as {
        data?: AppCustomProductPageLocalization;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "Failed to add localization");
      if (data.data) setLocalizations((prev) => [...prev, data.data!]);
      closeAddForm();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "Error adding localization");
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        {localizations.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-400">
            No localizations yet. Add one below.
          </div>
        ) : (
          localizations.map((loc) => (
            <LocalizationRow key={loc.id} localization={loc} cppId={cppId} />
          ))
        )}
      </div>

      {!showAddForm ? (
        <div className="flex items-center gap-2 flex-wrap">
          {availableLocales.length > 0 && (
            <button
              onClick={openAddForm}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-[#0071E3] border border-[#0071E3] rounded-lg hover:bg-blue-50 transition"
            >
              <Plus className="h-4 w-4" />
              Add Localization
            </button>
          )}
          <button
            onClick={() => setShowBulkImport(true)}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 transition"
          >
            <FolderInput className="h-4 w-4" />
            Bulk Import
          </button>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-slate-700">New Localization</p>
            <button
              onClick={closeAddForm}
              className="text-slate-400 hover:text-slate-600 transition"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-slate-700">Locale</label>
            <select
              value={newLocale}
              onChange={(e) => setNewLocale(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#0071E3] focus:border-transparent bg-white"
            >
              {availableLocales.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-slate-700">
              Promotional Text{" "}
              <span className="text-slate-400 font-normal">(optional)</span>
            </label>
            <textarea
              value={newPromoText}
              onChange={(e) => setNewPromoText(e.target.value)}
              rows={3}
              maxLength={170}
              placeholder="Promotional text for this locale…"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#0071E3] focus:border-transparent resize-none"
            />
            <p className="text-xs text-slate-400 text-right">{newPromoText.length}/170</p>
          </div>

          {addError && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {addError}
            </p>
          )}

          <div className="flex gap-3">
            <button
              onClick={closeAddForm}
              className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition"
            >
              Cancel
            </button>
            <button
              onClick={handleAddLocalization}
              disabled={adding || !newLocale}
              className="px-4 py-2 text-sm font-medium text-white bg-[#0071E3] hover:bg-[#0077ED] rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {adding ? "Adding…" : "Add Localization"}
            </button>
          </div>
        </div>
      )}

      {showBulkImport && (
        <BulkImportDialog
          cppId={cppId}
          versionId={versionId}
          appId={appId}
          existingLocalizations={localizations}
          onClose={() => setShowBulkImport(false)}
          onComplete={() => {
            // Refresh localizations list by re-fetching from API
            fetch(`/api/asc/cpps/${cppId}`)
              .then((r) => r.json())
              .then((json) => {
                const versions = json.versions ?? [];
                if (versions[0]?.localizations) {
                  setLocalizations(
                    versions[0].localizations.map(
                      (v: { localization: AppCustomProductPageLocalization }) => v.localization
                    )
                  );
                }
              })
              .catch(() => {});
          }}
        />
      )}
    </div>
  );
}
