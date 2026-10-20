/**
 * [TEMPLATE-xlsx-reimport] PA2.3 — the matrix view's "Import edited file"
 * calls (both screens share it). Pure I/O: no toast, no React — the screens
 * decide how to show what comes back.
 *
 * The TARGET is stated explicitly, from the page's server props — never left
 * to the server's session (the active account is session-wide and shared
 * across tabs; the Default matrix shows ONE account, and that is the one the
 * file must belong to — Q-E).
 */
import type {
  MatrixImportCommitResponse,
  MatrixImportErrorResponse,
  MatrixImportPreviewResponse,
} from "./template-reimport/types";

export const MATRIX_IMPORT_ENDPOINT = "/api/iap-management/pricing-templates";

export type MatrixImportTarget = { kind: "ACCOUNT"; accountId: string } | { kind: "APP"; appId: string };

export type MatrixImportResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: MatrixImportErrorResponse };

async function send<T>(
  file: File,
  target: MatrixImportTarget,
  intent: "preview" | "commit",
): Promise<MatrixImportResult<T>> {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("intent", intent);
  if (target.kind === "ACCOUNT") {
    fd.append("scope", "ACCOUNT");
    fd.append("account_id", target.accountId);
  } else {
    fd.append("scope", "APP");
    fd.append("app_id", target.appId);
  }
  const res = await fetch(MATRIX_IMPORT_ENDPOINT, { method: "POST", body: fd });
  // A body that is not JSON (a proxy's HTML page) or JSON `null` ⇒ no message.
  const body = ((await res.json().catch(() => null)) ?? {}) as T | MatrixImportErrorResponse;
  if (!res.ok) {
    const err = body as MatrixImportErrorResponse;
    return {
      ok: false,
      status: res.status,
      error: { ...err, error: err.error ?? fallbackMessage(intent, res.status) },
    };
  }
  return { ok: true, data: body as T };
}

/** When the server's answer carries no message of its own (a proxy page, a
 *  crash). A preview never writes, so it can say so; a COMMIT without an
 *  answer may or may not have written (KB P5 — never report an outcome
 *  nobody saw). */
function fallbackMessage(intent: "preview" | "commit", status: number): string {
  return intent === "preview" ? `Import failed (${status}). Nothing was written.` : commitOutcomeUnknown(`status ${status}`);
}

export function commitOutcomeUnknown(why: string): string {
  return (
    `The server gave no clear answer (${why}) — the template may or may not have been written. ` +
    "The matrix has been reloaded; import the same file again to be sure."
  );
}

/** What the import WOULD do. Writes nothing. */
export function previewMatrixImport(file: File, target: MatrixImportTarget) {
  return send<MatrixImportPreviewResponse>(file, target, "preview");
}

/** Write exactly the file. The server parses it again — the preview decides nothing. */
export function commitMatrixImport(file: File, target: MatrixImportTarget) {
  return send<MatrixImportCommitResponse>(file, target, "commit");
}
