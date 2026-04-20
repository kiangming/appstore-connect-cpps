'use client';

import { useMemo, useState, useTransition } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Loader2, Play, X } from 'lucide-react';
import { toast } from 'sonner';

import type {
  ClassificationResult,
  MatchedRule,
} from '@/lib/store-submissions/classifier/types';

import type { DraftState } from './helpers';
import {
  MAX_TEST_BODY_BYTES,
  OUTCOME_DISPLAY,
  buildTestPayload,
  formatCapturedGroups,
  summarizeTraceDetails,
  utf8ByteLength,
  type TestOutcomeKind,
} from './test-dialog-helpers';

/**
 * TestEmailDialog — classify a synthetic email against the *current draft*
 * rules without saving. Calls POST /api/store-submissions/rules/test which
 * is pure (no DB writes, no Gmail calls) — risk flag §2.
 *
 * Override semantics: the draft is submitted as `override_rules`, so the
 * Manager tests exactly what they see on screen, including unsaved edits
 * and newly-added rows. Incomplete rows are filtered out by
 * buildTestPayload — see its comment for the per-kind rules.
 */

interface TestEmailDialogProps {
  draft: DraftState;
  platformId: string;
  onClose: () => void;
}

type ApiResponse =
  | {
      ok: true;
      data: { result: ClassificationResult; trace: MatchedRule[] };
    }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

const STEP_LABEL: Record<string, string> = {
  sender: '1. Sender',
  subject: '2. Subject',
  app: '3. App',
  type: '4. Type',
  submission_id: '5. Submission ID',
};

function outcomeKind(result: ClassificationResult): TestOutcomeKind {
  return result.status;
}

export function TestEmailDialog({
  draft,
  platformId,
  onClose,
}: TestEmailDialogProps) {
  const [sender, setSender] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [response, setResponse] = useState<ApiResponse | null>(null);
  const [isPending, startTransition] = useTransition();

  const bodySize = useMemo(() => utf8ByteLength(body), [body]);
  const bodyTooLarge = bodySize > MAX_TEST_BODY_BYTES;

  const canSubmit =
    sender.trim() !== '' &&
    subject.trim() !== '' &&
    !bodyTooLarge &&
    !isPending;

  const handleRun = () => {
    if (!canSubmit) return;
    const payload = buildTestPayload(draft, platformId, {
      sender: sender.trim(),
      subject,
      body,
    });
    setResponse(null);
    startTransition(async () => {
      try {
        const res = await fetch('/api/store-submissions/rules/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const json = (await res.json()) as ApiResponse;
        setResponse(json);
        if (!json.ok) {
          toast.error(json.error.message);
        }
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Network error';
        setResponse({
          ok: false,
          error: { code: 'NETWORK', message },
        });
        toast.error(message);
      }
    });
  };

  const handleReset = () => {
    setSender('');
    setSubject('');
    setBody('');
    setResponse(null);
  };

  const result = response && response.ok ? response.data.result : null;
  const trace = response && response.ok ? response.data.trace : [];

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-slate-900/40 z-40" />
        <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-3xl max-h-[90vh] overflow-y-auto bg-white rounded-xl shadow-xl z-50">
          <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-slate-100 sticky top-0 bg-white z-10">
            <div>
              <Dialog.Title className="text-[16px] font-semibold text-slate-900">
                Test against current draft
              </Dialog.Title>
              <Dialog.Description className="text-[12.5px] text-slate-500 mt-0.5">
                Runs your unsaved rules against a synthetic email.
                No database writes, no Gmail calls.
              </Dialog.Description>
            </div>
            <Dialog.Close
              className="p-1 rounded hover:bg-slate-100 text-slate-400 hover:text-slate-600"
              aria-label="Close"
            >
              <X className="h-4 w-4" strokeWidth={1.8} />
            </Dialog.Close>
          </div>

          <div className="px-6 py-5 space-y-4">
            <div>
              <label className="block text-[11.5px] text-slate-500 uppercase tracking-wider mb-1">
                Sender
              </label>
              <input
                type="text"
                value={sender}
                onChange={(e) => setSender(e.target.value)}
                placeholder="no-reply@apple.com"
                className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-[12.5px] font-mono focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 focus:border-[#0071E3]"
              />
            </div>
            <div>
              <label className="block text-[11.5px] text-slate-500 uppercase tracking-wider mb-1">
                Subject
              </label>
              <input
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Review of your Puzzle Quest Saga submission is complete."
                className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-[12.5px] focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 focus:border-[#0071E3]"
              />
            </div>
            <div>
              <label className="flex items-baseline justify-between text-[11.5px] text-slate-500 uppercase tracking-wider mb-1">
                <span>Body</span>
                <span
                  className={`normal-case tracking-normal ${
                    bodyTooLarge ? 'text-red-600' : 'text-slate-400'
                  }`}
                >
                  {bodySize.toLocaleString()} /{' '}
                  {MAX_TEST_BODY_BYTES.toLocaleString()} bytes
                </span>
              </label>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={6}
                spellCheck={false}
                placeholder="Paste the full email body here…"
                className={`w-full px-2.5 py-1.5 border rounded-md text-[12.5px] font-mono resize-y focus:outline-none focus:ring-2 ${
                  bodyTooLarge
                    ? 'border-red-300 focus:ring-red-100'
                    : 'border-slate-200 focus:ring-[#0071E3]/20 focus:border-[#0071E3]'
                }`}
              />
              {bodyTooLarge && (
                <p className="text-[11px] text-red-600 mt-1">
                  Body exceeds {MAX_TEST_BODY_BYTES.toLocaleString()} bytes —
                  the classifier slices at this point, so slice client-side
                  and retry.
                </p>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={handleReset}
                disabled={isPending}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12.5px] font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 disabled:opacity-50"
              >
                Reset
              </button>
              <button
                type="button"
                onClick={handleRun}
                disabled={!canSubmit}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12.5px] font-semibold text-white bg-slate-900 hover:bg-slate-800 disabled:bg-slate-300 disabled:cursor-not-allowed"
              >
                {isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Play className="h-3.5 w-3.5" strokeWidth={2} />
                )}
                Run test
              </button>
            </div>

            {response !== null && (
              <div className="pt-4 border-t border-slate-100 space-y-3">
                <OutcomeBanner response={response} />
                {result && <TraceList trace={trace} result={result} />}
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// -- Sub-components ------------------------------------------------------

function OutcomeBanner({ response }: { response: ApiResponse }) {
  if (!response.ok) {
    return (
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[11.5px] font-semibold uppercase tracking-wider bg-rose-50 text-rose-700 border border-rose-200">
          API error
        </span>
        <span className="text-[12.5px] text-slate-600">
          {response.error.message}
        </span>
      </div>
    );
  }
  const kind = outcomeKind(response.data.result);
  const display = OUTCOME_DISPLAY[kind];
  return (
    <div>
      <div className="flex items-center gap-2">
        <span
          className={`inline-flex items-center px-2 py-0.5 rounded-md text-[11.5px] font-semibold uppercase tracking-wider border ${display.cls}`}
        >
          {display.label}
        </span>
        <span className="text-[12.5px] text-slate-600">
          {display.description}
        </span>
      </div>
      <ResultExtras result={response.data.result} />
    </div>
  );
}

function ResultExtras({ result }: { result: ClassificationResult }) {
  if (result.status === 'CLASSIFIED') {
    return (
      <div className="mt-2 text-[12px] text-slate-600 space-y-0.5">
        <div>
          <span className="text-slate-400">app_name:</span>{' '}
          <span className="font-mono">{result.extracted_app_name}</span>
        </div>
        <div>
          <span className="text-slate-400">outcome:</span>{' '}
          <span className="font-mono">{result.outcome}</span>
        </div>
        {Object.keys(result.type_payload).length > 0 && (
          <div>
            <span className="text-slate-400">payload:</span>{' '}
            <span className="font-mono">
              {formatCapturedGroups(result.type_payload)}
            </span>
          </div>
        )}
        {result.submission_id && (
          <div>
            <span className="text-slate-400">submission_id:</span>{' '}
            <span className="font-mono">{result.submission_id}</span>
          </div>
        )}
      </div>
    );
  }
  if (result.status === 'ERROR') {
    return (
      <p className="mt-2 text-[12px] text-rose-700 font-mono">
        {result.error_code}: {result.error_message}
      </p>
    );
  }
  if (result.status === 'UNCLASSIFIED_APP' && result.extracted_app_name) {
    return (
      <p className="mt-2 text-[12px] text-slate-600">
        Extracted app_name:{' '}
        <span className="font-mono">{result.extracted_app_name}</span>
      </p>
    );
  }
  if (result.status === 'UNCLASSIFIED_TYPE') {
    return (
      <p className="mt-2 text-[12px] text-slate-600">
        Matched app:{' '}
        <span className="font-mono">{result.extracted_app_name}</span>
      </p>
    );
  }
  return null;
}

function TraceList({
  trace,
  result,
}: {
  trace: MatchedRule[];
  result: ClassificationResult;
}) {
  void result;
  if (trace.length === 0) {
    return (
      <p className="text-[12px] text-slate-500 italic">
        No trace — email was dropped before any step ran.
      </p>
    );
  }
  return (
    <div>
      <h4 className="text-[11.5px] text-slate-500 uppercase tracking-wider font-medium mb-2">
        Trace
      </h4>
      <div className="bg-slate-50/50 border border-slate-200 rounded-lg divide-y divide-slate-100">
        {trace.map((step, idx) => {
          const summary = summarizeTraceDetails(step.step, step.details);
          return (
            <div
              key={idx}
              className="px-3 py-2 flex items-start gap-3 text-[12px]"
            >
              <span
                className={`inline-flex items-center justify-center w-4 h-4 rounded-full text-[10px] font-bold ${
                  step.matched
                    ? 'bg-emerald-100 text-emerald-700'
                    : 'bg-slate-200 text-slate-500'
                }`}
                aria-label={step.matched ? 'matched' : 'no match'}
              >
                {step.matched ? '✓' : '–'}
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-slate-700 font-medium">
                  {STEP_LABEL[step.step] ?? step.step}
                </div>
                {summary && (
                  <div className="text-slate-500 font-mono text-[11.5px] truncate">
                    {summary}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
