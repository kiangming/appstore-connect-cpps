'use client';

// Route-level error boundary for the Inbox tree.
// Catches: SSR errors in page.tsx, render errors in InboxClient + descendants,
// and uncaught Server Action throws. Mapped business errors stay below — those
// return ActionResult and never reach this boundary.

import { useEffect } from 'react';
import * as Sentry from '@sentry/nextjs';

interface InboxErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function InboxError({ error, reset }: InboxErrorProps) {
  useEffect(() => {
    Sentry.captureException(error, {
      tags: { component: 'inbox-error-boundary' },
      extra: { digest: error.digest },
    });
  }, [error]);

  return (
    <div className="px-8 py-16">
      <div className="max-w-md mx-auto text-center">
        <div className="mb-4 inline-flex items-center justify-center w-12 h-12 rounded-full bg-red-50 text-red-600">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="w-6 h-6"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        </div>
        <h2 className="text-lg font-semibold text-slate-900 mb-2">
          Something went wrong loading the Inbox
        </h2>
        <p className="text-sm text-slate-600 mb-6">
          We&apos;ve been notified about this issue. Try again, or reload the
          Inbox to fetch fresh data.
        </p>
        <div className="flex gap-2 justify-center">
          <button
            type="button"
            onClick={reset}
            className="inline-flex items-center px-4 py-2 text-[13px] font-medium rounded-lg bg-[#0071E3] text-white hover:bg-[#005cb8] transition-colors"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={() => {
              window.location.href = '/store-submissions/inbox';
            }}
            className="inline-flex items-center px-4 py-2 text-[13px] font-medium rounded-lg bg-white text-slate-700 border border-slate-200 hover:bg-slate-50 hover:border-slate-300 transition-colors"
          >
            Reload Inbox
          </button>
        </div>
        {error.digest ? (
          <p className="text-xs text-slate-400 mt-6 font-mono">
            Error ID: {error.digest}
          </p>
        ) : null}
      </div>
    </div>
  );
}
