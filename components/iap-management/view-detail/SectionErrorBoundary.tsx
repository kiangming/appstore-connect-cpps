"use client";

/**
 * IAP.p2.g — per-section error boundary.
 *
 * One render failure in a leaf section (e.g. unexpected Apple JSON shape)
 * shouldn't take down the whole page. This boundary catches a thrown
 * render error and surfaces a friendly amber notice in place of the
 * section, leaving the rest of the page intact. Manager Refresh re-runs
 * the server fetch — usually that clears the transient case.
 *
 * The render-tree-level boundary is the right tool here: data-fetch
 * errors are still handled in the route's outer try/catch + per-stage
 * try/catch in the composer. This boundary covers the remaining surface:
 * a runtime exception thrown by a section component on the client.
 */
import { Component, type ReactNode, type ErrorInfo } from "react";

interface Props {
  /** Human-readable section name for the fallback copy. */
  label: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class SectionErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Log to console so the issue lands in Manager's devtools; Sentry
    // wiring happens at the harness level (Store Mgmt has it; IAP shares
    // the same console-only stance pending a wider rollout).
    // eslint-disable-next-line no-console
    console.error(`[IAP view] ${this.props.label} section threw:`, error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <section
          role="alert"
          className="rounded-xl border border-amber-200 bg-amber-50 px-6 py-4 text-xs text-amber-900"
        >
          <p className="font-semibold mb-1">
            Couldn&apos;t render the {this.props.label} section.
          </p>
          <p>
            The rest of this page still reflects the latest Apple data.
            Refresh to retry — if the error persists, capture the message
            below for debugging.
          </p>
          <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-[11px] text-amber-700">
            {this.state.error.message}
          </pre>
        </section>
      );
    }
    return this.props.children;
  }
}
