"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const SUPPORTED_LOCALES = [
  { value: "en-US", label: "English (US)" },
  { value: "en-GB", label: "English (UK)" },
  { value: "vi", label: "Vietnamese" },
  { value: "ja", label: "Japanese" },
  { value: "zh-Hans", label: "Chinese (Simplified)" },
  { value: "zh-Hant", label: "Chinese (Traditional)" },
  { value: "ko", label: "Korean" },
  { value: "fr-FR", label: "French" },
  { value: "de-DE", label: "German" },
  { value: "es-ES", label: "Spanish (Spain)" },
  { value: "pt-BR", label: "Portuguese (Brazil)" },
];

interface Props {
  params: { appId: string };
}

export default function NewCppPage({ params }: Props) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [locale, setLocale] = useState("en-US");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const res = await fetch("/api/asc/cpps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId: params.appId, name, locale }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? "Failed to create CPP");
      }

      router.push(`/apps/${params.appId}/cpps`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="p-8 max-w-lg">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-900">New Custom Product Page</h1>
        <p className="text-sm text-slate-500 mt-0.5">
          Create a new CPP for app{" "}
          <code className="font-mono text-xs bg-slate-100 px-1 rounded">{params.appId}</code>
        </p>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 p-6">
        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="space-y-1.5">
            <label htmlFor="name" className="block text-sm font-medium text-slate-700">
              CPP Name <span className="text-red-500">*</span>
            </label>
            <input
              id="name"
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Summer Campaign"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#0071E3] focus:border-transparent transition"
            />
            <p className="text-xs text-slate-400">Internal name, not shown on the App Store</p>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="locale" className="block text-sm font-medium text-slate-700">
              Primary Locale <span className="text-red-500">*</span>
            </label>
            <select
              id="locale"
              value={locale}
              onChange={(e) => setLocale(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#0071E3] focus:border-transparent transition bg-white"
            >
              {SUPPORTED_LOCALES.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
          </div>

          {error && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={() => router.back()}
              className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !name.trim()}
              className="px-4 py-2 text-sm font-medium text-white bg-[#0071E3] hover:bg-[#0077ED] rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? "Creating…" : "Create CPP"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
