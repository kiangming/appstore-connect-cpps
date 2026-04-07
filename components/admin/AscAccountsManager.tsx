"use client";

import { useState } from "react";
import { Plus, Trash2, Pencil, X, Save } from "lucide-react";
import type { AscAccountPublic } from "@/lib/asc-accounts";

interface Props {
  accounts: AscAccountPublic[];
}

interface FormState {
  id: string;
  name: string;
  keyId: string;
  issuerId: string;
  privateKey: string;
}

const emptyForm: FormState = { id: "", name: "", keyId: "", issuerId: "", privateKey: "" };

export function AscAccountsManager({ accounts: initial }: Props) {
  const [accounts, setAccounts] = useState(initial);
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function openAdd() {
    setForm(emptyForm);
    setEditingId(null);
    setShowAddForm(true);
    setError(null);
  }

  function openEdit(account: AscAccountPublic) {
    setForm({ id: account.id, name: account.name, keyId: account.keyId, issuerId: "", privateKey: "" });
    setEditingId(account.id);
    setShowAddForm(false);
    setError(null);
  }

  function closeForm() {
    setShowAddForm(false);
    setEditingId(null);
    setForm(emptyForm);
    setError(null);
  }

  async function handleCreate() {
    if (!form.id || !form.name || !form.keyId || !form.issuerId || !form.privateKey) {
      setError("All fields are required.");
      return;
    }
    setSaving(true);
    setError(null);
    const res = await fetch("/api/admin/asc-accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    setSaving(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? `Error ${res.status}`);
      return;
    }
    setAccounts((prev) => [...prev, { id: form.id, name: form.name, keyId: form.keyId }]);
    closeForm();
  }

  async function handleUpdate() {
    if (!editingId) return;
    if (!form.name && !form.keyId && !form.issuerId && !form.privateKey) {
      setError("Provide at least one field to update.");
      return;
    }
    setSaving(true);
    setError(null);
    const body: Record<string, string> = {};
    if (form.name) body.name = form.name;
    if (form.keyId) body.keyId = form.keyId;
    if (form.issuerId) body.issuerId = form.issuerId;
    if (form.privateKey) body.privateKey = form.privateKey;

    const res = await fetch(`/api/admin/asc-accounts/${editingId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setSaving(false);
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      setError(b.error ?? `Error ${res.status}`);
      return;
    }
    setAccounts((prev) =>
      prev.map((a) =>
        a.id === editingId
          ? { ...a, name: form.name || a.name, keyId: form.keyId || a.keyId }
          : a
      )
    );
    closeForm();
  }

  async function handleDelete(id: string) {
    if (!confirm(`Delete account "${id}"? This cannot be undone.`)) return;
    setDeletingId(id);
    const res = await fetch(`/api/admin/asc-accounts/${id}`, { method: "DELETE" });
    setDeletingId(null);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      alert(body.error ?? `Error ${res.status}`);
      return;
    }
    setAccounts((prev) => prev.filter((a) => a.id !== id));
  }

  return (
    <div className="max-w-3xl mx-auto py-10 px-4">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">ASC Accounts</h1>
          <p className="text-sm text-slate-500 mt-0.5">Manage App Store Connect API keys</p>
        </div>
        <button
          onClick={openAdd}
          className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-[#0071E3] hover:bg-[#0077ED] text-white rounded-lg transition"
        >
          <Plus className="h-4 w-4" />
          Add Account
        </button>
      </div>

      {/* Account list */}
      <div className="rounded-xl border border-slate-200 bg-white divide-y divide-slate-100 mb-6">
        {accounts.length === 0 && (
          <p className="text-sm text-slate-500 text-center py-10">No accounts yet.</p>
        )}
        {accounts.map((account) => (
          <div key={account.id} className="flex items-center justify-between px-4 py-3 gap-4">
            <div className="min-w-0">
              <p className="text-sm font-medium text-slate-900 truncate">{account.name}</p>
              <p className="text-xs text-slate-400 font-mono mt-0.5">
                {account.id} · Key: {account.keyId.slice(0, 4)}••••
              </p>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <button
                onClick={() => openEdit(account)}
                className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded transition"
              >
                <Pencil className="h-4 w-4" />
              </button>
              <button
                onClick={() => handleDelete(account.id)}
                disabled={deletingId === account.id}
                className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded transition disabled:opacity-40"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Add / Edit form */}
      {(showAddForm || editingId !== null) && (
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-slate-900">
              {showAddForm ? "Add Account" : `Edit: ${editingId}`}
            </h2>
            <button onClick={closeForm} className="text-slate-400 hover:text-slate-700">
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="space-y-3">
            {showAddForm && (
              <Field label="ID" placeholder="e.g. vng-corp" value={form.id}
                onChange={(v) => setForm((f) => ({ ...f, id: v }))} />
            )}
            <Field label="Name" placeholder="VNG Corp" value={form.name}
              onChange={(v) => setForm((f) => ({ ...f, name: v }))} />
            <Field label="Key ID" placeholder="ABCDE12345" value={form.keyId}
              onChange={(v) => setForm((f) => ({ ...f, keyId: v }))} mono />
            <Field label={editingId ? "Issuer ID (leave blank to keep)" : "Issuer ID"}
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" value={form.issuerId}
              onChange={(v) => setForm((f) => ({ ...f, issuerId: v }))} mono />
            <div className="space-y-1">
              <label className="block text-xs font-medium text-slate-600">
                {editingId ? "Private Key (.p8) — leave blank to keep current" : "Private Key (.p8)"}
              </label>
              <textarea
                rows={5}
                value={form.privateKey}
                onChange={(e) => setForm((f) => ({ ...f, privateKey: e.target.value }))}
                placeholder={"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs font-mono text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#0071E3] focus:border-transparent transition resize-none"
              />
              <p className="text-xs text-slate-400">Paste the full contents of your .p8 file</p>
            </div>
          </div>

          {error && (
            <p className="mt-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2 mt-4">
            <button onClick={closeForm}
              className="px-4 py-2 text-sm font-medium bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg transition">
              Cancel
            </button>
            <button
              onClick={showAddForm ? handleCreate : handleUpdate}
              disabled={saving}
              className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-[#0071E3] hover:bg-[#0077ED] text-white rounded-lg transition disabled:opacity-50"
            >
              <Save className="h-3.5 w-3.5" />
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({
  label, placeholder, value, onChange, mono = false,
}: {
  label: string; placeholder: string; value: string;
  onChange: (v: string) => void; mono?: boolean;
}) {
  return (
    <div className="space-y-1">
      <label className="block text-xs font-medium text-slate-600">{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#0071E3] focus:border-transparent transition ${mono ? "font-mono text-xs" : ""}`}
      />
    </div>
  );
}
