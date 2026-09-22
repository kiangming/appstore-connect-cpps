/**
 * [BULK-IMPORT-locale-reason] — the reason a locale failed must be PERSISTED,
 * not just logged.
 *
 * ⚠ THE DEFECT THIS PINS, IN ITS OWN WORDS. On 2026-09-21 an 88-row Apple
 * bulk import returned 20 PARTIAL rows that were byte-identical in the one
 * place that mattered:
 *
 *     localizations { done: 0, total: 1, state: "FAILED", failed: ["vi"] }
 *     error: null
 *
 * Twenty rows, one symptom, and not a single word anywhere about what Apple
 * had objected to. The reason existed — every catch block computed it — and
 * every catch block handed it to `log()` and dropped it. A Railway log line
 * is not a record: it ages out, it is not queryable, and it is not in the
 * response the Manager reads.
 *
 * Two halves, because the hole had two halves:
 *   • behavioural — the recorder keeps message/full/httpStatus, and the
 *     renderer shows them;
 *   • structural — all three catch blocks in the harness-less execute route
 *     actually call the recorder, and the stage map actually carries it.
 *
 * ⚠ Structural for the route half for the reason `locale-loop-break.
 * structural.test.ts` states: `execute/route.ts` has no orchestration
 * harness. A behavioural test there would need Supabase, the Apple client,
 * the parser, conflict resolution, the territory catalogue and the
 * price-point cache — and would still be pinning one `catch` inside a
 * 1,700-line function.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  recordLocaleFailure,
  recordAllLocalesFailed,
  localeCodes,
  type LocaleFailure,
} from "./locale-failures";
import { formatLocalizationFailures, formatStageMap } from "./stage-map-view";
import type { RowStages } from "./row-outcome";
import { AppleApiError } from "@/lib/iap-management/apple/fetch";

const APPLE_BODY = JSON.stringify({
  errors: [
    {
      status: "409",
      code: "ENTITY_ERROR.ATTRIBUTE.INVALID.DUPLICATE",
      title: "An attribute value is not acceptable for the current resource state.",
      detail: "The provided name is already in use by another in-app purchase.",
    },
  ],
});

/**
 * ⚠ ARGUMENT ORDER IS `(status, method, endpoint, body)` — checked against
 * lib/shared/apple-fetch.ts:36, not assumed. The first draft of this helper
 * had `(status, body, method, endpoint)` and the suite failed with a message
 * that looked exactly like a real renderer defect. P44: a probe stub on the
 * wrong seam reports a harness bug in the format of a product bug.
 */
function appleErr(status = 409, body = APPLE_BODY) {
  return new AppleApiError(status, "POST", "/v1/inAppPurchaseLocalizations", body);
}

// ─── behavioural: the recorder keeps the reason ──────────────────────────────

describe("recordLocaleFailure keeps WHY, not just WHICH", () => {
  it("⚠ carries Apple's message, uncapped body and HTTP status", () => {
    const into: LocaleFailure[] = [];
    const entry = recordLocaleFailure(into, "vi", appleErr());

    expect(into).toHaveLength(1);
    // The field whose absence cost the investigation.
    expect(entry.message).toContain("ENTITY_ERROR.ATTRIBUTE.INVALID.DUPLICATE");
    expect(entry.httpStatus).toBe(409);
    // `full` is the diagnostic field — Apple puts `detail` in the body.
    expect(entry.full).toContain("already in use by another in-app purchase");
  });

  it("keeps a non-Apple throw readable too", () => {
    const into: LocaleFailure[] = [];
    const entry = recordLocaleFailure(into, "vi", new Error("socket hang up"));
    expect(entry.message).toBe("socket hang up");
    expect(entry.httpStatus).toBeUndefined();
  });

  it("⚠ `failed` is DERIVED from the same list — the two cannot drift", () => {
    const into: LocaleFailure[] = [];
    recordLocaleFailure(into, "vi", appleErr());
    recordLocaleFailure(into, "th", new Error("boom"));
    expect(localeCodes(into)).toEqual(["vi", "th"]);
  });
});

describe("recordAllLocalesFailed — a pre-flight throw sent NOTHING", () => {
  it("⚠ marks every locale, so the stage cannot read OK for an untouched row", () => {
    // Before this, the OVERWRITE path's outer catch only logged: `failed`
    // stayed empty, `done` equalled `total`, and the map said OK for a row
    // Apple was never told anything about.
    const into: LocaleFailure[] = [];
    recordAllLocalesFailed(
      into,
      [{ locale: "vi" }, { locale: "en-US" }],
      new Error("ECONNRESET"),
      "could not list existing localizations",
    );
    expect(localeCodes(into)).toEqual(["vi", "en-US"]);
    expect(into[0].message).toContain("could not list existing localizations");
    expect(into[0].message).toContain("ECONNRESET");
  });

  it("is idempotent — a locale already recorded is not doubled", () => {
    const into: LocaleFailure[] = [];
    recordLocaleFailure(into, "vi", appleErr());
    recordAllLocalesFailed(
      into,
      [{ locale: "vi" }, { locale: "th" }],
      new Error("ECONNRESET"),
      "ctx",
    );
    expect(localeCodes(into)).toEqual(["vi", "th"]);
  });
});

// ─── behavioural: the renderer surfaces the reason ───────────────────────────

function stagesWith(loc: Partial<RowStages["localizations"]>): RowStages {
  return {
    create: { state: "NOT_APPLICABLE" },
    localizations: {
      state: "FAILED",
      done: 0,
      total: 1,
      failed: ["vi"],
      skippedByStop: 0,
      ...loc,
    },
    pricing: { state: "OK", outcome: "set" },
    screenshot: { state: "NOT_APPLICABLE" },
    availability: { state: "NOT_APPLICABLE" },
    submit: { state: "NOT_APPLICABLE" },
  };
}

describe("the stage map RENDERS the reason", () => {
  it("⚠ formatStageMap shows Apple's objection, not just the locale code", () => {
    const detail: LocaleFailure[] = [];
    recordLocaleFailure(detail, "vi", appleErr());
    const text = formatStageMap(stagesWith({ failedDetail: detail }));

    // This is the exact 2026-09-21 row, and this is the line it could not say.
    expect(text).toContain("1 failed: vi");
    expect(text).toContain("ENTITY_ERROR.ATTRIBUTE.INVALID.DUPLICATE");
    expect(text).toContain("HTTP 409");
  });

  it("stays quiet on a response that predates the field", () => {
    // `failedDetail` is optional precisely so an older server response still
    // renders — the same reason `not_attempted` and `partial` are optional.
    const text = formatStageMap(stagesWith({}));
    expect(text).toContain("1 failed: vi");
    expect(formatLocalizationFailures(stagesWith({}).localizations)).toBe("");
  });

  it("gives every failed locale its own line", () => {
    const detail: LocaleFailure[] = [];
    recordLocaleFailure(detail, "vi", appleErr());
    recordLocaleFailure(detail, "th", appleErr(422, "bad description"));
    const text = formatLocalizationFailures(
      stagesWith({ failed: ["vi", "th"], total: 2, failedDetail: detail }).localizations,
    );
    expect(text.split("\n")).toHaveLength(2);
    expect(text).toContain("HTTP 422");
  });
});

// ─── structural: the route actually calls it, at every catch ─────────────────

const routeSrc = readFileSync(
  join(
    __dirname, "..", "..", "..",
    "app", "api", "iap-management", "apps", "[appId]",
    "bulk-import", "execute", "route.ts",
  ),
  "utf8",
);

describe("execute/route.ts persists the reason at EVERY locale catch", () => {
  it("⚠ no catch pushes a bare locale code any more", () => {
    // The pre-fix shape, verbatim. Its return would be the regression.
    expect(routeSrc).not.toMatch(/failedLocales\.push\(/);
  });

  it("⚠ records at all three write catches — CREATE, PATCH, POST", () => {
    // Three call sites, one choke point (CLAUDE.md meta-rule P1: the project
    // has repeatedly hardened one sibling and left the other).
    const calls = routeSrc.match(/recordLocaleFailure\(localeFailures,/g) ?? [];
    expect(calls).toHaveLength(3);
  });

  it("⚠ records the OVERWRITE pre-flight throw as every locale failing", () => {
    expect(routeSrc).toContain("recordAllLocalesFailed(");
    expect(routeSrc).toContain("could not list existing localizations");
  });

  it("⚠ both stage maps carry failedDetail, and derive `failed` from it", () => {
    // Twin paths. Hardening one and leaving the other is the exact mistake
    // the twin-path rule exists for — and this file's subject is a stage
    // that was left behind by five siblings that already carried an error.
    const detail = routeSrc.match(/failedDetail: localeFailures/g) ?? [];
    expect(detail).toHaveLength(2);
    const derived = routeSrc.match(/failed: localeCodes\(localeFailures\)/g) ?? [];
    expect(derived).toHaveLength(2);
  });
});
