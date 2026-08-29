"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Upload, RefreshCw, Sparkles, Trash2, Lock, Table2, Cog } from "lucide-react";
import type {
  AccountTemplateSummary,
  TemplateOverview,
} from "@/lib/iap-management/queries/templates";
import { TemplateEntriesTable } from "@/components/iap-management/pricing-tiers/TemplateEntriesTable";

export interface AccountOption {
  id: string;
  name: string;
}

interface Props {
  overview: TemplateOverview;
  /** Hotfix 11: non-admin sees the Default tab in read-only mode. */
  readOnly?: boolean;
  /** C-D: mọi ASC account đang tồn tại — kể cả account CHƯA có template. */
  accounts: AccountOption[];
  /** C-D: tóm tắt template của từng account (badge, pill, bảng toàn cảnh). */
  summaries: AccountTemplateSummary[];
  /** C-D: account đang xem. `overview` là của ĐÚNG account này. */
  selectedAccountId: string;
  /** Email người đang đăng nhập — quyết định biến thể modal ghi đè. */
  currentUserEmail: string;
}

function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/**
 * Hai biến thể của modal thay template (mockup State 4).
 *
 * ⚠ Phân biệt bằng `origin_note IS NOT NULL`, KHÔNG bằng
 * `uploaded_by === "SYSTEM_MIGRATION"`. Chuỗi đó do migration
 * 20260828010000 ghi ra; so chuỗi ở tầng UI là dựng một bản sao của một
 * hằng số nằm trong file SQL — hai bản sẽ trôi khỏi nhau và không có gì
 * bắt được. `origin_note` là cột, và cột thì có kiểu.
 */
type ReplaceIntent =
  | { kind: "none" }
  | { kind: "migrated"; entryCount: number; note: string | null }
  | { kind: "someone-else"; uploadedBy: string; uploadedAt: string; entryCount: number };

export function DefaultTemplateTab({
  overview,
  readOnly = false,
  accounts,
  summaries,
  selectedAccountId,
  currentUserEmail,
}: Props) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [pending, setPending] = useState<File | null>(null);
  const [intent, setIntent] = useState<ReplaceIntent>({ kind: "none" });
  const [, startTransition] = useTransition();

  const summaryByAccount = new Map(summaries.map((s) => [s.account_id, s]));
  const selectedAccount = accounts.find((a) => a.id === selectedAccountId);
  const selectedLabel = selectedAccount?.name ?? selectedAccountId;
  const template = overview.template;
  const isMigrated = template?.origin_note != null;

  function selectAccount(accountId: string) {
    if (accountId === selectedAccountId || uploading) return;
    startTransition(() => {
      router.push(
        `/iap-management/settings/pricing-tiers?account=${encodeURIComponent(accountId)}`,
      );
      router.refresh();
    });
  }

  async function doUpload(file: File) {
    setUploading(true);
    const form = new FormData();
    form.append("file", file);
    form.append("scope", "ACCOUNT");
    // ⚠ Account ĐANG CHỌN, không phải account đang active ở TopNav. Hai thứ
    //   này khác nhau bất cứ khi nào Manager bấm sang account khác ở thanh
    //   trên — và gửi nhầm ở đây là ghi đè 1140 ô của một account mà Manager
    //   đang không nhìn.
    form.append("account_id", selectedAccountId);

    try {
      const res = await fetch("/api/iap-management/pricing-templates", {
        method: "POST",
        body: form,
      });
      const data = (await res.json()) as
        | {
            template_id: string;
            inserted_entry_count: number;
            tier_count?: number;
            territory_count?: number;
            warnings?: string[];
          }
        | { error: string };

      if (!res.ok) {
        toast.error("error" in data ? data.error : `Upload failed (HTTP ${res.status})`);
        return;
      }
      if ("warnings" in data && data.warnings && data.warnings.length > 0) {
        toast.warning(
          `${data.warnings.length} parse warning${data.warnings.length === 1 ? "" : "s"} — see audit log`,
        );
      }
      const tierCount = "tier_count" in data ? data.tier_count ?? 0 : 0;
      const territoryCount = "territory_count" in data ? data.territory_count ?? 0 : 0;
      toast.success(
        `Default Template của ${selectedLabel} đã thay — ${
          "inserted_entry_count" in data ? data.inserted_entry_count : 0
        } ô, ${tierCount} tier × ${territoryCount} territory.`,
      );
      startTransition(() => router.refresh());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Network error");
    } finally {
      setUploading(false);
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    if (!template) {
      void doUpload(file);
      return;
    }
    setPending(file);
    if (template.origin_note != null) {
      setIntent({
        kind: "migrated",
        entryCount: overview.populated_entry_count,
        note: template.origin_note,
      });
    } else if (template.uploaded_by !== currentUserEmail) {
      setIntent({
        kind: "someone-else",
        uploadedBy: template.uploaded_by,
        uploadedAt: template.uploaded_at,
        entryCount: overview.populated_entry_count,
      });
    } else {
      void doUpload(file);
      setPending(null);
    }
  }

  function confirmReplace() {
    const file = pending;
    setIntent({ kind: "none" });
    setPending(null);
    if (file) void doUpload(file);
  }

  async function handleRemove() {
    if (!template) return;
    if (
      !window.confirm(
        `Xoá Default Template của ${selectedLabel}? IAP của account này tạo từ giờ ` +
          `với nguồn Default sẽ không còn override theo territory.`,
      )
    ) {
      return;
    }
    try {
      const res = await fetch(`/api/iap-management/pricing-templates/${template.id}`, {
        method: "DELETE",
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        toast.error(data.error ?? `Delete failed (HTTP ${res.status})`);
        return;
      }
      toast.success(`Đã xoá Default Template của ${selectedLabel}.`);
      startTransition(() => router.refresh());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Network error");
    }
  }

  return (
    <div className="space-y-4">
      {/* ── Thanh chọn account (mockup State 1) ───────────────────────── */}
      <div
        className="bg-slate-50 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 rounded-xl px-4 py-3"
        data-testid="account-bar"
      >
        <div className="flex items-center justify-between mb-2">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Account App Store
          </div>
          <div className="text-[11.5px] text-slate-500">
            {accounts.length} account ·{" "}
            {accounts.filter((a) => !summaryByAccount.get(a.id)?.template).length === 0
              ? "tất cả đang có template"
              : `${accounts.filter((a) => !summaryByAccount.get(a.id)?.template).length} account chưa có template`}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {/* ⚠ Hiện ĐỦ account, kể cả account chưa có template — lập luận bê
              từ Settings → API Key Pool: ẩn đi thì "chưa có template" và
              "account không tồn tại" nhìn giống hệt nhau, mà cái đầu mới là
              trạng thái bình thường của một account vừa được thêm. */}
          {accounts.map((account) => {
            const has = summaryByAccount.get(account.id)?.template != null;
            const active = account.id === selectedAccountId;
            return (
              <button
                key={account.id}
                type="button"
                data-testid={`account-chip-${account.id}`}
                aria-current={active ? "true" : undefined}
                onClick={() => selectAccount(account.id)}
                disabled={uploading}
                className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border text-[13px] transition disabled:opacity-50 ${
                  active
                    ? "border-[#0071E3] bg-[#0071E3]/[0.06] text-slate-900 dark:text-slate-100 font-medium ring-2 ring-[#0071E3]/20"
                    : "border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 hover:border-slate-300"
                }`}
              >
                <span>{account.name}</span>
                <span className="font-mono text-[11px] text-slate-400">{account.id}</span>
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

      {/* ── Thẻ tóm tắt của account đang chọn ─────────────────────────── */}
      <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-6">
        <div className="flex items-start justify-between mb-4 gap-4">
          <div>
            <h2 className="text-base font-medium text-slate-900 dark:text-slate-100">
              Default Template ·{" "}
              <span className="text-[#0071E3]">{selectedLabel}</span>{" "}
              <span className="font-mono text-xs text-slate-400">{selectedAccountId}</span>
            </h2>
            <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">
              Áp dụng cho mọi app của account này, trừ app đã có template riêng.
              Ô trống được phép — cặp (tier, territory) thiếu rơi về
              auto-equalize của Apple.
            </p>
            {isMigrated && (
              <div className="mt-2">
                <span
                  data-testid="origin-pill"
                  title={template?.origin_note ?? undefined}
                  className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium bg-violet-50 text-violet-700 border border-violet-200"
                >
                  <Cog className="h-3 w-3" />
                  Do migration nhân bản · chưa ai cấu hình riêng
                </span>
              </div>
            )}
          </div>
          {readOnly ? (
            <div className="flex items-center gap-2 shrink-0">
              {template && (
                <Link
                  href="/iap-management/settings/pricing-tiers/default-matrix"
                  className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-sky-700 dark:text-sky-300 border border-sky-200 dark:border-sky-800 hover:bg-sky-50 dark:hover:bg-sky-950/40 rounded-lg transition"
                >
                  <Table2 className="h-4 w-4" />
                  Open matrix view
                </Link>
              )}
              <div className="flex items-center gap-1.5 px-3 py-2 text-xs text-slate-500 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 rounded-lg">
                <Lock className="h-3.5 w-3.5" />
                Admin-managed
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2 shrink-0">
              {template && (
                <Link
                  href="/iap-management/settings/pricing-tiers/default-matrix"
                  className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-sky-700 dark:text-sky-300 border border-sky-200 dark:border-sky-800 hover:bg-sky-50 dark:hover:bg-sky-950/40 rounded-lg transition"
                >
                  <Table2 className="h-4 w-4" />
                  Open matrix view
                </Link>
              )}
              {template && (
                <button
                  onClick={handleRemove}
                  className="flex items-center gap-1.5 px-3 py-2 text-sm text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition"
                >
                  <Trash2 className="h-4 w-4" />
                  Remove
                </button>
              )}
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                data-testid="upload-button"
                className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-[#0071E3] hover:bg-[#0077ED] text-white rounded-lg transition disabled:opacity-50"
              >
                {uploading ? (
                  <RefreshCw className="h-4 w-4 animate-spin" />
                ) : (
                  <Upload className="h-4 w-4" />
                )}
                {uploading ? "Uploading…" : template ? "Replace" : "Upload .xlsx"}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx"
                onChange={handleFileChange}
                className="hidden"
                data-testid="file-input"
              />
            </div>
          )}
        </div>

        <div className="grid grid-cols-4 gap-4">
          <Stat label="Tiers" value={overview.tiers.length} />
          <Stat label="Territories" value={overview.territory_count} />
          <Stat label="Populated entries" value={overview.populated_entry_count} />
          <Stat
            label="Uploaded"
            value={formatTimestamp(template?.uploaded_at)}
            hint={template?.uploaded_by}
          />
        </div>
      </div>

      {/* ── Empty state / bảng tier (mockup State 1 & 2) ──────────────── */}
      {template === null ? (
        <div className="bg-white dark:bg-slate-900 rounded-xl border border-dashed border-slate-300 dark:border-slate-700 p-10 text-center">
          <Sparkles className="mx-auto h-8 w-8 text-slate-300 dark:text-slate-600 mb-3" />
          <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
            Chưa có Default Template cho {selectedLabel}
          </p>
          <p className="text-xs text-slate-400 dark:text-slate-500 mt-1 max-w-lg mx-auto">
            {readOnly
              ? "Cần admin upload template cho account này trước khi IAP của nó dùng được nguồn Default."
              : "Upload price-tiers-template.xlsx để đặt giá theo territory dùng chung cho mọi app của account này."}
          </p>
          <div className="mt-4 max-w-lg mx-auto text-left rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
            Trong lúc chưa có: ở form tạo/sửa IAP của account này, nguồn giá{" "}
            <span className="font-mono">Default Template</span> bị vô hiệu hoá.
            IAP tạo lúc này dùng giá auto-equalize của Apple —{" "}
            <strong>không còn tầng global đỡ phía sau</strong>.
          </div>
        </div>
      ) : (
        <TemplateEntriesTable tiers={overview.tiers} />
      )}

      {/* ── Bảng toàn cảnh (mockup State 5) ───────────────────────────── */}
      <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-100 dark:border-slate-800">
          <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
            Toàn cảnh {accounts.length} account
          </div>
          <div className="text-[11.5px] text-slate-500">
            Cột “Nguồn gốc” phân biệt template thừa hưởng từ migration với
            template có người cố ý đặt.
          </div>
        </div>
        <table className="w-full text-[13px]" data-testid="overview-table">
          <thead>
            <tr className="bg-slate-50 dark:bg-slate-800/50 text-[10px] uppercase tracking-wide text-slate-500">
              <th className="text-left font-semibold px-4 py-2">Account</th>
              <th className="text-left font-semibold px-4 py-2">Trạng thái</th>
              <th className="text-left font-semibold px-4 py-2">Số ô</th>
              <th className="text-left font-semibold px-4 py-2">Nguồn gốc</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((account) => {
              const s = summaryByAccount.get(account.id);
              const has = s?.template != null;
              const migrated = s?.template?.origin_note != null;
              return (
                <tr
                  key={account.id}
                  data-testid={`overview-row-${account.id}`}
                  className="border-b border-slate-50 dark:border-slate-800/60 last:border-0"
                >
                  <td className="px-4 py-2">
                    <span className="text-slate-800 dark:text-slate-200">{account.name}</span>{" "}
                    <span className="font-mono text-[11px] text-slate-400">{account.id}</span>
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
                  <td className="px-4 py-2 font-mono text-slate-600 dark:text-slate-400">
                    {has ? s?.entry_count.toLocaleString() : "—"}
                  </td>
                  <td className="px-4 py-2 text-[11.5px] text-slate-500">
                    {!has ? (
                      "—"
                    ) : migrated ? (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] bg-violet-50 text-violet-700 border border-violet-200">
                        <Cog className="h-3 w-3" />
                        do migration
                      </span>
                    ) : (
                      <>
                        {s?.template?.uploaded_by} ·{" "}
                        {formatTimestamp(s?.template?.uploaded_at)}
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ── Modal thay template — HAI biến thể (mockup State 4) ───────── */}
      {intent.kind !== "none" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-6">
          <div
            role="dialog"
            aria-modal="true"
            data-testid={`replace-modal-${intent.kind}`}
            className="w-full max-w-lg bg-white dark:bg-slate-900 rounded-2xl shadow-2xl overflow-hidden"
          >
            <div className="px-6 py-5 border-b border-slate-100 dark:border-slate-800">
              <div className="text-base font-semibold text-slate-900 dark:text-slate-100">
                {intent.kind === "migrated"
                  ? `Thay Default Template của ${selectedLabel}?`
                  : `Ghi đè Default Template của ${selectedLabel}?`}
              </div>
            </div>
            <div className="px-6 py-5 space-y-3">
              {intent.kind === "migrated" ? (
                <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-[12px] text-sky-900">
                  Template hiện tại <strong>do migration nhân bản</strong> từ Default
                  cũ — <strong>chưa ai cấu hình riêng cho account này</strong>.
                </div>
              ) : (
                <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-800">
                  Template hiện tại do <strong>{intent.uploadedBy}</strong> upload lúc{" "}
                  <strong>{formatTimestamp(intent.uploadedAt)}</strong> — không phải bạn.
                </div>
              )}
              <div className="text-[13px] text-slate-700 dark:text-slate-300">
                Upload sẽ thay toàn bộ{" "}
                <strong>{intent.entryCount.toLocaleString()} ô</strong>. Không hoàn tác
                được.
              </div>
              <div className="text-[11.5px] text-slate-500">
                Ảnh hưởng: mọi IAP của {selectedLabel} chọn nguồn Default Template ở
                lần submit tiếp theo. IAP đã đẩy lên Apple không bị đổi giá.
              </div>
            </div>
            <div className="px-6 py-4 bg-slate-50 dark:bg-slate-800/50 flex justify-end gap-2">
              <button
                onClick={() => {
                  setIntent({ kind: "none" });
                  setPending(null);
                }}
                className="px-4 py-2 text-sm font-medium bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 rounded-lg"
              >
                Huỷ
              </button>
              <button
                onClick={confirmReplace}
                data-testid="replace-confirm"
                className={`px-4 py-2 text-sm font-medium text-white rounded-lg ${
                  intent.kind === "migrated"
                    ? "bg-[#0071E3] hover:bg-[#0077ED]"
                    : "bg-red-600 hover:bg-red-700"
                }`}
              >
                {intent.kind === "migrated" ? "Thay template" : "Ghi đè"}
              </button>
            </div>
          </div>
        </div>
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
      <p className="text-xs text-slate-400 dark:text-slate-500 uppercase tracking-wide">
        {label}
      </p>
      <p className="text-lg font-semibold text-slate-900 dark:text-slate-100 mt-1 truncate">
        {value}
      </p>
      {hint && (
        <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5">{hint}</p>
      )}
    </div>
  );
}
