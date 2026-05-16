"use client";

import { Check, AlertCircle } from "lucide-react";
import type { ChecklistState } from "@/lib/iap-management/validation";

interface Props {
  state: ChecklistState;
}

/**
 * Live submit-prerequisite checklist (Q-IAP.h.3). Six items render in fixed
 * order matching validation.ts. Submit button (rendered by the parent) is
 * gated by `state.allPassed`.
 */
export function SubmitChecklist({ state }: Props) {
  return (
    <div className="border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-400 dark:text-slate-500">
          Submit checklist
        </h3>
        <span
          className={`text-xs font-medium ${
            state.allPassed ? "text-emerald-600" : "text-slate-500 dark:text-slate-400 dark:text-slate-500"
          }`}
        >
          {state.passedCount} / {state.items.length} met
        </span>
      </div>
      <ul className="space-y-1.5">
        {state.items.map((item) => (
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
                item.passed ? "text-slate-700 dark:text-slate-300" : "text-slate-500 dark:text-slate-400 dark:text-slate-500"
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
