/**
 * RBAC posture audit (Hotfix 10).
 *
 * Static fitness test: asserts that each IAP Management page + API route
 * uses the correct auth helper for the lock interpretation that landed in
 * Hotfix 10. Prevents accidental regressions where a future contributor
 * re-adds `requireIapAdmin` to a member-accessible surface (or, more
 * dangerously, drops the admin guard from a Settings surface).
 *
 * Lock recap (Hotfix 10):
 *   - admin = Settings only (pricing tiers, pricing templates)
 *   - member = full IAP module access (CRUD, submit, bulk-import, view)
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
  // Pages
  "app/(dashboard)/iap-management/apps/[appId]/iaps/new/page.tsx",
  "app/(dashboard)/iap-management/apps/[appId]/bulk-import/page.tsx",
  "app/(dashboard)/iap-management/apps/[appId]/iaps/[iapId]/page.tsx",
  "app/(dashboard)/iap-management/apps/[appId]/iaps/[iapId]/view/page.tsx",
  // API routes
  "app/api/iap-management/asc-apps/route.ts",
  "app/api/iap-management/iaps/[iapId]/route.ts",
  "app/api/iap-management/apps/[appId]/iaps/route.ts",
  "app/api/iap-management/apps/[appId]/iaps/submit-batch/route.ts",
  "app/api/iap-management/apps/[appId]/iaps/[iapId]/create-on-apple/route.ts",
  "app/api/iap-management/apps/[appId]/iaps/sync-states/route.ts",
  "app/api/iap-management/apps/[appId]/iaps/[iapId]/update-on-apple/route.ts",
  "app/api/iap-management/apps/[appId]/iaps/[iapId]/submit/route.ts",
  "app/api/iap-management/apps/[appId]/bulk-import/execute/route.ts",
];

// Surfaces that must remain admin-only (Settings tier).
const ADMIN_ONLY = [
  "app/(dashboard)/iap-management/settings/pricing-tiers/page.tsx",
  "app/api/iap-management/pricing-tiers/route.ts",
  "app/api/iap-management/pricing-templates/route.ts",
  "app/api/iap-management/pricing-templates/[templateId]/route.ts",
];

// Strip line comments so a "(was requireIapAdmin pre-Hotfix-10)" comment
// doesn't trip the call-site check.
function stripComments(src: string): string {
  return src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("Hotfix 10 RBAC posture audit", () => {
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
});
