"use client";

import { useState } from "react";
import Link from "next/link";
import { FolderInput, Download, Copy, Check } from "lucide-react";
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

function StatusBadge({ state }: { state?: CppState }) {
  if (!state) return <span className="text-xs text-slate-400">—</span>;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${STATE_STYLES[state]}`}
    >
      {STATE_LABELS[state]}
    </span>
  );
}

export function CppList({ cpps, appId, versionStates }: Props) {
  const [viewingCpp, setViewingCpp] = useState<AppCustomProductPage | null>(null);
  const [showBulkImport, setShowBulkImport] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

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
      {/* Action buttons — above the table */}
      <div className="flex justify-end gap-2 mb-3">
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

      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50">
              <th className="px-4 py-3 text-left font-medium text-slate-500 text-xs uppercase tracking-wider">
                Name
              </th>
              <th className="px-4 py-3 text-left font-medium text-slate-500 text-xs uppercase tracking-wider">
                Status
              </th>
              <th className="px-4 py-3 text-left font-medium text-slate-500 text-xs uppercase tracking-wider">
                Visibility
              </th>
              <th className="px-4 py-3 text-left font-medium text-slate-500 text-xs uppercase tracking-wider">
                CPP URL
              </th>
              <th className="px-4 py-3 text-left font-medium text-slate-500 text-xs uppercase tracking-wider">
                ID
              </th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {cpps.map((cpp) => (
              <tr key={cpp.id} className="hover:bg-slate-50 transition-colors">
                <td className="px-4 py-3 font-medium text-slate-900">
                  {cpp.attributes.name}
                </td>
                <td className="px-4 py-3">
                  <StatusBadge state={versionStates[cpp.id]} />
                </td>
                <td className="px-4 py-3 text-slate-600">
                  {resolveVisibility(cpp.attributes)}
                </td>
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
                <td className="px-4 py-3 font-mono text-xs text-slate-400">
                  {cpp.id}
                </td>
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
            ))}
          </tbody>
        </table>
      </div>

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
