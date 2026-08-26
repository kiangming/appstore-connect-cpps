"use client";

/**
 * The Apple IAP Management settings tab strip — the ONE navigation idiom
 * across the three settings routes.
 *
 * ─── WHAT THIS REPLACES, AND WHY ───────────────────────────────────────────
 *
 * Each settings page used to hand-write its own chain of sibling links into
 * its header, next to the title and description:
 *
 *   Pricing Templates   →  "Hub Tracking →"
 *   Hub Tracking        →  "← Pricing Templates"   "API Key Pool →"
 *   API Key Pool        →  "← Hub Tracking"        (twice — see below)
 *
 * Three problems, all reported by the Manager at UAT and all structural
 * rather than cosmetic:
 *
 *   1. **It never says where you are.** A chain of links to OTHER pages leaves
 *      the current page as the one thing unlabelled — you infer your position
 *      from what is missing.
 *   2. **It is a different shape on every page.** One link, two links, arrows
 *      pointing different ways. The set of destinations is the same three
 *      pages every time; only the rendering disagreed.
 *   3. **It shares the header with the title and description**, so the line
 *      that should be the calmest part of the screen carried navigation.
 *
 * `KeyPoolClient` even carried a comment justifying the chain — "no such
 * component exists … building a tab bar here would have been a fourth
 * navigation idiom". That was true when only one page was being built. The
 * answer was never to add a fourth idiom; it was to build this once and delete
 * the other three. That comment is removed along with the links it defended.
 *
 * ─── THESE ARE LINKS, NOT STATE ────────────────────────────────────────────
 *
 * ⚠ The three settings pages are three INDEPENDENT ROUTES, not three tabs of
 * one page (confirmed in the key-pool census, U3). So the strip renders
 * `<Link>`s and derives the active tab from `usePathname()`. There is no
 * `activeTab` prop and there must not be one: a prop each page passes by hand
 * is a fourth place to get it wrong, and it would let a page claim to be a tab
 * it is not on.
 *
 * ─── ADMIN: ALL THREE TABS, ALWAYS, ENABLED ────────────────────────────────
 *
 * ⚠ None of these routes is admin-only. All three `page.tsx` gate on
 * `requireIapSession`, and `isAdmin` only decides what renders INSIDE
 * (key-pool shows a locked panel, pricing shows read-only, hub-tracking hides
 * the save form). A member can reach every one of them.
 *
 * So the strip takes no role prop. Hiding a tab would hide a page the user can
 * actually open; disabling one would claim it is unreachable when it is not.
 * The honest surface is three live tabs, with the per-page content explaining
 * any restriction — which is what those pages already do, in their own words.
 *
 * ⚠ This includes the key-pool NOT-ADMIN branch, which renders the strip too.
 * Leaving it on the old link there would mean the one screen a member is most
 * likely to land on confused is the one still using the old idiom.
 *
 * ─── STYLING COMES FROM THE MOCKUP ─────────────────────────────────────────
 *
 * `docs/iap-management/design/pool-key-management-mockup.html:29-30,59-63`:
 *
 *   .tab        { padding:8px 14px; font-size:13px; font-weight:500;
 *                 border-bottom:2px solid transparent; color:#64748b }
 *   .tab-active { color:#0f172a; border-bottom-color:#0071E3 }
 *   container   : flex items-center gap-1 px-3 pt-2 border-b border-slate-200
 *
 * Translated to the module's existing tokens — `#0071E3` is the accent used by
 * every other nav in this module, and `slate-500` / `slate-900` are the text
 * pair already in use. No new palette, no new spacing scale.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * ⚠ ORDER IS THE MOCKUP'S ORDER (Q3): Pricing Templates · Hub Tracking ·
 * API Key Pool. It is also the order the old link chain implied, so nobody's
 * muscle memory moves.
 */
export const SETTINGS_TABS = [
  {
    href: "/iap-management/settings/pricing-tiers",
    /**
     * ⚠ "Pricing Templates", NOT "Pricing Tiers" — and the route slug stays
     * `pricing-tiers` regardless.
     *
     * The codebase was split: the page's own `<h1>` said "Pricing Templates",
     * the breadcrumbs said "Pricing Tiers", the mockup's tab said "Pricing
     * Tiers", and the user guide said "Pricing Templates" 8 times to 1.
     * "Templates" wins for a reason beyond the head-count: **a price TIER is a
     * different, live domain object** — `iap_mgmt.price_tiers`, `iaps.tier_id`
     * — and this page does not manage those. It manages TEMPLATES that map
     * tiers onto territory prices. Naming a surface after a same-named-but-
     * different-meaning entity is the trap KB §9 P5 names for statuses; it
     * costs just as much in a label.
     *
     * The slug is not renamed because that is a route change: ~15 call sites,
     * the sidebar's `getSettingsHref`, and every existing bookmark.
     */
    label: "Pricing Templates",
  },
  { href: "/iap-management/settings/hub-tracking", label: "Hub Tracking" },
  { href: "/iap-management/settings/key-pool", label: "API Key Pool" },
] as const;

export function SettingsTabs() {
  const pathname = usePathname();

  return (
    <div
      data-testid="settings-tabs"
      /**
       * ⚠ `overflow-x-auto` + `whitespace-nowrap`: on a narrow window the strip
       * SCROLLS rather than wrapping. Wrapping would put one tab on a second
       * line under a border that is meant to read as a single baseline, and the
       * underline that marks the active tab would land mid-card. Horizontal
       * scroll is the module's existing answer for content wider than its
       * container (`IapLocalizationSection.tsx:144`).
       */
      className="mb-6 flex items-center gap-1 overflow-x-auto border-b border-slate-200 dark:border-slate-800"
    >
      {SETTINGS_TABS.map((tab) => {
        /**
         * ⚠ Exact match, not `startsWith`. `/settings/pricing-tiers` is a
         * PREFIX of `/settings/pricing-tiers/default-matrix`, and those matrix
         * pages are full-page views with their own breadcrumb trail — not a
         * settings tab. `startsWith` would light the tab up on a page that
         * does not render the strip at all, and would be a bug nobody sees
         * until they are three levels deep.
         */
        const active = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            data-testid={`settings-tab-${active ? "active" : "idle"}`}
            className={`shrink-0 whitespace-nowrap border-b-2 px-3.5 py-2 text-[13px] font-medium transition ${
              active
                ? // Mockup `.tab-active`: dark text + the accent underline.
                  // ⚠ Deliberately NOT the accent-coloured TEXT used by the
                  // in-page tabs on the Pricing Templates screen — see below.
                  "border-[#0071E3] text-slate-900 dark:text-slate-100"
                : "border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}

/**
 * ─── TWO ROWS OF TABS ON ONE SCREEN, AND HOW THEY STAY TELLABLE APART ──────
 *
 * The Pricing Templates page has its OWN tabs inside it — Default Template /
 * Per-App Templates (`PricingTiersClient.tsx:82-117`). With this strip added,
 * that screen shows two tab rows, and confusing them would mean a Manager
 * clicking what they think is a sub-tab and leaving the page entirely.
 *
 * Three signals separate them, and the first is the one that does the work:
 *
 *   1. **The page title sits BETWEEN them.** Route tabs render above the
 *      `<h1>`; the in-page tabs render below it, inside the content. A tab row
 *      under a heading reads as part of that heading's content — which is
 *      exactly what it is.
 *   2. **Different active treatment.** Route tab: slate-900 text + blue
 *      underline (mockup). In-page tab: BLUE text + blue underline. Same
 *      underline, different text colour, so the two rows never look identical
 *      even out of context.
 *   3. **Only the in-page tabs carry count pills** (`12`, `3`). A route tab
 *      counts nothing, and giving it a badge would have collapsed signal 2.
 *
 * ⚠ Do not "harmonise" these two styles. They are two different kinds of
 * navigation — one changes the URL, one changes what the page shows — and the
 * visual difference is load-bearing.
 */
