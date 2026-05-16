"use client";

import { useCallback, useState } from "react";
import { useDropzone, type FileRejection } from "react-dropzone";
import { Upload, Image as ImageIcon, X, CheckCircle } from "lucide-react";

interface Props {
  /** Current staged filename (parent state). Null when no screenshot. */
  filename: string | null;
  /** Whether the IAP has already been pushed to Apple. When true, the screenshot
   *  upload is owned by Apple's side and managed via Apple Connect; this
   *  component renders a read-only summary instead. */
  syncedToApple: boolean;
  /** Called when the user stages a new file (drag-drop or click).
   *  Parent stores the File reference for the create-on-apple FormData payload. */
  onFileStaged: (file: File) => void;
  /** Called when the user clears the staged file. */
  onRemove?: () => void;
}

const MAX_SIZE = 8 * 1024 * 1024;

/**
 * Staging-only screenshot input (IAP.o.6a).
 *
 * Bytes stay client-side in the parent form's state until the user clicks
 * "Create on Apple", at which point the file is sent as part of the
 * /create-on-apple multipart FormData. No upfront server round-trip.
 */
export function ScreenshotUpload({
  filename,
  syncedToApple,
  onFileStaged,
  onRemove,
}: Props) {
  const [error, setError] = useState<string | null>(null);

  const handleDrop = useCallback(
    (accepted: File[], rejected: FileRejection[]) => {
      const file = accepted[0];
      if (!file) {
        const rej = rejected[0]?.errors[0];
        if (rej?.code === "file-too-large") {
          setError("File exceeds 8MB limit.");
        } else if (rej?.code === "file-invalid-type") {
          setError("PNG or JPEG required.");
        } else if (rej) {
          setError(rej.message);
        }
        return;
      }
      setError(null);
      onFileStaged(file);
    },
    [onFileStaged],
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop: handleDrop,
    accept: { "image/png": [".png"], "image/jpeg": [".jpg", ".jpeg"] },
    maxSize: MAX_SIZE,
    multiple: false,
    disabled: syncedToApple,
  });

  if (syncedToApple) {
    return (
      <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/30 p-4 flex items-center gap-3">
        <ImageIcon className="h-5 w-5 text-slate-400 dark:text-slate-500 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-slate-700 dark:text-slate-300">
            Screenshot managed on Apple Connect
          </p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">
            {filename ?? "Edit via App Store Connect web UI."}
          </p>
        </div>
      </div>
    );
  }

  if (filename) {
    return (
      <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 flex items-center gap-3">
        <CheckCircle className="h-5 w-5 text-emerald-600 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-emerald-800">
            Screenshot staged
          </p>
          <p className="text-[11px] font-mono text-emerald-700 truncate">
            {filename}
          </p>
        </div>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="p-1.5 rounded text-emerald-700 hover:bg-emerald-100 transition"
            title="Remove + re-stage"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    );
  }

  return (
    <>
      <div
        {...getRootProps()}
        className={`rounded-lg border-2 border-dashed p-8 text-center cursor-pointer transition ${
          isDragActive
            ? "border-[#0071E3] bg-blue-50"
            : "border-slate-300 dark:border-slate-700 hover:border-slate-400 bg-white dark:bg-slate-900"
        }`}
      >
        <input {...getInputProps()} />
        <Upload className="mx-auto h-7 w-7 text-slate-400 dark:text-slate-500 mb-2" />
        <p className="text-xs font-medium text-slate-700 dark:text-slate-300">
          {isDragActive
            ? "Drop screenshot here"
            : "Drag & drop a screenshot or click to stage"}
        </p>
        <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-1">
          PNG/JPEG · max 8 MB · optional at create · Apple requires before submit
        </p>
      </div>
      {error && (
        <p className="mt-2 text-xs text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">
          {error}
        </p>
      )}
    </>
  );
}
