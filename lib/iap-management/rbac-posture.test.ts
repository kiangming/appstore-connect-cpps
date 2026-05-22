/**
 * RBAC posture audit (Hotfix 10 + Hotfix 11).
 *
 * Static fitness test: asserts that each IAP Management page + API route
 * uses the correct auth helper for the current lock interpretation.
 * Prevents accidental regressions where a future contributor re-adds
 * `requireIapAdmin` to a member-accessible surface (or drops the
 * scope-conditional admin gate from a route that handles both scopes).
 *
 * Lock recap:
 *   - Hotfix 10: admin = Settings, member = full IAP module access
 *   - Hotfix 11 refinement: Settings page itself is member-accessible
 *     (page renders Default tab in read-only mode); Default Template
 *     mutations remain admin-only via scope-conditional checks in the
 *     dual-purpose pricing-templates routes.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(__dirname, "..", "..");

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

// Surfaces that should accept any signed-in user.
const MEMBER_ACCESSIBLE = [
  // Pages (Hotfix 10)
  "app/(dashboard)/iap-management/apps/[appId]/iaps/new/page.tsx",
  "app/(dashboard)/iap-management/apps/[appId]/bulk-import/page.tsx",
  "app/(dashboard)/iap-management/apps/[appId]/iaps/[iapId]/page.tsx",
  "app/(dashboard)/iap-management/apps/[appId]/iaps/[iapId]/view/page.tsx",
  // Pages (Hotfix 11 — Settings now member-accessible, role gate is
  // tab-level + server-side scope-conditional)
  "app/(dashboard)/iap-management/settings/pricing-tiers/page.tsx",
  // API routes (Hotfix 10)
  "app/api/iap-management/asc-apps/route.ts",
  "app/api/iap-management/iaps/[iapId]/route.ts",
  "app/api/iap-management/apps/[appId]/iaps/route.ts",
  "app/api/iap-management/apps/[appId]/iaps/submit-batch/route.ts",
  "app/api/iap-management/apps/[appId]/iaps/[iapId]/create-on-apple/route.ts",
  "app/api/iap-management/apps/[appId]/iaps/sync-states/route.ts",
  "app/api/iap-management/apps/[appId]/iaps/[iapId]/update-on-apple/route.ts",
  "app/api/iap-management/apps/[appId]/iaps/[iapId]/submit/route.ts",
  "app/api/iap-management/apps/[appId]/bulk-import/execute/route.ts",
  // API routes (Hotfix 11 — dual-purpose: requireIapSession at entry,
  // then scope-conditional admin gate when scope_type === "GLOBAL")
  "app/api/iap-management/pricing-templates/route.ts",
  "app/api/iap-management/pricing-templates/[templateId]/route.ts",
];

// Surfaces that must remain admin-only (Settings tier — single-scope
// routes whose only purpose is the Default Template / price-tier
// catalog management).
const ADMIN_ONLY = [
  "app/api/iap-management/pricing-tiers/route.ts",
];

// Surfaces with scope-conditional admin gate (Hotfix 11): entry uses
// requireIapSession but the handler enforces admin when the request
// targets the GLOBAL (Default Template) scope. Assertion: must mention
// both the role-check pattern AND the GLOBAL token so a future
// regression that drops one or the other gets caught.
const SCOPE_CONDITIONAL_ADMIN = [
  "app/api/iap-management/pricing-templates/route.ts",
  "app/api/iap-management/pricing-templates/[templateId]/route.ts",
];

// Strip line comments so a "(was requireIapAdmin pre-Hotfix-10)" comment
// doesn't trip the call-site check.
function stripComments(src: string): string {
  return src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("Hotfix 10 + 11 RBAC posture audit", () => {
  describe("member-accessible surfaces use requireIapSession (not requireIapAdmin)", () => {
    it.each(MEMBER_ACCESSIBLE)("%s", (path) => {
      const src = stripComments(read(path));
      expect(src).toMatch(/requireIapSession/);
      expect(src).not.toMatch(/requireIapAdmin/);
    });
  });

  describe("admin-only surfaces still use requireIapAdmin", () => {
    it.each(ADMIN_ONLY)("%s", (path) => {
      const src = stripComments(read(path));
      expect(src).toMatch(/requireIapAdmin/);
    });
  });

  describe("scope-conditional admin gate (Hotfix 11 dual-purpose routes)", () => {
    it.each(SCOPE_CONDITIONAL_ADMIN)("%s", (path) => {
      const src = stripComments(read(path));
      // Must reference GLOBAL scope AND enforce role check (the literal
      // string "admin" appears in the role comparison). Together these
      // catch a regression that either drops the scope check or
      // flattens the route back to unconditional access.
      expect(src).toMatch(/GLOBAL/);
      expect(src).toMatch(/role !== "admin"|role === "admin"/);
    });
  });
});
