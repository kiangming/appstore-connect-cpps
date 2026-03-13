"use client";

import { useState } from "react";
import Link from "next/link";
import { FolderInput, Download, Copy, Check, Trash2 } from "lucide-react";
import type { AppCustomProductPage, CppState } from "@/types/asc";
import { resolveVisibility } from "@/types/asc";
import { CppDetailPanel } from "@/components/cpp/CppDetailPanel";
import { CppBulkImportDialog } from "@/components/cpp/CppBulkImportDialog";

interface Props {
  cpps: AppCustomProductPage[];
  appId: string;
  versionStates: Record<string, CppState>;
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
  READY_FOR_REVIEW: "Ready",
  WAITING_FOR_REVIEW: "Waiting",
  IN_REVIEW: "In Review",
  APPROVED: "Approved",
  REJECTED: "Rejected",
};

const DELETABLE_STATES: CppState[] = ["PREPARE_FOR_SUBMISSION", "APPROVED"];

function StatusBadge({ state }: { state?: CppState }) {
  if (!state) return <span className="text-xs text-slate-400">—</span>;
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${STATE_STYLES[state]}`}>
      {STATE_LABELS[state]}
    </span>
  );
}

// ── Dialog: no selection ───────────────────────────────────────────────────────
function NoSelectionDialog({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-sm bg-white rounded-xl shadow-xl border border-slate-200 p-6">
        <h2 className="text-base font-semibold text-slate-900 mb-2">No CPPs selected</h2>
        <p className="text-sm text-slate-500 mb-5">Please select at least one CPP to delete.</p>
        <div className="flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg transition"
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Dialog: review selected list ───────────────────────────────────────────────
function ReviewDialog({
  selected,
  versionStates,
  onCancel,
  onConfirm,
}: {
  selected: AppCustomProductPage[];
  versionStates: Record<string, CppState>;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-md bg-white rounded-xl shadow-xl border border-slate-200 p-6">
        <h2 className="text-base font-semibold text-slate-900 mb-1">Delete CPPs</h2>
        <p className="text-sm text-slate-500 mb-3">
          The following CPPs and all their localizations will be permanently deleted:
        </p>
        <ul className="max-h-48 overflow-y-auto rounded-lg border border-slate-100 bg-slate-50 divide-y divide-slate-100 mb-5">
          {selected.map((cpp) => (
            <li key={cpp.id} className="flex items-center justify-between px-3 py-2">
              <span className="text-sm text-slate-800 font-medium truncate max-w-[260px]">{cpp.attributes.name}</span>
              <StatusBadge state={versionStates[cpp.id]} />
            </li>
          ))}
        </ul>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm font-medium bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg transition"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-4 py-2 text-sm font-medium bg-red-600 hover:bg-red-700 text-white rounded-lg transition"
          >
            Continue →
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Dialog: final confirmation ─────────────────────────────────────────────────
function FinalConfirmDialog({
  count,
  deleting,
  onCancel,
  onDelete,
}: {
  count: number;
  deleting: boolean;
  onCancel: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-sm bg-white rounded-xl shadow-xl border border-slate-200 p-6">
        <h2 className="text-base font-semibold text-slate-900 mb-2">⚠ Confirm permanent deletion</h2>
        <p className="text-sm text-slate-600 mb-5">
          Are you sure you want to delete <strong>{count} CPP{count > 1 ? "s" : ""}</strong> along
          with all their localizations? This action cannot be undone.
        </p>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={deleting}
            className="px-4 py-2 text-sm font-medium bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg transition disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onDelete}
            disabled={deleting}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-red-600 hover:bg-red-700 text-white rounded-lg transition disabled:opacity-60"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {deleting ? "Deleting…" : "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Dialog: result summary ─────────────────────────────────────────────────────
function ResultDialog({
  succeeded,
  failed,
  onClose,
}: {
  succeeded: number;
  failed: Array<{ name: string; reason: string }>;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-md bg-white rounded-xl shadow-xl border border-slate-200 p-6">
        <h2 className="text-base font-semibold text-slate-900 mb-3">Deletion complete</h2>
        {succeeded > 0 && (
          <p className="text-sm text-green-700 mb-2">
            ✓ {succeeded} CPP{succeeded > 1 ? "s" : ""} deleted successfully.
          </p>
        )}
        {failed.length > 0 && (
          <>
            <p className="text-sm text-red-600 mb-1">✗ {failed.length} failed:</p>
            <ul className="max-h-36 overflow-y-auto rounded-lg border border-red-100 bg-red-50 divide-y divide-red-100 mb-3">
              {failed.map((f, i) => (
                <li key={i} className="px-3 py-2">
                  <p className="text-sm font-medium text-slate-800">{f.name}</p>
                  <p className="text-xs text-red-600">{f.reason}</p>
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg transition"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main CppList ───────────────────────────────────────────────────────────────
export function CppList({ cpps, appId, versionStates }: Props) {
  const [viewingCpp, setViewingCpp] = useState<AppCustomProductPage | null>(null);
  const [showBulkImport, setShowBulkImport] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Selection state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Delete dialog state: null | "no-selection" | "review" | "confirm" | "result"
  const [deleteStep, setDeleteStep] = useState<"no-selection" | "review" | "confirm" | "result" | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteResult, setDeleteResult] = useState<{
    succeeded: number;
    failed: Array<{ name: string; reason: string }>;
  } | null>(null);

  const eligibleIds = cpps
    .filter((cpp) => {
      const state = versionStates[cpp.id];
      return !state || DELETABLE_STATES.includes(state);
    })
    .map((cpp) => cpp.id);

  const allEligibleSelected =
    eligibleIds.length > 0 && eligibleIds.every((id) => selectedIds.has(id));

  function toggleSelectAll() {
    if (allEligibleSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(eligibleIds));
    }
  }

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleCopy(cppId: string, url: string) {
    try {
      navigator.clipboard.writeText(url);
      setCopiedId(cppId);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {
      // clipboard unavailable — silent fail
    }
  }

  function handleExportCsv() {
    const header = ["Name", "Status", "URL"];
    const rows = cpps.map((cpp) => [
      `"${cpp.attributes.name.replace(/"/g, '""')}"`,
      `"${STATE_LABELS[versionStates[cpp.id]!] ?? ""}"`,
      `"${cpp.attributes.url ?? ""}"`,
    ]);
    const csv = [header.join(","), ...rows.map((r) => r.join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `cpps-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleDeleteClick() {
    if (selectedIds.size === 0) {
      setDeleteStep("no-selection");
    } else {
      setDeleteStep("review");
    }
  }

  function closeAllDialogs() {
    setDeleteStep(null);
    setDeleteResult(null);
  }

  async function handleFinalDelete() {
    const selected = cpps.filter((cpp) => selectedIds.has(cpp.id));
    setDeleting(true);

    const results = await Promise.allSettled(
      selected.map((cpp) =>
        fetch(`/api/asc/cpps/${cpp.id}`, { method: "DELETE" }).then(async (res) => {
          if (res.status === 204) return { cpp, ok: true, reason: "" };
          const body = await res.json().catch(() => ({}));
          return { cpp, ok: false, reason: body.error ?? `HTTP ${res.status}` };
        })
      )
    );

    const succeeded = results.filter(
      (r) => r.status === "fulfilled" && r.value.ok
    ).length;
    const failed = results
      .filter((r) => r.status === "fulfilled" && !r.value.ok)
      .map((r) => ({
        name: (r as PromiseFulfilledResult<{ cpp: AppCustomProductPage; ok: boolean; reason: string }>).value.cpp.attributes.name,
        reason: (r as PromiseFulfilledResult<{ cpp: AppCustomProductPage; ok: boolean; reason: string }>).value.reason,
      }));

    setDeleting(false);
    setDeleteResult({ succeeded, failed });
    setDeleteStep("result");

    if (succeeded > 0) {
      setSelectedIds(new Set());
    }
  }

  const selectedCpps = cpps.filter((cpp) => selectedIds.has(cpp.id));

  if (cpps.length === 0) {
    return (
      <>
        <div className="rounded-xl border border-slate-200 bg-white py-16 text-center">
          <p className="text-sm text-slate-500">No Custom Product Pages yet.</p>
          <div className="mt-3 flex items-center justify-center gap-4">
            <Link
              href={`/apps/${appId}/cpps/new`}
              className="text-sm font-medium text-[#0071E3] hover:underline"
            >
              Create your first CPP →
            </Link>
            <button
              onClick={() => setShowBulkImport(true)}
              className="flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-800 transition"
            >
              <FolderInput className="h-4 w-4" />
              Bulk Import CPPs
            </button>
          </div>
        </div>
        {showBulkImport && (
          <CppBulkImportDialog
            appId={appId}
            existingCpps={cpps}
            onClose={() => setShowBulkImport(false)}
            onComplete={() => { setShowBulkImport(false); window.location.reload(); }}
          />
        )}
      </>
    );
  }

  return (
    <>
      {/* Action bar */}
      <div className="flex items-center justify-between gap-2 mb-3">
        {/* Left: Delete */}
        <button
          onClick={handleDeleteClick}
          className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border transition ${
            selectedIds.size > 0
              ? "bg-red-600 hover:bg-red-700 text-white border-red-600"
              : "bg-white text-red-500 border-red-200 hover:bg-red-50"
          }`}
        >
          <Trash2 className="h-4 w-4" />
          Delete{selectedIds.size > 0 ? ` (${selectedIds.size})` : ""}
        </button>

        {/* Right: Export + Bulk Import */}
        <div className="flex items-center gap-2">
          <button
            onClick={handleExportCsv}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition"
          >
            <Download className="h-4 w-4" />
            Export CSV
          </button>
          <button
            onClick={() => setShowBulkImport(true)}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition"
          >
            <FolderInput className="h-4 w-4" />
            Bulk Import CPPs
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50">
              <th className="px-4 py-3 w-8">
                <input
                  type="checkbox"
                  checked={allEligibleSelected}
                  onChange={toggleSelectAll}
                  className="rounded border-slate-300 text-red-600 focus:ring-red-500"
                  title="Select all eligible"
                />
              </th>
              <th className="px-4 py-3 text-left font-medium text-slate-500 text-xs uppercase tracking-wider">Name</th>
              <th className="px-4 py-3 text-left font-medium text-slate-500 text-xs uppercase tracking-wider">Status</th>
              <th className="px-4 py-3 text-left font-medium text-slate-500 text-xs uppercase tracking-wider">Visibility</th>
              <th className="px-4 py-3 text-left font-medium text-slate-500 text-xs uppercase tracking-wider">CPP URL</th>
              <th className="px-4 py-3 text-left font-medium text-slate-500 text-xs uppercase tracking-wider">ID</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {cpps.map((cpp) => {
              const state = versionStates[cpp.id];
              const canDelete = !state || DELETABLE_STATES.includes(state);
              const isSelected = selectedIds.has(cpp.id);

              return (
                <tr
                  key={cpp.id}
                  className={`hover:bg-slate-50 transition-colors ${isSelected ? "bg-red-50/40" : ""}`}
                >
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      disabled={!canDelete}
                      onChange={() => toggleSelect(cpp.id)}
                      title={canDelete ? undefined : `Cannot delete while ${STATE_LABELS[state!] ?? "in review"}`}
                      className="rounded border-slate-300 text-red-600 focus:ring-red-500 disabled:opacity-30 disabled:cursor-not-allowed"
                    />
                  </td>
                  <td className="px-4 py-3 font-medium text-slate-900">{cpp.attributes.name}</td>
                  <td className="px-4 py-3">
                    <StatusBadge state={state} />
                  </td>
                  <td className="px-4 py-3 text-slate-600">{resolveVisibility(cpp.attributes)}</td>
                  <td className="px-4 py-3">
                    {cpp.attributes.url ? (
                      <div className="flex items-center gap-1.5">
                        <a
                          href={cpp.attributes.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={cpp.attributes.url}
                          className="text-xs font-mono text-[#0071E3] hover:underline max-w-[220px] truncate block"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {cpp.attributes.url}
                        </a>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleCopy(cpp.id, cpp.attributes.url!); }}
                          className="flex-shrink-0 text-slate-400 hover:text-slate-600 transition-colors"
                          title="Copy URL"
                        >
                          {copiedId === cpp.id
                            ? <Check className="h-3.5 w-3.5 text-green-500" />
                            : <Copy className="h-3.5 w-3.5" />
                          }
                        </button>
                      </div>
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-400">{cpp.id}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-3">
                      <button
                        onClick={() => setViewingCpp(cpp)}
                        className="text-sm text-slate-500 hover:text-slate-800 transition-colors"
                      >
                        View
                      </button>
                      <Link
                        href={`/apps/${appId}/cpps/${cpp.id}`}
                        className="text-sm font-medium text-[#0071E3] hover:underline"
                      >
                        Edit
                      </Link>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Dialogs */}
      {deleteStep === "no-selection" && (
        <NoSelectionDialog onClose={closeAllDialogs} />
      )}
      {deleteStep === "review" && (
        <ReviewDialog
          selected={selectedCpps}
          versionStates={versionStates}
          onCancel={closeAllDialogs}
          onConfirm={() => setDeleteStep("confirm")}
        />
      )}
      {deleteStep === "confirm" && (
        <FinalConfirmDialog
          count={selectedIds.size}
          deleting={deleting}
          onCancel={closeAllDialogs}
          onDelete={handleFinalDelete}
        />
      )}
      {deleteStep === "result" && deleteResult && (
        <ResultDialog
          succeeded={deleteResult.succeeded}
          failed={deleteResult.failed}
          onClose={() => {
            closeAllDialogs();
            if (deleteResult.succeeded > 0) window.location.reload();
          }}
        />
      )}

      {viewingCpp && (
        <CppDetailPanel
          cppId={viewingCpp.id}
          cppName={viewingCpp.attributes.name}
          onClose={() => setViewingCpp(null)}
        />
      )}
      {showBulkImport && (
        <CppBulkImportDialog
          appId={appId}
          existingCpps={cpps}
          onClose={() => setShowBulkImport(false)}
          onComplete={() => { setShowBulkImport(false); window.location.reload(); }}
        />
      )}
    </>
  );
}
