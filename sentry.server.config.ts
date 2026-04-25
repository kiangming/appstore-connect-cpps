import * as Sentry from "@sentry/nextjs";

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
    release: process.env.SENTRY_RELEASE,
    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,
    debug: false,
    beforeSend(event) {
      // Redact message bodies that may carry reviewer PII from Apple / Google
      // before the payload leaves this runtime. Stack traces + tags keep enough
      // signal to triage without shipping email contents to Sentry.
      if (event.request?.data && typeof event.request.data === "object") {
        const data = event.request.data as Record<string, unknown>;
        for (const key of ["body", "email_body", "body_excerpt", "content"]) {
          if (key in data) data[key] = "[redacted]";
        }
      }
      if (event.extra) {
        for (const key of Object.keys(event.extra)) {
          if (/body|email|content/i.test(key)) {
            event.extra[key] = "[redacted]";
          }
        }
      }
      return event;
    },
  });
}
