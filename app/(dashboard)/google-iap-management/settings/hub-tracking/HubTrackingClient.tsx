"use client";

import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { CheckCircle2, RefreshCw, ShieldAlert } from "lucide-react";
import type { HubTrackingConfigPublic } from "@/lib/google-iap-management/hub-tracking/config";

interface Props {
  initialConfig: HubTrackingConfigPublic;
}

interface SaveResponse extends HubTrackingConfigPublic {
  validation?: { ok: boolean; reason?: "rejected" | "network-error"; detail?: string };
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function HubTrackingClient({ initialConfig }: Props) {
  const [config, setConfig] = useState(initialConfig);
  const [workflowId, setWorkflowId] = useState(initialConfig.workflow_id);
  const [token, setToken] = useState("");
  const [enabled, setEnabled] = useState(initialConfig.enabled);
  const [saving, setSaving] = useState(false);
  const [validation, setValidation] = useState<SaveResponse["validation"]>(undefined);

  async function handleSave() {
    if (!workflowId.trim()) {
      toast.error("Workflow ID is required.");
      return;
    }
    setSaving(true);
    setValidation(undefined);
    try {
      const res = await fetch("/api/google-iap-management/hub-tracking/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflow_id: workflowId.trim(),
          ...(token ? { token } : {}),
          enabled,
        }),
      });
      const data = (await res.json()) as SaveResponse | { error: string };
      if (!res.ok) {
        toast.error("error" in data ? data.error : `Save failed (HTTP ${res.status})`);
        return;
      }
      const saved = data as SaveResponse;
      setConfig(saved);
      setToken("");
      setValidation(saved.validation);

      if (saved.validation?.ok === false) {
        if (saved.validation.reason === "rejected") {
          toast.warning("Saved — but Hub rejected these credentials (check Workflow ID / Token).");
        } else {
          toast.warning("Saved — couldn't verify with Hub right now (saved anyway).");
        }
      } else {
        toast.success("Hub tracking config saved.");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Network error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="p-8 max-w-3xl mx-auto">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Hub Tracking</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Tracks each Bulk Import run on the VNGGames Hub dashboard —
            started when the Excel upload is previewed, closed once the
            Google Play import finishes.
          </p>
        </div>
        <Link
          href="/google-iap-management/settings/google-accounts"
          className="text-sm text-slate-500 hover:text-emerald-700 transition shrink-0"
        >
          ← Google Accounts
        </Link>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-5">
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
              config.configured
                ? "bg-emerald-100 text-emerald-700"
                : "bg-slate-100 text-slate-500"
            }`}
          >
            {config.configured ? (
              <CheckCircle2 className="h-3.5 w-3.5" />
            ) : (
              <ShieldAlert className="h-3.5 w-3.5" />
            )}
            {config.configured ? "Configured" : "Not configured"}
          </span>
          {config.configured && (
            <span className="text-xs text-slate-400">
              Last saved {formatTimestamp(config.updated_at)}
            </span>
          )}
        </div>

        <label className="flex items-center justify-between gap-4 py-2 border-y border-slate-100">
          <div>
            <p className="text-sm font-medium text-slate-900">Tracking enabled</p>
            <p className="text-xs text-slate-400 mt-0.5">
              Off fully no-ops tracking — Bulk Import works exactly as
              today. Doesn&apos;t delete the stored Workflow ID / Token.
            </p>
          </div>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="h-5 w-5 accent-emerald-600"
          />
        </label>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">
            Workflow ID
          </label>
          <input
            type="text"
            value={workflowId}
            onChange={(e) => setWorkflowId(e.target.value)}
            placeholder="e.g. google-iap-bulk-import"
            className="w-full px-3 py-2 text-sm border border-slate-300 bg-white rounded-lg"
          />
          <p className="text-xs text-slate-400 mt-1">
            Must already be registered in Hub Admin → Workflows — an
            unregistered ID is rejected by Hub (surfaced below on save).
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">Token</label>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={config.configured ? "•••••••• (configured — leave blank to keep)" : "Ingest token"}
            autoComplete="off"
            className="w-full px-3 py-2 text-sm border border-slate-300 bg-white rounded-lg"
          />
          <p className="text-xs text-slate-400 mt-1">
            Never shown once saved. Leave blank to keep the existing token.
          </p>
        </div>

        {validation && !validation.ok && (
          <div
            role="alert"
            className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
          >
            {validation.reason === "rejected"
              ? "Hub rejected these credentials — double-check the Workflow ID is registered and the Token is correct."
              : "Couldn't verify with Hub right now (saved anyway) — tracking may silently no-op until Hub is reachable."}
          </div>
        )}

        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg transition disabled:opacity-50"
        >
          {saving && <RefreshCw className="h-4 w-4 animate-spin" />}
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
