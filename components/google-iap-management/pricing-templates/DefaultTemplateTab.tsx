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
  Cog,
  Lock,
} from "lucide-react";

import type {
  AccountTemplateSummary,
  TemplateOverview,
} from "@/lib/google-iap-management/queries/templates";
import { replaceConfirmVariant } from "@/lib/google-iap-management/replace-confirm";
import { EntriesPreviewTable } from "./EntriesPreviewTable";

export interface AccountOption {
  id: string;
  name: string;
}

interface Props {
  overview: TemplateOverview;
  /** ⚠ E1 — MỌI account đang tồn tại, KỂ CẢ account chưa có template.
   *  Ẩn account chưa có template đi thì "chưa cấu hình" và "không tồn
   *  tại" nhìn giống hệt nhau trên màn, và người dùng không có cách nào
   *  phân biệt. */
  accounts: AccountOption[];
  summaries: AccountTemplateSummary[];
  /** Account ĐANG XEM. `overview` là của ĐÚNG account này. */
  selectedAccountId: string;
  /** E7 — không phải admin thì tab ở chế độ chỉ-đọc. */
  readOnly?: boolean;
}

function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function DefaultTemplateTab({
  overview,
  accounts,
  summaries,
  selectedAccountId,
  readOnly = false,
}: Props) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  /** File đang chờ Manager xác nhận trong modal Replace. */
  const [pendingFile, setPendingFile] = useState<File | null>(null);

  const summaryByAccount = new Map(summaries.map((s) => [s.account_id, s]));
  const selectedAccount = accounts.find((a) => a.id === selectedAccountId);
  const selectedLabel = selectedAccount?.name ?? selectedAccountId;
  const isMigrated = overview.template?.origin_note != null;

  /**
   * ⚠ E1 — CHỌN ACCOUNT ĐỂ XEM, KHÔNG ĐỔI ACTIVE ACCOUNT CỦA MODULE.
   *
   * Lựa chọn đi vào QUERY STRING `?account=`. Nó CỐ Ý không gọi
   * `writeActiveAccountId` và không đụng cookie `g_iap_active_v2`:
   * Manager cần liếc Default của một account khác mà không làm xê dịch
   * account mà mọi màn còn lại của module đang bám theo (danh sách app,
   * bulk import, single-IAP form…).
   *
   * Đổi chỗ này thành "đổi luôn active account cho tiện" là làm một cú
   * bấm để XEM biến thành một cú bấm đổi NGỮ CẢNH của cả module.
   * Test ghim: DefaultTemplateTab.account-chips.test.tsx.
   */
  function selectAccount(accountId: string) {
    if (accountId === selectedAccountId || uploading) return;
    startTransition(() => {
      router.push(
        `/google-iap-management/settings/pricing-templates?account=${encodeURIComponent(accountId)}`,
      );
      router.refresh();
    });
  }

  async function handleFile(file: File) {
    setError(null);
    setSuccess(null);
    setUploading(true);
    const form = new FormData();
    form.append("file", file);
    form.append("scope", "ACCOUNT");
    // ⚠ G1e — GỬI ACCOUNT ĐANG XEM, và đây là một thay đổi CÓ CHỦ Ý so
    //   với G1b (khi đó comment ở đây ghi "client không gửi và không
    //   được gửi").
    //   Lý do đổi: G1e cho phép XEM Default của account khác mà KHÔNG
    //   đổi active account. Từ lúc đó, cookie không còn trả lời được câu
    //   "Manager đang muốn ghi vào account nào" — chỉ màn hình biết.
    //   An toàn KHÔNG đến từ việc giấu giá trị này, mà đến từ:
    //     (1) route đối chiếu account_id với listAccounts() — client
    //         không bịa ra được một account;
    //     (2) gate admin của G1c vẫn chặn trước đó.
    form.append("account_id", selectedAccountId);
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
      {/* ── E1 · hàng chip chọn account ─────────────────────────────── */}
      <div data-testid="account-chips" className="space-y-2">
        <div className="text-xs text-slate-500">
          {accounts.length} account · chọn để XEM Default của account đó.
          Việc chọn ở đây KHÔNG đổi account đang hoạt động của module.
        </div>
        <div className="flex flex-wrap gap-2">
          {accounts.map((account) => {
            const has = summaryByAccount.get(account.id)?.template != null;
            const isSelected = account.id === selectedAccountId;
            return (
              <button
                key={account.id}
                type="button"
                data-testid={`account-chip-${account.id}`}
                data-selected={isSelected ? "true" : "false"}
                onClick={() => selectAccount(account.id)}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs transition ${
                  isSelected
                    ? "border-emerald-500 bg-emerald-50 text-emerald-900"
                    : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
                }`}
              >
                <span className="font-medium">{account.name}</span>
                <span className="font-mono text-[11px] text-slate-400">
                  {account.id}
                </span>
                <span
                  className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] border ${
                    has
                      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                      : "bg-amber-50 text-amber-700 border-amber-200"
                  }`}
                >
                  {has ? "có template" : "chưa có"}
                </span>
              </button>
            );
          })}
        </div>
      </div>

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
              Default Template ·{" "}
              <span data-testid="selected-account-label" className="text-emerald-700">
                {selectedLabel}
              </span>{" "}
              <span className="font-mono text-xs text-slate-400">
                {selectedAccountId}
              </span>
            </h2>
            <p className="text-xs text-slate-500 mt-0.5 max-w-prose">
              Applied to every app unless overridden by a per-app template.
              Sparse cells are permitted — missing (tier, region) pairs fall
              back to Google&apos;s auto-equalisation.
            </p>
            {/* ── E3 · pill nguồn gốc ────────────────────────────────── */}
            {isMigrated && (
              <div className="mt-2">
                <span
                  data-testid="origin-pill"
                  title={overview.template?.origin_note ?? undefined}
                  className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium bg-violet-50 text-violet-700 border border-violet-200"
                >
                  <Cog className="h-3 w-3" />
                  Do migration nhân bản · chưa ai cấu hình riêng cho account
                  này
                </span>
              </div>
            )}
            {/* ── E5 · account CHƯA có template ──────────────────────── */}
            {!overview.template && (
              <p
                data-testid="empty-state-note"
                className="mt-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2"
              >
                Account này chưa có Default Template. IAP của nó rơi về giá
                gốc + auto-equalisation của Google cho tới khi có bản upload
                đầu tiên.
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {/* ── E7 · không phải admin → chỉ đọc ──────────────────────
                Gate THẬT nằm ở server (G1c requireGoogleIapAdmin). Cụm
                này chỉ để khỏi mời người dùng bấm vào nút chắc chắn 403.
                Vẫn giữ lối vào "Open matrix view" vì XEM không bị gate. */}
            {readOnly && (
              <div
                data-testid="readonly-lock"
                className="flex items-center gap-1.5 px-3 py-2 text-xs text-slate-500 bg-slate-100 rounded-lg"
              >
                <Lock className="h-3.5 w-3.5" />
                Chỉ admin sửa được Default Template
              </div>
            )}
            {overview.template && (
              <Link
                href="/google-iap-management/settings/pricing-templates/default"
                className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-emerald-700 border border-emerald-200 hover:bg-emerald-50 rounded-lg transition"
              >
                <Table2 className="h-4 w-4" />
                Open matrix view
              </Link>
            )}
            {overview.template && !readOnly && (
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
              disabled={uploading || readOnly}
              hidden={readOnly}
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

      {/* ── E6 · bảng toàn cảnh N account ───────────────────────────────
          Đây là CHỖ DUY NHẤT so được các account cạnh nhau. Thẻ phía trên
          chỉ nói về account đang chọn, nên một account bị bỏ quên sẽ không
          bao giờ tự lộ ra ở đó. */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-100">
          <div className="text-sm font-semibold text-slate-900">
            Toàn cảnh {accounts.length} account
          </div>
          <div className="text-[11.5px] text-slate-500">
            Cột &ldquo;Nguồn gốc&rdquo; phân biệt bản thừa hưởng từ migration
            với bản có người cố ý đặt.
          </div>
        </div>
        <table className="w-full text-[13px]" data-testid="overview-table">
          <thead>
            <tr className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500">
              <th className="text-left font-semibold px-4 py-2">Account</th>
              <th className="text-left font-semibold px-4 py-2">Trạng thái</th>
              <th className="text-left font-semibold px-4 py-2">Số ô</th>
              <th className="text-left font-semibold px-4 py-2">Nguồn gốc</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((account) => {
              const sum = summaryByAccount.get(account.id);
              const has = sum?.template != null;
              const migrated = sum?.template?.origin_note != null;
              return (
                <tr
                  key={account.id}
                  data-testid={`overview-row-${account.id}`}
                  className="border-b border-slate-50 last:border-0"
                >
                  <td className="px-4 py-2">
                    <span className="text-slate-800">{account.name}</span>{" "}
                    <span className="font-mono text-[11px] text-slate-400">
                      {account.id}
                    </span>
                  </td>
                  <td className="px-4 py-2">
                    <span
                      className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] border ${
                        has
                          ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                          : "bg-amber-50 text-amber-700 border-amber-200"
                      }`}
                    >
                      {has ? "có template" : "chưa có"}
                    </span>
                  </td>
                  <td className="px-4 py-2 font-mono text-slate-600">
                    {has ? sum?.entry_count.toLocaleString() : "—"}
                  </td>
                  <td className="px-4 py-2 text-[11.5px] text-slate-500">
                    {!has
                      ? "—"
                      : migrated
                        ? "bản sao migration"
                        : sum?.template?.uploaded_by}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
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
