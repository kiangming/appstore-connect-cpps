"use client";

import { useState } from "react";

export default function SettingsPage() {
  const [keyId, setKeyId] = useState("");
  const [issuerId, setIssuerId] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);

    try {
      const res = await fetch("/api/settings/asc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keyId, issuerId, privateKey }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? "Failed to save settings");
      }

      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    }
  }

  return (
    <div className="p-8 max-w-2xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-900">Settings</h1>
        <p className="text-sm text-slate-500 mt-0.5">
          Configure your App Store Connect API credentials
        </p>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 p-6">
        <h2 className="text-base font-medium text-slate-900 mb-4">
          App Store Connect API
        </h2>

        <form onSubmit={handleSave} className="space-y-5">
          <div className="space-y-1.5">
            <label htmlFor="keyId" className="block text-sm font-medium text-slate-700">
              Key ID
            </label>
            <input
              id="keyId"
              type="text"
              value={keyId}
              onChange={(e) => setKeyId(e.target.value)}
              placeholder="XXXXXXXXXX"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#0071E3] focus:border-transparent transition"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="issuerId" className="block text-sm font-medium text-slate-700">
              Issuer ID
            </label>
            <input
              id="issuerId"
              type="text"
              value={issuerId}
              onChange={(e) => setIssuerId(e.target.value)}
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#0071E3] focus:border-transparent transition"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="privateKey" className="block text-sm font-medium text-slate-700">
              Private Key (.p8 content)
            </label>
            <textarea
              id="privateKey"
              value={privateKey}
              onChange={(e) => setPrivateKey(e.target.value)}
              rows={8}
              placeholder={"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#0071E3] focus:border-transparent transition resize-none"
            />
            <p className="text-xs text-slate-400">
              Paste the full contents of your AuthKey_XXXXXXXXXX.p8 file
            </p>
          </div>

          {error && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          {saved && (
            <p className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
              Settings saved successfully
            </p>
          )}

          <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2">
            <p className="text-xs text-amber-700">
              <strong>Security note:</strong> Credentials are stored server-side only and never
              exposed to the browser.
            </p>
          </div>

          <button
            type="submit"
            className="px-4 py-2 text-sm font-medium text-white bg-[#0071E3] hover:bg-[#0077ED] rounded-lg transition"
          >
            Save Settings
          </button>
        </form>
      </div>
    </div>
  );
}
