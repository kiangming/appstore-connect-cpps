"use client";

import { Check, AlertCircle } from "lucide-react";
import type {
  ChecklistItem,
  GroupedChecklistState,
} from "@/lib/iap-management/validation";

interface Props {
  state: GroupedChecklistState;
}

/**
 * Grouped live checklist (IAP.o.6a Manager Apple workflow alignment).
 *
 * Two-stage layout:
 *   • Group A — required for Create on Apple (5 items)
 *   • Group B — additional for Submit for Apple Review (currently 1: screenshot)
 *
 * Apple's per-IAP state (READY_TO_SUBMIT vs MISSING_METADATA) remains the
 * authoritative gate for the list-page Submit Selected flow; this checklist is
 * the local hint surfacing what Apple is likely to require.
 */
export function SubmitChecklist({ state }: Props) {
  return (
    <div className="border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 p-4 space-y-4">
      <Group
        title="Create on Apple"
        subtitle={`${state.createPassedCount} / ${state.createItems.length} ready`}
        allPassed={state.createReady}
        items={state.createItems}
      />
      <div className="border-t border-slate-100 dark:border-slate-800" />
      <Group
        title="Additional for Submit"
        subtitle={`${state.submitPassedCount} / ${state.submitOnlyItems.length} extra`}
        allPassed={state.submitReady}
        items={state.submitOnlyItems}
      />
    </div>
  );
}

interface GroupProps {
  title: string;
  subtitle: string;
  allPassed: boolean;
  items: ChecklistItem[];
}

function Group({ title, subtitle, allPassed, items }: GroupProps) {
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-400">
          {title}
        </h3>
        <span
          className={`text-xs font-medium ${
            allPassed ? "text-emerald-600" : "text-slate-500 dark:text-slate-400"
          }`}
        >
          {subtitle}
        </span>
      </div>
      <ul className="space-y-1.5">
        {items.map((item) => (
          <li key={item.key} className="flex items-start gap-2 text-xs">
            <span
              className={`flex-shrink-0 mt-0.5 w-4 h-4 rounded-full flex items-center justify-center ${
                item.passed
                  ? "bg-emerald-100 text-emerald-700"
                  : "bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-500"
              }`}
            >
              {item.passed ? (
                <Check className="h-3 w-3" strokeWidth={3} />
              ) : (
                <AlertCircle className="h-3 w-3" />
              )}
            </span>
            <span
              className={`${
                item.passed
                  ? "text-slate-700 dark:text-slate-300"
                  : "text-slate-500 dark:text-slate-400"
              } flex-1`}
            >
              {item.label}
              {item.detail && (
                <span className="ml-1.5 text-[10px] text-slate-400 dark:text-slate-500">
                  ({item.detail})
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
