/**
 * [TEMPLATE-xlsx-reimport] PA2.3 — the matrix import's response shapes,
 * SHARED by the route (which builds them) and the client (which reads them),
 * so the two cannot drift (KB P29). Types only — safe to import anywhere.
 */
import type { MatrixEditProblem } from "../parsers/template-matrix-edit";
import type { ImportTarget } from "./scope-check";
import type { TemplateDiff } from "./diff";

export type { ImportTarget, MatrixEditProblem, TemplateDiff };

export interface MatrixImportPreviewResponse extends TemplateDiff {
  kind: "preview";
  target: ImportTarget;
  file: { name: string; exportedAt: string | null; exportedBy: string | null };
}

export interface MatrixImportCommitResponse {
  kind: "commit";
  template_id: string;
  inserted_entry_count: number;
  audit_batch_id: string;
  /** Against the template as it was at COMMIT time, not the preview's. */
  totals: TemplateDiff["totals"];
}

export type MatrixImportErrorCode =
  | "NOT_EDIT_FILE"
  | "INVALID_FILE"
  | "SCOPE_MISMATCH"
  | "EDIT_FILE_USE_MATRIX_VIEW"
  | "WRITE_FAILED";

export interface MatrixImportErrorResponse {
  error: string;
  code?: MatrixImportErrorCode;
  problems?: MatrixEditProblem[];
}
