/**
 * What Google actually said when a call failed — kept, not paraphrased.
 *
 * ⚠ THIS MODULE EXISTS BECAUSE THE ANSWER USED TO BE THROWN AWAY.
 * Every Publisher call funnels through `timed()`, which kept exactly one
 * thing from a failure: `err.message`, sliced to 200 chars. Google's 403
 * body carries the only fields that distinguish the possible causes from
 * each other —
 *
 *   { "error": { "code": 403,
 *                "message": "The caller does not have permission",
 *                "status": "PERMISSION_DENIED",
 *                "errors": [{ "reason": "forbidden", "domain": "global" }],
 *                "details": [{ "@type": ".../ErrorInfo",
 *                              "reason": "SERVICE_DISABLED",
 *                              "metadata": { ... } }] } }
 *
 * — and `message` is the one field that is identical across all of them.
 * On 2026-10-12 `vng.games.tamquoc.chienky` failed 16/16 twice with that
 * message while `vng.games.lightandnight` succeeded 9/9 under the SAME
 * service account, and the investigation had to proceed on inference
 * because `status`, `errors[].reason` and `details[]` were never captured.
 *
 * ⚠ SAME CLASS AS Apple's `failedDetail[].full` HOLE, and deliberately the
 * same shape: `message` (capped, backward-compatible) + `full` (complete,
 * never sliced) + `httpStatus`. A reader who knows how to read a failed
 * Apple row can read a failed Google call without learning a second
 * vocabulary. See lib/iap-management/bulk-import/apple-error-descriptor.ts.
 *
 * ⛔ NO SECRET EVER LEAVES THIS MODULE. The 200-char cap this replaces was
 * not arbitrary — logging.ts recorded that Google "occasionally echo[es]
 * private-key tails on scope errors". Un-capping without redacting would
 * trade one hole for a worse one, so `redactSecrets` runs over every string
 * this module emits, before it can reach a log line OR the audit payload.
 */

/** One entry of Google's `error.details[]`, kept VERBATIM.
 *  Open-ended by design: `@type` and `metadata` are the fields that name
 *  the real cause, and an interface that listed only known keys would
 *  silently drop the next one Google adds. */
export interface GoogleErrorDetail {
  "@type"?: string;
  reason?: string;
  domain?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface GoogleErrorDescriptor {
  /** Capped at 500 chars — safe for a table cell, and the field every
   *  existing consumer of `error`/`err.message` already reads. */
  message: string;
  /** Google's COMPLETE response body (or the full error message for a
   *  non-HTTP error), redacted but NEVER sliced. The diagnostic field. */
  full: string;
  /** The HTTP status (403, 404, 500…), when the throw came off the wire. */
  httpStatus?: number;
  /** `error.status` — the canonical enum, e.g. "PERMISSION_DENIED".
   *  ⚠ THIS, NOT `message`, IS WHAT CODE SHOULD EVER BRANCH ON. */
  status?: string;
  /** `error.errors[].reason`, in order. e.g. ["forbidden"]. */
  reasons?: string[];
  /** `error.details[]`, verbatim, including `@type` and `metadata`. */
  details?: GoogleErrorDetail[];
}

/** Apple parity: `describeAppleError` caps `message` at 500. */
const MESSAGE_CAP = 500;

/**
 * Strip anything that could be key material out of a string bound for a
 * log line or the audit log.
 *
 * ⚠ THE PAIRED PATTERN MUST RUN BEFORE THE UNPAIRED ONE. A truncated body
 * can carry a BEGIN marker with no END; the second pattern catches that
 * tail, but it is greedy-to-end, so running it first would swallow a whole
 * well-formed body after the first key.
 *
 * These are OUR patterns over OUR data, not user-supplied — the RE2 rule
 * (CLAUDE.md invariant #4) governs Store Management's user-authored regex
 * and does not apply here.
 */
export function redactSecrets(input: string): string {
  return input
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      "[REDACTED PRIVATE KEY]",
    )
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*/g,
      "[REDACTED PRIVATE KEY]",
    )
    .replace(
      /"private_key"\s*:\s*"(?:[^"\\]|\\.)*"/g,
      '"private_key":"[REDACTED]"',
    );
}

/** Narrow an unknown to the Gaxios error surface we read.
 *  gaxios@7 `GaxiosError`: `message`, `code?: string|number`,
 *  `status?: number`, `response?: { status, data }`
 *  (node_modules/gaxios/build/cjs/src/common.d.ts:35-97). */
interface GaxiosLike {
  message?: string;
  code?: string | number;
  status?: number;
  response?: { status?: number; data?: unknown };
}

function httpStatusOf(e: GaxiosLike): number | undefined {
  if (typeof e.response?.status === "number") return e.response.status;
  if (typeof e.status === "number") return e.status;
  // gaxios only makes `code` a number when it came from an API-level error.
  if (typeof e.code === "number") return e.code;
  // googleapis has historically surfaced it as a numeric string.
  if (typeof e.code === "string" && /^\d{3}$/.test(e.code)) {
    return Number(e.code);
  }
  return undefined;
}

function serializeBody(data: unknown): string | undefined {
  if (data === undefined || data === null) return undefined;
  if (typeof data === "string") return data;
  try {
    return JSON.stringify(data);
  } catch {
    // Circular / non-serializable body — better a marker than a throw from
    // inside an error handler.
    return String(data);
  }
}

/**
 * Pull the structured parts out of a Google JSON-API error body.
 * Tolerates every shape we might get: the parsed `{error:{…}}` object, a
 * raw JSON string of the same, or something else entirely.
 */
function structuredPartsOf(
  data: unknown,
): Pick<GoogleErrorDescriptor, "status" | "reasons" | "details"> {
  let obj: unknown = data;
  if (typeof obj === "string") {
    try {
      obj = JSON.parse(obj);
    } catch {
      return {};
    }
  }
  if (!obj || typeof obj !== "object") return {};
  const err = (obj as Record<string, unknown>).error;
  if (!err || typeof err !== "object") return {};
  const e = err as Record<string, unknown>;

  const out: Pick<GoogleErrorDescriptor, "status" | "reasons" | "details"> = {};

  if (typeof e.status === "string" && e.status.length > 0) {
    out.status = e.status;
  }

  if (Array.isArray(e.errors)) {
    const reasons = e.errors
      .map((x) =>
        x && typeof x === "object"
          ? (x as Record<string, unknown>).reason
          : undefined,
      )
      .filter((r): r is string => typeof r === "string" && r.length > 0);
    if (reasons.length > 0) out.reasons = reasons;
  }

  if (Array.isArray(e.details) && e.details.length > 0) {
    // Verbatim — `@type` and `metadata` included. Round-tripped through
    // JSON so the stored value is a plain, detached structure rather than
    // a live reference into the SDK's response object.
    try {
      out.details = JSON.parse(
        redactSecrets(JSON.stringify(e.details)),
      ) as GoogleErrorDetail[];
    } catch {
      /* non-serializable details — `full` still carries the body */
    }
  }

  return out;
}

/**
 * Describe any thrown value as a Google error.
 *
 * Total by construction: a non-HTTP throw (a TypeError in our own mapping
 * code, a timeout) still yields `{message, full}` so callers never have to
 * branch on "was this really from Google".
 */
export function describeGoogleError(err: unknown): GoogleErrorDescriptor {
  const e = (err ?? {}) as GaxiosLike;
  const rawMessage =
    typeof e.message === "string" && e.message.length > 0
      ? e.message
      : String(err);
  const message = redactSecrets(rawMessage);

  const body = serializeBody(e.response?.data);
  const full = redactSecrets(body ?? rawMessage);

  const httpStatus = httpStatusOf(e);

  return {
    message: message.slice(0, MESSAGE_CAP),
    full,
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...structuredPartsOf(e.response?.data),
  };
}

/**
 * Both halves of a try-new-then-legacy write, when BOTH halves failed.
 *
 * ⚠ THE FALLBACK'S ERROR USED TO BE DELETED OUTRIGHT — `catch { throw err }`,
 * six times over in publisher-client.ts. That is the worst of the three
 * holes this arc closes, because the swallowed call is the one that
 * produced the log line an operator actually sees: the Railway line reads
 * `method=inappproducts.batchUpdate … status=403`, while the error reaching
 * the Manager came from `monetization.onetimeproducts.batchUpdate`. Two
 * different calls, one message, and no way to tell them apart.
 *
 * ⚠ `code` IS LOAD-BEARING, NOT DECORATION. The bulk-import execute route
 * maps `err.code` to its own HTTP response status
 * (bulk-import/execute/route.ts). Throwing a bare Error here would turn
 * every Google 403 into a 500 at the API boundary.
 */
export class GoogleDualPathError extends Error {
  /** The new Monetization API's failure — the one callers saw before. */
  readonly primary: GoogleErrorDescriptor;
  /** The legacy `inappproducts.*` failure — the one that was discarded. */
  readonly fallback: GoogleErrorDescriptor;
  /** Preserved so existing `err.code`-based status mapping keeps working. */
  readonly code?: number;
  readonly httpStatus?: number;

  constructor(
    op: string,
    primary: GoogleErrorDescriptor,
    fallback: GoogleErrorDescriptor,
  ) {
    super(
      `${op}: new API failed (${primary.status ?? primary.httpStatus ?? "?"}) ` +
        `${primary.message} — legacy fallback also failed ` +
        `(${fallback.status ?? fallback.httpStatus ?? "?"}) ${fallback.message}`,
    );
    this.name = "GoogleDualPathError";
    this.primary = primary;
    this.fallback = fallback;
    this.code = primary.httpStatus;
    this.httpStatus = primary.httpStatus;
  }
}

/**
 * Flatten a descriptor into the `actions_log` payload's flat key space.
 *
 * ⚠ ONE WRITER, NOT N. Every orchestrator that persists a Google failure
 * goes through here, so the audit log cannot grow two spellings of
 * "the reason Google said no" (CLAUDE.md meta-rule P1).
 *
 * `prefix` lets the dual-path case store both halves side by side
 * (`error_*` for the new API, `error_fallback_*` for the legacy one)
 * without the two colliding.
 */
export function errorPayloadFields(
  desc: GoogleErrorDescriptor,
  prefix = "error",
): Record<string, unknown> {
  return {
    [prefix]: desc.message,
    [`${prefix}_full`]: desc.full,
    ...(desc.httpStatus !== undefined
      ? { [`${prefix}_http_status`]: desc.httpStatus }
      : {}),
    ...(desc.status !== undefined ? { [`${prefix}_status`]: desc.status } : {}),
    ...(desc.reasons !== undefined
      ? { [`${prefix}_reasons`]: desc.reasons }
      : {}),
    ...(desc.details !== undefined
      ? { [`${prefix}_details`]: desc.details }
      : {}),
  };
}

/**
 * The audit payload for any Google failure, dual-path aware.
 *
 * Callers pass the raw thrown value; this decides whether there is one
 * half or two. Keeps `error` holding the new API's message in BOTH cases,
 * so a reader (and the SQL in the runbook) sees the same key either way.
 */
export function googleErrorPayload(err: unknown): Record<string, unknown> {
  if (err instanceof GoogleDualPathError) {
    return {
      ...errorPayloadFields(err.primary),
      ...errorPayloadFields(err.fallback, "error_fallback"),
      error_both_paths_failed: true,
    };
  }
  return errorPayloadFields(describeGoogleError(err));
}
