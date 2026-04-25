'use client';

// Root-level fallback when the root layout itself throws during render.
// Replaces <html> + <body> entirely — Tailwind / external CSS may not have
// loaded if the layout broke, so all styling is inline. Per Sentry's
// recommendation for React render errors in App Router.

import { useEffect } from 'react';
import * as Sentry from '@sentry/nextjs';

interface GlobalErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function GlobalError({ error, reset }: GlobalErrorProps) {
  useEffect(() => {
    Sentry.captureException(error, {
      tags: { component: 'global-error-boundary' },
      extra: { digest: error.digest },
    });
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
          backgroundColor: '#f8fafc',
          color: '#0f172a',
        }}
      >
        <div
          style={{
            minHeight: '100vh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '24px',
          }}
        >
          <div
            style={{
              maxWidth: '420px',
              textAlign: 'center',
            }}
          >
            <h1
              style={{
                fontSize: '20px',
                fontWeight: 600,
                margin: '0 0 8px',
              }}
            >
              Application error
            </h1>
            <p
              style={{
                fontSize: '14px',
                color: '#475569',
                margin: '0 0 24px',
                lineHeight: 1.5,
              }}
            >
              A critical error occurred. We&apos;ve been notified. Try again,
              or reload the page.
            </p>
            <button
              type="button"
              onClick={reset}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                padding: '8px 16px',
                fontSize: '13px',
                fontWeight: 500,
                borderRadius: '8px',
                backgroundColor: '#0071E3',
                color: '#ffffff',
                border: 'none',
                cursor: 'pointer',
              }}
            >
              Try again
            </button>
            {error.digest ? (
              <p
                style={{
                  fontSize: '12px',
                  color: '#94a3b8',
                  marginTop: '24px',
                  fontFamily:
                    'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
                }}
              >
                Error ID: {error.digest}
              </p>
            ) : null}
          </div>
        </div>
      </body>
    </html>
  );
}
