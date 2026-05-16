"use client";

import { useCallback, useState } from "react";
import { useDropzone } from "react-dropzone";
import { Upload, Image as ImageIcon, X, Loader2, CheckCircle } from "lucide-react";

interface Props {
  /** Current screenshot filename (server-side state). Null when no screenshot. */
  filename: string | null;
  /** Whether the user has already saved the IAP as a draft (gate for upload). */
  iapPersisted: boolean;
  /** Called after successful upload — parent updates form state. */
  onUploaded: (filename: string) => void;
  /** Optional remove-screenshot handler. */
  onRemove?: () => void;
  /** Endpoint to POST the file to. Server orchestrates Apple 3-step. */
  uploadEndpoint: string;
}

const MAX_SIZE = 8 * 1024 * 1024; // 8MB per Apple constraint

export function ScreenshotUpload({
  filename,
  iapPersisted,
  onUploaded,
  onRemove,
  uploadEndpoint,
}: Props) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDrop = useCallback(
    async (accepted: File[]) => {
      const file = accepted[0];
      if (!file) return;
      setError(null);
      setUploading(true);

      try {
        const form = new FormData();
        form.append("file", file);

        const res = await fetch(uploadEndpoint, {
          method: "POST",
          body: form,
        });
        const data = (await res.json()) as
          | { filename: string }
          | { error: string };

        if (!res.ok) {
          setError("error" in data ? data.error : `Upload failed (${res.status})`);
          return;
        }
        if ("filename" in data) {
          onUploaded(data.filename);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Upload failed");
      } finally {
        setUploading(false);
      }
    },
    [uploadEndpoint, onUploaded],
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop: handleDrop,
    accept: { "image/png": [".png"], "image/jpeg": [".jpg", ".jpeg"] },
    maxSize: MAX_SIZE,
    multiple: false,
    disabled: !iapPersisted || uploading,
  });

  if (!iapPersisted) {
    return (
      <div className="rounded-lg border-2 border-dashed border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/30 p-8 text-center">
        <ImageIcon className="mx-auto h-7 w-7 text-slate-300 mb-2" />
        <p className="text-xs text-slate-500 dark:text-slate-400 dark:text-slate-500">
          Save as Draft first to enable screenshot upload.
        </p>
      </div>
    );
  }

  if (filename) {
    return (
      <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 flex items-center gap-3">
        <CheckCircle className="h-5 w-5 text-emerald-600 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-emerald-800">
            Screenshot uploaded
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
            title="Remove + re-upload"
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
            : uploading
              ? "border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/30 cursor-wait"
              : "border-slate-300 dark:border-slate-700 hover:border-slate-400 bg-white dark:bg-slate-900"
        }`}
      >
        <input {...getInputProps()} />
        {uploading ? (
          <>
            <Loader2 className="mx-auto h-7 w-7 text-[#0071E3] mb-2 animate-spin" />
            <p className="text-xs text-slate-600">Uploading…</p>
          </>
        ) : (
          <>
            <Upload className="mx-auto h-7 w-7 text-slate-400 dark:text-slate-500 mb-2" />
            <p className="text-xs font-medium text-slate-700 dark:text-slate-300">
              {isDragActive
                ? "Drop screenshot here"
                : "Drag & drop a screenshot or click to upload"}
            </p>
            <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-1">
              PNG/JPEG · max 8 MB · required by Apple before submission
            </p>
          </>
        )}
      </div>
      {error && (
        <p className="mt-2 text-xs text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">
          {error}
        </p>
      )}
    </>
  );
}
