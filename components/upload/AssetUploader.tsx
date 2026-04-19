"use client";

import { useCallback, useState } from "react";
import { useDropzone } from "react-dropzone";
import Image from "next/image";
import { Upload, X, CheckCircle, AlertCircle, Loader2 } from "lucide-react";

interface UploadFile {
  id: string;
  file: File;
  preview: string;
  status: "pending" | "uploading" | "done" | "error";
  error?: string;
  progress?: number;
}

interface Props {
  cppId: string;
  screenshotSetId?: string;
  onUploaded?: (url: string) => void;
}

async function computeMd5Hex(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest("MD5", buffer).catch(() => {
    // MD5 not supported in SubtleCrypto; return empty string — server will handle
    return new ArrayBuffer(0);
  });
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function AssetUploader({ cppId: _cppId, screenshotSetId, onUploaded }: Props) {
  const [files, setFiles] = useState<UploadFile[]>([]);

  const onDrop = useCallback(
    (accepted: File[]) => {
      const newFiles: UploadFile[] = accepted.map((f) => ({
        id: `${f.name}-${Date.now()}-${Math.random()}`,
        file: f,
        preview: URL.createObjectURL(f),
        status: "pending",
      }));
      setFiles((prev) => [...prev, ...newFiles]);
    },
    []
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { "image/png": [".png"], "image/jpeg": [".jpg", ".jpeg"] },
    maxSize: 20 * 1024 * 1024, // 20MB
  });

  function removeFile(id: string) {
    setFiles((prev) => {
      const target = prev.find((f) => f.id === id);
      if (target) URL.revokeObjectURL(target.preview);
      return prev.filter((f) => f.id !== id);
    });
  }

  async function uploadFile(uf: UploadFile) {
    if (!screenshotSetId) {
      setFiles((prev) =>
        prev.map((f) =>
          f.id === uf.id ? { ...f, status: "error", error: "No screenshotSetId configured" } : f
        )
      );
      return;
    }

    setFiles((prev) =>
      prev.map((f) => (f.id === uf.id ? { ...f, status: "uploading" } : f))
    );

    try {
      const checksum = await computeMd5Hex(uf.file);
      const formData = new FormData();
      formData.append("screenshotSetId", screenshotSetId);
      formData.append("file", uf.file);
      formData.append("checksum", checksum);

      const res = await fetch("/api/asc/upload", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? "Upload failed");
      }

      setFiles((prev) =>
        prev.map((f) => (f.id === uf.id ? { ...f, status: "done" } : f))
      );

      onUploaded?.(uf.preview);
    } catch (err) {
      const error = err instanceof Error ? err.message : "Upload failed";
      setFiles((prev) =>
        prev.map((f) => (f.id === uf.id ? { ...f, status: "error", error } : f))
      );
    }
  }

  async function uploadAll() {
    const pending = files.filter((f) => f.status === "pending");
    await Promise.all(pending.map(uploadFile));
  }

  const hasPending = files.some((f) => f.status === "pending");

  return (
    <div className="space-y-4">
      {/* Drop zone */}
      <div
        {...getRootProps()}
        className={`rounded-xl border-2 border-dashed p-10 text-center cursor-pointer transition-colors ${
          isDragActive
            ? "border-[#0071E3] bg-blue-50"
            : "border-slate-300 hover:border-slate-400 bg-white"
        }`}
      >
        <input {...getInputProps()} />
        <Upload className="mx-auto h-8 w-8 text-slate-400 mb-3" />
        <p className="text-sm font-medium text-slate-700">
          {isDragActive ? "Drop screenshots here" : "Drag & drop screenshots here"}
        </p>
        <p className="text-xs text-slate-400 mt-1">PNG or JPEG, up to 20MB each</p>
      </div>

      {/* File grid */}
      {files.length > 0 && (
        <div>
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
            {files.map((uf) => (
              <div
                key={uf.id}
                className="relative rounded-xl overflow-hidden border border-slate-200 bg-white aspect-[9/16]"
              >
                <Image
                  src={uf.preview}
                  alt={uf.file.name}
                  fill
                  className="object-cover"
                  unoptimized
                />

                {/* Status overlay */}
                {uf.status !== "pending" && (
                  <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                    {uf.status === "uploading" && (
                      <Loader2 className="h-6 w-6 text-white animate-spin" />
                    )}
                    {uf.status === "done" && (
                      <CheckCircle className="h-6 w-6 text-green-400" />
                    )}
                    {uf.status === "error" && (
                      <div className="text-center px-2">
                        <AlertCircle className="h-5 w-5 text-red-400 mx-auto" />
                        <p className="text-[10px] text-white mt-1 line-clamp-2">
                          {uf.error}
                        </p>
                      </div>
                    )}
                  </div>
                )}

                {/* Remove button */}
                {uf.status === "pending" && (
                  <button
                    onClick={() => removeFile(uf.id)}
                    className="absolute top-1 right-1 bg-black/50 hover:bg-black/70 rounded-full p-0.5 transition"
                  >
                    <X className="h-3 w-3 text-white" />
                  </button>
                )}

                {/* Filename */}
                <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/60 px-2 py-1.5">
                  <p className="text-[10px] text-white truncate">{uf.file.name}</p>
                </div>
              </div>
            ))}
          </div>

          {hasPending && (
            <div className="mt-4 flex justify-end">
              <button
                onClick={uploadAll}
                className="inline-flex items-center gap-2 bg-[#0071E3] hover:bg-[#0077ED] text-white text-sm font-medium px-4 py-2 rounded-lg transition"
              >
                <Upload className="h-4 w-4" />
                Upload {files.filter((f) => f.status === "pending").length} file
                {files.filter((f) => f.status === "pending").length !== 1 ? "s" : ""}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
