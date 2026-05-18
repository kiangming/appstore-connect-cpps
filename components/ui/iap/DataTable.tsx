/**
 * IAP.p2.b — small Tailwind table primitive.
 *
 * Not a generic data-grid — just the visual pattern from the mockup
 * (slate-50 header, divide-slate-100 body, hover:bg-slate-50). Caller
 * supplies columns; the table handles header + body wiring. Empty state
 * renders a dashed-border placeholder.
 *
 * Server-renderable.
 */
import type { ReactNode } from "react";

export interface DataTableColumn<T> {
  /** Stable key per column (used as React key + th identity). */
  key: string;
  header: string;
  render: (row: T, index: number) => ReactNode;
  /** Extra Tailwind classes applied to both th and td (e.g. width). */
  className?: string;
}

export interface DataTableProps<T> {
  columns: readonly DataTableColumn<T>[];
  rows: readonly T[];
  rowKey?: (row: T, index: number) => string | number;
  /** Custom empty-state node. Defaults to "No data." */
  emptyState?: ReactNode;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  emptyState,
}: DataTableProps<T>) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-slate-200 px-4 py-3 text-xs italic text-slate-400">
        {emptyState ?? "No data."}
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-slate-200 overflow-hidden">
      <table className="w-full text-xs">
        <thead className="bg-slate-50 border-b border-slate-200">
          <tr className="text-left text-[10px] font-medium uppercase tracking-wide text-slate-500">
            {columns.map((c) => (
              <th key={c.key} className={`px-4 py-2 ${c.className ?? ""}`}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((row, i) => (
            <tr key={rowKey ? rowKey(row, i) : i} className="hover:bg-slate-50">
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={`px-4 py-2.5 text-slate-700 ${c.className ?? ""}`}
                >
                  {c.render(row, i)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
