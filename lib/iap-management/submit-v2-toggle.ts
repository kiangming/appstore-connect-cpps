/**
 * Rollout toggle for the IAP reviewSubmissions v2 submit migration.
 *
 * `IAP_SUBMIT_V2_APPS` — comma-separated allowlist of Apple App IDs (the
 * SAME id form `submit-batch/route.ts` already keys on via
 * `ctx.params.appId`, i.e. Apple's numeric app id, NOT the internal
 * `iap_mgmt.apps` UUID — paste the exact id shown in the app's Apple ASC
 * URL / IAP Management app header).
 *
 * Three states:
 *   - unset / empty  → v2 OFF for every app (safe default; old
 *     inAppPurchaseSubmissions flow stays live everywhere).
 *   - "*"            → v2 ON for every app, including apps added later.
 *     Handled as an explicit branch — "*" is never treated as a literal
 *     app id to string-match (no app has id "*", so a literal-match
 *     implementation would silently behave as OFF for every app).
 *   - "id1,id2,..."  → v2 ON only for those exact app ids (dogfood mode).
 *
 * Entries are trimmed so `"id1, id2"` parses the same as `"id1,id2"`.
 */

export interface ParsedAllowlist {
  wildcard: boolean;
  ids: ReadonlySet<string>;
}

export function parseAllowlist(raw: string): ParsedAllowlist {
  const entries = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return {
    wildcard: entries.includes("*"),
    ids: new Set(entries),
  };
}

export interface V2ToggleDecision {
  enabled: boolean;
  /** Short reason string for the Railway log line — one of
   *  "allowlist=*" | "allowlisted" | "not in allowlist" | "allowlist empty". */
  reason: string;
}

/**
 * Decide whether the v2 submit path is enabled for a given Apple app id,
 * and why — the reason is logged alongside the decision so the toggle's
 * effect is confirmable from Railway logs without needing to inspect env
 * config directly.
 */
export function v2ToggleDecision(
  appleAppId: string,
  rawEnv: string | undefined = process.env.IAP_SUBMIT_V2_APPS,
): V2ToggleDecision {
  const raw = (rawEnv ?? "").trim();
  if (!raw) {
    return { enabled: false, reason: "allowlist empty" };
  }
  const { wildcard, ids } = parseAllowlist(raw);
  if (wildcard) {
    return { enabled: true, reason: "allowlist=*" };
  }
  if (ids.has(appleAppId)) {
    return { enabled: true, reason: "allowlisted" };
  }
  return { enabled: false, reason: "not in allowlist" };
}

export function isV2SubmitEnabled(
  appleAppId: string,
  rawEnv: string | undefined = process.env.IAP_SUBMIT_V2_APPS,
): boolean {
  return v2ToggleDecision(appleAppId, rawEnv).enabled;
}
