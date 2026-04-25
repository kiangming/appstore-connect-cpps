// Next.js instrumentation hook — invoked once per runtime boot.
// Sentry SDK v8+ pattern: dynamic import per runtime so edge / node bundles stay lean.
// Docs: https://docs.sentry.io/platforms/javascript/guides/nextjs/

export async function register() {
  if (!process.env.SENTRY_DSN) return;

  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}
