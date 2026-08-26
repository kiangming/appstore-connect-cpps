"use client";

/**
 * [POOL-key-management-UI] U2 — Settings → API Key Pool.
 *
 * Follows `pool-key-management-mockup.html`, all five states. Replaces
 * `scripts/seed-asc-pool-key.mjs` for operators; the runbook stays as the
 * dev/emergency path.
 *
 * ⚠ THE PRIVATE KEY LIVES IN COMPONENT STATE FOR EXACTLY AS LONG AS IT TAKES
 * TO POST IT. `resetForm()` runs on success, and it is not cosmetic tidying:
 * a `.p8` left in a closed form is a `.p8` sitting in the tab's heap for the
 * rest of the session, reachable from a devtools snapshot. Pinned by test.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Plus,
  ShieldAlert,
  X,
} from "lucide-react";
import type {
  PoolAccountOption,
  PoolKeyAdminRow,
} from "@/lib/iap-management/key-pool/admin";

interface Props {
  isAdmin: boolean;
}

/** Mirrors the Test route's response union. */
interface TestResult {
  ok: boolean;
  kind: "OK" | "WRONG_TEAM" | "UNKNOWN";
  keyId: string;
  accountName: string;
  remaining?: number | null;
  limit?: number | null;
  error?: string;
}

const API = "/api/iap-management/pool-keys";

function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/**
 * ⚠ A cooldown in the PAST is not a cooldown. The column is a timestamp
 * rather than a flag precisely so "until when" is answerable, and a row whose
 * deadline has passed is back in rotation — showing it as still cooling would
 * send an operator hunting a problem that resolved itself.
 */
function cooldownState(iso: string | null): { cooling: boolean; label: string } {
  if (!iso) return { cooling: false, label: "—" };
  const until = new Date(iso).getTime();
  if (Number.isNaN(until) || until <= Date.now()) return { cooling: false, label: "—" };
  const mins = Math.max(1, Math.round((until - Date.now()) / 60000));
  return {
    cooling: true,
    label: `đến ${new Date(until).toLocaleTimeString()} (còn ~${mins} phút)`,
  };
}

export function KeyPoolClient({ isAdmin }: Props) {
  const [keys, setKeys] = useState<PoolKeyAdminRow[]>([]);
  const [accounts, setAccounts] = useState<PoolAccountOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [showAdd, setShowAdd] = useState(false);
  const [formAccountId, setFormAccountId] = useState("");
  const [formKeyId, setFormKeyId] = useState("");
  const [formPrivateKey, setFormPrivateKey] = useState("");
  const [formNote, setFormNote] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [busyRow, setBusyRow] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});
  const [rowError, setRowError] = useState<string | null>(null);

  const fileRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(API);
      const data = (await res.json()) as
        | { keys: PoolKeyAdminRow[]; accounts: PoolAccountOption[] }
        | { error: string };
      if (!res.ok) {
        // ⚠ Shown, not swallowed into a generic toast. A 403 here means the
        // signed-in user is not an IAP admin, which is a fact they can act
        // on; "Something went wrong" is not.
        setLoadError("error" in data ? data.error : `HTTP ${res.status}`);
        return;
      }
      const ok = data as { keys: PoolKeyAdminRow[]; accounts: PoolAccountOption[] };
      setKeys(ok.keys);
      setAccounts(ok.accounts);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // ⚠ Not fetched for a non-admin. The early return further down keeps the
    // table off screen, but hooks run before it — so without this guard every
    // member visiting the page fires a request that can only come back 403,
    // filling the logs with rejections that look like attacks and are just
    // the page loading. The server gate is unchanged and remains the real
    // boundary; this only stops asking a question we know the answer to.
    if (!isAdmin) {
      setLoading(false);
      return;
    }
    void load();
  }, [load, isAdmin]);

  /**
   * ⚠ Clears the private key FIRST. Ordering is deliberate: if a later
   * setState in this function ever throws, the secret is already gone.
   */
  const resetForm = useCallback(() => {
    setFormPrivateKey("");
    setFormAccountId("");
    setFormKeyId("");
    setFormNote("");
    setFormError(null);
    if (fileRef.current) fileRef.current.value = "";
  }, []);

  /** Accounts sharing one Apple team — the case where one key seeded twice
   *  halves a real budget while the table looks like added headroom. */
  const sharedIssuers = useMemo(() => {
    const byIssuer = new Map<string, PoolAccountOption[]>();
    for (const a of accounts) {
      const list = byIssuer.get(a.issuerId) ?? [];
      list.push(a);
      byIssuer.set(a.issuerId, list);
    }
    return [...byIssuer.values()].filter((g) => g.length > 1);
  }, [accounts]);

  const selectedShared = useMemo(() => {
    if (!formAccountId) return null;
    const chosen = accounts.find((a) => a.id === formAccountId);
    if (!chosen) return null;
    return sharedIssuers.find((g) => g.some((a) => a.id === chosen.id)) ?? null;
  }, [formAccountId, accounts, sharedIssuers]);

  const keysByAccount = useMemo(() => {
    const map = new Map<string, PoolKeyAdminRow[]>();
    for (const k of keys) {
      const list = map.get(k.accountId) ?? [];
      list.push(k);
      map.set(k.accountId, list);
    }
    return map;
  }, [keys]);

  async function handleAdd() {
    setFormError(null);
    if (!formAccountId) return setFormError("Chọn account.");
    if (!formKeyId.trim()) return setFormError("Nhập Key ID.");
    if (!formPrivateKey.includes("-----BEGIN PRIVATE KEY-----")) {
      return setFormError(
        "Nội dung .p8 không hợp lệ — phải chứa dòng -----BEGIN PRIVATE KEY-----.",
      );
    }

    setSubmitting(true);
    try {
      const res = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: formAccountId,
          keyId: formKeyId.trim(),
          privateKey: formPrivateKey,
          note: formNote.trim() || undefined,
        }),
      });
      const data = (await res.json()) as { keys?: PoolKeyAdminRow[]; error?: string };
      if (!res.ok) {
        setFormError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      if (data.keys) setKeys(data.keys);
      // ⚠ Reset BEFORE closing. Closing first would unmount the inputs while
      // the key is still in state, which looks identical on screen and keeps
      // the secret in the heap.
      resetForm();
      setShowAdd(false);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleToggle(row: PoolKeyAdminRow) {
    setBusyRow(row.id);
    setRowError(null);
    try {
      const res = await fetch(`${API}/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !row.enabled }),
      });
      const data = (await res.json()) as { keys?: PoolKeyAdminRow[]; error?: string };
      if (!res.ok) {
        setRowError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      if (data.keys) setKeys(data.keys);
    } catch (err) {
      setRowError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyRow(null);
    }
  }

  async function handleTest(row: PoolKeyAdminRow) {
    setTesting(row.id);
    setRowError(null);
    setTestResults((prev) => {
      const next = { ...prev };
      delete next[row.id];
      return next;
    });
    try {
      const res = await fetch(`${API}/${row.id}/test`, { method: "POST" });
      const data = (await res.json()) as TestResult | { error: string };
      if (!res.ok) {
        // 401/403/404 — the route never got to Apple. Not a key verdict.
        setRowError(
          ("error" in data ? data.error : undefined) ?? `HTTP ${res.status}`,
        );
        return;
      }
      setTestResults((prev) => ({ ...prev, [row.id]: data as TestResult }));
    } catch (err) {
      setRowError(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(null);
    }
  }

  if (!isAdmin) {
    return (
      <div className="p-8 max-w-5xl mx-auto">
        <div className="mb-3">
          <a
            href="/iap-management/settings/hub-tracking"
            className="text-sm text-slate-500 hover:text-[#0071E3] transition"
          >
            ← Hub Tracking
          </a>
        </div>
        <div
          data-testid="not-admin"
          className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          <ShieldAlert className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <div>
            <p className="font-medium">Chỉ admin mới quản lý được API Key Pool.</p>
            <p className="text-[12px] mt-0.5 text-amber-700">
              Key pool nắm private key của Apple, nên mọi thao tác đều giới hạn ở
              admin. Liên hệ admin của tool nếu bạn cần thêm key.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8 max-w-5xl mx-auto">
      {/* ⚠ Header link chain, NOT a tab strip. The approved mockup drew tabs
          across the three settings pages, but no such component exists: each
          settings page is a standalone route and they link to each other from
          the header (`Pricing Templates → Hub Tracking`). Building a tab bar
          here would have been a fourth navigation idiom in one module. */}
      <div className="flex items-center justify-between mb-1">
        <a
          href="/iap-management/settings/hub-tracking"
          className="text-sm text-slate-500 hover:text-[#0071E3] transition"
        >
          ← Hub Tracking
        </a>
      </div>
      <div className="flex items-start justify-between mb-4">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">API Key Pool</h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Nhiều key cho một account = nhiều hạn mức gọi Apple mỗi giờ.
          </p>
        </div>
        <button
          type="button"
          data-testid="open-add"
          onClick={() => setShowAdd(true)}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-[#0071E3] hover:bg-[#0077ED] text-white rounded-lg transition"
        >
          <Plus className="h-4 w-4" /> Add key
        </button>
      </div>

      {loadError && (
        <div
          data-testid="load-error"
          className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
        >
          {loadError}
        </div>
      )}
      {rowError && (
        <div
          data-testid="row-error"
          className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
        >
          {rowError}
        </div>
      )}

      {loading ? (
        <div className="text-sm text-slate-500 flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" /> Đang tải…
        </div>
      ) : (
        <div className="border border-slate-200 rounded-xl overflow-hidden bg-white">
          {accounts.map((acct) => {
            const rows = keysByAccount.get(acct.id) ?? [];
            return (
              <div key={acct.id} data-testid={`account-group-${acct.id}`}>
                <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200 flex items-center gap-2 flex-wrap">
                  <span className="text-[13px] font-semibold text-slate-800">{acct.name}</span>
                  <span className="font-mono text-[11px] text-slate-400">{acct.id}</span>
                  <span className="text-[11px] text-slate-500">
                    · issuer <span className="font-mono">{acct.issuerId}</span>
                  </span>
                  <span className="ml-auto text-[11px] text-slate-500">
                    {rows.length === 0
                      ? "chưa có key"
                      : `${rows.length} key`}
                  </span>
                </div>

                {rows.length === 0 ? (
                  // ⚠ The account is still listed. Hiding it would make "no
                  // pool key" indistinguishable from "account does not exist",
                  // and the first is the normal state for most accounts.
                  <p
                    data-testid={`empty-${acct.id}`}
                    className="px-4 py-4 text-[12px] text-slate-500"
                  >
                    Account này chưa có pool key — mọi request vẫn ký bằng key gốc của
                    chính nó, đúng như trước khi có pool. Đây là trạng thái bình thường,
                    không phải lỗi.
                  </p>
                ) : (
                  <table className="w-full text-xs">
                    <thead className="bg-white border-b border-slate-100">
                      <tr className="text-left text-[10px] uppercase tracking-wide text-slate-500">
                        <th className="px-4 py-2">Key ID</th>
                        <th className="px-4 py-2 w-28">Trạng thái</th>
                        <th className="px-4 py-2 w-52">Cooldown</th>
                        <th className="px-4 py-2 w-44">Thêm lúc</th>
                        <th className="px-4 py-2">Ghi chú</th>
                        <th className="px-4 py-2 w-52 text-right">Thao tác</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {rows.map((row) => {
                        const cd = cooldownState(row.cooldownUntil);
                        const result = testResults[row.id];
                        return (
                          <tr key={row.id} data-testid={`key-row-${row.keyId}`}>
                            <td className="px-4 py-2.5">
                              {/* ⚠ FULL key id (Manager Q2). It is documented
                                  non-secret, travels in the JWT header, and is
                                  already printed in full on the
                                  `[asc-client] … key=` log line — truncating it
                                  would break the one thing this column is for:
                                  matching a row against the logs. */}
                              <span className="font-mono text-[12px] text-slate-800">
                                {row.keyId}
                              </span>
                            </td>
                            <td className="px-4 py-2.5">
                              {row.enabled ? (
                                cd.cooling ? (
                                  <span
                                    data-testid={`status-${row.keyId}`}
                                    className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border bg-amber-50 text-amber-800 border-amber-300"
                                  >
                                    cooling down
                                  </span>
                                ) : (
                                  <span
                                    data-testid={`status-${row.keyId}`}
                                    className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border bg-emerald-50 text-emerald-700 border-emerald-200"
                                  >
                                    enabled
                                  </span>
                                )
                              ) : (
                                <span
                                  data-testid={`status-${row.keyId}`}
                                  className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border bg-slate-100 text-slate-600 border-slate-200"
                                >
                                  disabled
                                </span>
                              )}
                            </td>
                            <td className="px-4 py-2.5 text-[11px] text-slate-500">
                              {cd.label}
                            </td>
                            <td className="px-4 py-2.5 text-[11px] text-slate-500">
                              {formatTimestamp(row.createdAt)}
                            </td>
                            <td className="px-4 py-2.5 text-[11px] text-slate-500">
                              {row.note ?? "—"}
                            </td>
                            <td className="px-4 py-2.5 text-right whitespace-nowrap">
                              <button
                                type="button"
                                data-testid={`test-${row.keyId}`}
                                disabled={testing === row.id}
                                onClick={() => void handleTest(row)}
                                className="inline-flex items-center gap-1 px-3 py-1.5 text-[11px] font-medium bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg transition disabled:opacity-50"
                              >
                                {testing === row.id && (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                )}
                                {testing === row.id ? "Đang kiểm…" : "Test key"}
                              </button>{" "}
                              <button
                                type="button"
                                data-testid={`toggle-${row.keyId}`}
                                disabled={busyRow === row.id}
                                onClick={() => void handleToggle(row)}
                                className="inline-flex items-center gap-1 px-3 py-1.5 text-[11px] font-medium bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg transition disabled:opacity-50"
                              >
                                {row.enabled ? "Disable" : "Enable"}
                              </button>
                              {result && (
                                <div className="mt-2 text-left">
                                  <TestResultBox result={result} />
                                </div>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            );
          })}
        </div>
      )}

      {showAdd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-2xl rounded-2xl border border-slate-200 bg-white shadow-xl">
            <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between">
              <div className="text-sm font-semibold text-slate-900">Add pool key</div>
              <button
                type="button"
                aria-label="Close"
                onClick={() => {
                  resetForm();
                  setShowAdd(false);
                }}
                className="text-slate-400 hover:text-slate-600"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="px-5 py-4 space-y-4">
              <div>
                <label htmlFor="pool-account" className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Account *
                </label>
                <select
                  id="pool-account"
                  data-testid="account-select"
                  value={formAccountId}
                  onChange={(e) => setFormAccountId(e.target.value)}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm bg-white"
                >
                  <option value="">— Chọn account —</option>
                  {accounts.map((a) => (
                    // ⚠ issuer is in the LABEL, not just the data. It is the
                    // only way to see that two accounts share one Apple team
                    // at the moment of choosing.
                    <option key={a.id} value={a.id}>
                      {a.name} · {a.id} · issuer {a.issuerId}
                    </option>
                  ))}
                </select>
              </div>

              {selectedShared && (
                <div
                  data-testid="shared-issuer-warning"
                  className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900"
                >
                  ⚠ <strong>{selectedShared.map((a) => a.name).join("</strong> và <strong>")}</strong>{" "}
                  đang dùng chung một issuer — tức cùng một team Apple. Mỗi account phải
                  có key <strong>riêng</strong>: seed cùng một key cho cả hai sẽ chia đôi
                  hạn mức của đúng một key trong khi bảng trông như đã tăng gấp đôi.
                </div>
              )}

              <div>
                <label htmlFor="pool-key-id" className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Key ID *
                </label>
                <input
                  id="pool-key-id"
                  data-testid="key-id-input"
                  value={formKeyId}
                  onChange={(e) => setFormKeyId(e.target.value)}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono"
                  placeholder="2X9R4HXF34"
                />
                <p className="text-[11px] text-slate-500 mt-1.5">
                  Đúng phần <span className="font-mono">&lt;KID&gt;</span> trong tên file{" "}
                  <span className="font-mono">AuthKey_&lt;KID&gt;.p8</span>.
                </p>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label htmlFor="pool-p8" className="block text-xs font-semibold text-slate-700">
                    Private Key (.p8) *
                  </label>
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".p8"
                    data-testid="p8-file"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (!f) return;
                      const reader = new FileReader();
                      reader.onload = (ev) =>
                        setFormPrivateKey((ev.target?.result as string) ?? "");
                      reader.readAsText(f);
                    }}
                    className="text-[11px]"
                  />
                </div>
                <textarea
                  id="pool-p8"
                  data-testid="p8-input"
                  rows={4}
                  value={formPrivateKey}
                  onChange={(e) => setFormPrivateKey(e.target.value)}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 font-mono text-[11.5px]"
                  placeholder="-----BEGIN PRIVATE KEY-----"
                />
                <p className="text-[11px] text-slate-500 mt-1.5">
                  Key được mã hoá ở server trước khi lưu. Không bao giờ ghi ra log,
                  không trả về lại trình duyệt.
                </p>
              </div>

              <div>
                <label htmlFor="pool-note" className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Ghi chú
                </label>
                <input
                  id="pool-note"
                  data-testid="note-input"
                  value={formNote}
                  onChange={(e) => setFormNote(e.target.value)}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
                  placeholder="vd: pool key 2"
                />
              </div>

              {formError && (
                <div
                  data-testid="form-error"
                  className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
                >
                  {formError}
                </div>
              )}
            </div>

            <div className="px-5 py-3 border-t border-slate-100 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  resetForm();
                  setShowAdd(false);
                }}
                className="px-4 py-2 text-sm font-medium bg-white text-slate-600 border border-slate-200 rounded-lg"
              >
                Huỷ
              </button>
              <button
                type="button"
                data-testid="submit-add"
                disabled={submitting}
                onClick={() => void handleAdd()}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-[#0071E3] hover:bg-[#0077ED] text-white rounded-lg disabled:opacity-50"
              >
                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                Add key
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * ⚠ THREE OUTCOMES, THREE SHAPES. `ok` alone does not decide this: a 503 and
 * a 401 both mean "not verified", but only one of them means the key is
 * wrong. Rendering the green tick on anything other than `kind === "OK"`
 * would tell an operator a key is good when Apple never confirmed it.
 */
function TestResultBox({ result }: { result: TestResult }) {
  if (result.kind === "OK") {
    return (
      <div
        data-testid="test-ok"
        className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11.5px] text-emerald-800"
      >
        <div className="font-semibold flex items-center gap-1">
          <CheckCircle2 className="h-3.5 w-3.5" />
          Key <span className="font-mono">{result.keyId}</span> hoạt động với account{" "}
          <strong>{result.accountName}</strong>
        </div>
        <div className="mt-0.5">
          Apple trả <strong>200</strong>. Hạn mức còn lại của riêng key này:{" "}
          <strong>
            {result.remaining ?? "—"} / {result.limit ?? "—"}
          </strong>
          .
        </div>
      </div>
    );
  }

  if (result.kind === "WRONG_TEAM") {
    return (
      <div
        data-testid="test-wrong-team"
        className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[11.5px] text-red-800"
      >
        <div className="font-semibold">❌ Key không thuộc team của account này</div>
        <div className="mt-0.5">{result.error}</div>
        <div className="mt-1">
          Cách sửa: <strong>Disable</strong> key này, rồi Add lại key được tạo trong
          đúng team của <strong>{result.accountName}</strong>.
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="test-unknown"
      className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11.5px] text-amber-900"
    >
      <div className="font-semibold flex items-center gap-1">
        <AlertTriangle className="h-3.5 w-3.5" />
        Không xác minh được key <span className="font-mono">{result.keyId}</span>
      </div>
      <div className="mt-0.5">{result.error}</div>
      <div className="mt-1">Đây không phải kết luận key sai — thử lại sau ít phút.</div>
    </div>
  );
}
