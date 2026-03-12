"use client";

import { useEffect, useState } from "react";
import { X, ExternalLink, ChevronRight } from "lucide-react";
import type { AppCustomProductPage, AppScreenshot, AppPreview, CppState, ScreenshotDisplayType, PreviewType } from "@/types/asc";
import { resolveVisibility } from "@/types/asc";
import type { VersionWithLocalizations, LocalizationWithMedia } from "@/app/api/asc/cpps/[cppId]/route";

interface PanelData {
  cpp: AppCustomProductPage;
  versions: VersionWithLocalizations[];
}

interface Props {
  cppId: string;
  cppName: string;
  onClose: () => void;
}

const STATE_STYLES: Record<CppState, string> = {
  PREPARE_FOR_SUBMISSION: "bg-slate-100 text-slate-600",
  READY_FOR_REVIEW: "bg-blue-50 text-blue-700",
  WAITING_FOR_REVIEW: "bg-yellow-50 text-yellow-700",
  IN_REVIEW: "bg-orange-50 text-orange-700",
  APPROVED: "bg-green-50 text-green-700",
  REJECTED: "bg-red-50 text-red-700",
};

const STATE_LABELS: Record<CppState, string> = {
  PREPARE_FOR_SUBMISSION: "Draft",
  READY_FOR_REVIEW: "Ready for Review",
  WAITING_FOR_REVIEW: "Waiting for Review",
  IN_REVIEW: "In Review",
  APPROVED: "Approved",
  REJECTED: "Rejected",
};

const SCREENSHOT_TYPE_LABELS: Record<ScreenshotDisplayType, string> = {
  APP_IPHONE_67: "iPhone 6.7\"",
  APP_IPHONE_65: "iPhone 6.5\"",
  APP_IPHONE_61: "iPhone 6.1\"",
  APP_IPHONE_55: "iPhone 5.5\"",
  APP_IPHONE_47: "iPhone 4.7\"",
  APP_IPHONE_40: "iPhone 4\"",
  APP_IPHONE_35: "iPhone 3.5\"",
  APP_IPAD_PRO_3GEN_129: "iPad Pro 12.9\" (3rd gen)",
  APP_IPAD_PRO_3GEN_11: "iPad Pro 11\"",
  APP_IPAD_PRO_129: "iPad Pro 12.9\"",
  APP_IPAD_105: "iPad 10.5\"",
  APP_IPAD_97: "iPad 9.7\"",
};

const PREVIEW_TYPE_LABELS: Record<PreviewType, string> = {
  IPHONE_67: "iPhone 6.7\"",
  IPHONE_65: "iPhone 6.5\"",
  IPHONE_61: "iPhone 6.1\"",
  IPHONE_58: "iPhone 5.8\"",
  IPHONE_55: "iPhone 5.5\"",
  IPHONE_47: "iPhone 4.7\"",
  IPHONE_40: "iPhone 4\"",
  IPAD_PRO_3GEN_129: "iPad Pro 12.9\" (3rd gen)",
  IPAD_PRO_3GEN_11: "iPad Pro 11\"",
  IPAD_PRO_129: "iPad Pro 12.9\"",
  IPAD_105: "iPad 10.5\"",
  IPAD_97: "iPad 9.7\"",
};

function screenshotUrl(screenshot: AppScreenshot): string | null {
  const asset = screenshot.attributes.imageAsset;
  if (!asset) return null;
  if (asset.templateUrl) {
    return asset.templateUrl
      .replace("{w}", "390")
      .replace("{h}", "844")
      .replace("{f}", "png");
  }
  return asset.url ?? null;
}

function previewThumbUrl(preview: AppPreview): string | null {
  const img = preview.attributes.previewImage;
  if (!img) return null;
  if (img.templateUrl) {
    return img.templateUrl
      .replace("{w}", "390")
      .replace("{h}", "844")
      .replace("{f}", "png");
  }
  return img.url ?? null;
}

// ── Collapsible localization row ───────────────────────────────────────────
function LocalizationRow({ loc }: { loc: LocalizationWithMedia }) {
  const [open, setOpen] = useState(false);
  const { localization, screenshotSets, previewSets } = loc;
  const totalScreenshots = screenshotSets.reduce((n, s) => n + s.screenshots.length, 0);
  const totalPreviews = previewSets.reduce((n, s) => n + s.previews.length, 0);

  return (
    <div className="border-b border-slate-100 last:border-b-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-3 px-6 py-4 text-left hover:bg-slate-50 transition-colors"
      >
        <ChevronRight
          className={`h-4 w-4 text-[#0071E3] flex-shrink-0 transition-transform duration-200 ${open ? "rotate-90" : ""}`}
        />
        <span className="font-semibold text-slate-900 text-sm flex-1">
          {localization.attributes.locale}
        </span>
        <span className="text-xs text-slate-400">
          {totalScreenshots > 0 && `${totalScreenshots} screenshot${totalScreenshots !== 1 ? "s" : ""}`}
          {totalScreenshots > 0 && totalPreviews > 0 && " · "}
          {totalPreviews > 0 && `${totalPreviews} preview${totalPreviews !== 1 ? "s" : ""}`}
          {totalScreenshots === 0 && totalPreviews === 0 && "No media"}
        </span>
      </button>

      {open && (
        <div className="px-6 pb-6 space-y-5 border-t border-slate-100 bg-white">
          {/* Promo text */}
          <div className="pt-4">
            <p className="text-xs font-medium text-slate-400 mb-1.5">Promotional Text</p>
            {localization.attributes.promotionalText ? (
              <p className="text-sm text-slate-800 whitespace-pre-wrap leading-relaxed">
                {localization.attributes.promotionalText}
              </p>
            ) : (
              <p className="text-xs text-slate-400 italic">Not set</p>
            )}
          </div>

          {/* Screenshots grouped by device */}
          {screenshotSets.filter((s) => s.screenshots.length > 0).length > 0 && (
            <div>
              <p className="text-xs font-medium text-slate-400 mb-2">Screenshots</p>
              <div className="space-y-3">
                {screenshotSets
                  .filter((s) => s.screenshots.length > 0)
                  .map(({ set, screenshots }) => (
                    <div key={set.id}>
                      <p className="text-xs text-slate-400 mb-1.5">
                        {SCREENSHOT_TYPE_LABELS[set.attributes.screenshotDisplayType] ?? set.attributes.screenshotDisplayType}
                        <span className="ml-1 text-slate-300">({screenshots.length})</span>
                      </p>
                      <div className="flex gap-1.5 flex-wrap">
                        {screenshots.map((screenshot) => {
                          const imgUrl = screenshotUrl(screenshot);
                          return imgUrl ? (
                            <a
                              key={screenshot.id}
                              href={imgUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img
                                src={imgUrl}
                                alt={screenshot.attributes.fileName}
                                className="h-24 w-auto rounded border border-slate-200 object-cover hover:opacity-80 transition-opacity"
                                onError={(e) => {
                                  (e.target as HTMLImageElement).style.display = "none";
                                }}
                              />
                            </a>
                          ) : (
                            <div
                              key={screenshot.id}
                              className="h-24 w-12 rounded border border-slate-200 bg-slate-50 flex items-center justify-center"
                            >
                              <span className="text-xs text-slate-400 text-center px-1 break-all">
                                {screenshot.attributes.fileName}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          )}

          {/* Previews grouped by device */}
          {previewSets.filter((s) => s.previews.length > 0).length > 0 && (
            <div>
              <p className="text-xs font-medium text-slate-400 mb-2">App Previews</p>
              <div className="space-y-3">
                {previewSets
                  .filter((s) => s.previews.length > 0)
                  .map(({ set, previews }) => (
                    <div key={set.id}>
                      <p className="text-xs text-slate-400 mb-1.5">
                        {PREVIEW_TYPE_LABELS[set.attributes.previewType] ?? set.attributes.previewType}
                        <span className="ml-1 text-slate-300">({previews.length})</span>
                      </p>
                      <div className="flex gap-1.5 flex-wrap">
                        {previews.map((preview) => {
                          const thumb = previewThumbUrl(preview);
                          const videoUrl = preview.attributes.videoUrl;
                          return (
                            <div key={preview.id} className="relative">
                              {thumb ? (
                                <a
                                  href={videoUrl ?? thumb}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  <img
                                    src={thumb}
                                    alt={preview.attributes.fileName}
                                    className="h-24 w-auto rounded border border-slate-200 object-cover hover:opacity-80 transition-opacity"
                                    onError={(e) => {
                                      (e.target as HTMLImageElement).style.display = "none";
                                    }}
                                  />
                                  <span className="absolute inset-0 flex items-center justify-center">
                                    <span className="bg-black/50 text-white rounded-full w-7 h-7 flex items-center justify-center text-xs">▶</span>
                                  </span>
                                </a>
                              ) : (
                                <div className="h-24 w-12 rounded border border-slate-200 bg-slate-50 flex items-center justify-center">
                                  <span className="text-xs text-slate-400 text-center px-1">
                                    {preview.attributes.fileName}
                                  </span>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────
export function CppDetailPanel({ cppId, cppName, onClose }: Props) {
  const [data, setData] = useState<PanelData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/asc/cpps/${cppId}`)
      .then((r) => r.json())
      .then((json) => {
        if (json.error) throw new Error(json.error);
        setData(json);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [cppId]);

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/40 z-40" onClick={onClose} />

      {/* Centered modal */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col">

          {/* Header */}
          <div className="flex items-center justify-between px-6 py-5 border-b border-slate-100 flex-shrink-0">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">{cppName}</h2>
              <p className="text-xs font-mono text-slate-400 mt-0.5">{cppId}</p>
            </div>
            <button
              onClick={onClose}
              className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Scrollable body */}
          <div className="flex-1 overflow-y-auto">
            {loading && (
              <div className="flex items-center justify-center py-20">
                <div className="h-6 w-6 rounded-full border-2 border-[#0071E3] border-t-transparent animate-spin" />
              </div>
            )}

            {error && (
              <div className="m-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 break-all">
                {error}
              </div>
            )}

            {data && (
              <>
                {/* General info */}
                <div className="px-6 py-5 border-b border-slate-100">
                  <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">General</p>
                  <dl className="grid grid-cols-2 gap-x-8 gap-y-3 text-sm">
                    <div>
                      <dt className="text-slate-500 text-xs mb-0.5">Name</dt>
                      <dd className="text-slate-900 font-medium">{data.cpp.attributes.name}</dd>
                    </div>
                    <div>
                      <dt className="text-slate-500 text-xs mb-0.5">Visibility</dt>
                      <dd className="text-slate-900 font-medium">
                        {resolveVisibility(data.cpp.attributes)}
                      </dd>
                    </div>
                    {data.cpp.attributes.url && (
                      <div className="col-span-2">
                        <dt className="text-slate-500 text-xs mb-0.5">URL</dt>
                        <dd>
                          <a
                            href={data.cpp.attributes.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[#0071E3] text-xs font-mono break-all hover:underline inline-flex items-center gap-1"
                          >
                            {data.cpp.attributes.url}
                            <ExternalLink className="h-3 w-3 flex-shrink-0" />
                          </a>
                        </dd>
                      </div>
                    )}
                  </dl>
                </div>

                {/* Versions */}
                {data.versions.map((versionData) => (
                  <div key={versionData.version.id}>
                    {/* Version header */}
                    <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 bg-slate-50">
                      <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                        Localizations
                      </p>
                      <span
                        className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${STATE_STYLES[versionData.version.attributes.state]}`}
                      >
                        {STATE_LABELS[versionData.version.attributes.state]}
                      </span>
                    </div>

                    {versionData.localizations.length === 0 ? (
                      <p className="px-6 py-5 text-sm text-slate-400 italic">No localizations.</p>
                    ) : (
                      <div>
                        {versionData.localizations.map((loc) => (
                          <LocalizationRow key={loc.localization.id} loc={loc} />
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
