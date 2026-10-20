"use client";

/**
 * [TEMPLATE-xlsx-reimport] PA2.3 — "Import edited file" on the matrix view
 * (Manager 2026-10-19, Q-E/Q-F; design-template-matrix-reimport.md §L2.9).
 * One component for BOTH screens and their empty states (KB P1 — the twin
 * views wire the same thing).
 *
 *   pick a file → PREVIEW (the server reads it, compares with the template
 *   for DISPLAY only, writes nothing) → the Manager reads what will change →
 *   WRITE (the server reads the file again and writes exactly it).
 *
 * No Apple price is shown for a removed override — only "back to Apple's
 * price" (Manager Q-F: no ~89-request lookups in a preview).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Loader2, X } from "lucide-react";
import { toast } from "sonner";

import {
  commitMatrixImport,
  commitOutcomeUnknown,
  previewMatrixImport,
  type MatrixImportTarget,
} from "@/lib/iap-management/matrix-import-client";
import type {
  MatrixImportErrorResponse,
  MatrixImportPreviewResponse,
} from "@/lib/iap-management/template-reimport/types";
import { formatPrice } from "@/lib/iap-management/matrix-price-format";
import { territoryName } from "@/components/iap-management/view-detail/territory-name";

export const MAX_ROWS_SHOWN = 200;

type Change = MatrixImportPreviewResponse["changes"][number];

/**
 * The table shows at most MAX_ROWS_SHOWN rows, so WHICH rows come first is a
 * decision: the rows the warnings point at (USA, ×10, tier ladder), then the
 * removed overrides (the destructive part of a REPLACE), then price changes,
 * then new overrides. Within a group, file order. Totals and warning counts
 * always cover every row.
 */
export function orderChangesForDisplay(changes: ReadonlyArray<Change>): Change[] {
  const rank = (c: Change) => (c.flags.length > 0 ? 0 : c.kind === "removed" ? 1 : c.kind === "changed" ? 2 : 3);
  return changes
    .map((c, i) => ({ c, i }))
    .sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i)
    .map((x) => x.c);
}

export interface MatrixImportProps {
  target: MatrixImportTarget;
  /** What the page shows, e.g. "Default template · VNG (vng-corp)". */
  label: string;
  isPerApp: boolean;
  /** For tier names in the change list (territory names come from the
   *  same `territoryName` the matrix uses). */
  tierNames: ReadonlyArray<{ tier_id: string; tier_name: string }>;
  /** The hidden file input — the page's "Import edited file" button clicks it. */
  inputRef: React.RefObject<HTMLInputElement>;
  /** True from choosing a file until its dialog closes — including a write in
   *  flight. The page disables its import button meanwhile: ONE file at a
   *  time, so a write's outcome can only land on its own dialog. */
  onBusyChange?: (busy: boolean) => void;
}

type Opened =
  | { kind: "preview"; file: File; data: MatrixImportPreviewResponse }
  | { kind: "error"; file: File; status: number; error: MatrixImportErrorResponse };

export function MatrixImport({ target, label, isPerApp, tierNames, inputRef, onBusyChange }: MatrixImportProps) {
  const [opened, setOpened] = useState<Opened | null>(null);
  const [previewing, setPreviewing] = useState(false);
  // A new key per chosen file: the dialog's "already written" guard lives in
  // the dialog instance and never resets inside it (KB P12).
  const [dialogKey, setDialogKey] = useState(0);

  const busy = previewing || opened !== null;
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  async function onFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const chosen = e.target.files?.[0];
    // Reset so choosing the SAME file again (after fixing it) fires again.
    e.target.value = "";
    if (!chosen || busy) return;
    setPreviewing(true);
    try {
      // The bytes are read ONCE, here: preview and write send the same bytes,
      // even if the file is saved again in Excel while the dialog is open
      // (Chrome refuses to send a file changed after selection; another
      // browser could send bytes nobody previewed).
      const file = new File([await chosen.arrayBuffer()], chosen.name, { type: chosen.type });
      const res = await previewMatrixImport(file, target);
      setDialogKey((k) => k + 1);
      setOpened(res.ok ? { kind: "preview", file, data: res.data } : { kind: "error", file, status: res.status, error: res.error });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not read the file.");
    } finally {
      setPreviewing(false);
    }
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        className="hidden"
        data-testid="matrix-import-input"
        onChange={onFileChosen}
      />
      {opened && (
        <MatrixImportDialog
          key={dialogKey}
          opened={opened}
          target={target}
          label={label}
          isPerApp={isPerApp}
          tierNames={tierNames}
          onClose={() => setOpened(null)}
        />
      )}
    </>
  );
}

function MatrixImportDialog({
  opened,
  target,
  label,
  isPerApp,
  tierNames,
  onClose,
}: {
  opened: Opened;
  target: MatrixImportTarget;
  label: string;
  isPerApp: boolean;
  tierNames: ReadonlyArray<{ tier_id: string; tier_name: string }>;
  onClose: () => void;
}) {
  const router = useRouter();
  // ⚠ KB P12 — a PERMANENT "already sent" ref, not the in-flight flag: the
  //   in-flight flag reopens after the request settles, and a second click on
  //   a slow network would write twice.
  const committedRef = useRef(false);
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const tierName = useMemo(() => new Map(tierNames.map((t) => [t.tier_id, t.tier_name])), [tierNames]);

  // Keyboard: focus starts on the SAFE button (Cancel / Close), Escape closes
  // unless a write is in flight, and Tab stays inside the dialog.
  useEffect(() => {
    panelRef.current?.querySelector<HTMLButtonElement>("[data-autofocus]")?.focus();
  }, []);
  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      if (!committing) onClose();
      return;
    }
    if (e.key !== "Tab" || !panelRef.current) return;
    const focusable = [...panelRef.current.querySelectorAll<HTMLElement>("button:not([disabled])")];
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    } else if (!panelRef.current.contains(document.activeElement)) {
      e.preventDefault();
      first.focus();
    }
  }

  async function write() {
    if (opened.kind !== "preview" || committedRef.current) return;
    committedRef.current = true;
    setCommitting(true);
    setCommitError(null);
    try {
      const res = await commitMatrixImport(opened.file, target);
      if (!res.ok) {
        failed(res.error.error);
        return;
      }
      const t = res.data.totals;
      toast.success(
        `Template written: ${t.added} new · ${t.changed} changed · ${t.removed} removed — ` +
          `${res.data.inserted_entry_count} overrides.`,
      );
      onClose();
      router.refresh();
    } catch (err) {
      // The request may have reached the server before the connection broke.
      failed(commitOutcomeUnknown(err instanceof Error ? err.message : "no response"));
    } finally {
      setCommitting(false);
    }
  }

  /** A write that did not succeed may still have written part of the template
   *  (REPLACE is not one transaction). Reload the page behind so it shows
   *  what IS there, and say it in a toast too — the reload can replace this
   *  dialog's page (e.g. with the empty state), and the message must outlive it. */
  function failed(message: string) {
    setCommitError(message);
    toast.error(message);
    router.refresh();
  }

  const removedSuffix = isPerApp ? " — not the Default" : "";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-labelledby="matrix-import-title"
      onKeyDown={onKeyDown}
    >
      <div
        ref={panelRef}
        className="w-[760px] max-w-[95vw] max-h-[85vh] overflow-y-auto rounded-xl bg-white border border-slate-200 shadow-xl"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <h2 id="matrix-import-title" className="text-base font-semibold text-slate-900">
            Import edited file — {label}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={committing}
            className="text-slate-400 hover:text-slate-600 transition disabled:opacity-40"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {opened.kind === "error" ? (
          <div className="px-5 py-4 space-y-3 text-sm text-slate-700">
            <p className="flex items-start gap-2 text-red-700 font-medium">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{opened.error.error}</span>
            </p>
            <p className="text-xs text-slate-500">File: {opened.file.name}. Nothing was written.</p>
            {opened.error.problems && opened.error.problems.length > 0 && (
              <ul className="text-xs font-mono bg-red-50 border border-red-200 rounded p-3 space-y-1" aria-label="Problems">
                {opened.error.problems.map((p, i) => (
                  <li key={i}>
                    {p.cell ? <span className="font-semibold">{p.cell}</span> : null}
                    {p.cell ? " — " : null}
                    {p.message}
                  </li>
                ))}
              </ul>
            )}
            <div className="flex justify-end pt-2">
              <button
                type="button"
                onClick={onClose}
                data-autofocus
                className="px-3 py-1.5 text-sm border border-slate-300 rounded-lg"
              >
                Close
              </button>
            </div>
          </div>
        ) : (
          <PreviewBody
            data={opened.data}
            fileName={opened.file.name}
            tierName={tierName}
            removedSuffix={removedSuffix}
            committing={committing}
            commitError={commitError}
            onCancel={onClose}
            onWrite={write}
            writeDisabled={committing || committedRef.current}
          />
        )}
      </div>
    </div>
  );
}

function PreviewBody({
  data,
  fileName,
  tierName,
  removedSuffix,
  committing,
  commitError,
  onCancel,
  onWrite,
  writeDisabled,
}: {
  data: MatrixImportPreviewResponse;
  fileName: string;
  tierName: Map<string, string>;
  removedSuffix: string;
  committing: boolean;
  commitError: string | null;
  onCancel: () => void;
  onWrite: () => void;
  writeDisabled: boolean;
}) {
  const t = data.totals;
  const w = data.warnings;
  const changeCount = t.added + t.changed + t.removed;
  const shown = useMemo(() => orderChangesForDisplay(data.changes).slice(0, MAX_ROWS_SHOWN), [data.changes]);
  const money = (x: { price: number; currency: string } | null) =>
    x ? `${formatPrice(x.price)} ${x.currency}` : "·";

  return (
    <div className="px-5 py-4 space-y-4 text-sm text-slate-700">
      <p className="text-xs text-slate-500">
        File: <span className="font-mono">{fileName}</span>
        {data.file.exportedAt && <> · exported {new Date(data.file.exportedAt).toLocaleString()}</>}
        {data.file.exportedBy && <> by {data.file.exportedBy}</>}. After writing, the template is exactly this file.
      </p>

      <ul className="space-y-1" aria-label="Totals">
        <li>
          <span className="font-semibold text-emerald-700">+{t.added}</span> new overrides
        </li>
        <li>
          <span className="font-semibold text-sky-700">~{t.changed}</span> price changes
        </li>
        <li>
          <span className="font-semibold text-rose-700">−{t.removed}</span> overrides removed — back to Apple&apos;s price
          {removedSuffix}
          {t.removed > 0 && (
            <span className="text-xs text-slate-500">
              {" "}
              (cleared in the file: {t.removedCleared} · territory not in the file: {t.removedColumnAbsent} · tier not in
              the file: {t.removedRowAbsent})
            </span>
          )}
        </li>
        <li>
          <span className="font-semibold text-slate-600">={t.unchanged}</span> unchanged ·{" "}
          {t.after} overrides after writing (now {t.before})
        </li>
      </ul>

      {(w.usaChanges > 0 || w.usaColumnMissing || w.usaCurrencyNotUsd || w.magnitude > 0 || w.ladder > 0 || t.proceedsCleared > 0) && (
        <ul className="text-xs bg-amber-50 border border-amber-200 rounded p-3 space-y-1" aria-label="Warnings">
          {w.usaChanges > 0 && (
            <li>
              {w.usaChanges} change(s) in the USA column — bulk import reads its tiers and USD base prices from it.
            </li>
          )}
          {w.usaColumnMissing && <li>The file has no USA column — bulk import from this template will find no tier.</li>}
          {w.usaCurrencyNotUsd && <li>The USA column is not in USD — bulk import only reads USD prices from it.</li>}
          {w.magnitude > 0 && (
            <li>{w.magnitude} price(s) changed more than ×10 — check for a typo such as 49,000 typed as 49.</li>
          )}
          {w.ladder > 0 && <li>{w.ladder} new override(s) sit outside their neighbouring tiers in the same column.</li>}
          {t.proceedsCleared > 0 && (
            <li>
              {t.proceedsCleared} cells hold proceeds today — they will be empty after writing (the file has no
              proceeds).
            </li>
          )}
        </ul>
      )}

      {changeCount === 0 ? (
        <p className="text-slate-600">No changes — the file matches the template.</p>
      ) : (
        <table className="w-full text-xs" aria-label="Changes">
          <thead>
            <tr className="text-left text-slate-500 border-b border-slate-100">
              <th className="py-1 pr-2">Tier</th>
              <th className="py-1 pr-2">Territory</th>
              <th className="py-1 pr-2">Now</th>
              <th className="py-1 pr-2">File</th>
              <th className="py-1">Change</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((c) => (
              <tr key={`${c.kind}|${c.tier_id}|${c.territory_code}`} className="border-b border-slate-50">
                <td className="py-1 pr-2">{tierName.get(c.tier_id) ?? c.tier_id}</td>
                <td className="py-1 pr-2">{territoryName(c.territory_code)}</td>
                <td className="py-1 pr-2 font-mono">{money(c.before)}</td>
                <td className="py-1 pr-2 font-mono">{money(c.after)}</td>
                <td className="py-1">
                  {c.kind === "added" && "new override"}
                  {c.kind === "changed" && "price change"}
                  {c.kind === "removed" && `back to Apple's price${removedSuffix}`}
                  {c.flags.includes("usa") && <span className="ml-1 text-amber-700">· USA</span>}
                  {c.flags.includes("magnitude") && <span className="ml-1 text-amber-700">· ×10</span>}
                  {c.flags.includes("ladder") && <span className="ml-1 text-amber-700">· tier ladder</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data.changes.length > MAX_ROWS_SHOWN && (
        <p className="text-xs text-slate-500">
          …and {data.changes.length - MAX_ROWS_SHOWN} more changes (flagged and removed rows are listed first).
        </p>
      )}

      {commitError && (
        <p className="flex items-start gap-2 text-red-700 text-sm" role="alert">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>{commitError}</span>
        </p>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={committing}
          data-autofocus
          className="px-3 py-1.5 text-sm border border-slate-300 rounded-lg disabled:opacity-40"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onWrite}
          disabled={writeDisabled}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-[#0071E3] hover:bg-[#0077ED] rounded-lg disabled:opacity-40"
        >
          {committing && <Loader2 className="h-4 w-4 animate-spin" />}
          {changeCount === 0 ? "Write anyway" : `Write ${changeCount} changes`}
        </button>
      </div>
    </div>
  );
}
