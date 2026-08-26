// @vitest-environment jsdom
/**
 * The settings tab strip — and the header link chain it replaced.
 *
 * MUTATION (i): hardcoding the active tab (rather than deriving it from
 * `usePathname`) must FAIL. That is the shape the old chain effectively had —
 * each page asserting its own idea of where it sat — and it is how a tab strip
 * ends up highlighting the wrong page on one route while looking perfect on
 * the other two.
 *
 * MUTATION (ii): leaving the old "← X" / "Y →" chain on any of the three pages
 * must FAIL. Two navigation idioms side by side is precisely the mess the
 * Manager reported; deleting the chain is half the change, and a test that
 * only checked the new strip would pass with both on screen.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const pathnameMock = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ usePathname: pathnameMock }));

import { SettingsTabs, SETTINGS_TABS } from "./SettingsTabs";

const PRICING = "/iap-management/settings/pricing-tiers";
const HUB = "/iap-management/settings/hub-tracking";
const KEYS = "/iap-management/settings/key-pool";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderAt(pathname: string) {
  pathnameMock.mockReturnValue(pathname);
  render(<SettingsTabs />);
}

// ─── (a) the active tab follows the pathname ───────────────────────────────

describe("⚠ MUTATION (i) — the active tab is DERIVED from the pathname", () => {
  it.each([
    [PRICING, "Pricing Templates"],
    [HUB, "Hub Tracking"],
    [KEYS, "API Key Pool"],
  ])("on %s the active tab is %s", (pathname, expectedLabel) => {
    renderAt(pathname);
    const active = screen.getByTestId("settings-tab-active");
    expect(active.textContent).toBe(expectedLabel);
    // `aria-current="page"` is the same fact for a screen reader — a strip
    // that only marked the active tab with colour would say nothing here.
    expect(active.getAttribute("aria-current")).toBe("page");
  });

  it("⚠ EXACTLY ONE tab is active on every route — never zero, never two", () => {
    // The mutation that hardcodes a page would light two tabs on that page's
    // siblings, or none on itself. Both are caught here.
    for (const pathname of [PRICING, HUB, KEYS]) {
      cleanup();
      renderAt(pathname);
      expect(screen.getAllByTestId("settings-tab-active")).toHaveLength(1);
      expect(screen.getAllByTestId("settings-tab-idle")).toHaveLength(2);
    }
  });

  it("⚠ a matrix SUB-page does not light the Pricing tab — exact match, not startsWith", () => {
    // `/settings/pricing-tiers` is a prefix of `/settings/pricing-tiers/
    // default-matrix`. Those are full-page views with their own breadcrumbs
    // and they do not render this strip; a `startsWith` check would still
    // claim one was active.
    renderAt(`${PRICING}/default-matrix`);
    expect(screen.queryByTestId("settings-tab-active")).toBeNull();
    expect(screen.getAllByTestId("settings-tab-idle")).toHaveLength(3);
  });
});

// ─── (b) the other two are real links to the real routes ───────────────────

describe("the inactive tabs are links to the sibling routes", () => {
  it.each([
    [PRICING, [HUB, KEYS]],
    [HUB, [PRICING, KEYS]],
    [KEYS, [PRICING, HUB]],
  ])("on %s the idle tabs link to %s", (pathname, expectedHrefs) => {
    renderAt(pathname);
    const hrefs = screen
      .getAllByTestId("settings-tab-idle")
      .map((el) => el.getAttribute("href"));
    expect(hrefs.sort()).toEqual([...expectedHrefs].sort());
  });

  it("every tab is an anchor — these are ROUTES, not state", () => {
    renderAt(HUB);
    const strip = screen.getByTestId("settings-tabs");
    const links = within(strip).getAllByRole("link");
    expect(links).toHaveLength(3);
    // Including the active one: staying clickable is what lets a Manager
    // reload the page they are on, and matches how the mockup drew it.
    expect(links.map((l) => l.getAttribute("href")).sort()).toEqual(
      [PRICING, HUB, KEYS].sort(),
    );
  });

  it("renders the three labels in the mockup's order", () => {
    renderAt(PRICING);
    const strip = screen.getByTestId("settings-tabs");
    const labels = within(strip)
      .getAllByRole("link")
      .map((l) => l.textContent);
    expect(labels).toEqual(["Pricing Templates", "Hub Tracking", "API Key Pool"]);
  });

  it("⚠ the pricing tab reads 'Pricing Templates', never 'Pricing Tiers'", () => {
    // The route SLUG stays `pricing-tiers`; the LABEL does not. A price tier
    // is a different live object (iap_mgmt.price_tiers) and this page does not
    // manage those.
    renderAt(PRICING);
    expect(screen.getByText("Pricing Templates")).toBeTruthy();
    expect(screen.queryByText("Pricing Tiers")).toBeNull();
    expect(SETTINGS_TABS[0].href).toBe(PRICING);
  });
});

// ─── (c) the old chain is GONE from all three pages ────────────────────────

describe("⚠ MUTATION (ii) — the old header link chain no longer exists", () => {
  const ROOT = process.cwd();
  const CLIENTS = [
    "app/(dashboard)/iap-management/settings/pricing-tiers/PricingTiersClient.tsx",
    "app/(dashboard)/iap-management/settings/hub-tracking/HubTrackingClient.tsx",
    "app/(dashboard)/iap-management/settings/key-pool/KeyPoolClient.tsx",
  ];
  const read = (f: string) => readFileSync(join(ROOT, f), "utf8");

  /** Strip comments — prose may legitimately say "Settings → API Key Pool". */
  const stripComments = (code: string) =>
    code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it.each(CLIENTS)("%s has no <a>/<Link> to a sibling settings route", (file) => {
    const code = stripComments(read(file));
    // The chain was built from anchors/Links pointing at the OTHER two
    // settings pages. The strip is the only thing allowed to do that now, and
    // it lives in its own file.
    const siblingLinks = [
      ...code.matchAll(/<(?:a|Link)\b[^>]*href=["'{`]?[^>]*settings\/(pricing-tiers|hub-tracking|key-pool)/g),
    ];
    expect(siblingLinks.map((m) => m[0])).toEqual([]);
  });

  it.each(CLIENTS)("%s renders no arrow-chain label", (file) => {
    const code = stripComments(read(file));
    // "← Hub Tracking" / "API Key Pool →" / "Hub Tracking →" — the literal
    // shape the Manager pointed at.
    expect(code).not.toMatch(/←\s*(Pricing|Hub|API)/);
    expect(code).not.toMatch(/(Templates|Tracking|Pool)\s*→/);
  });

  it.each(CLIENTS)("%s renders <SettingsTabs />", (file) => {
    // The other half of the same change: removing the chain without adding the
    // strip would leave a page with no sibling navigation at all.
    expect(read(file)).toContain("<SettingsTabs />");
  });

  it("⚠ the key-pool NOT-ADMIN branch gets the strip too", () => {
    // Two return branches in that file. A member landing on the locked screen
    // is the person most in need of a way to the other pages, and the old
    // link lived on that branch as well.
    const code = read(CLIENTS[2]);
    const notAdminIdx = code.indexOf('data-testid="not-admin"');
    expect(notAdminIdx).toBeGreaterThan(-1);
    const beforeNotAdmin = code.slice(0, notAdminIdx);
    expect(beforeNotAdmin).toContain("<SettingsTabs />");
  });

  it("the strip is defined ONCE — no page hand-rolls its own copy", () => {
    for (const file of CLIENTS) {
      const code = stripComments(read(file));
      expect(code).not.toContain("SETTINGS_TABS");
      expect(code).not.toMatch(/usePathname/);
    }
  });
});

// ─── the two-tier tab problem ──────────────────────────────────────────────

describe("route tabs stay visually distinct from the in-page tabs", () => {
  const pricingClient = readFileSync(
    join(
      process.cwd(),
      "app/(dashboard)/iap-management/settings/pricing-tiers/PricingTiersClient.tsx",
    ),
    "utf8",
  );

  it("the route strip renders ABOVE the page title, the in-page tabs below it", () => {
    // The heading between them is the primary separator. If the strip ever
    // moves under the <h1>, the two rows sit adjacent and a Manager clicking
    // what looks like a sub-tab leaves the page.
    const strip = pricingClient.indexOf("<SettingsTabs />");
    const title = pricingClient.indexOf("Pricing Templates\n");
    const innerTabs = pricingClient.indexOf('aria-label="Pricing templates tabs"');
    expect(strip).toBeGreaterThan(-1);
    expect(title).toBeGreaterThan(strip);
    expect(innerTabs).toBeGreaterThan(title);
  });

  it("⚠ active TEXT colour differs between the two tiers", () => {
    renderAt(PRICING);
    const active = screen.getByTestId("settings-tab-active");
    // Route tab: dark text + accent underline (mockup .tab-active).
    expect(active.className).toContain("text-slate-900");
    expect(active.className).toContain("border-[#0071E3]");
    // The in-page tab uses accent TEXT instead — asserted on the source so the
    // difference cannot be "harmonised" away in either file.
    expect(pricingClient).toContain('? "text-[#0071E3]"');
  });

  it("route tabs carry no count pills — that badge belongs to the in-page tabs", () => {
    renderAt(PRICING);
    const strip = screen.getByTestId("settings-tabs");
    expect(strip.textContent).toBe("Pricing TemplatesHub TrackingAPI Key Pool");
  });
});

// ─── responsive ────────────────────────────────────────────────────────────

describe("a narrow window scrolls the strip rather than wrapping it", () => {
  it("the container scrolls horizontally and the tabs refuse to shrink or wrap", () => {
    renderAt(KEYS);
    const strip = screen.getByTestId("settings-tabs");
    expect(strip.className).toContain("overflow-x-auto");
    for (const tab of within(strip).getAllByRole("link")) {
      expect(tab.className).toContain("whitespace-nowrap");
      expect(tab.className).toContain("shrink-0");
    }
  });
});
