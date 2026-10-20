/**
 * [TEMPLATE-xlsx-reimport] PA2.2 — does the file belong to the template it is
 * being imported into? (Manager 2026-10-19, Q-E: wrong scope ⇒ BLOCK.)
 *
 * The TARGET comes from the request — the matrix page the Manager is on —
 * never from the file (KB §25.2 / P35: a "never accept X from the client"
 * contract). The file's own statement is only compared against it. Why block
 * rather than warn: the write is a REPLACE of the whole template, and a file
 * of another account looks like "7 small price changes" in a diff (measured)
 * — no magnitude flag catches it.
 *
 * Pure.
 */
import type { EditScopeInfo } from "../template-matrix-edit-spec";

export type ImportTarget =
  | { kind: "ACCOUNT"; accountId: string; accountName: string }
  | { kind: "APP"; appId: string; bundleId: string; appName: string };

function describe(s: EditScopeInfo | ImportTarget): string {
  return s.kind === "ACCOUNT"
    ? `the Default template of account ${s.accountName ? `${s.accountName} (${s.accountId})` : s.accountId}`
    : `the Per-App template of ${s.appName ? `${s.appName} (${s.bundleId || s.appId})` : s.bundleId || s.appId}`;
}

/** null ⇒ same template. Otherwise the message to show — it names BOTH sides. */
export function scopeMismatch(file: EditScopeInfo, target: ImportTarget): string | null {
  const same =
    file.kind === "ACCOUNT"
      ? target.kind === "ACCOUNT" && file.accountId === target.accountId
      : target.kind === "APP" && file.appId === target.appId;
  if (same) return null;
  return (
    `This file is ${describe(file)}; this page is ${describe(target)}. ` +
    "Nothing was written. Import the file on the matrix view of the template it was exported from."
  );
}
