"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Upload,
  RefreshCw,
  Sparkles,
  Trash2,
  AlertCircle,
  CheckCircle2,
  Table2,
} from "lucide-react";

import type { TemplateOverview } from "@/lib/google-iap-management/queries/templates";
import { replaceConfirmVariant } from "@/lib/google-iap-management/replace-confirm";
import { EntriesPreviewTable } from "./EntriesPreviewTable";

interface Props {
  overview: TemplateOverview;
}

function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function DefaultTemplateTab({ overview }: Props) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  /** File đang chờ Manager xác nhận trong modal Replace. */
  const [pendingFile, setPendingFile] = useState<File | null>(null);

  async function handleFile(file: File) {
    setError(null);
    setSuccess(null);
    setUploading(true);
    const form = new FormData();
    form.append("file", file);
    // G1b — "ACCOUNT": Default Template giờ thuộc về account đang active.
    // Route đọc account ở SERVER; client không gửi và không được gửi.
    form.append("scope", "ACCOUNT");
    try {
      const res = await fetch("/api/google-iap-management/pricing-templates", {
        method: "POST",
        body: form,
      });
      const data = (await res.json()) as {
        template_id?: string;
        inserted_entry_count?: number;
        tier_count?: number;
        territory_count?: number;
        warnings?: string[];
        errors?: string[];
        error?: string;
      };
      if (!res.ok) {
        const message =
          data.error ?? data.errors?.join(" · ") ?? `Upload failed (HTTP ${res.status})`;
        setError(message);
        return;
      }
      const w = data.warnings && data.warnings.length > 0
        ? ` · ${data.warnings.length} warning(s)`
        : "";
      setSuccess(
        `Replaced — ${data.inserted_entry_count ?? 0} entries across ${data.tier_count ?? 0} tiers × ${data.territory_count ?? 0} regions${w}.`,
      );
      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setUploading(false);
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    // ⚠ C5 — XÁC NHẬN MỌI LẦN, không chỉ lần "nguy hiểm". Upload đè là
    //   thao tác một-chiều: bản cũ biến mất ngay khi lệnh DELETE chạy
    //   (replaceTemplate = delete-rồi-insert). Hỏi mọi lần thì cái hỏi
    //   mới là thói quen; hỏi có chọn lọc thì lần hỏi thật bị bấm qua
    //   theo quán tính.
    //   Lần đầu chưa có template thì không có gì để đè ⇒ đi thẳng.
    if (!overview.template) {
      void handleFile(file);
      return;
    }
    setPendingFile(file);
  }

  async function handleRemove() {
    if (!overview.template) return;
    if (
      !window.confirm(
        "Remove the Default Template? IAPs that use the Default source will fall back to base price + Google auto-equalisation.",
      )
    ) {
      return;
    }
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch(
        `/api/google-iap-management/pricing-templates/${overview.template.id}`,
        { method: "DELETE" },
      );
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? `Delete failed (HTTP ${res.status})`);
        return;
      }
      setSuccess("Default Template removed.");
      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    }
  }

  return (
    <div className="space-y-4">
      {pendingFile && overview.template && (
        <ReplaceConfirmDialog
          fileName={pendingFile.name}
          /* Quy tắc + lý do đầy đủ: lib/google-iap-management/replace-confirm.ts */
          isUntouchedClone={
            replaceConfirmVariant(overview.template) === "untouched-clone"
          }
          previousUploader={overview.template.uploaded_by}
          uploadedAt={formatTimestamp(overview.template.uploaded_at)}
          onCancel={() => setPendingFile(null)}
          onConfirm={() => {
            const f = pendingFile;
            setPendingFile(null);
            void handleFile(f);
          }}
        />
      )}
      <section className="bg-white border border-slate-200 rounded-xl p-6">
        <div className="flex items-start justify-between mb-4 gap-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Default Template
            </h2>
            <p className="text-xs text-slate-500 mt-0.5 max-w-prose">
              Applied to every app unless overridden by a per-app template.
              Sparse cells are permitted — missing (tier, region) pairs fall
              back to Google&apos;s auto-equalisation.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {overview.template && (
              <Link
                href="/google-iap-management/settings/pricing-templates/default"
                className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-emerald-700 border border-emerald-200 hover:bg-emerald-50 rounded-lg transition"
              >
                <Table2 className="h-4 w-4" />
                Open matrix view
              </Link>
            )}
            {overview.template && (
              <button
                onClick={handleRemove}
                disabled={uploading}
                className="flex items-center gap-1.5 px-3 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg transition disabled:opacity-50"
              >
                <Trash2 className="h-4 w-4" />
                Remove
              </button>
            )}
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg transition disabled:opacity-50"
            >
              {uploading ? (
                <RefreshCw className="h-4 w-4 animate-spin" />
              ) : (
                <Upload className="h-4 w-4" />
              )}
              {uploading
                ? "Uploading…"
                : overview.template
                  ? "Replace"
                  : "Upload .xlsx"}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={handleFileChange}
              className="hidden"
            />
          </div>
        </div>

        <div className="grid grid-cols-4 gap-4">
          <Stat label="Tiers" value={overview.tierCount} />
          <Stat label="Regions" value={overview.territoryCount} />
          <Stat label="Entries" value={overview.entryCount} />
          <Stat
            label="Uploaded"
            value={formatTimestamp(overview.template?.uploaded_at)}
            hint={overview.template?.uploaded_by ?? null}
          />
        </div>
      </section>

      {error && (
        <div className="flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}
      {success && (
        <div className="flex items-start gap-2 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
          <CheckCircle2 className="h-4 w-4 flex-shrink-0 mt-0.5" />
          <span>{success}</span>
        </div>
      )}

      {overview.template === null ? (
        <div className="bg-white border border-dashed border-slate-300 rounded-xl p-10 text-center">
          <Sparkles className="mx-auto h-8 w-8 text-slate-300 mb-3" />
          <p className="text-sm font-medium text-slate-700">
            No Default Template
          </p>
          <p className="text-xs text-slate-500 mt-1">
            Upload the Manager-provided{" "}
            <code className="bg-slate-100 px-1.5 py-0.5 rounded text-[11px]">
              pricing-template-google.xlsx
            </code>{" "}
            to set per-region pricing shared across all apps.
          </p>
        </div>
      ) : (
        <EntriesPreviewTable
          entries={overview.sampleEntries}
          totalEntryCount={overview.entryCount}
        />
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint?: string | null;
}) {
  return (
    <div>
      <p className="text-xs text-slate-400 uppercase tracking-wide">{label}</p>
      <p className="text-lg font-semibold text-slate-900 mt-1 truncate">
        {value}
      </p>
      {hint && (
        <p className="text-[11px] text-slate-400 mt-0.5 truncate">{hint}</p>
      )}
    </div>
  );
}

/**
 * C5 — modal xác nhận Replace, HAI BIẾN THỂ.
 *
 * ⚠ Điều kiện rẽ nhánh là `isUntouchedClone`, do caller tính từ
 *   `origin_note !== null`. Component này CỐ Ý không nhận `origin_note`
 *   thô và cũng không nhìn thấy `uploaded_by === "SYSTEM_MIGRATION"`:
 *   để chỗ duy nhất quyết định "bản clone hay bản người thật" nằm ở một
 *   nơi, đọc được, và không ai vô tình thay bằng phép so chuỗi.
 */
function ReplaceConfirmDialog({
  fileName,
  isUntouchedClone,
  previousUploader,
  uploadedAt,
  onCancel,
  onConfirm,
}: {
  fileName: string;
  isUntouchedClone: boolean;
  previousUploader: string;
  uploadedAt: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const tone = isUntouchedClone
    ? {
        ring: "border-emerald-200",
        badge: "bg-emerald-50 text-emerald-700 border-emerald-200",
        button: "bg-emerald-600 hover:bg-emerald-700",
        title: "Replace the Default Template?",
        headline: "Chưa ai cấu hình riêng cho account này.",
        detail:
          "Bản đang có là bản sao tự động sinh khi tách Default Template theo account. Thay nó không đè lên việc của ai.",
      }
    : {
        ring: "border-red-300",
        badge: "bg-red-50 text-red-700 border-red-200",
        button: "bg-red-600 hover:bg-red-700",
        title: "Ghi đè Default Template của account này?",
        headline: `Sẽ ghi đè việc của ${previousUploader}.`,
        detail:
          "Bản đang có do người thật upload cho account này. Thay nó là mất toàn bộ nội dung đó — không có bước hoàn tác.",
      };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="replace-tpl-title"
    >
      <div
        className={`w-full max-w-lg bg-white rounded-xl border ${tone.ring} shadow-xl p-6 space-y-4`}
      >
        <div className="space-y-1">
          <h3
            id="replace-tpl-title"
            className="text-base font-semibold text-slate-900"
          >
            {tone.title}
          </h3>
          <p
            className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${tone.badge}`}
          >
            {tone.headline}
          </p>
        </div>
        <p className="text-sm text-slate-600">{tone.detail}</p>
        <dl className="text-xs text-slate-500 space-y-1">
          <div className="flex gap-2">
            <dt className="w-28 shrink-0">Bản đang có</dt>
            <dd className="font-mono text-slate-700">
              {previousUploader} · {uploadedAt}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-28 shrink-0">File mới</dt>
            <dd className="font-mono text-slate-700">{fileName}</dd>
          </div>
        </dl>
        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-lg transition"
          >
            Huỷ
          </button>
          <button
            onClick={onConfirm}
            className={`px-4 py-2 text-sm font-medium text-white rounded-lg transition ${tone.button}`}
          >
            Replace
          </button>
        </div>
      </div>
    </div>
  );
}
