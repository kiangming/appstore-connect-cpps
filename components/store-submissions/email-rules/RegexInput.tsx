'use client';

import { useEffect, useId, useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2 } from 'lucide-react';

import type { ClientValidatorResult } from '@/lib/store-submissions/regex/client-validators';

import {
  REGEX_INPUT_HINTS,
  pickRegexValidator,
  type RegexInputKind,
} from './regex-input-helpers';

export type { RegexInputKind };

export interface RegexInputProps {
  kind: RegexInputKind;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  /**
   * Set true when the field is allowed to be blank (e.g. types.payload_extract_regex
   * where an empty string means "no payload extraction"). Empty values skip
   * validation and render the hint in a neutral colour.
   */
  allowEmpty?: boolean;
  /**
   * Debounce delay for the validator call. 0 disables (use when unit-testing
   * the input in isolation). Defaults to 300ms per 3.2 scope spec.
   */
  debounceMs?: number;
  disabled?: boolean;
  ariaLabel?: string;
}

/**
 * Textarea with real-time RE2-approximate validation.
 *
 * The debounced result drives the bottom hint line and the aria-invalid /
 * aria-describedby wiring. The authoritative RE2 check still runs on the
 * Save path (zod superRefine in saveRulesInputSchema) — debounce can miss
 * the very last keystroke before click, but a failing Save lands an
 * inline error message just as this hint does.
 *
 * This component does not enforce anything on its own. The parent form is
 * responsible for (1) disabling Save when any RegexInput has an error, and
 * (2) running a synchronous re-validation at submit time regardless of
 * debounce state (spec risk §1).
 */
export function RegexInput({
  kind,
  value,
  onChange,
  placeholder,
  allowEmpty = false,
  debounceMs = 300,
  disabled,
  ariaLabel,
}: RegexInputProps) {
  const errorId = useId();
  const validator = useMemo(() => pickRegexValidator(kind), [kind]);

  // `result` trails `value` by `debounceMs` so an in-flight edit doesn't
  // flash a red error on every keystroke. The hint area reserves a fixed
  // height so the layout doesn't shift when the error appears.
  const [result, setResult] = useState<ClientValidatorResult | null>(() => {
    if (value.trim() === '' && allowEmpty) return null;
    if (value.trim() === '') return null;
    return validator(value);
  });

  useEffect(() => {
    if (value.trim() === '' && allowEmpty) {
      setResult(null);
      return;
    }
    if (debounceMs <= 0) {
      setResult(validator(value));
      return;
    }
    const t = window.setTimeout(() => {
      setResult(validator(value));
    }, debounceMs);
    return () => window.clearTimeout(t);
  }, [value, validator, allowEmpty, debounceMs]);

  const isInvalid = result !== null && !result.ok;

  const borderClass = isInvalid
    ? 'border-red-300 focus:ring-red-100 focus:border-red-500'
    : result?.ok
      ? 'border-emerald-300 focus:ring-emerald-200 focus:border-emerald-500'
      : 'border-slate-200 focus:ring-[#0071E3]/20 focus:border-[#0071E3]';

  return (
    <div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-invalid={isInvalid || undefined}
        aria-describedby={isInvalid ? errorId : undefined}
        rows={2}
        spellCheck={false}
        className={`w-full px-2.5 py-1.5 border rounded-md text-[12.5px] font-mono resize-y focus:outline-none focus:ring-2 disabled:bg-slate-50 disabled:text-slate-500 ${borderClass}`}
      />
      <div className="min-h-[16px] mt-1 text-[11px]">
        {result === null ? (
          <span className="text-slate-400">{REGEX_INPUT_HINTS[kind]}</span>
        ) : result.ok ? (
          <span className="text-emerald-700 inline-flex items-center gap-1">
            <CheckCircle2 className="h-3 w-3" strokeWidth={2} />
            Valid
          </span>
        ) : (
          <span
            id={errorId}
            role="alert"
            className="text-red-600 inline-flex items-center gap-1"
          >
            <AlertCircle className="h-3 w-3" strokeWidth={2} />
            {result.error}
          </span>
        )}
      </div>
    </div>
  );
}

