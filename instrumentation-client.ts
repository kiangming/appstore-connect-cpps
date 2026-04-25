import * as Sentry from "@sentry/nextjs";

if (process.env.NEXT_PUBLIC_SENTRY_DSN || process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN ?? process.env.SENTRY_DSN,
    environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
    release: process.env.NEXT_PUBLIC_SENTRY_RELEASE,
    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,
    // Session Replay deferred post-MVP — bundle-size sensitive.
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    debug: false,
  });
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
