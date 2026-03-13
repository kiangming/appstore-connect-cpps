"use client";

import { useState, useRef } from "react";
import { Building2, Plus, Trash2, Copy, Check, Upload } from "lucide-react";

interface MaskedAccount {
  name: string;
  keyId: string;
  issuerId: string;
}

interface BuilderAccount {
  name: string;
  keyId: string;
  issuerId: string;
  privateKey: string;
}

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
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) {
    return "Không đúng định dạng UUID";
  }
  return null;
}

function validatePrivateKey(v: string): string | null {
  if (!v) return "Bắt buộc";
  if (!v.includes("-----BEGIN PRIVATE KEY-----")) return "Private key không hợp lệ";
  return null;
}

export function SettingsPage({ currentAccounts }: { currentAccounts: MaskedAccount[] }) {
  const [builderList, setBuilderList] = useState<BuilderAccount[]>([]);
  const [name, setName] = useState("");
  const [keyId, setKeyId] = useState("");
  const [issuerId, setIssuerId] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [output, setOutput] = useState("");
  const [copied, setCopied] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      setPrivateKey((ev.target?.result as string) ?? "");
      setFormErrors((prev) => ({ ...prev, privateKey: "" }));
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  function handleAddToList() {
    const errors: Record<string, string> = {};
    if (!name.trim()) errors.name = "Bắt buộc";
    const keyErr = validateKeyId(keyId.trim());
    if (keyErr) errors.keyId = keyErr;
    const issuerErr = validateIssuerId(issuerId.trim());
    if (issuerErr) errors.issuerId = issuerErr;
    const pkErr = validatePrivateKey(privateKey.trim());
    if (pkErr) errors.privateKey = pkErr;

    const slug = slugify(name.trim());
    if (!errors.name && builderList.some((a) => slugify(a.name) === slug)) {
      errors.name = "Tên này trùng với account đã thêm";
    }

    if (Object.keys(errors).length > 0) {
      setFormErrors(errors);
      return;
    }

    setBuilderList((prev) => [
      ...prev,
      {
        name: name.trim(),
        keyId: keyId.trim(),
        issuerId: issuerId.trim(),
        privateKey: privateKey.trim().replace(/\r\n/g, "\n"),
      },
    ]);
    setName("");
    setKeyId("");
    setIssuerId("");
    setPrivateKey("");
    setFormErrors({});
    setOutput("");
  }

  function handleRemove(index: number) {
    setBuilderList((prev) => prev.filter((_, i) => i !== index));
    setOutput("");
  }

  function handleGenerate() {
    const arr = builderList.map((a) => ({
      id: slugify(a.name),
      name: a.name,
      keyId: a.keyId,
      issuerId: a.issuerId,
      privateKey: a.privateKey,
    }));
    setOutput(`ASC_ACCOUNTS=${JSON.stringify(arr)}`);
  }

  async function handleCopy() {
    if (!output) return;
    await navigator.clipboard.writeText(output);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="p-8 max-w-3xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-900">Settings</h1>
        <p className="text-sm text-slate-500 mt-0.5">
          Quản lý cấu hình App Store Connect
        </p>
      </div>

      {/* Section 1 — Active Accounts */}
      <div className="bg-white rounded-xl border border-slate-200 p-6 mb-6">
        <h2 className="text-base font-medium text-slate-900 mb-1">
          App Store Connect Accounts
        </h2>
        <p className="text-xs text-slate-400 mb-4">
          Accounts đang được cấu hình qua{" "}
          <code className="font-mono bg-slate-100 px-1 rounded">ASC_ACCOUNTS</code> trong .env
        </p>

        {currentAccounts.length === 0 ? (
          <p className="text-sm text-slate-400 italic">
            Chưa có account nào được cấu hình trong .env
          </p>
        ) : (
          <div className="space-y-2">
            {currentAccounts.map((a) => (
              <div
                key={a.name}
                className="flex items-start gap-3 rounded-lg border border-slate-100 bg-slate-50 px-4 py-3"
              >
                <Building2 className="h-4 w-4 text-slate-400 mt-0.5 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-sm font-medium text-slate-800">{a.name}</span>
                    <span className="text-[10px] font-medium text-slate-400 border border-slate-200 rounded px-1.5 py-0.5 leading-none bg-white">
                      From ENV
                    </span>
                  </div>
                  <p className="text-xs text-slate-400 font-mono">Key ID: {a.keyId}</p>
                  <p className="text-xs text-slate-400 font-mono">Issuer ID: {a.issuerId}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Section 2 — Account Builder */}
      <div className="bg-white rounded-xl border border-slate-200 p-6">
        <h2 className="text-base font-medium text-slate-900 mb-1">
          Tạo cấu hình ASC_ACCOUNTS
        </h2>
        <p className="text-xs text-slate-400 mb-5">
          Điền thông tin từng account, nhấn Generate để tạo chuỗi{" "}
          <code className="font-mono bg-slate-100 px-1 rounded">ASC_ACCOUNTS</code> paste vào .env
        </p>

        {/* Builder list */}
        {builderList.length > 0 && (
          <div className="mb-5">
            <p className="text-xs font-medium text-slate-500 mb-2 uppercase tracking-wider">
              Accounts trong builder
            </p>
            <div className="space-y-1.5">
              {builderList.map((a, i) => (
                <div
                  key={i}
                  className="flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2"
                >
                  <Building2 className="h-3.5 w-3.5 text-slate-400 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-medium text-slate-800">{a.name}</span>
                    <span className="text-xs text-slate-400 font-mono ml-2">
                      Key: {a.keyId}
                    </span>
                  </div>
                  <button
                    onClick={() => handleRemove(i)}
                    className="text-slate-400 hover:text-red-500 transition-colors p-1 rounded"
                    title="Xoá khỏi builder"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Add form */}
        <div className={`space-y-4 ${builderList.length > 0 ? "border-t border-slate-100 pt-5" : ""}`}>
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">
            Thêm account mới
          </p>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-slate-700">
                Tên hiển thị <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setFormErrors((p) => ({ ...p, name: "" }));
                }}
                placeholder="Client A"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#0071E3] focus:border-transparent transition"
              />
              {formErrors.name && (
                <p className="text-xs text-red-500">{formErrors.name}</p>
              )}
            </div>

            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-slate-700">
                Key ID <span className="text-red-500">*</span>
                <span className="text-xs text-slate-400 font-normal ml-1">(10 ký tự)</span>
              </label>
              <input
                type="text"
                value={keyId}
                onChange={(e) => {
                  setKeyId(e.target.value.toUpperCase());
                  setFormErrors((p) => ({ ...p, keyId: "" }));
                }}
                placeholder="AAAAAAAAAA"
                maxLength={10}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#0071E3] focus:border-transparent transition"
              />
              {formErrors.keyId && (
                <p className="text-xs text-red-500">{formErrors.keyId}</p>
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-slate-700">
              Issuer ID <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={issuerId}
              onChange={(e) => {
                setIssuerId(e.target.value);
                setFormErrors((p) => ({ ...p, issuerId: "" }));
              }}
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#0071E3] focus:border-transparent transition"
            />
            {formErrors.issuerId && (
              <p className="text-xs text-red-500">{formErrors.issuerId}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="block text-sm font-medium text-slate-700">
                Private Key (.p8) <span className="text-red-500">*</span>
              </label>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-1.5 text-xs text-[#0071E3] hover:text-[#0077ED] transition-colors"
              >
                <Upload className="h-3 w-3" />
                Upload file .p8
              </button>
            </div>
            <textarea
              value={privateKey}
              onChange={(e) => {
                setPrivateKey(e.target.value);
                setFormErrors((p) => ({ ...p, privateKey: "" }));
              }}
              rows={6}
              placeholder={"-----BEGIN PRIVATE KEY-----\nMIGTAgEAMBMGByqGSM49...\n-----END PRIVATE KEY-----"}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#0071E3] focus:border-transparent transition resize-none"
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

          <div className="flex justify-end">
            <button
              type="button"
              onClick={handleAddToList}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-[#0071E3] hover:bg-[#0077ED] rounded-lg transition"
            >
              <Plus className="h-4 w-4" />
              Thêm vào danh sách
            </button>
          </div>
        </div>

        {/* Generate output */}
        <div className="border-t border-slate-100 mt-5 pt-5 space-y-3">
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">
            Output
          </p>
          <button
            type="button"
            onClick={handleGenerate}
            disabled={builderList.length === 0}
            title={builderList.length === 0 ? "Thêm ít nhất 1 account" : undefined}
            className="px-4 py-2 text-sm font-medium text-white bg-slate-800 hover:bg-slate-700 rounded-lg transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Generate ASC_ACCOUNTS string
          </button>

          {output && (
            <div className="space-y-2">
              <div className="relative">
                <textarea
                  readOnly
                  value={output}
                  rows={3}
                  className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 pr-10 text-sm font-mono text-slate-700 resize-none focus:outline-none"
                />
                <button
                  onClick={handleCopy}
                  className="absolute top-2 right-2 p-1.5 rounded-md bg-white border border-slate-200 hover:bg-slate-50 transition-colors"
                  title="Copy to clipboard"
                >
                  {copied ? (
                    <Check className="h-3.5 w-3.5 text-green-600" />
                  ) : (
                    <Copy className="h-3.5 w-3.5 text-slate-500" />
                  )}
                </button>
              </div>
              <div className="rounded-lg bg-blue-50 border border-blue-200 px-3 py-2">
                <p className="text-xs text-blue-700">
                  Copy toàn bộ dòng trên vào file{" "}
                  <code className="font-mono">.env</code>, thay thế giá trị{" "}
                  <code className="font-mono">ASC_ACCOUNTS</code> cũ (nếu có), rồi restart server.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
