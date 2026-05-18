// @vitest-environment jsdom

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { IapLocalizationSection } from "./IapLocalizationSection";
import type { InAppPurchaseLocalization } from "@/types/iap-management/apple";

function makeLoc(
  id: string,
  attrs: Partial<InAppPurchaseLocalization["attributes"]>,
): InAppPurchaseLocalization {
  return {
    type: "inAppPurchaseLocalizations",
    id,
    attributes: {
      locale: attrs.locale ?? "en-US",
      name: attrs.name ?? "",
      description: attrs.description,
      state: attrs.state,
    },
  };
}

const EDIT = "/iap-management/apps/123/iaps/abc";

describe("IapLocalizationSection", () => {
  it("renders one row per localization with friendly locale name + display name + description", () => {
    render(
      <IapLocalizationSection
        editBaseHref={EDIT}
        localizations={[
          makeLoc("l1", {
            locale: "en-GB",
            name: "Test tool EN UK product",
            description: "Description in en-GB",
            state: "PREPARE_FOR_SUBMISSION",
          }),
          makeLoc("l2", {
            locale: "en-US",
            name: "Test tool product",
            description: "Description in en-US",
            state: "READY_FOR_SALE",
          }),
        ]}
      />,
    );
    expect(screen.getByText(/English \(U\.K\.\)/i)).toBeInTheDocument();
    expect(screen.getByText(/English \(U\.S\.\)/i)).toBeInTheDocument();
    expect(screen.getByText("Test tool EN UK product")).toBeInTheDocument();
    expect(screen.getByText("Test tool product")).toBeInTheDocument();
    expect(screen.getByText("Description in en-GB")).toBeInTheDocument();
    expect(screen.getByText("Description in en-US")).toBeInTheDocument();
  });

  it("renders each locale link pointing at the edit page with ?locale=<code>", () => {
    render(
      <IapLocalizationSection
        editBaseHref={EDIT}
        localizations={[
          makeLoc("l1", { locale: "vi", name: "Vi name", state: "READY_FOR_SALE" }),
        ]}
      />,
    );
    const link = screen.getByRole("link", { name: /Vietnamese/i });
    expect(link).toHaveAttribute("href", `${EDIT}?locale=vi`);
  });

  it("applies the Q-D tone to the status dot per locale state", () => {
    const { container } = render(
      <IapLocalizationSection
        editBaseHref={EDIT}
        localizations={[
          makeLoc("a", { locale: "en-US", name: "a", state: "READY_FOR_SALE" }), // success
          makeLoc("b", { locale: "vi", name: "b", state: "MISSING_METADATA" }),  // warning
          makeLoc("c", { locale: "ja", name: "c", state: "WAITING_FOR_REVIEW" }),// info
          makeLoc("d", { locale: "ko", name: "d", state: "REJECTED" }),          // error
          makeLoc("e", { locale: "th", name: "e", state: "READY_TO_SUBMIT" }),   // neutral
        ]}
      />,
    );
    const dots = container.querySelectorAll(
      "span[aria-hidden].rounded-full",
    );
    // 5 rows → 5 dots
    expect(dots.length).toBe(5);
    expect(dots[0].className).toContain("bg-emerald-500");
    expect(dots[1].className).toContain("bg-amber-500");
    expect(dots[2].className).toContain("bg-blue-500");
    expect(dots[3].className).toContain("bg-red-500");
    expect(dots[4].className).toContain("bg-slate-400");
  });

  it("defaults missing locale state to READY_TO_SUBMIT (neutral tone) instead of crashing", () => {
    const { container } = render(
      <IapLocalizationSection
        editBaseHref={EDIT}
        localizations={[
          makeLoc("nostate", { locale: "en-US", name: "x", state: undefined }),
        ]}
      />,
    );
    expect(screen.getByText("Ready To Submit")).toBeInTheDocument();
    const dot = container.querySelector("span[aria-hidden].rounded-full");
    expect(dot?.className).toContain("bg-slate-400");
  });

  it("renders the empty placeholder when no localizations are present", () => {
    render(<IapLocalizationSection editBaseHref={EDIT} localizations={[]} />);
    expect(
      screen.getByText(/No localizations on Apple/i),
    ).toBeInTheDocument();
  });

  it("renders the Learn More link in the helper text", () => {
    render(<IapLocalizationSection editBaseHref={EDIT} localizations={[]} />);
    const link = screen.getByRole("link", { name: /Learn More/i });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("href")).toMatch(/developer\.apple\.com/);
  });

  it("renders the title + add adornment", () => {
    render(<IapLocalizationSection editBaseHref={EDIT} localizations={[]} />);
    expect(screen.getByText("App Store Localization")).toBeInTheDocument();
    expect(
      screen.getByLabelText(/Add localization via Edit/i),
    ).toBeInTheDocument();
  });
});
