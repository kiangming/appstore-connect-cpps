"use client";

import { useState } from "react";
import type {
  AppCustomProductPage,
  AppCustomProductPageVersion,
  AppCustomProductPageLocalization,
  CppState,
} from "@/types/asc";
import { resolveVisibility } from "@/types/asc";
import { AppStorePreview } from "@/components/cpp/AppStorePreview";
import { LocalizationManager } from "@/components/cpp/LocalizationManager";

interface Props {
  cpp: AppCustomProductPage;
  appId: string;
  versions: AppCustomProductPageVersion[];
  localizations: AppCustomProductPageLocalization[];
}

const TABS = ["Overview", "Details", "Assets", "Preview"] as const;
type Tab = (typeof TABS)[number];

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
  READY_FOR_REVIEW: "Ready for Review",
  WAITING_FOR_REVIEW: "Waiting for Review",
  IN_REVIEW: "In Review",
  APPROVED: "Approved",
  REJECTED: "Rejected",
};

function StateBadge({ state }: { state: CppState }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${STATE_STYLES[state]}`}
    >
      {STATE_LABELS[state]}
    </span>
  );
}

export function CppEditor({ cpp, appId, versions, localizations }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>("Overview");
  const [name, setName] = useState(cpp.attributes.name);
  const [isVisible, setIsVisible] = useState(cpp.attributes.isVisible);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const latestVersion = versions[0];

  async function handleSave() {
    setSaving(true);
    setSaveMsg(null);
    try {
      const res = await fetch(`/api/asc/cpps/${cpp.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, isVisible }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? "Save failed");
      }
      setSaveMsg("Saved successfully");
      setTimeout(() => setSaveMsg(null), 3000);
    } catch (err) {
      setSaveMsg(err instanceof Error ? err.message : "Error saving");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex gap-6">
      <div className="flex-1 min-w-0">
        <div className="flex border-b border-slate-200 mb-6">
          {TABS.map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
                activeTab === tab
                  ? "border-[#0071E3] text-[#0071E3]"
                  : "border-transparent text-slate-500 hover:text-slate-700"
              }`}
            >
              {tab}
            </button>
          ))}
        </div>

        {activeTab === "Overview" && (
          <div className="space-y-4">
            <div className="bg-white rounded-xl border border-slate-200 p-6">
              <h2 className="text-sm font-semibold text-slate-700 mb-4">Current Status</h2>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-slate-400 text-xs mb-1">CPP Name</p>
                  <p className="text-slate-900 font-medium">{cpp.attributes.name}</p>
                </div>
                <div>
                  <p className="text-slate-400 text-xs mb-1">Visibility</p>
                  <p className="text-slate-900">
                    {resolveVisibility(cpp.attributes)}
                  </p>
                </div>
                {latestVersion && (
                  <div>
                    <p className="text-slate-400 text-xs mb-1">Version State</p>
                    <StateBadge state={latestVersion.attributes.state} />
                  </div>
                )}
                {latestVersion?.attributes.deepLink && (
                  <div>
                    <p className="text-slate-400 text-xs mb-1">Deep Link</p>
                    <p className="text-slate-900 font-mono text-xs break-all">
                      {latestVersion.attributes.deepLink}
                    </p>
                  </div>
                )}
              </div>
            </div>

            {localizations.length > 0 && (
              <div className="bg-white rounded-xl border border-slate-200 p-6">
                <h2 className="text-sm font-semibold text-slate-700 mb-4">
                  Localizations ({localizations.length})
                </h2>
                <div className="space-y-3">
                  {localizations.map((loc) => (
                    <div
                      key={loc.id}
                      className="rounded-lg border border-slate-100 bg-slate-50 px-4 py-3"
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-mono font-medium text-slate-600 bg-slate-200 px-2 py-0.5 rounded">
                          {loc.attributes.locale}
                        </span>
                        <span className="text-xs text-slate-400">{loc.id}</span>
                      </div>
                      {loc.attributes.promotionalText ? (
                        <p className="text-sm text-slate-700 mt-2 whitespace-pre-wrap">
                          {loc.attributes.promotionalText}
                        </p>
                      ) : (
                        <p className="text-xs text-slate-400 mt-1 italic">No promotional text</p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {localizations.length === 0 && (
              <div className="bg-white rounded-xl border border-slate-200 p-6 text-center">
                <p className="text-sm text-slate-400">No localizations found for this version.</p>
              </div>
            )}
          </div>
        )}

        {activeTab === "Details" && (
          <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-5">
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-slate-700">Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#0071E3] focus:border-transparent transition"
              />
            </div>

            <div className="flex items-center gap-3">
              <input
                id="visible"
                type="checkbox"
                checked={isVisible ?? false}
                onChange={(e) => setIsVisible(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 accent-[#0071E3]"
              />
              <label htmlFor="visible" className="text-sm text-slate-700">
                Visible on App Store
              </label>
            </div>

            {saveMsg && (
              <p
                className={`text-sm rounded-lg px-3 py-2 ${
                  saveMsg.includes("success")
                    ? "bg-green-50 border border-green-200 text-green-700"
                    : "bg-red-50 border border-red-200 text-red-700"
                }`}
              >
                {saveMsg}
              </p>
            )}

            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 text-sm font-medium text-white bg-[#0071E3] hover:bg-[#0077ED] rounded-lg transition disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save Changes"}
            </button>
          </div>
        )}

        {activeTab === "Assets" && (
          <LocalizationManager
            cppId={cpp.id}
            versionId={versions[0]?.id ?? ""}
            initialLocalizations={localizations}
            appId={appId}
          />
        )}

        {activeTab === "Preview" && (
          <AppStorePreview screenshots={[]} appName={name} />
        )}
      </div>
    </div>
  );
}
