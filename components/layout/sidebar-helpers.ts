/**
 * Pure helpers for AppSidebar. Extracted so they can be unit-tested from a
 * node-env vitest suite (the `.tsx` component pulls in client-only modules
 * like `next-auth/react` that explode on node import).
 */

/**
 * Resolve the Settings icon target based on the current route.
 *
 * Each module owns its own settings surface; the global Settings icon is
 * just a shortcut that follows the user's module context:
 *   - Inside `/store-submissions/*` → Store Management settings page.
 *   - Anywhere else → global ASC admin settings (admin-only; non-admins
 *     hit the pre-existing redirect in app/(dashboard)/settings/page.tsx).
 *
 * Extend with additional `pathname.startsWith(...)` branches when new
 * modules ship their own settings page.
 */
export function getSettingsHref(pathname: string): string {
  if (pathname.startsWith('/store-submissions')) {
    return '/store-submissions/config/settings';
  }
  return '/settings';
}
