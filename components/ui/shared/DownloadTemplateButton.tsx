"use client";

/**
 * "Download template" button — THE single call-site component for the
 * bulk-import template download, used by BOTH modules in BOTH places
 * (apps-list page header + bulk-import wizard header). Extracted so a
 * future template change cannot make call sites diverge: generation
 * stays in lib/xlsx-template.ts + each module's parsers/template-spec.ts,
 * and this component only triggers it.
 *
 * `getSpec` is a factory prop (not an imported spec) on purpose: the
 * component must not import either module's template-spec itself, or
 * every consumer would bundle BOTH locale maps. Each call site passes
 * its own module's spec — Apple pages never carry Google's 82-locale
 * map and vice versa. xlsx stays in a lazy chunk loaded on click
 * (downloadXlsxTemplate does the dynamic import).
 */

import { useState } from "react";
import { Download, Loader2 } from "lucide-react";

import {
  downloadXlsxTemplate,
  type XlsxTemplateSpec,
} from "@/lib/xlsx-template";

export interface DownloadTemplateButtonProps {
  /** Module template spec factory (appleIapTemplateSpec /
   *  googleIapTemplateSpec). Called on click. */
  getSpec: () => XlsxTemplateSpec;
  /** Visible label — explicit by design (discoverability), never an
   *  unlabeled icon. */
  label?: string;
  /** Full styling control per module (Apple blue vs Google emerald). */
  className?: string;
  /** Route download errors into the caller's error UI; when omitted a
   *  small inline message renders under the button. */
  onError?: (message: string) => void;
}

const DEFAULT_CLASSES =
  "inline-flex shrink-0 items-center gap-1.5 rounded-md border border-slate-300 px-2.5 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-60";

export function DownloadTemplateButton({
  getSpec,
  label = "Download template",
  className = DEFAULT_CLASSES,
  onError,
}: DownloadTemplateButtonProps) {
  const [downloading, setDownloading] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);

  async function handleClick() {
    setDownloading(true);
    setInlineError(null);
    try {
      await downloadXlsxTemplate(getSpec());
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Template download failed";
      if (onError) onError(message);
      else setInlineError(message);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-end">
      <button
        type="button"
        onClick={handleClick}
        disabled={downloading}
        className={className}
      >
        {downloading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Download className="h-3.5 w-3.5" />
        )}
        {label}
      </button>
      {inlineError && (
        <span className="mt-1 text-[11px] text-red-600">{inlineError}</span>
      )}
    </span>
  );
}
