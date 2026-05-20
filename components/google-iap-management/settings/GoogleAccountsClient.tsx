"use client";

import { useRef, useState } from "react";
import {
  Plus,
  Trash2,
  Upload,
  CheckCircle2,
  AlertCircle,
  Clock,
  Building2,
  ShieldCheck,
  X,
} from "lucide-react";

import type { GoogleConsoleAccountPublic } from "@/lib/google-iap-management/repository/google-accounts";

interface Props {
  initialAccounts: GoogleConsoleAccountPublic[];
}

export function GoogleAccountsClient({ initialAccounts }: Props) {
  const [accounts, setAccounts] = useState(initialAccounts);
  const [showAddForm, setShowAddForm] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [jsonContent, setJsonContent] = useState("");
  const [filename, setFilename] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function resetForm() {
    setDisplayName("");
    setJsonContent("");
    setFilename("");
    setFormError(null);
  }

  function openAdd() {
    resetForm();
    setShowAddForm(true);
    setPageError(null);
  }

  function closeAdd() {
    setShowAddForm(false);
    resetForm();
  }

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".json")) {
      setFormError("Please choose a Service Account .json file.");
      e.target.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = (ev.target?.result as string) ?? "";
      setJsonContent(text);
      setFilename(file.name);
      setFormError(null);
      // Try to auto-fill display name from project_id if blank.
      if (!displayName.trim()) {
        try {
          const parsed = JSON.parse(text) as { project_id?: string };
          if (typeof parsed.project_id === "string") {
            setDisplayName(parsed.project_id);
          }
        } catch {
          // best effort only
        }
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  async function handleCreate() {
    if (!displayName.trim()) {
      setFormError("Display name is required.");
      return;
    }
    if (!jsonContent.trim()) {
      setFormError("Upload or paste the Service Account JSON.");
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const res = await fetch("/api/google-iap-management/google-accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: displayName.trim(),
          serviceAccountJson: jsonContent,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        account?: GoogleConsoleAccountPublic;
        error?: string;
      };
      if (!res.ok) {
        setFormError(body.error ?? `Error ${res.status}`);
        return;
      }
      if (body.account) {
        setAccounts((prev) => [body.account!, ...prev]);
      }
      closeAdd();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Network error");
    } finally {
      setSaving(false);
    }
  }

  async function handleVerify(id: string) {
    setVerifyingId(id);
    setPageError(null);
    try {
      const res = await fetch(
        `/api/google-iap-management/google-accounts/${id}/verify`,
        { method: "POST" },
      );
      const body = (await res.json().catch(() => ({}))) as {
        status?: string;
        apps_visible?: number;
        error?: string;
      };
      if (!res.ok) {
        setAccounts((prev) =>
          prev.map((a) => (a.id === id ? { ...a, status: "invalid" } : a)),
        );
        setPageError(body.error ?? `Verification failed (HTTP ${res.status}).`);
        return;
      }
      setAccounts((prev) =>
        prev.map((a) =>
          a.id === id
            ? { ...a, status: "verified", verified_at: new Date().toISOString() }
            : a,
        ),
      );
    } catch (err) {
      setPageError(err instanceof Error ? err.message : "Network error");
    } finally {
      setVerifyingId(null);
    }
  }

  async function handleDelete(id: string, name: string) {
    if (!confirm(`Delete Google Console account "${name}"? This cannot be undone.`))
      return;
    setDeletingId(id);
    setPageError(null);
    try {
      const res = await fetch(`/api/google-iap-management/google-accounts/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setPageError(body.error ?? `Delete failed (HTTP ${res.status}).`);
        return;
      }
      setAccounts((prev) => prev.filter((a) => a.id !== id));
    } catch (err) {
      setPageError(err instanceof Error ? err.message : "Network error");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="p-8 max-w-3xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-900">
          Google Console Accounts
        </h1>
        <p className="text-sm text-slate-500 mt-0.5">
          Service Account credentials for Google Play Android Publisher + Reporting APIs
        </p>
      </div>

      {pageError && (
        <div className="mb-4 flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
          <span>{pageError}</span>
        </div>
      )}

      <div className="bg-white rounded-xl border border-slate-200 p-6 mb-4">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-base font-medium text-slate-900">Accounts</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Credentials encrypted at rest (AES-256-GCM, never logged)
            </p>
          </div>
          <button
            onClick={openAdd}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg transition"
          >
            <Plus className="h-4 w-4" />
            Add account
          </button>
        </div>

        {accounts.length === 0 ? (
          <p className="text-sm text-slate-400 italic text-center py-6">
            No accounts yet. Click &ldquo;Add account&rdquo; to upload a Service Account .json.
          </p>
        ) : (
          <div className="space-y-2">
            {accounts.map((a) => (
              <div
                key={a.id}
                className="flex items-center gap-3 rounded-lg border border-slate-100 bg-slate-50 px-4 py-3"
              >
                <Building2 className="h-4 w-4 text-slate-400 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-slate-800 truncate">
                      {a.display_name}
                    </span>
                    <StatusBadge status={a.status} />
                  </div>
                  <p className="text-xs text-slate-400 font-mono mt-0.5 truncate">
                    {a.service_account_email}
                  </p>
                  {a.verified_at && a.status === "verified" && (
                    <p className="text-[11px] text-slate-400 mt-0.5">
                      Verified {new Date(a.verified_at).toLocaleString()}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => handleVerify(a.id)}
                    disabled={verifyingId === a.id}
                    className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-slate-600 hover:text-emerald-700 hover:bg-emerald-50 rounded transition disabled:opacity-40"
                    title="Verify both API scopes"
                  >
                    <ShieldCheck className="h-3.5 w-3.5" />
                    {verifyingId === a.id ? "Verifying…" : "Verify"}
                  </button>
                  <button
                    onClick={() => handleDelete(a.id, a.display_name)}
                    disabled={deletingId === a.id}
                    className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded transition disabled:opacity-40"
                    title="Delete"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {showAddForm && (
        <div className="bg-white rounded-xl border border-slate-200 p-6">
          <div className="flex items-center justify-between mb-5">
            <h2 className="text-base font-medium text-slate-900">
              Add Google Console account
            </h2>
            <button
              onClick={closeAdd}
              className="text-slate-400 hover:text-slate-700 transition"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-slate-700">
                Display name *
              </label>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="VNG Games — Play Console"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition"
              />
              <p className="text-[11px] text-slate-400">
                Human-friendly label. Auto-filled from project_id if you upload first.
              </p>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="block text-sm font-medium text-slate-700">
                  Service Account JSON *
                </label>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="flex items-center gap-1.5 text-xs text-emerald-700 hover:text-emerald-800 transition"
                >
                  <Upload className="h-3 w-3" />
                  Upload .json
                </button>
              </div>
              <textarea
                rows={6}
                value={jsonContent}
                onChange={(e) => setJsonContent(e.target.value)}
                placeholder={'{\n  "type": "service_account",\n  "project_id": "…",\n  …\n}'}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs font-mono text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition resize-none"
              />
              {filename && (
                <p className="text-[11px] text-slate-500">
                  Loaded: <span className="font-mono">{filename}</span>
                </p>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,application/json"
                onChange={handleFile}
                className="hidden"
              />
            </div>
          </div>

          {formError && (
            <p className="mt-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {formError}
            </p>
          )}

          <div className="flex justify-end gap-2 mt-5">
            <button
              onClick={closeAdd}
              className="px-4 py-2 text-sm font-medium bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg transition"
            >
              Cancel
            </button>
            <button
              onClick={handleCreate}
              disabled={saving}
              className="px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg transition disabled:opacity-50"
            >
              {saving ? "Saving…" : "Add account"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusBadge({
  status,
}: {
  status: "pending" | "verified" | "invalid";
}) {
  if (status === "verified") {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-1.5 py-0.5">
        <CheckCircle2 className="h-2.5 w-2.5" />
        Verified
      </span>
    );
  }
  if (status === "invalid") {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-medium text-red-700 bg-red-50 border border-red-200 rounded px-1.5 py-0.5">
        <AlertCircle className="h-2.5 w-2.5" />
        Invalid
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">
      <Clock className="h-2.5 w-2.5" />
      Pending
    </span>
  );
}
