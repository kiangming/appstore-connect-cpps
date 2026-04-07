"use client";

import { useState, useRef } from "react";
import { Plus, Trash2, Pencil, X, Save, Upload, Building2 } from "lucide-react";
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

function slugify(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
}

function validateKeyId(v: string): string | null {
  if (!v) return "Bắt buộc";
  if (!/^[A-Z0-9]{10}$/.test(v)) return "Key ID phải đúng 10 ký tự (A-Z, 0-9)";
  return null;
}

function validateIssuerId(v: string): string | null {
  if (!v) return "Bắt buộc";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v))
    return "Không đúng định dạng UUID";
  return null;
}

export function SettingsPage({ accounts: initial }: Props) {
  const [accounts, setAccounts] = useState(initial);
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function openAdd() {
    setForm(emptyForm);
    setEditingId(null);
    setShowAddForm(true);
    setFormErrors({});
    setApiError(null);
  }

  function openEdit(account: AscAccountPublic) {
    setForm({ id: account.id, name: account.name, keyId: account.keyId, issuerId: "", privateKey: "" });
    setEditingId(account.id);
    setShowAddForm(false);
    setFormErrors({});
    setApiError(null);
  }

  function closeForm() {
    setShowAddForm(false);
    setEditingId(null);
    setForm(emptyForm);
    setFormErrors({});
    setApiError(null);
  }

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      setForm((f) => ({ ...f, privateKey: (ev.target?.result as string) ?? "" }));
      setFormErrors((p) => ({ ...p, privateKey: "" }));
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  function validateAddForm(): boolean {
    const errors: Record<string, string> = {};
    if (!form.id.trim()) errors.id = "Bắt buộc";
    if (!form.name.trim()) errors.name = "Bắt buộc";
    const keyErr = validateKeyId(form.keyId.trim());
    if (keyErr) errors.keyId = keyErr;
    const issuerErr = validateIssuerId(form.issuerId.trim());
    if (issuerErr) errors.issuerId = issuerErr;
    if (!form.privateKey.trim()) errors.privateKey = "Bắt buộc";
    if (form.privateKey && !form.privateKey.includes("-----BEGIN PRIVATE KEY-----"))
      errors.privateKey = "Private key không hợp lệ";
    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  }

  async function handleCreate() {
    if (!validateAddForm()) return;
    setSaving(true);
    setApiError(null);

    const res = await fetch("/api/admin/asc-accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: form.id.trim() || slugify(form.name.trim()),
        name: form.name.trim(),
        keyId: form.keyId.trim(),
        issuerId: form.issuerId.trim(),
        privateKey: form.privateKey.trim().replace(/\r\n/g, "\n"),
      }),
    });

    setSaving(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setApiError(body.error ?? `Error ${res.status}`);
      return;
    }

    setAccounts((prev) => [
      ...prev,
      { id: form.id.trim() || slugify(form.name.trim()), name: form.name.trim(), keyId: form.keyId.trim() },
    ]);
    closeForm();
  }

  async function handleUpdate() {
    if (!editingId) return;
    const updates: Record<string, string> = {};
    if (form.name.trim()) updates.name = form.name.trim();
    if (form.keyId.trim()) {
      const err = validateKeyId(form.keyId.trim());
      if (err) { setFormErrors((p) => ({ ...p, keyId: err })); return; }
      updates.keyId = form.keyId.trim();
    }
    if (form.issuerId.trim()) {
      const err = validateIssuerId(form.issuerId.trim());
      if (err) { setFormErrors((p) => ({ ...p, issuerId: err })); return; }
      updates.issuerId = form.issuerId.trim();
    }
    if (form.privateKey.trim()) {
      if (!form.privateKey.includes("-----BEGIN PRIVATE KEY-----")) {
        setFormErrors((p) => ({ ...p, privateKey: "Private key không hợp lệ" }));
        return;
      }
      updates.privateKey = form.privateKey.trim().replace(/\r\n/g, "\n");
    }
    if (Object.keys(updates).length === 0) {
      setApiError("Chưa có thay đổi nào.");
      return;
    }

    setSaving(true);
    setApiError(null);
    const res = await fetch(`/api/admin/asc-accounts/${editingId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });
    setSaving(false);

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setApiError(body.error ?? `Error ${res.status}`);
      return;
    }

    setAccounts((prev) =>
      prev.map((a) =>
        a.id === editingId
          ? { ...a, name: updates.name ?? a.name, keyId: updates.keyId ?? a.keyId }
          : a
      )
    );
    closeForm();
  }

  async function handleDelete(id: string, name: string) {
    if (!confirm(`Xóa account "${name}"? Hành động này không thể hoàn tác.`)) return;
    setDeletingId(id);
    const res = await fetch(`/api/admin/asc-accounts/${id}`, { method: "DELETE" });
    setDeletingId(null);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      alert(body.error ?? `Error ${res.status}`);
      return;
    }
    setAccounts((prev) => prev.filter((a) => a.id !== id));
    if (editingId === id) closeForm();
  }

  const isEditing = editingId !== null;
  const showForm = showAddForm || isEditing;

  return (
    <div className="p-8 max-w-3xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-900">Settings</h1>
        <p className="text-sm text-slate-500 mt-0.5">Quản lý tài khoản App Store Connect</p>
      </div>

      {/* Account list */}
      <div className="bg-white rounded-xl border border-slate-200 p-6 mb-4">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-base font-medium text-slate-900">App Store Connect Accounts</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Credentials được lưu mã hóa trong Supabase
            </p>
          </div>
          <button
            onClick={openAdd}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-[#0071E3] hover:bg-[#0077ED] text-white rounded-lg transition"
          >
            <Plus className="h-4 w-4" />
            Thêm account
          </button>
        </div>

        {accounts.length === 0 ? (
          <p className="text-sm text-slate-400 italic text-center py-6">
            Chưa có account nào. Nhấn "Thêm account" để bắt đầu.
          </p>
        ) : (
          <div className="space-y-2">
            {accounts.map((a) => (
              <div
                key={a.id}
                className={`flex items-center gap-3 rounded-lg border px-4 py-3 transition ${
                  editingId === a.id
                    ? "border-[#0071E3] bg-blue-50"
                    : "border-slate-100 bg-slate-50"
                }`}
              >
                <Building2 className="h-4 w-4 text-slate-400 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-slate-800">{a.name}</span>
                    <span className="text-[10px] text-slate-400 font-mono border border-slate-200 rounded px-1.5 py-0.5 bg-white">
                      {a.id}
                    </span>
                  </div>
                  <p className="text-xs text-slate-400 font-mono mt-0.5">
                    Key: {a.keyId.slice(0, 4)}••••••
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => openEdit(a)}
                    className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-white rounded transition"
                    title="Chỉnh sửa"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => handleDelete(a.id, a.name)}
                    disabled={deletingId === a.id}
                    className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded transition disabled:opacity-40"
                    title="Xóa"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Add / Edit form */}
      {showForm && (
        <div className="bg-white rounded-xl border border-slate-200 p-6">
          <div className="flex items-center justify-between mb-5">
            <h2 className="text-base font-medium text-slate-900">
              {showAddForm ? "Thêm account mới" : `Chỉnh sửa: ${editingId}`}
            </h2>
            <button onClick={closeForm} className="text-slate-400 hover:text-slate-700 transition">
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="space-y-4">
            {/* ID — only when adding */}
            {showAddForm && (
              <div className="grid grid-cols-2 gap-4">
                <Field
                  label="ID (tự động từ tên nếu để trống)"
                  placeholder="e.g. vng-corp"
                  value={form.id}
                  onChange={(v) => setForm((f) => ({ ...f, id: v }))}
                  error={formErrors.id}
                />
                <Field
                  label="Tên hiển thị *"
                  placeholder="VNG Corp"
                  value={form.name}
                  onChange={(v) => setForm((f) => ({ ...f, name: v }))}
                  error={formErrors.name}
                />
              </div>
            )}

            {/* Name — only when editing */}
            {isEditing && (
              <Field
                label="Tên hiển thị (để trống = giữ nguyên)"
                placeholder="VNG Corp"
                value={form.name}
                onChange={(v) => setForm((f) => ({ ...f, name: v }))}
                error={formErrors.name}
              />
            )}

            <div className="grid grid-cols-2 gap-4">
              <Field
                label={`Key ID${isEditing ? " (để trống = giữ nguyên)" : " *"}`}
                placeholder="AAAAAAAAAA"
                value={form.keyId}
                onChange={(v) => setForm((f) => ({ ...f, keyId: v.toUpperCase() }))}
                error={formErrors.keyId}
                mono
                maxLength={10}
              />
              <Field
                label={`Issuer ID${isEditing ? " (để trống = giữ nguyên)" : " *"}`}
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                value={form.issuerId}
                onChange={(v) => setForm((f) => ({ ...f, issuerId: v }))}
                error={formErrors.issuerId}
                mono
              />
            </div>

            {/* Private key */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-slate-700">
                  {isEditing
                    ? "Private Key (.p8) — để trống = giữ nguyên"
                    : "Private Key (.p8) *"}
                </label>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="flex items-center gap-1.5 text-xs text-[#0071E3] hover:text-[#0077ED] transition"
                >
                  <Upload className="h-3 w-3" />
                  Upload .p8
                </button>
              </div>
              <textarea
                rows={5}
                value={form.privateKey}
                onChange={(e) => {
                  setForm((f) => ({ ...f, privateKey: e.target.value }));
                  setFormErrors((p) => ({ ...p, privateKey: "" }));
                }}
                placeholder={"-----BEGIN PRIVATE KEY-----\nMIGTAgEAMBMGByqGSM49...\n-----END PRIVATE KEY-----"}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs font-mono text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#0071E3] focus:border-transparent transition resize-none"
              />
              {formErrors.privateKey && (
                <p className="text-xs text-red-500">{formErrors.privateKey}</p>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept=".p8"
                onChange={handleFileUpload}
                className="hidden"
              />
            </div>
          </div>

          {apiError && (
            <p className="mt-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {apiError}
            </p>
          )}

          <div className="flex justify-end gap-2 mt-5">
            <button
              onClick={closeForm}
              className="px-4 py-2 text-sm font-medium bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg transition"
            >
              Hủy
            </button>
            <button
              onClick={showAddForm ? handleCreate : handleUpdate}
              disabled={saving}
              className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-[#0071E3] hover:bg-[#0077ED] text-white rounded-lg transition disabled:opacity-50"
            >
              <Save className="h-3.5 w-3.5" />
              {saving ? "Đang lưu…" : "Lưu"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({
  label, placeholder, value, onChange, error, mono = false, maxLength,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  mono?: boolean;
  maxLength?: number;
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-sm font-medium text-slate-700">{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        maxLength={maxLength}
        className={`w-full rounded-lg border px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#0071E3] focus:border-transparent transition ${
          error ? "border-red-400" : "border-slate-300"
        } ${mono ? "font-mono text-xs" : ""}`}
      />
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  );
}
