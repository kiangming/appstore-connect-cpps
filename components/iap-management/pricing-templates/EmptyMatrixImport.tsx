"use client";

/**
 * PA2.3 — "Import edited file" on a matrix page that has NO template to show
 * (none uploaded, deleted in Settings, or emptied by a write that broke
 * part-way). The import's target is still fully known from the page, and an
 * edit file is refused by the Settings upload (wrong door) — so without this
 * button the WRITE_FAILED advice "import the same file again" has nowhere to
 * go. Same component, same guards as the matrix itself (KB P1).
 */
import { useRef, useState } from "react";
import { Upload } from "lucide-react";

import type { MatrixImportTarget } from "@/lib/iap-management/matrix-import-client";

import { MatrixImport } from "./MatrixImport";

export function EmptyMatrixImport({
  target,
  label,
  isPerApp,
  tierNames,
}: {
  target: MatrixImportTarget;
  label: string;
  isPerApp: boolean;
  tierNames: ReadonlyArray<{ tier_id: string; tier_name: string }>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => input.current?.click()}
        disabled={busy}
        title='Import a file made with "Export for editing" — the template becomes exactly the file.'
        className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-slate-700 border border-slate-300 hover:bg-slate-50 rounded-lg transition disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <Upload className="h-4 w-4" />
        {busy ? "Importing…" : "Import edited file"}
      </button>
      <MatrixImport
        target={target}
        label={label}
        isPerApp={isPerApp}
        tierNames={tierNames}
        inputRef={input}
        onBusyChange={setBusy}
      />
    </>
  );
}
