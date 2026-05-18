"use client";

/**
 * IAP.p2.b — Q-E click-to-enlarge screenshot thumbnail.
 *
 * Renders a thumbnail card; clicking it opens a fixed-position modal with
 * the full-size image. ESC closes; clicking the backdrop closes; the
 * image itself stops propagation so a stray click on the image doesn't
 * dismiss. When `thumbnailUrl` is omitted, renders an empty placeholder
 * and disables the click.
 *
 * Apple's `templateUrl` is the source for both sizes — caller resolves it
 * to a thumbnail vs full-size URL by swapping the `{w}/{h}/{f}` tokens.
 */
import { useEffect, useState } from "react";
import { Image as ImageIcon, X } from "lucide-react";

export interface ScreenshotPreviewProps {
  /** Thumbnail src. When undefined, an empty placeholder is rendered. */
  thumbnailUrl?: string;
  /** Larger src used in the modal. Defaults to `thumbnailUrl`. */
  fullUrl?: string;
  fileName?: string;
  /** Metadata line under the thumbnail ("1290 × 2796 · 1.4 MB"). */
  metaLine?: string;
}

export function ScreenshotPreview({
  thumbnailUrl,
  fullUrl,
  fileName,
  metaLine,
}: ScreenshotPreviewProps) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const enlargedSrc = fullUrl ?? thumbnailUrl;

  return (
    <>
      <button
        type="button"
        onClick={() => thumbnailUrl && setOpen(true)}
        disabled={!thumbnailUrl}
        aria-label={
          thumbnailUrl ? `Enlarge ${fileName ?? "screenshot"}` : "No screenshot"
        }
        className="block w-full overflow-hidden rounded-lg border border-slate-200 bg-slate-50 transition hover:border-slate-300 disabled:cursor-default"
      >
        {thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={thumbnailUrl}
            alt={fileName ?? "Screenshot"}
            className="block w-full"
          />
        ) : (
          <div className="flex aspect-[9/19.5] items-center justify-center text-slate-400">
            <ImageIcon className="h-12 w-12" aria-hidden />
          </div>
        )}
        {(fileName || metaLine) && (
          <div className="border-t border-slate-200 bg-white px-3 py-2 text-left">
            {fileName && (
              <p className="truncate text-xs font-medium text-slate-700">
                {fileName}
              </p>
            )}
            {metaLine && (
              <p className="text-[10px] text-slate-400">{metaLine}</p>
            )}
          </div>
        )}
      </button>

      {open && enlargedSrc && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Enlarged screenshot"
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/70 p-6"
        >
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close enlarged screenshot"
            className="absolute right-4 top-4 rounded-full p-2 text-white hover:bg-white/10"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={enlargedSrc}
            alt={fileName ?? "Screenshot"}
            onClick={(e) => e.stopPropagation()}
            className="max-h-[90vh] max-w-[90vw] rounded-lg shadow-2xl"
          />
        </div>
      )}
    </>
  );
}
